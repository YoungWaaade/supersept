// Chat agents: each message runs one headless Claude Code turn (`claude -p`, stream-json) that
// resumes the agent's conversation. Agents act through the Supersept MCP tools (projects,
// sessions…), never by editing files themselves; they speak briefly and work in the background.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, HUB_DIR } from './db.js';
import { getAgent, listAgents } from './agents.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const running = new Map(); // agent → child process
const queues = new Map(); // agent → pending turns

let ctx = null; // { claude, port, userName, broadcast, env }
// While the hub shuts down, keep the "running" marks so interrupted turns resume at next boot.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { shuttingDown = true; });
export function initChat(c) { ctx = c; }

const now = () => Date.now();
function addMessage(agent, role, text, meta = null) {
  const conv = chatState(agent).conversation;
  const r = db.prepare('INSERT INTO chat_messages (agent, role, text, meta, at, conversation) VALUES (?, ?, ?, ?, ?, ?)').run(agent, role, text ?? null, meta ? JSON.stringify(meta) : null, now(), conv);
  const msg = { id: Number(r.lastInsertRowid), agent, role, text, meta, at: now(), conversation: conv };
  ctx.broadcast({ type: 'chat', agent, message: msg });
  return msg;
}
function updateMessage(msg, patch) {
  Object.assign(msg, patch);
  db.prepare('UPDATE chat_messages SET text = ?, meta = ? WHERE id = ?').run(msg.text ?? null, msg.meta ? JSON.stringify(msg.meta) : null, msg.id);
  ctx.broadcast({ type: 'chat', agent: msg.agent, message: msg });
}

// Whole conversation (the current one by default), oldest first.
export function chatHistory(agent, conversation = null) {
  const conv = conversation ?? chatState(agent).conversation;
  return db.prepare('SELECT * FROM chat_messages WHERE agent = ? AND conversation = ? ORDER BY id').all(agent, conv)
    .map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));
}

export function conversations(agent) {
  const current = chatState(agent).conversation;
  return db.prepare(`SELECT conversation, COUNT(*) AS count, MIN(at) AS started, MAX(at) AS last,
      (SELECT text FROM chat_messages f WHERE f.agent = m.agent AND f.conversation = m.conversation AND f.role = 'user' ORDER BY id LIMIT 1) AS first
    FROM chat_messages m WHERE agent = ? GROUP BY conversation ORDER BY conversation DESC`).all(agent)
    .map((c) => ({ ...c, current: c.conversation === current }));
}
export const isBusy = (agent) => running.has(agent);

// New conversation: the previous one is kept (readable from the history), Claude starts fresh.
export function resetChat(agent) {
  stopTurn(agent);
  const st = chatState(agent);
  db.prepare('UPDATE agent_chats SET conversation = ?, session_id = ?, started = 0, manager = NULL WHERE agent = ?').run(st.conversation + 1, crypto.randomUUID(), agent);
  ctx.broadcast({ type: 'chat-reset', agent });
}

// At boot: tell agents whose turn was cut by the restart to check where they were.
export function resumeInterrupted() {
  for (const { agent } of db.prepare('SELECT agent FROM agent_chats WHERE running = 1').all()) {
    db.prepare('UPDATE agent_chats SET running = 0 WHERE agent = ?').run(agent);
    if (!getAgent(agent)) continue;
    try {
      sendToAgent(agent, "[Supersept] Ton dernier tour a été interrompu par un redémarrage de Supersept. Regarde où tu en étais (supersept sessions --mine) et termine ce qui restait à faire, sans refaire ce qui est déjà fait.", { internal: true });
    } catch {}
  }
}

export function stopTurn(agent) {
  queues.delete(agent);
  running.get(agent)?.kill('SIGTERM');
}

function chatState(agent) {
  let row = db.prepare('SELECT * FROM agent_chats WHERE agent = ?').get(agent);
  if (!row) {
    db.prepare('INSERT INTO agent_chats (agent, session_id, started, created_at) VALUES (?, ?, 0, ?)').run(agent, crypto.randomUUID(), now());
    row = db.prepare('SELECT * FROM agent_chats WHERE agent = ?').get(agent);
  }
  return row;
}

function systemPrompt(a) {
  return [
    `Tu es « ${a.label} », un agent de Supersept. Tu parles avec ${ctx.userName} dans un chat.`,
    '',
    'Style — très important :',
    '- Réponds très simplement et efficacement : 1 à 3 phrases courtes, en français, comme un collègue.',
    "- Pas de jargon, pas de détails techniques, pas de titres. Une petite liste seulement si c'est vraiment plus clair.",
    "- Ne raconte pas ce que tu vas faire en détail : fais-le, puis dis le résultat en une phrase.",
    '',
    'Comment tu travailles :',
    "- Tu agis uniquement avec la commande `supersept`, lancée via l'outil Bash (aucune autre commande n'est autorisée, et tu ne modifies aucun fichier toi-même) :",
    '    supersept projects                         → projets et leurs sessions',
    '    supersept create-project --name "Nom" [--github owner/repo | --folder ~/chemin]',
    '    supersept start-session --task "mission complète et précise" [--project ID] [--name "Nom court"] [--mode local|worktree] [--agent slug]',
    '    supersept sessions [--project ID] [--mine]',
    '    supersept session ID                       → statut, dernier message, activité',
    '    supersept send ID "message"                → répondre ou donner une consigne à une session',
    '    supersept archive ID',
    '    supersept memory PROJECT_ID   /   supersept set-memory PROJECT_ID --content "…"',
    "- Le travail concret est fait par les sessions que tu lances : donne-leur une mission complète, précise et autonome.",
    "- Avant de créer un projet, regarde les projets existants (supersept projects) et réutilise le plus pertinent. Crée un projet seulement si rien ne convient.",
    "- Ne fais jamais de boucle d'attente. Tu recevras automatiquement un message « [Supersept] » quand une de tes sessions se termine ou attend une réponse. Alors regarde-la (supersept session ID) et fais un point d'une phrase.",
    "- Si une session te pose une question que tu peux trancher sans risque, réponds-lui toi-même (supersept send). Demande à l'utilisateur seulement pour les décisions importantes : supprimer, publier, payer, envoyer quelque chose à l'extérieur.",
    '',
    ...(a.manager ? managerSection(a) : [
      "- Si un message vient d'un autre agent qui coordonne l'équipe (par exemple Nami), traite sa demande comme celle de l'utilisateur et réponds-lui aussi court ; ta réponse lui est transmise automatiquement.",
    ]),
    '',
    `Ton rôle : ${a.description || ''}`,
    '',
    a.prompt || '',
  ].join('\n');
}

function managerSection(a) {
  const team = listAgents().filter((x) => x.slug !== a.slug);
  return [
    '',
    "Tu coordonnes l'équipe d'agents de l'utilisateur :",
    ...(team.length ? team.map((x) => `    - ${x.label} (identifiant ${x.slug}) : ${x.description || 'pas de description'}`) : ["    (aucun autre agent pour l'instant)"]),
    "- Pour chaque mission, choisis l'agent le plus adapté et confie-la-lui : supersept ask-agent IDENTIFIANT \"mission complète\". Sa réponse te revient automatiquement dans un message « [Supersept] … a répondu ». Fais alors une synthèse d'une ou deux phrases à l'utilisateur.",
    "- Tu peux confier plusieurs missions en parallèle à des agents différents.",
    '- Si aucun agent ne convient, lance toi-même une session (supersept start-session).',
    "- Si un besoin revient souvent et qu'aucun agent ne le couvre, propose à l'utilisateur de créer un agent ; crée-le seulement après son accord : supersept create-agent --name \"Nom\" --description \"quand l'utiliser\" --prompt \"instructions\".",
    "- supersept agents liste l'équipe à jour.",
  ];
}

// Each agent gets a home folder with a `supersept` launcher on its PATH.
function agentHome(agent) {
  const dir = path.join(HUB_DIR, 'agent-home', agent);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const launcher = path.join(bin, 'supersept');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  return { dir, bin };
}

// Short, human labels for what the agent does in the background.
// Pull `--flag "value"` out of a supersept command line, for the activity labels.
const flag = (cmd, f) => (new RegExp(`--${f}\\s+("([^"]*)"|'([^']*)'|(\\S+))`).exec(cmd) || []).slice(2).find(Boolean);
function describeTool(name, input = {}) {
  const q = (s) => (s ? ` « ${String(s).slice(0, 70)} »` : '');
  if (name === 'Bash') {
    const cmd = String(input.command || '');
    const verb = (/supersept\s+([\w-]+)/.exec(cmd) || [])[1];
    switch (verb) {
      case 'projects': return { icon: 'folder', label: 'Regarde tes projets' };
      case 'create-project': return { icon: 'folder-plus', label: `Crée le projet${q(flag(cmd, 'name'))}` };
      case 'start-session': return { icon: 'play', label: `Lance une session${q(flag(cmd, 'name') || flag(cmd, 'task'))}` };
      case 'sessions': return { icon: 'layers', label: 'Regarde les sessions' };
      case 'session': return { icon: 'eye', label: 'Vérifie une session' };
      case 'send': return { icon: 'send', label: 'Répond à une session' };
      case 'archive': return { icon: 'archive', label: 'Archive une session' };
      case 'memory': return { icon: 'brain', label: 'Lit la mémoire du projet' };
      case 'set-memory': return { icon: 'brain', label: 'Met à jour la mémoire du projet' };
      case 'agents': return { icon: 'users', label: "Regarde l'équipe" };
      case 'ask-agent': {
        const who = (/ask-agent\s+([\w-]+)/.exec(cmd) || [])[1];
        const label = listAgents().find((x) => x.slug === who)?.label || who;
        return { icon: 'send', label: `Confie une mission à ${label}`, agent: who };
      }
      case 'create-agent': return { icon: 'bot', label: `Crée l'agent${q(flag(cmd, 'name'))}` };
      default: return { icon: 'tool', label: 'Commande Supersept' };
    }
  }
  const t = name;
  switch (t) {
    case 'WebSearch': return { icon: 'search', label: `Cherche sur le web${q(input.query)}` };
    case 'WebFetch': return { icon: 'globe', label: 'Lit une page web' };
    default: return { icon: 'tool', label: t.startsWith('mcp__') ? t.split('__').slice(1).join(' · ') : t };
  }
}

// from: slug of the agent delegating this message (a manager like Nami); its replies go back to it.
export function sendToAgent(agent, text, { internal = false, from = null } = {}) {
  const a = getAgent(agent);
  if (!a) throw new Error('agent introuvable');
  if (from && from === agent) throw new Error('un agent ne peut pas se déléguer une mission à lui-même');
  const sender = from ? getAgent(from) : null;
  chatState(agent);
  // Talking directly to an agent takes it back from its manager; a delegation hands it over.
  if (!internal) db.prepare('UPDATE agent_chats SET manager = ? WHERE agent = ?').run(sender ? sender.slug : null, agent);
  addMessage(agent, internal ? 'system' : 'user', text, sender ? { from: sender.slug, fromLabel: sender.label } : null);
  if (sender) text = `[Message de ${sender.label}, qui coordonne l'équipe] ${text}`;
  const q = queues.get(agent) || [];
  q.push(text);
  queues.set(agent, q);
  if (!running.has(agent)) runNext(agent);
}

function runNext(agent) {
  const q = queues.get(agent);
  if (!q?.length) { queues.delete(agent); return; }
  const text = q.shift();
  const a = getAgent(agent);
  if (!a) return;
  const st = chatState(agent);
  const { dir, bin } = agentHome(agent);
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'Bash(supersept:*)', 'mcp__figma', 'WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep',
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
    '--append-system-prompt', systemPrompt(a)];
  if (a.model) args.push('--model', a.model);
  if (a.effort) args.push('--effort', a.effort);
  args.push(...(st.started ? ['--resume', st.session_id] : ['--session-id', st.session_id]));
  args.push(text);

  const env = ctx.env();
  env.PATH = `${bin}:${env.PATH}`;
  env.SUPERSEPT_URL = `http://127.0.0.1:${ctx.port}`;
  env.SUPERSEPT_AGENT = agent;
  const child = spawn(ctx.claude, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(agent, child);
  db.prepare('UPDATE agent_chats SET running = 1 WHERE agent = ?').run(agent);
  ctx.broadcast({ type: 'chat-busy', agent, busy: true });
  db.prepare('UPDATE agent_chats SET started = 1 WHERE agent = ?').run(agent);

  const tools = new Map(); // tool_use id → activity message
  let reply = null;
  let buf = '';
  let errText = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'assistant') {
        for (const c of ev.message?.content || []) {
          if (c.type === 'text' && c.text.trim()) {
            reply = addMessage(agent, 'assistant', c.text.trim());
          } else if (c.type === 'tool_use') {
            const d = describeTool(c.name, c.input);
            tools.set(c.id, addMessage(agent, 'activity', d.label, { ...d, status: 'running' }));
          }
        }
      } else if (ev.type === 'user') {
        for (const c of ev.message?.content || []) {
          if (c.type !== 'tool_result' || !tools.has(c.tool_use_id)) continue;
          const msg = tools.get(c.tool_use_id);
          const out = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('') : String(c.content || '');
          const meta = { ...msg.meta, status: c.is_error ? 'error' : 'done' };
          // Link the chip to the session/project it created.
          try {
            const j = JSON.parse(out);
            if (j?.id && msg.meta.icon === 'play') meta.workspace = j.id;
            if (j?.id && msg.meta.icon === 'folder-plus') meta.project = j.id;
          } catch {}
          updateMessage(msg, { meta });
        }
      } else if (ev.type === 'result' && ev.is_error && !reply) {
        errText = ev.result || 'erreur';
      }
    }
  });
  child.stderr.on('data', (d) => { errText += d; });
  child.on('close', (code) => {
    running.delete(agent);
    if (!shuttingDown) db.prepare('UPDATE agent_chats SET running = 0 WHERE agent = ?').run(agent);
    // A delegated agent reports each answer back to its manager, who sums it up for the user.
    const manager = db.prepare('SELECT manager FROM agent_chats WHERE agent = ?').get(agent)?.manager;
    if (reply && manager && manager !== agent && getAgent(manager)) {
      try { sendToAgent(manager, `[Supersept] ${a.label} a répondu : ${reply.text.slice(0, 2000)}`, { internal: true }); } catch {}
    }
    for (const m of tools.values()) if (m.meta.status === 'running') updateMessage(m, { meta: { ...m.meta, status: code ? 'error' : 'done' } });
    if (code && !reply && code !== 143 && code !== null) addMessage(agent, 'error', `Je n'ai pas pu répondre (${String(errText).trim().split('\n').pop()?.slice(0, 200) || `code ${code}`}).`);
    ctx.broadcast({ type: 'chat-busy', agent, busy: false });
    runNext(agent);
  });
}

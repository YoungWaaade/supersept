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
// Each conversation runs on its own, so several can work in parallel. Keyed by "agent:conversation".
const running = new Map(); // key → child process
const queues = new Map(); // key → pending turns
const key = (agent, conv) => `${agent}:${conv}`;

let ctx = null; // { claude, port, userName, broadcast, env }
// While the hub shuts down, keep the "running" marks so interrupted turns resume at next boot.
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { shuttingDown = true; });
export function initChat(c) { ctx = c; }

const now = () => Date.now();
const getConv = (agent, n) => db.prepare('SELECT * FROM agent_convs WHERE agent = ? AND conversation = ?').get(agent, n);
function createConv(agent, { manager = null, managerConv = null, title = null } = {}) {
  const n = 1 + (db.prepare(`SELECT MAX(n) AS n FROM (SELECT MAX(conversation) AS n FROM agent_convs WHERE agent = ?
    UNION ALL SELECT MAX(conversation) FROM chat_messages WHERE agent = ?)`).get(agent, agent)?.n ?? -1);
  db.prepare('INSERT INTO agent_convs (agent, conversation, session_id, manager, manager_conv, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(agent, n, crypto.randomUUID(), manager, managerConv, title, now(), now());
  ctx.broadcast({ type: 'chat-convs', agent });
  return n;
}
// The conversation a message goes to when none is given: the last active open one.
function latestConv(agent) {
  const row = db.prepare('SELECT conversation FROM agent_convs WHERE agent = ? AND open = 1 ORDER BY updated_at DESC LIMIT 1').get(agent);
  return row ? row.conversation : createConv(agent);
}

function addMessage(agent, conv, role, text, meta = null) {
  const r = db.prepare('INSERT INTO chat_messages (agent, role, text, meta, at, conversation) VALUES (?, ?, ?, ?, ?, ?)').run(agent, role, text ?? null, meta ? JSON.stringify(meta) : null, now(), conv);
  db.prepare('UPDATE agent_convs SET updated_at = ? WHERE agent = ? AND conversation = ?').run(now(), agent, conv);
  const msg = { id: Number(r.lastInsertRowid), agent, role, text, meta, at: now(), conversation: conv };
  ctx.broadcast({ type: 'chat', agent, conversation: conv, message: msg });
  return msg;
}
function updateMessage(msg, patch) {
  Object.assign(msg, patch);
  db.prepare('UPDATE chat_messages SET text = ?, meta = ? WHERE id = ?').run(msg.text ?? null, msg.meta ? JSON.stringify(msg.meta) : null, msg.id);
  ctx.broadcast({ type: 'chat', agent: msg.agent, conversation: msg.conversation, message: msg });
}

// Whole conversation (the last active one by default), oldest first.
export function chatHistory(agent, conversation = null) {
  const conv = conversation ?? latestConv(agent);
  return db.prepare('SELECT * FROM chat_messages WHERE agent = ? AND conversation = ? ORDER BY id').all(agent, conv)
    .map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));
}

export function conversations(agent) {
  return db.prepare(`SELECT c.conversation, c.title, c.open, c.manager, c.created_at AS started, c.updated_at AS last,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.agent = c.agent AND m.conversation = c.conversation) AS count,
      (SELECT text FROM chat_messages f WHERE f.agent = c.agent AND f.conversation = c.conversation AND f.role = 'user' ORDER BY id LIMIT 1) AS first
    FROM agent_convs c WHERE c.agent = ? ORDER BY c.updated_at DESC`).all(agent)
    .map((c) => ({ ...c, open: !!c.open, busy: running.has(key(agent, c.conversation)) }));
}
export const isBusy = (agent, conv = null) => (conv === null ? [...running.keys()].some((k) => k.startsWith(`${agent}:`)) : running.has(key(agent, conv)));

export function newConversation(agent) { return createConv(agent); }
// Close (hide the tab, the conversation stays in the history) or reopen, rename.
export function updateConversation(agent, conv, { open, title } = {}) {
  if (!getConv(agent, conv)) throw new Error('conversation introuvable');
  if (open !== undefined) db.prepare('UPDATE agent_convs SET open = ? WHERE agent = ? AND conversation = ?').run(open ? 1 : 0, agent, conv);
  if (title !== undefined) db.prepare('UPDATE agent_convs SET title = ? WHERE agent = ? AND conversation = ?').run(String(title).trim().slice(0, 80) || null, agent, conv);
  ctx.broadcast({ type: 'chat-convs', agent });
}

// Kept for older clients: "Nouvelle conversation" now just opens another one next to the others.
export function resetChat(agent) { return createConv(agent); }

// At boot: tell conversations whose turn was cut by the restart to check where they were.
export function resumeInterrupted() {
  for (const { agent, conversation } of db.prepare('SELECT agent, conversation FROM agent_convs WHERE running = 1').all()) {
    db.prepare('UPDATE agent_convs SET running = 0 WHERE agent = ? AND conversation = ?').run(agent, conversation);
    if (!getAgent(agent)) continue;
    try {
      sendToAgent(agent, "[Supersept] Ton dernier tour a été interrompu par un redémarrage de Supersept. Regarde où tu en étais (supersept sessions --mine) et termine ce qui restait à faire, sans refaire ce qui est déjà fait.", { internal: true, conversation });
    } catch {}
  }
}

export function stopTurn(agent, conv = null) {
  for (const k of [...queues.keys(), ...running.keys()]) {
    if (conv === null ? !k.startsWith(`${agent}:`) : k !== key(agent, conv)) continue;
    queues.delete(k);
    running.get(k)?.kill('SIGTERM');
  }
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
    case 'Read': return String(input.file_path || '').includes(`${path.sep}attachments${path.sep}`) ? { icon: 'image', label: "Regarde l'image" } : { icon: 'eye', label: 'Lit un fichier' };
    default: return { icon: 'tool', label: t.startsWith('mcp__') ? t.split('__').slice(1).join(' · ') : t };
  }
}

// A conversation that has messages but no Claude session yet (archived before conversations could be
// continued): give Claude a recap so it picks up where it was.
function recap(agent, conv) {
  const msgs = db.prepare("SELECT role, text FROM chat_messages WHERE agent = ? AND conversation = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 30").all(agent, conv).reverse();
  if (msgs.length < 2) return '';
  const lines = msgs.slice(0, -1).map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Toi'} : ${String(m.text || '').slice(0, 600)}`);
  return `[Supersept] Reprise d'une ancienne conversation. Voici ce qui s'était dit :\n${lines.join('\n')}\n\nNouveau message :\n`;
}

// from: slug of the agent delegating this message (a manager like Nami), fromConv: its conversation;
// replies go back there. conversation: where the message goes (default: the last active one).
// images: [{ path, name }] attached files, read by the agent with the Read tool.
// Returns the conversation number.
export function sendToAgent(agent, text, { internal = false, from = null, fromConv = null, conversation = null, images = [] } = {}) {
  const a = getAgent(agent);
  if (!a) throw new Error('agent introuvable');
  if (from && from === agent) throw new Error('un agent ne peut pas se déléguer une mission à lui-même');
  const sender = from ? getAgent(from) : null;
  let conv = conversation !== null && getConv(agent, conversation) ? conversation : null;
  if (conv === null && sender) {
    // Each conversation of the manager gets its own conversation here, so parallel missions don't mix.
    const row = db.prepare('SELECT conversation FROM agent_convs WHERE agent = ? AND manager = ? AND manager_conv IS ? ORDER BY updated_at DESC LIMIT 1').get(agent, sender.slug, fromConv);
    conv = row ? row.conversation : createConv(agent, { manager: sender.slug, managerConv: fromConv, title: `Mission de ${sender.label}` });
  }
  if (conv === null) conv = latestConv(agent);
  const st = getConv(agent, conv);
  if (!st.open) db.prepare('UPDATE agent_convs SET open = 1 WHERE agent = ? AND conversation = ?').run(agent, conv);
  // Talking directly to an agent takes the conversation back from its manager; a delegation hands it over.
  if (!internal) db.prepare('UPDATE agent_convs SET manager = ?, manager_conv = ? WHERE agent = ? AND conversation = ?').run(sender ? sender.slug : null, sender ? fromConv : null, agent, conv);
  const meta = {};
  if (sender) Object.assign(meta, { from: sender.slug, fromLabel: sender.label });
  if (images.length) meta.images = images.map((i) => ({ path: i.path, name: i.name }));
  addMessage(agent, conv, internal ? 'system' : 'user', text, Object.keys(meta).length ? meta : null);
  if (!st.open) ctx.broadcast({ type: 'chat-convs', agent });
  if (sender) text = `[Message de ${sender.label}, qui coordonne l'équipe] ${text}`;
  if (images.length) text += `\n\n[Images jointes, regarde-les avec l'outil Read : ${images.map((i) => i.path).join(' , ')}]`;
  if (!st.started) text = recap(agent, conv) + text;
  const k = key(agent, conv);
  const q = queues.get(k) || [];
  q.push(text);
  queues.set(k, q);
  if (!running.has(k)) runNext(agent, conv);
  return conv;
}

function runNext(agent, conv) {
  const k = key(agent, conv);
  const q = queues.get(k);
  if (!q?.length) { queues.delete(k); return; }
  const text = q.shift();
  const a = getAgent(agent);
  if (!a) return;
  const st = getConv(agent, conv);
  const { dir, bin } = agentHome(agent);
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'Bash(supersept:*)', 'mcp__figma', 'WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep',
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
    '--add-dir', path.join(HUB_DIR, 'attachments'),
    '--append-system-prompt', systemPrompt(a)];
  if (a.model) args.push('--model', a.model);
  if (a.effort) args.push('--effort', a.effort);
  args.push(...(st.started ? ['--resume', st.session_id] : ['--session-id', st.session_id]));
  args.push(text);

  const env = ctx.env();
  env.PATH = `${bin}:${env.PATH}`;
  env.SUPERSEPT_URL = `http://127.0.0.1:${ctx.port}`;
  env.SUPERSEPT_AGENT = agent;
  env.SUPERSEPT_CONV = String(conv);
  fs.mkdirSync(path.join(HUB_DIR, 'attachments'), { recursive: true });
  const child = spawn(ctx.claude, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(k, child);
  db.prepare('UPDATE agent_convs SET running = 1, started = 1 WHERE agent = ? AND conversation = ?').run(agent, conv);
  ctx.broadcast({ type: 'chat-busy', agent, conversation: conv, busy: true });

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
            reply = addMessage(agent, conv, 'assistant', c.text.trim());
          } else if (c.type === 'tool_use') {
            const d = describeTool(c.name, c.input);
            tools.set(c.id, addMessage(agent, conv, 'activity', d.label, { ...d, status: 'running' }));
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
    running.delete(k);
    if (!shuttingDown) db.prepare('UPDATE agent_convs SET running = 0 WHERE agent = ? AND conversation = ?').run(agent, conv);
    // A delegated conversation reports each answer back to the manager's conversation, which sums it up.
    const { manager, manager_conv: managerConv } = getConv(agent, conv) || {};
    if (reply && manager && manager !== agent && getAgent(manager)) {
      try { sendToAgent(manager, `[Supersept] ${a.label} a répondu : ${reply.text.slice(0, 2000)}`, { internal: true, conversation: managerConv }); } catch {}
    }
    for (const m of tools.values()) if (m.meta.status === 'running') updateMessage(m, { meta: { ...m.meta, status: code ? 'error' : 'done' } });
    if (code && !reply && code !== 143 && code !== null) addMessage(agent, conv, 'error', `Je n'ai pas pu répondre (${String(errText).trim().split('\n').pop()?.slice(0, 200) || `code ${code}`}).`);
    ctx.broadcast({ type: 'chat-busy', agent, conversation: conv, busy: false });
    runNext(agent, conv);
  });
}

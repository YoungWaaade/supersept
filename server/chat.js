// Chat agents: each message runs one headless Claude Code turn (`claude -p`, stream-json) that
// resumes the agent's conversation. Agents act through the Supersept MCP tools (projects,
// sessions…), never by editing files themselves; they speak briefly and work in the background.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, HUB_DIR } from './db.js';
import { getAgent } from './agents.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const running = new Map(); // agent → child process
const queues = new Map(); // agent → pending turns

let ctx = null; // { claude, port, userName, broadcast, env }
export function initChat(c) { ctx = c; }

const now = () => Date.now();
function addMessage(agent, role, text, meta = null) {
  const r = db.prepare('INSERT INTO chat_messages (agent, role, text, meta, at) VALUES (?, ?, ?, ?, ?)').run(agent, role, text ?? null, meta ? JSON.stringify(meta) : null, now());
  const msg = { id: Number(r.lastInsertRowid), agent, role, text, meta, at: now() };
  ctx.broadcast({ type: 'chat', agent, message: msg });
  return msg;
}
function updateMessage(msg, patch) {
  Object.assign(msg, patch);
  db.prepare('UPDATE chat_messages SET text = ?, meta = ? WHERE id = ?').run(msg.text ?? null, msg.meta ? JSON.stringify(msg.meta) : null, msg.id);
  ctx.broadcast({ type: 'chat', agent: msg.agent, message: msg });
}

export function chatHistory(agent) {
  return db.prepare('SELECT * FROM chat_messages WHERE agent = ? ORDER BY id DESC LIMIT 300').all(agent)
    .reverse().map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }));
}
export const isBusy = (agent) => running.has(agent);

export function resetChat(agent) {
  stopTurn(agent);
  db.prepare('DELETE FROM chat_messages WHERE agent = ?').run(agent);
  db.prepare('DELETE FROM agent_chats WHERE agent = ?').run(agent);
  ctx.broadcast({ type: 'chat-reset', agent });
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
    `Ton rôle : ${a.description || ''}`,
    '',
    a.prompt || '',
  ].join('\n');
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

export function sendToAgent(agent, text, { internal = false } = {}) {
  const a = getAgent(agent);
  if (!a) throw new Error('agent introuvable');
  addMessage(agent, internal ? 'system' : 'user', text);
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
    for (const m of tools.values()) if (m.meta.status === 'running') updateMessage(m, { meta: { ...m.meta, status: code ? 'error' : 'done' } });
    if (code && !reply && code !== 143 && code !== null) addMessage(agent, 'error', `Je n'ai pas pu répondre (${String(errText).trim().split('\n').pop()?.slice(0, 200) || `code ${code}`}).`);
    ctx.broadcast({ type: 'chat-busy', agent, busy: false });
    runNext(agent);
  });
}

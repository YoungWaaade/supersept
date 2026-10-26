import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { db, HUB_DIR, HOOKS_DIR, WORKTREES_DIR, MEMORY_DIR, memoryFile } from './db.js';
import * as git from './git.js';
import { listSessions, lastAssistantText } from './history.js';
import { listAgents, getAgent, saveAgent, deleteAgent, isSlug, slugify } from './agents.js';
import { sessions, spawn, spawnShell, killWorkspace, which, homedir, childEnv } from './pty.js';
import { initChat, sendToAgent, chatHistory, isBusy, resetChat, stopTurn, conversations, resumeInterrupted } from './chat.js';
import * as remote from './remote.js';

const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE = which('claude') || 'claude';
const GH = which('gh');
const COLORS = ['#7c8cff', '#4fd1a5', '#f6a04d', '#f06292', '#5ec8f2', '#c792ea', '#e6c84f', '#ff7a6b'];
const now = () => Date.now();
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const uid = () => crypto.randomBytes(5).toString('hex');
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ws';

// ---------- state & live updates ----------
const eventClients = new Set();
const statsCache = new Map();

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of eventClients) c.send(s);
}

const getProject = (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
const getWorkspace = (id) => db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);

function decorate(ws) {
  return {
    ...ws,
    is_worktree: !!ws.is_worktree,
    has_conversation: !!ws.has_conversation,
    archived: !!ws.archived,
    running: !!sessions.get(`${ws.id}:agent`)?.alive,
    run_running: !!sessions.get(`${ws.id}:run`)?.alive,
    stats: statsCache.get(ws.id) || null,
  };
}

function state() {
  const projects = db.prepare('SELECT * FROM projects ORDER BY sort, created_at').all().map((p) => ({ ...p, has_icon: !!projectIcon(p), github: githubRepo(p.path) }));
  const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all().map(decorate);
  return { projects, workspaces, agents: listAgents() };
}

function pushWorkspace(id) {
  const ws = getWorkspace(id);
  if (ws) broadcast({ type: 'workspace', workspace: decorate(ws) });
}

function setStatus(id, status, lastMessage) {
  const ws = getWorkspace(id);
  if (!ws) return;
  if (ws.status !== status) {
    db.prepare('UPDATE workspaces SET status = ?, status_since = ?, updated_at = ? WHERE id = ?').run(status, now(), now(), id);
  }
  if (lastMessage !== undefined) db.prepare('UPDATE workspaces SET last_message = ? WHERE id = ?').run(lastMessage, id);
  pushWorkspace(id);
}

// A (re)started or exited agent is no longer busy, but "to review"/"done" stay meaningful.
function settle(id) {
  const ws = getWorkspace(id);
  if (ws && (ws.status === 'working' || ws.status === 'waiting')) setStatus(id, 'idle');
  else pushWorkspace(id);
}

function logEvent(id, kind, text) {
  db.prepare('INSERT INTO events (workspace_id, kind, text, at) VALUES (?, ?, ?, ?)').run(id, kind, text ?? null, now());
}

async function refreshStats(id) {
  const ws = getWorkspace(id);
  if (!ws || !fs.existsSync(ws.cwd)) return;
  try {
    const s = await git.stats(ws);
    const prev = statsCache.get(id);
    statsCache.set(id, s);
    if (JSON.stringify(prev) !== JSON.stringify(s)) pushWorkspace(id);
  } catch {}
}

// ---------- agent launch ----------
function hookSettings(wsId) {
  const cmd = (event) => ({
    type: 'command',
    command: `curl -s -m 3 -X POST -H 'Content-Type: application/json' --data-binary @- http://${HOST}:${PORT}/api/hook/${wsId}/${event} >/dev/null 2>&1 || true`,
  });
  const hooks = {};
  for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd']) {
    hooks[e] = [{ ...(e === 'PreToolUse' ? { matcher: '*' } : {}), hooks: [cmd(e)] }];
  }
  const file = path.join(HOOKS_DIR, `${wsId}.json`);
  fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2));
  return file;
}

// Sessions outside any project share one memory file.
const SESSIONS_MEMORY_ID = 'sessions';

function systemPrompt(ws, project) {
  const mem = memoryFile(project?.id ?? SESSIONS_MEMORY_ID);
  const content = fs.existsSync(mem) ? fs.readFileSync(mem, 'utf8').trim() : '';
  return [
    project
      ? `Tu tournes dans Supersept, workspace "${ws.name}" du projet "${project.name}" (${project.path}).`
      : `Tu tournes dans Supersept, session libre "${ws.name}" (hors projet) dans ${ws.cwd}.`,
    ws.is_worktree ? `Ce workspace est un git worktree isolé sur la branche "${ws.branch}" (base: ${ws.base_branch}). Ne travaille que dans ${ws.cwd}.` : '',
    `Mémoire persistante ${project ? 'du projet' : 'des sessions libres'} : ${mem}`,
    `Elle est partagée entre toutes les sessions ${project ? 'de ce projet' : 'libres'}. Quand tu apprends quelque chose de durable (décisions, conventions, commandes utiles, état d'avancement, pièges), mets-la à jour de façon concise (puces courtes, sections par thème). N'y mets rien d'éphémère.`,
    content ? `--- Contenu actuel de la mémoire ---\n${content}\n--- fin ---` : 'La mémoire est vide pour l\'instant.',
  ].filter(Boolean).join('\n');
}

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { shuttingDown = true; process.exit(0); });

// Workspaces whose next launch must fork the resumed conversation instead of continuing it.
const forkPending = new Set();

// Claude Code records live sessions in ~/.claude/sessions/<pid>.json. Two processes on one
// conversation would interleave its transcript, so refuse to resume one still open elsewhere.
function externalHolder(sessionId) {
  const dir = path.join(homedir, '.claude', 'sessions');
  const ours = new Set([...sessions.values()].filter((s) => s.alive).map((s) => s.proc.pid));
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch {}
  for (const f of files) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (info.sessionId !== sessionId || ours.has(info.pid)) continue;
      process.kill(info.pid, 0); // throws if the process is gone
      return info.pid;
    } catch {}
  }
  return null;
}

function startAgent(wsId) {
  const ws = getWorkspace(wsId) && { ...getWorkspace(wsId), fork_pending: forkPending.delete(wsId) };
  if (!ws) throw new Error('workspace introuvable');
  const project = ws.project_id ? getProject(ws.project_id) : null;
  if (!fs.existsSync(ws.cwd)) throw new Error(`dossier introuvable : ${ws.cwd}`);
  if (ws.has_conversation) {
    const pid = externalHolder(ws.session_id);
    if (pid) throw Object.assign(new Error(`Cette conversation est encore ouverte dans un autre terminal (process ${pid}, par exemple un onglet iTerm).\r\nFerme-la là-bas : elle reprendra ici automatiquement.`), { busy: true });
  }
  const args = ['--settings', hookSettings(ws.id), '--add-dir', MEMORY_DIR, '--append-system-prompt', systemPrompt(ws, project), '-n', ws.name];
  // A custom agent brings its own instructions/model; the workspace's explicit choices win.
  const agent = ws.agent ? getAgent(ws.agent) : null;
  if (agent) args.push('--agent', agent.slug);
  if (ws.model) args.push('--model', ws.model);
  const effort = ws.effort || agent?.effort;
  if (effort) args.push('--effort', effort);
  const mode = ws.permission_mode || agent?.permissionMode;
  if (mode) args.push('--permission-mode', mode);
  if (ws.has_conversation) {
    args.push('--resume', ws.session_id);
    if (ws.fork_pending) args.push('--fork-session');
  }
  else {
    args.push('--session-id', ws.session_id);
    const first = ws.initial_prompt || agent?.initialPrompt;
    if (first) args.push(first);
  }
  // autostart marks agents to bring back if the hub restarts (update, crash, reboot).
  db.prepare('UPDATE workspaces SET autostart = 1 WHERE id = ?').run(ws.id);
  const s = spawn(`${ws.id}:agent`, CLAUDE, args, ws.cwd, {
    env: { CLAUDE_HUB_WORKSPACE: ws.id },
    onExit: () => {
      if (!shuttingDown) db.prepare('UPDATE workspaces SET autostart = 0 WHERE id = ?').run(ws.id);
      settle(ws.id);
      refreshStats(ws.id);
    },
  });
  watchTrustPrompt(s, ws, project);
  settle(ws.id);
  return s;
}

// Folders the user already trusted in Claude Code (read-only look at ~/.claude.json).
function trustedByUser(dir) {
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(homedir, '.claude.json'), 'utf8')).projects || {};
    return !!projects[real(dir)]?.hasTrustDialogAccepted || !!projects[dir]?.hasTrustDialogAccepted;
  } catch {
    return false;
  }
}

// Claude Code asks "Do you trust this folder?" at launch, and never remembers the answer for the home
// folder, so every hub restart blocked all sessions running in ~. Answer it for the user when trusting is
// already their choice: home folder, a conversation they already worked on there, or a folder/project they
// approved before. A brand-new session in an unknown folder still asks (that's when the check matters);
// if an agent launched it, the agent tells the user.
function trustIsKnown(ws, project) {
  return real(ws.cwd) === real(homedir) || !!ws.has_conversation || trustedByUser(ws.cwd) || (project && trustedByUser(project.path));
}

function watchTrustPrompt(s, ws, project) {
  let seen = '';
  const sub = s.proc.onData((d) => {
    seen = (seen + d).slice(-4000).replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, '');
    if (!/trust\s*this\s*folder/i.test(seen)) return;
    sub.dispose();
    if (trustIsKnown(ws, project)) {
      setTimeout(() => { s.write('\x1b[B'); setTimeout(() => s.write('\r'), 150); }, 300);
      logEvent(ws.id, 'trust', `Dossier ${ws.cwd.replace(homedir, '~')} accepté automatiquement`);
    } else if (ws.owner_agent) {
      const msg = `Claude demande si tu fais confiance au dossier ${ws.cwd.replace(homedir, '~')} : ouvre la session et choisis « Yes, I trust this folder ».`;
      logEvent(ws.id, 'waiting', msg);
      setStatus(ws.id, 'waiting', msg);
      reportToOwner(ws.id, 'attend une réponse', msg);
    }
  });
  setTimeout(() => sub.dispose(), 60000);
}

// Project "run" command (dev server, etc.) in its own PTY, like Superset's Run button.
function startRun(wsId) {
  const ws = getWorkspace(wsId);
  const project = ws?.project_id && getProject(ws.project_id);
  if (!project?.run_command) throw new Error("aucune commande d'exécution définie pour ce projet");
  const s = spawn(`${wsId}:run`, process.env.SHELL || '/bin/zsh', ['-lc', project.run_command], ws.cwd, { onExit: () => pushWorkspace(wsId) });
  pushWorkspace(wsId);
  return s;
}

// Claude Code stores a conversation once it has a first message: that's when to resume it.
const transcriptExists = (cwd, sessionId) => fs.existsSync(path.join(homedir, '.claude', 'projects', real(cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`));

// A secondary tab running a custom agent in the workspace folder, with its own conversation.
function startAgentTab(wsId, tabId) {
  const ws = getWorkspace(wsId);
  const tab = db.prepare('SELECT * FROM agent_tabs WHERE id = ? AND workspace_id = ?').get(tabId, wsId);
  if (!ws || !tab) throw new Error('onglet introuvable');
  const agent = getAgent(tab.agent);
  if (!agent) throw new Error(`l'agent « ${tab.agent} » n'existe plus`);
  const project = ws.project_id ? getProject(ws.project_id) : null;
  const args = ['--agent', agent.slug, '--add-dir', MEMORY_DIR, '--append-system-prompt', systemPrompt(ws, project), '-n', `${agent.label} · ${ws.name}`];
  if (agent.effort) args.push('--effort', agent.effort);
  if (agent.permissionMode) args.push('--permission-mode', agent.permissionMode);
  if (transcriptExists(ws.cwd, tab.session_id)) {
    const pid = externalHolder(tab.session_id);
    if (pid) throw Object.assign(new Error(`Cette conversation est encore ouverte ailleurs (process ${pid}).`), { busy: true });
    args.push('--resume', tab.session_id);
  } else {
    args.push('--session-id', tab.session_id);
    if (agent.initialPrompt) args.push(agent.initialPrompt);
  }
  const s = spawn(`${wsId}:ag-${tabId}`, CLAUDE, args, ws.cwd, { env: { CLAUDE_HUB_WORKSPACE: ws.id } });
  watchTrustPrompt(s, { ...ws, owner_agent: null, has_conversation: transcriptExists(ws.cwd, tab.session_id) ? 1 : ws.has_conversation }, project);
  return s;
}

function ensureSession(key) {
  const existing = sessions.get(key);
  if (existing) return existing;
  const [wsId, kind] = key.split(':');
  const ws = getWorkspace(wsId);
  if (!ws) return null;
  if (kind === 'agent') return startAgent(wsId);
  if (/^shell(-[\w]+)?$/.test(kind)) return spawnShell(key, ws.cwd);
  if (kind === 'run') return startRun(wsId);
  if (kind?.startsWith('ag-')) return startAgentTab(wsId, kind.slice(3));
  return null;
}

// ---------- http ----------
const app = express();
app.use(express.json({ limit: '5mb' }));

const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://supersept.localhost:${PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
const allowedOrigin = (o) => !o || ORIGINS.has(o);
const dist = path.join(ROOT, 'dist');
// This server can spawn processes: refuse cross-site requests, and anyone off this Mac without the phone token.
function trusted(req) {
  if (remote.isLoopback(req.socket.remoteAddress)) return allowedOrigin(req.headers.origin);
  const o = req.headers.origin;
  return remote.enabled() && remote.authed(req) && (!o || o === `http://${req.headers.host}`);
}
app.use((req, res, next) => {
  const local = remote.isLoopback(req.socket.remoteAddress);
  if (!local && remote.enabled() && req.path === '/pair') {
    if (!remote.tokenOk(req.query.token)) return res.status(403).type('html').send(remote.PAIR_PAGE);
    // Serve the app right here: "Add to Home Screen" keeps this URL, so the home screen app pairs itself on launch.
    res.setHeader('Set-Cookie', remote.cookie());
    return fs.existsSync(dist) ? res.sendFile(path.join(dist, 'index.html')) : res.redirect('/');
  }
  if (!trusted(req)) {
    if (local) return res.status(403).json({ error: 'origin refusée' });
    return res.status(remote.enabled() ? 401 : 403).type('html').send(remote.PAIR_PAGE);
  }
  // Hooks and pairing settings only make sense from the Mac itself.
  if (!local && /^\/api\/(hook|remote)\b/.test(req.path)) return res.status(403).json({ error: 'réservé au Mac' });
  next();
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

app.get('/api/state', (req, res) => res.json(state()));

let fullName = null;
try { fullName = execFileSync('id', ['-F'], { encoding: 'utf8' }).trim(); } catch {}
app.get('/api/me', (req, res) => res.json({ name: fullName || os.userInfo().username, home: homedir, claude: CLAUDE, hubDir: HUB_DIR, port: PORT }));

// ---------- phone access ----------
const remoteSockets = new Set();
const dropRemote = () => { for (const s of remoteSockets) s.destroy(); };
// Re-bind once the response is out: 0.0.0.0 when phone access is on, 127.0.0.1 otherwise.
const relisten = () => { server.close(); server.listen(PORT, remote.listenHost()); };
app.get('/api/remote', wrap(async (req, res) => res.json(await remote.status(PORT))));
app.post('/api/remote', wrap(async (req, res) => {
  remote.setEnabled(!!req.body.enabled);
  if (!remote.enabled()) dropRemote();
  res.on('finish', relisten);
  res.json(await remote.status(PORT));
}));
app.post('/api/remote/rotate', wrap(async (req, res) => {
  remote.rotate();
  dropRemote();
  res.json(await remote.status(PORT));
}));

// ---------- GitHub: list repos, clone a repo into a new project, link a project ----------
const SESSIONS_ROOT = path.join(homedir, 'claude sessions');
const ghRun = (args, opts = {}) => new Promise((ok, ko) => execFile(GH || 'gh', args, { maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60 * 1000, ...opts },
  (e, out, err) => (e ? ko(new Error((err || e.message).trim().split('\n').pop() || 'gh a échoué')) : ok(out))));
const REPO_RE = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const parseRepo = (s) => { const m = REPO_RE.exec(String(s || '').trim()); return m ? `${m[1]}/${m[2]}` : null; };

// Sessions started in a new folder would get an empty Claude auto-memory; share the home one instead.
function linkClaudeMemory(dir) {
  const enc = dir.replace(/[^a-zA-Z0-9]/g, '-');
  const pdir = path.join(homedir, '.claude', 'projects', enc);
  const home = path.join(homedir, '.claude', 'projects', homedir.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  if (enc.length > 200 || !fs.existsSync(home)) return;
  fs.mkdirSync(pdir, { recursive: true });
  if (!fs.existsSync(path.join(pdir, 'memory'))) fs.symlinkSync(path.relative(pdir, home), path.join(pdir, 'memory'));
}

function insertProject(dir, name) {
  const count = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
  const id = uid();
  db.prepare('INSERT INTO projects (id, name, path, color, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, dir, COLORS[count % COLORS.length], count, now());
  const mem = memoryFile(id);
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, `# Mémoire — ${name}\n\n`);
  broadcast({ type: 'reload' });
  return getProject(id);
}

app.get('/api/github/owners', wrap(async (req, res) => {
  const [me, orgs] = await Promise.all([ghRun(['api', 'user', '--jq', '.login']), ghRun(['api', 'user/orgs', '--jq', '.[].login']).catch(() => '')]);
  res.json([me.trim(), ...orgs.split('\n').filter(Boolean)]);
}));

app.get('/api/github/repos', wrap(async (req, res) => {
  const args = ['repo', 'list'];
  if (req.query.owner && /^[\w.-]+$/.test(req.query.owner)) args.push(String(req.query.owner));
  args.push('--limit', '200', '--json', 'name,nameWithOwner,description,isPrivate,updatedAt,url');
  const repos = JSON.parse(await ghRun(args));
  const cloned = new Set(db.prepare('SELECT path FROM projects').all().map((r) => githubRepo(r.path)).filter(Boolean));
  res.json(repos.map((r) => ({ ...r, cloned: cloned.has(r.nameWithOwner) })));
}));

app.post('/api/projects/clone', wrap(async (req, res) => {
  const repo = parseRepo(req.body.repo);
  if (!repo) throw new Error('repo invalide : utilise owner/nom ou une URL github.com');
  const name = String(req.body.name || '').trim() || repo.split('/')[1];
  let dest = String(req.body.dest || '').trim().replace(/^~(?=\/|$)/, homedir) || path.join(SESSIONS_ROOT, repo.split('/')[1]);
  dest = path.resolve(dest);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`le dossier existe déjà et n'est pas vide : ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await ghRun(['repo', 'clone', repo, dest]);
  dest = fs.realpathSync(dest); // Claude names its folder after the real path (/tmp → /private/tmp)
  linkClaudeMemory(dest);
  res.json(insertProject(dest, name));
}));

// Empty project folder → clone the repo into it. Existing git repo without origin → add it.
app.post('/api/projects/:id/github', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new Error('projet introuvable');
  const repo = parseRepo(req.body.repo);
  if (!repo) throw new Error('repo invalide : utilise owner/nom ou une URL github.com');
  if (p.path === homedir) throw new Error("ce projet pointe sur ton dossier perso : donne-lui d'abord son propre dossier");
  const entries = fs.existsSync(p.path) ? fs.readdirSync(p.path).filter((f) => f !== '.DS_Store') : [];
  if (!entries.length) {
    fs.rmSync(path.join(p.path, '.DS_Store'), { force: true });
    await ghRun(['repo', 'clone', repo, p.path]);
  } else if (await git.isRepo(p.path)) {
    if (githubRepo(p.path)) throw new Error(`ce projet est déjà relié à ${githubRepo(p.path)}`);
    await git.git(p.path, 'remote', 'add', 'origin', `https://github.com/${repo}.git`);
  } else {
    throw new Error("le dossier du projet n'est ni vide ni un repo git : impossible d'y cloner sans écraser tes fichiers");
  }
  iconCache.delete(p.id);
  broadcast({ type: 'reload' });
  res.json({ ...getProject(p.id), github: githubRepo(p.path) });
}));

app.post('/api/projects/empty', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || /[/\\:]/.test(name)) throw new Error('nom de projet invalide');
  const dir = path.join(SESSIONS_ROOT, name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`le dossier existe déjà et n'est pas vide : ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  linkClaudeMemory(fs.realpathSync(dir));
  res.json(insertProject(fs.realpathSync(dir), name));
}));

app.post('/api/projects', wrap(async (req, res) => {
  let p = String(req.body.path || '').trim().replace(/^~(?=\/|$)/, homedir);
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('dossier introuvable');
  p = fs.realpathSync(p);
  if (!req.body.force && db.prepare('SELECT 1 FROM projects WHERE path = ?').get(p)) throw new Error('ce dossier a déjà un projet');
  const count = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
  const id = uid();
  db.prepare('INSERT INTO projects (id, name, path, color, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.body.name?.trim() || path.basename(p), p, COLORS[count % COLORS.length], count, now());
  const mem = memoryFile(id);
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, `# Mémoire — ${req.body.name?.trim() || path.basename(p)}\n\n`);
  broadcast({ type: 'reload' });
  res.json(getProject(id));
}));

// Sidebar order of projects: body.ids is the full list in display order.
app.post('/api/projects/order', wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const set = db.prepare('UPDATE projects SET sort = ? WHERE id = ?');
  db.exec('BEGIN');
  try { ids.forEach((id, i) => set.run(i, String(id))); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  broadcast({ type: 'reload' });
  res.json({ ok: true });
}));

app.patch('/api/projects/:id', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new Error('projet introuvable');
  const run = req.body.run_command === undefined ? p.run_command : String(req.body.run_command).trim() || null;
  // Changing the folder only affects new workspaces; existing ones keep their own cwd (needed to resume).
  let dir = p.path;
  if (req.body.path !== undefined) {
    dir = String(req.body.path).trim().replace(/^~(?=\/|$)/, homedir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('dossier introuvable');
    dir = fs.realpathSync(dir);
    iconCache.delete(p.id);
  }
  db.prepare('UPDATE projects SET name = ?, color = ?, run_command = ?, path = ? WHERE id = ?').run(req.body.name ?? p.name, req.body.color ?? p.color, run, dir, p.id);
  broadcast({ type: 'reload' });
  res.json(getProject(p.id));
}));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  for (const ws of db.prepare('SELECT id FROM workspaces WHERE project_id = ?').all(req.params.id)) killWorkspace(ws.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  broadcast({ type: 'reload' });
  res.json({ ok: true });
}));

app.get('/api/projects/:id/info', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new Error('projet introuvable');
  const repo = await git.isRepo(p.path);
  res.json({ repo, branch: repo ? await git.currentBranch(p.path) : null, branches: repo ? await git.branches(p.path) : [] });
}));

// Project thumbnail like Superset's: the repo's own favicon/logo when it has one.
const ICON_CANDIDATES = ['public/favicon.svg', 'public/favicon.png', 'public/icon.png', 'public/logo.png', 'public/favicon.ico', 'app/icon.png', 'app/icon.svg', 'app/favicon.ico', 'src/app/icon.png', 'src/app/favicon.ico', 'static/favicon.png', 'favicon.ico', 'favicon.png', 'icon.png', 'logo.png', 'assets/icon.png'];
const iconCache = new Map();
function projectIcon(p) {
  if (!iconCache.has(p.id)) iconCache.set(p.id, ICON_CANDIDATES.map((c) => path.join(p.path, c)).find((f) => fs.existsSync(f)) || null);
  return iconCache.get(p.id);
}
function githubRepo(dir) {
  try {
    let gitDir = path.join(dir, '.git');
    if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(dir, fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim(), '..', '..');
    const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    const gh = m && /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(m[1]);
    return gh ? `${gh[1]}/${gh[2]}` : null;
  } catch {
    return null;
  }
}

app.get('/api/projects/:id/icon', (req, res) => {
  const p = getProject(req.params.id);
  const icon = p && projectIcon(p);
  if (!icon) return res.status(404).end();
  res.set('Cache-Control', 'max-age=3600').sendFile(icon);
});

app.param('id', (req, res, next, id) => (/^[\w-]+$/.test(id) ? next() : res.status(400).json({ error: 'id invalide' })));

app.get('/api/projects/:id/branches', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new Error('projet introuvable');
  res.json(await git.branchList(p.path));
}));

// GitHub issues / PRs through the user's own `gh` login.
app.get('/api/projects/:id/github/:kind', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new Error('projet introuvable');
  const kind = req.params.kind === 'prs' ? 'pr' : 'issue';
  const fields = kind === 'pr' ? 'number,title,url,headRefName,author,updatedAt' : 'number,title,url,body,author,updatedAt';
  const args = [kind, 'list', '--limit', '50', '--json', fields];
  if (req.query.q) args.push('--search', String(req.query.q));
  const out = await new Promise((ok, ko) => execFile(GH || 'gh', args, { cwd: p.path, env: { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin' }, maxBuffer: 10 * 1024 * 1024 },
    (e, stdout, stderr) => (e ? ko(new Error(stderr.trim().split('\n')[0] || 'gh a échoué')) : ok(stdout))));
  res.json(JSON.parse(out || '[]'));
}));

app.get('/api/projects/:id/memory', (req, res) => {
  const f = memoryFile(req.params.id);
  res.json({ path: f, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' });
});

app.put('/api/projects/:id/memory', (req, res) => {
  fs.writeFileSync(memoryFile(req.params.id), String(req.body.content ?? ''));
  res.json({ ok: true });
});

app.get('/api/projects/:id/history', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new Error('projet introuvable');
  const known = new Set(db.prepare('SELECT session_id FROM workspaces').all().map((r) => r.session_id));
  const wsDirs = new Set(db.prepare('SELECT cwd FROM workspaces WHERE project_id = ?').all(p.id).map((r) => real(r.cwd)));
  const inProject = (cwd) => cwd === p.path || cwd.startsWith(p.path + '/') || wsDirs.has(real(cwd));
  res.json(listSessions().filter((s) => inProject(s.cwd)).map((s) => ({ ...s, imported: known.has(s.sessionId) })));
}));

// Every Claude Code session on this machine, tagged with the project it belongs to.
app.get('/api/history', (req, res) => {
  const projects = db.prepare('SELECT id, path FROM projects').all();
  const byCwd = new Map(db.prepare('SELECT cwd, project_id FROM workspaces').all().map((r) => [real(r.cwd), r.project_id]));
  const known = new Set(db.prepare('SELECT session_id FROM workspaces').all().map((r) => r.session_id));
  res.json(listSessions().map((s) => ({
    ...s,
    projectId: byCwd.get(real(s.cwd)) ?? projects.find((p) => s.cwd === p.path || s.cwd.startsWith(p.path + '/'))?.id ?? null,
    imported: known.has(s.sessionId),
  })));
});

// Directories with Claude Code history that aren't projects yet.
app.get('/api/discover', (req, res) => {
  const known = new Set(db.prepare('SELECT path FROM projects').all().map((r) => r.path));
  const byCwd = new Map();
  for (const s of listSessions()) {
    if (!fs.existsSync(s.cwd) || real(s.cwd).startsWith(real(WORKTREES_DIR) + '/')) continue;
    const e = byCwd.get(s.cwd) || { path: s.cwd, sessions: 0, updatedAt: 0 };
    e.sessions++;
    e.updatedAt = Math.max(e.updatedAt, s.updatedAt);
    byCwd.set(s.cwd, e);
  }
  res.json([...byCwd.values()].filter((e) => !known.has(e.path)).sort((a, b) => b.updatedAt - a.updatedAt));
});

app.post('/api/pick-folder', (req, res) => {
  execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choisir un projet")'], (err, out) => {
    res.json({ path: err ? null : out.trim().replace(/\/$/, '') });
  });
});

app.post('/api/workspaces', wrap(async (req, res) => {
  const p = req.body.projectId ? getProject(req.body.projectId) : null;
  if (req.body.projectId && !p) throw new Error('projet introuvable');
  const prompt = req.body.prompt?.trim() || '';
  // Like Superset: a workspace is named after its task, the main checkout is just "local".
  const name = String(req.body.name || '').trim() || prompt.replace(/\s+/g, ' ').slice(0, 80) || (req.body.worktree ? 'nouvel espace' : p ? 'local' : 'session');
  const id = uid();
  let cwd = p?.path ?? homedir, branch = null, base = null, isWorktree = 0;
  if (!p && req.body.cwd) {
    cwd = String(req.body.cwd).replace(/^~(?=\/|$)/, homedir);
    if (!fs.existsSync(cwd)) throw new Error('dossier introuvable');
  }
  if (req.body.worktree && p) {
    if (!(await git.isRepo(p.path))) throw new Error("le projet n'est pas un repo git");
    base = req.body.baseBranch || (await git.currentBranch(p.path));
    if (req.body.prBranch) {
      const head = String(req.body.prBranch).replace(/[^\w./-]/g, '');
      await git.git(p.path, 'fetch', 'origin', head);
      base = `origin/${head}`;
    }
    const existing = new Set(await git.branches(p.path));
    const wanted = slug(req.body.branch || name.split(' ').slice(0, 6).join(' '));
    branch = wanted;
    for (let i = 2; existing.has(branch); i++) branch = `${wanted}-${i}`;
    cwd = path.join(WORKTREES_DIR, slug(p.name), branch);
    await git.addWorktree(p.path, cwd, branch, base);
    isWorktree = 1;
  } else {
    branch = await git.currentBranch(cwd);
  }
  if (req.body.forkFrom) {
    const src = getWorkspace(req.body.forkFrom);
    if (!src?.has_conversation) throw new Error('rien à forker : la session n\'a pas encore de conversation');
    req.body.resumeSessionId = src.session_id;
  }
  const sessionId = req.body.resumeSessionId || crypto.randomUUID();
  if (req.body.resumeSessionId) {
    const s = listSessions().find((x) => x.sessionId === req.body.resumeSessionId);
    if (s?.cwd && fs.existsSync(s.cwd)) cwd = s.cwd; // resume needs the original cwd
  }
  db.prepare(`INSERT INTO workspaces (id, project_id, name, cwd, branch, base_branch, is_worktree, session_id, has_conversation, initial_prompt, status, status_since, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)`)
    .run(id, p?.id ?? null, name, cwd, branch, base, isWorktree, sessionId, req.body.resumeSessionId ? 1 : 0, prompt || null, now(), now(), now());
  const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'plan'];
  if (req.body.agent && getAgent(req.body.agent)) db.prepare('UPDATE workspaces SET agent = ? WHERE id = ?').run(req.body.agent, id);
  // Sessions launched by a chat agent report back to it when they finish.
  const owner = req.body.ownerAgent || req.get('X-Supersept-Agent');
  if (owner && getAgent(owner)) db.prepare('UPDATE workspaces SET owner_agent = ? WHERE id = ?').run(owner, id);
  db.prepare('UPDATE workspaces SET model = ?, effort = ?, permission_mode = ? WHERE id = ?').run(
    MODELS.includes(req.body.model) ? req.body.model : null,
    EFFORTS.includes(req.body.effort) ? req.body.effort : null,
    MODES.includes(req.body.permissionMode) ? req.body.permissionMode : null,
    id,
  );
  logEvent(id, 'created', name);
  if (req.body.forkFrom) forkPending.add(id);
  if (req.body.start !== false) startAgent(id);
  refreshStats(id);
  res.json(decorate(getWorkspace(id)));
}));

app.patch('/api/workspaces/:id', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  const status = req.body.status && ['idle', 'review', 'done'].includes(req.body.status) ? req.body.status : null;
  const base = typeof req.body.base_branch === 'string' && /^[\w./-]+$/.test(req.body.base_branch) ? req.body.base_branch : ws.base_branch;
  // Moving between projects (null = "Sessions"). Only grouping and memory change; the folder stays.
  let projectId = ws.project_id;
  if (req.body.project_id !== undefined) {
    if (req.body.project_id !== null && !getProject(req.body.project_id)) throw new Error('projet introuvable');
    projectId = req.body.project_id;
  }
  db.prepare('UPDATE workspaces SET name = ?, archived = ?, base_branch = ?, project_id = ?, updated_at = ? WHERE id = ?')
    .run(req.body.name ?? ws.name, req.body.archived === undefined ? ws.archived : req.body.archived ? 1 : 0, base, projectId, now(), ws.id);
  if (projectId !== ws.project_id) logEvent(ws.id, 'moved', getProject(projectId)?.name ?? 'Sessions');
  if (base !== ws.base_branch) refreshStats(ws.id);
  if (req.body.archived) {
    db.prepare('UPDATE workspaces SET autostart = 0 WHERE id = ?').run(ws.id);
    killWorkspace(ws.id);
  }
  if (status) setStatus(ws.id, status);
  else pushWorkspace(ws.id);
  res.json(decorate(getWorkspace(ws.id)));
}));

app.delete('/api/workspaces/:id', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  killWorkspace(ws.id);
  if (ws.is_worktree && req.query.removeWorktree === '1') await git.removeWorktree(ws.cwd);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
  fs.rmSync(path.join(HOOKS_DIR, `${ws.id}.json`), { force: true });
  statsCache.delete(ws.id);
  broadcast({ type: 'reload' });
  res.json({ ok: true });
}));

app.post('/api/workspaces/:id/restart', wrap(async (req, res) => {
  startAgent(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/workspaces/:id/run', wrap(async (req, res) => {
  startRun(req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/workspaces/:id/run', wrap(async (req, res) => {
  const s = sessions.get(`${req.params.id}:run`);
  if (s?.alive) req.query.force === '1' ? s.proc.kill('SIGKILL') : s.kill();
  setTimeout(() => pushWorkspace(req.params.id), 200);
  res.json({ ok: true });
}));

// PR for the workspace branch, through the user's gh login.
app.get('/api/workspaces/:id/pr', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws?.branch) return res.json(null);
  const fields = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,comments,reviews,headRefName,baseRefName';
  execFile(GH || 'gh', ['pr', 'view', ws.branch, '--json', fields], { cwd: ws.cwd, maxBuffer: 10 * 1024 * 1024 }, (e, out) => {
    if (e) return res.json(null);
    try { res.json(JSON.parse(out)); } catch { res.json(null); }
  });
}));

app.post('/api/workspaces/:id/stop', wrap(async (req, res) => {
  sessions.get(`${req.params.id}:agent`)?.kill();
  res.json({ ok: true });
}));

app.get('/api/workspaces/:id/diff', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  refreshStats(ws.id);
  res.json(await git.diff(ws));
}));

app.get('/api/workspaces/:id/changes', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  res.json({ base: ws.base_branch || (await git.currentBranch(ws.cwd)), files: await git.changedFiles(ws), commits: await git.commits(ws) });
}));

app.get('/api/workspaces/:id/commit/:sha', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  res.json({ patch: await git.showCommit(ws, req.params.sha) });
}));

app.get('/api/workspaces/:id/files', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  res.json(await git.listFiles(ws.cwd));
}));

app.get('/api/workspaces/:id/file', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  const root = real(ws.cwd);
  const file = real(path.resolve(root, String(req.query.path || '')));
  if (!file.startsWith(root + '/')) throw new Error('chemin hors du workspace');
  const st = fs.statSync(file);
  if (st.size > 1_000_000) return res.json({ binary: true, size: st.size });
  const buf = fs.readFileSync(file);
  res.json(buf.includes(0) ? { binary: true, size: st.size } : { content: buf.toString() });
}));

app.get('/api/agents', (req, res) => res.json(listAgents()));

app.get('/api/agents/:slug/chat', (req, res) => {
  const conv = req.query.conversation !== undefined ? Number(req.query.conversation) : null;
  res.json({ messages: chatHistory(req.params.slug, Number.isFinite(conv) ? conv : null), busy: isBusy(req.params.slug) });
});
app.get('/api/agents/:slug/conversations', (req, res) => res.json(conversations(req.params.slug)));
app.post('/api/agents/:slug/chat', wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw new Error('message vide');
  const from = req.get('X-Supersept-Agent') || null;
  sendToAgent(req.params.slug, text, { from: from && getAgent(from) ? from : null });
  res.json({ ok: true });
}));
app.post('/api/agents/:slug/chat/stop', (req, res) => { stopTurn(req.params.slug); res.json({ ok: true }); });
app.post('/api/agents/:slug/chat/reset', (req, res) => { resetChat(req.params.slug); res.json({ ok: true }); });

// Type a message into a session's Claude (used by chat agents to answer or follow up).
app.post('/api/workspaces/:id/send', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('session introuvable');
  const text = String(req.body.text || '').trim();
  if (!text) throw new Error('message vide');
  let s = sessions.get(`${ws.id}:agent`);
  const fresh = !s?.alive;
  if (fresh) s = startAgent(ws.id);
  // Paste the text (bracketed paste, so Claude Code treats it as one block), then press Enter
  // separately: sent in the same burst, the Enter would be swallowed by the paste and never submit.
  // A freshly (re)started Claude needs a few seconds before it accepts input.
  // Claude Code refuses to send invisible characters (French non-breaking spaces before « : », zero-width
  // chars…) and asks to "review and press Enter": normalise them, and confirm if it still asks.
  const clean = text.replace(/\r?\n/g, ' ').replace(/[\u00a0\u202f\u2007\u2009\u200a]/g, ' ').replace(/[\u200b-\u200d\u2060\ufeff]/g, '');
  setTimeout(() => {
    s.write(`\x1b[200~${clean}\x1b[201~`);
    setTimeout(() => {
      const mark = s.buffer.length;
      s.write('\r');
      setTimeout(() => {
        if (/press\s*Enter\s*to\s*send/i.test(s.buffer.slice(mark).replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, ''))) s.write('\r');
      }, 1200);
    }, 400);
  }, fresh ? 6000 : 50);
  logEvent(ws.id, 'prompt', text);
  res.json({ ok: true, demarree: fresh });
}));

app.put('/api/agents/:slug', wrap(async (req, res) => {
  const slug = req.body.slug ? slugify(req.body.slug) : req.params.slug;
  if (!isSlug(req.params.slug) && req.params.slug !== 'new') throw new Error('agent invalide');
  if (slug !== req.params.slug && getAgent(slug)) throw new Error(`un agent « ${slug} » existe déjà`);
  const a = saveAgent(slug, req.body);
  if (req.params.slug !== 'new' && slug !== req.params.slug) {
    deleteAgent(req.params.slug);
    db.prepare('UPDATE workspaces SET agent = ? WHERE agent = ?').run(slug, req.params.slug);
    db.prepare('UPDATE agent_tabs SET agent = ? WHERE agent = ?').run(slug, req.params.slug);
    // Keep its chat and the sessions it launched attached to the renamed agent.
    db.prepare('UPDATE workspaces SET owner_agent = ? WHERE owner_agent = ?').run(slug, req.params.slug);
    db.prepare('UPDATE agent_chats SET manager = ? WHERE manager = ?').run(slug, req.params.slug);
    if (!db.prepare('SELECT 1 FROM agent_chats WHERE agent = ?').get(slug)) {
      db.prepare('UPDATE agent_chats SET agent = ? WHERE agent = ?').run(slug, req.params.slug);
      db.prepare('UPDATE chat_messages SET agent = ? WHERE agent = ?').run(slug, req.params.slug);
    }
  }
  broadcast({ type: 'reload' });
  res.json(a);
}));

app.delete('/api/agents/:slug', wrap(async (req, res) => {
  deleteAgent(req.params.slug);
  broadcast({ type: 'reload' });
  res.json({ ok: true });
}));

app.post('/api/workspaces/:id/agent-tabs', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  if (!getAgent(req.body.agent)) throw new Error('agent introuvable');
  const id = uid();
  db.prepare('INSERT INTO agent_tabs (id, workspace_id, agent, session_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, ws.id, req.body.agent, crypto.randomUUID(), now());
  res.json({ id, pane: `ag-${id}` });
}));

app.get('/api/workspaces/:id/agent-tabs', (req, res) => {
  res.json(db.prepare('SELECT id, agent FROM agent_tabs WHERE workspace_id = ?').all(req.params.id));
});

app.delete('/api/workspaces/:id/agent-tabs/:tab', wrap(async (req, res) => {
  sessions.get(`${req.params.id}:ag-${req.params.tab}`)?.kill();
  sessions.delete(`${req.params.id}:ag-${req.params.tab}`);
  db.prepare('DELETE FROM agent_tabs WHERE id = ? AND workspace_id = ?').run(req.params.tab, req.params.id);
  res.json({ ok: true });
}));

app.get('/api/prompts', (req, res) => {
  const rows = db.prepare("SELECT text, MAX(at) AS at FROM events WHERE kind = 'prompt' AND text <> '' GROUP BY text ORDER BY at DESC LIMIT 100").all();
  res.json(rows);
});

// Attachments are saved on disk and handed to Claude as @file references.
app.post('/api/attachments', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  const name = path.basename(String(req.query.name || 'fichier')).replace(/[^\w.\- ]/g, '_') || 'fichier';
  const dir = path.join(HUB_DIR, 'attachments', uid());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, req.body);
  res.json({ path: file, name, size: req.body.length });
});

app.get('/api/workspaces/:id/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM events WHERE workspace_id = ? ORDER BY at DESC LIMIT 100').all(req.params.id));
});

const OPENERS = {
  vscode: ['open', ['-a', 'Visual Studio Code']],
  cursor: ['open', ['-a', 'Cursor']],
  finder: ['open', []],
  terminal: ['open', ['-a', 'Terminal']],
  iterm: ['open', ['-a', 'iTerm']],
};
app.post('/api/projects/:id/open', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  const o = OPENERS[req.body.app];
  if (!p || !o) throw new Error('cible inconnue');
  await new Promise((ok, ko) => execFile(o[0], [...o[1], p.path], (e) => (e ? ko(new Error(`impossible d'ouvrir avec ${req.body.app}`)) : ok())));
  res.json({ ok: true });
}));

app.post('/api/workspaces/:id/open', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  const o = OPENERS[req.body.app];
  if (!ws || !o) throw new Error('cible inconnue');
  await new Promise((ok, ko) => execFile(o[0], [...o[1], ws.cwd], (e) => (e ? ko(new Error(`impossible d'ouvrir avec ${req.body.app}`)) : ok())));
  res.json({ ok: true });
}));

// Tell the chat agent that launched a session what happened, so it can follow up on its own.
function reportToOwner(wsId, what, text) {
  const ws = getWorkspace(wsId);
  if (!ws?.owner_agent || !getAgent(ws.owner_agent)) return;
  const msg = `[Supersept] La session « ${ws.name} » (id ${ws.id}) ${what}.${text ? ` Son dernier message : ${String(text).slice(0, 1500)}` : ''}`;
  try { sendToAgent(ws.owner_agent, msg, { internal: true }); } catch {}
}

// Claude Code hooks (called by curl from inside the agent, no Origin header).
app.post('/api/hook/:id/:event', (req, res) => {
  res.json({});
  const { id, event } = req.params;
  const ws = getWorkspace(id);
  if (!ws) return;
  const body = req.body || {};
  if (body.session_id && body.session_id !== ws.session_id) {
    // /clear or a fork created a new conversation: follow it so resume picks up the latest.
    db.prepare('UPDATE workspaces SET session_id = ? WHERE id = ?').run(body.session_id, id);
  }
  switch (event) {
    case 'UserPromptSubmit':
      db.prepare('UPDATE workspaces SET has_conversation = 1 WHERE id = ?').run(id);
      logEvent(id, 'prompt', String(body.prompt || '').slice(0, 2000));
      setStatus(id, 'working', null);
      break;
    case 'PreToolUse':
      if (ws.status !== 'working') setStatus(id, 'working');
      break;
    case 'Notification': {
      const msg = String(body.message || 'En attente de ton input');
      if (/idle|waiting for your input/i.test(msg) && ws.status === 'review') break;
      logEvent(id, 'waiting', msg);
      setStatus(id, 'waiting', msg);
      reportToOwner(id, 'attend une réponse', msg);
      break;
    }
    case 'Stop': {
      const text = body.last_assistant_message || (body.transcript_path && lastAssistantText(body.transcript_path)) || null;
      logEvent(id, 'stop', text?.slice(0, 4000));
      setStatus(id, 'review', text?.slice(0, 600) ?? null);
      refreshStats(id);
      reportToOwner(id, 'vient de terminer', text);
      break;
    }
    case 'SessionStart':
      pushWorkspace(id);
      break;
    case 'SessionEnd':
      settle(id);
      break;
  }
});

app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').json({
  name: 'Supersept', short_name: 'Supersept', display: 'standalone', background_color: '#151110', theme_color: '#151110',
  start_url: remote.isLoopback(req.socket.remoteAddress) ? '/' : remote.pairPath(),
  icons: [{ src: '/icon.png', sizes: '400x400', type: 'image/png' }],
}));

if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------- websockets ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('connection', (sock) => {
  if (remote.isLoopback(sock.remoteAddress)) return;
  remoteSockets.add(sock);
  sock.on('close', () => remoteSockets.delete(sock));
});

server.on('upgrade', (req, socket, head) => {
  if (!trusted(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws/events') {
    eventClients.add(ws);
    ws.on('close', () => eventClients.delete(ws));
    return;
  }
  if (url.pathname !== '/ws/term') return ws.close();
  const key = url.searchParams.get('key') || '';
  let s;
  try {
    s = ensureSession(key);
  } catch (e) {
    // Replace the screen (the client retries every 2s) instead of stacking error lines.
    ws.send(JSON.stringify({ type: 'reset', alive: false, data: `\x1b[${e.busy ? '33' : '31'}m${e.message}\x1b[0m\r\n` }));
    return ws.close();
  }
  if (!s) return ws.close();
  const attach = (sess) => {
    s = sess;
    s.clients.add(ws);
    ws.send(JSON.stringify({ type: 'reset', data: s.buffer, alive: s.alive }));
  };
  attach(s);
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'input') s.write(m.data);
    else if (m.type === 'resize') s.resize(m.cols, m.rows);
    else if (m.type === 'kill') { s.kill(); sessions.delete(key); }
    else if (m.type === 'restart') {
      s.clients.delete(ws);
      s.kill();
      sessions.delete(key);
      try { attach(ensureSession(key)); } catch (e) { ws.send(JSON.stringify({ type: 'output', data: `\x1b[31m${e.message}\x1b[0m\r\n` })); }
    }
  });
  ws.on('close', () => s.clients.delete(ws));
});

// Keep diff counters fresh for live agents.
setInterval(() => {
  for (const [key, s] of sessions) if (s.alive && key.endsWith(':agent')) refreshStats(key.split(':')[0]);
}, 15000);

// On boot nothing is running anymore: reset stale "working" states.
db.prepare("UPDATE workspaces SET status = 'idle' WHERE status IN ('working', 'waiting')").run();
for (const { id } of db.prepare('SELECT id FROM workspaces WHERE archived = 0').all()) refreshStats(id);

initChat({ claude: CLAUDE, port: PORT, userName: fullName || os.userInfo().username, broadcast, env: () => childEnv({}) });

server.listen(PORT, remote.listenHost(), () => {
  console.log(`Supersept → http://localhost:${PORT}${remote.enabled() ? ' (accès téléphone activé)' : ''}`);
  // Chat agents whose turn was cut by the restart pick up where they were.
  resumeInterrupted();
  // Bring back the agents that were running when the hub stopped.
  for (const { id, name } of db.prepare('SELECT id, name FROM workspaces WHERE autostart = 1 AND archived = 0').all()) {
    try { startAgent(id); console.log(`  reprise : ${name}`); }
    catch (e) { console.log(`  non repris (${name}) : ${e.message.split('\r')[0]}`); }
  }
});

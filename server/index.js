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
import { sessions, spawn, spawnShell, killWorkspace, which, homedir } from './pty.js';

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
  const projects = db.prepare('SELECT * FROM projects ORDER BY sort, created_at').all().map((p) => ({ ...p, has_icon: !!projectIcon(p) }));
  const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all().map(decorate);
  return { projects, workspaces };
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
      ? `Tu tournes dans Claude Hub, workspace "${ws.name}" du projet "${project.name}" (${project.path}).`
      : `Tu tournes dans Claude Hub, session libre "${ws.name}" (hors projet) dans ${ws.cwd}.`,
    ws.is_worktree ? `Ce workspace est un git worktree isolé sur la branche "${ws.branch}" (base: ${ws.base_branch}). Ne travaille que dans ${ws.cwd}.` : '',
    `Mémoire persistante ${project ? 'du projet' : 'des sessions libres'} : ${mem}`,
    `Elle est partagée entre toutes les sessions ${project ? 'de ce projet' : 'libres'}. Quand tu apprends quelque chose de durable (décisions, conventions, commandes utiles, état d'avancement, pièges), mets-la à jour de façon concise (puces courtes, sections par thème). N'y mets rien d'éphémère.`,
    content ? `--- Contenu actuel de la mémoire ---\n${content}\n--- fin ---` : 'La mémoire est vide pour l\'instant.',
  ].filter(Boolean).join('\n');
}

// Workspaces whose next launch must fork the resumed conversation instead of continuing it.
const forkPending = new Set();

function startAgent(wsId) {
  const ws = getWorkspace(wsId) && { ...getWorkspace(wsId), fork_pending: forkPending.delete(wsId) };
  if (!ws) throw new Error('workspace introuvable');
  const project = ws.project_id ? getProject(ws.project_id) : null;
  if (!fs.existsSync(ws.cwd)) throw new Error(`dossier introuvable : ${ws.cwd}`);
  const args = ['--settings', hookSettings(ws.id), '--add-dir', MEMORY_DIR, '--append-system-prompt', systemPrompt(ws, project), '-n', ws.name];
  if (ws.model) args.push('--model', ws.model);
  if (ws.effort) args.push('--effort', ws.effort);
  if (ws.permission_mode) args.push('--permission-mode', ws.permission_mode);
  if (ws.has_conversation) {
    args.push('--resume', ws.session_id);
    if (ws.fork_pending) args.push('--fork-session');
  }
  else {
    args.push('--session-id', ws.session_id);
    if (ws.initial_prompt) args.push(ws.initial_prompt);
  }
  const s = spawn(`${ws.id}:agent`, CLAUDE, args, ws.cwd, {
    env: { CLAUDE_HUB_WORKSPACE: ws.id },
    onExit: () => {
      settle(ws.id);
      refreshStats(ws.id);
    },
  });
  settle(ws.id);
  return s;
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

function ensureSession(key) {
  const existing = sessions.get(key);
  if (existing) return existing;
  const [wsId, kind] = key.split(':');
  const ws = getWorkspace(wsId);
  if (!ws) return null;
  if (kind === 'agent') return startAgent(wsId);
  if (/^shell(-[\w]+)?$/.test(kind)) return spawnShell(key, ws.cwd);
  if (kind === 'run') return startRun(wsId);
  return null;
}

// ---------- http ----------
const app = express();
app.use(express.json({ limit: '5mb' }));

const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
const allowedOrigin = (o) => !o || ORIGINS.has(o);
app.use((req, res, next) => {
  // Refuse cross-site requests: this server can spawn processes.
  if (!allowedOrigin(req.headers.origin)) return res.status(403).json({ error: 'origin refusée' });
  next();
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

app.get('/api/state', (req, res) => res.json(state()));

let fullName = null;
try { fullName = execFileSync('id', ['-F'], { encoding: 'utf8' }).trim(); } catch {}
app.get('/api/me', (req, res) => res.json({ name: fullName || os.userInfo().username, home: homedir, claude: CLAUDE, hubDir: HUB_DIR, port: PORT }));

app.post('/api/projects', wrap(async (req, res) => {
  let p = String(req.body.path || '').trim().replace(/^~(?=\/|$)/, homedir);
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('dossier introuvable');
  p = fs.realpathSync(p);
  if (db.prepare('SELECT 1 FROM projects WHERE path = ?').get(p)) throw new Error('projet déjà ajouté');
  const count = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
  const id = uid();
  db.prepare('INSERT INTO projects (id, name, path, color, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.body.name?.trim() || path.basename(p), p, COLORS[count % COLORS.length], count, now());
  const mem = memoryFile(id);
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, `# Mémoire — ${req.body.name?.trim() || path.basename(p)}\n\n`);
  broadcast({ type: 'reload' });
  res.json(getProject(id));
}));

app.patch('/api/projects/:id', wrap(async (req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new Error('projet introuvable');
  const run = req.body.run_command === undefined ? p.run_command : String(req.body.run_command).trim() || null;
  db.prepare('UPDATE projects SET name = ?, color = ?, run_command = ? WHERE id = ?').run(req.body.name ?? p.name, req.body.color ?? p.color, run, p.id);
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
  db.prepare('UPDATE workspaces SET model = ?, effort = ?, permission_mode = ? WHERE id = ?').run(
    MODELS.includes(req.body.model) ? req.body.model : null,
    EFFORTS.includes(req.body.effort) ? req.body.effort : null,
    MODES.includes(req.body.permissionMode) ? req.body.permissionMode : null,
    id,
  );
  logEvent(id, 'created', name);
  if (req.body.forkFrom) forkPending.add(id);
  startAgent(id);
  refreshStats(id);
  res.json(decorate(getWorkspace(id)));
}));

app.patch('/api/workspaces/:id', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  const status = req.body.status && ['idle', 'review', 'done'].includes(req.body.status) ? req.body.status : null;
  const base = typeof req.body.base_branch === 'string' && /^[\w./-]+$/.test(req.body.base_branch) ? req.body.base_branch : ws.base_branch;
  db.prepare('UPDATE workspaces SET name = ?, archived = ?, base_branch = ?, updated_at = ? WHERE id = ?')
    .run(req.body.name ?? ws.name, req.body.archived === undefined ? ws.archived : req.body.archived ? 1 : 0, base, now(), ws.id);
  if (base !== ws.base_branch) refreshStats(ws.id);
  if (req.body.archived) killWorkspace(ws.id);
  if (status) setStatus(ws.id, status);
  else pushWorkspace(ws.id);
  res.json(decorate(getWorkspace(ws.id)));
}));

app.delete('/api/workspaces/:id', wrap(async (req, res) => {
  const ws = getWorkspace(req.params.id);
  if (!ws) throw new Error('workspace introuvable');
  killWorkspace(ws.id);
  if (ws.is_worktree && req.query.removeWorktree === '1') {
    const p = getProject(ws.project_id);
    await git.removeWorktree(p.path, ws.cwd);
  }
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
      break;
    }
    case 'Stop': {
      const text = body.last_assistant_message || (body.transcript_path && lastAssistantText(body.transcript_path)) || null;
      logEvent(id, 'stop', text?.slice(0, 4000));
      setStatus(id, 'review', text?.slice(0, 600) ?? null);
      refreshStats(id);
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

const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------- websockets ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!allowedOrigin(req.headers.origin)) return socket.destroy();
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
    ws.send(JSON.stringify({ type: 'output', data: `\x1b[31m${e.message}\x1b[0m\r\n` }));
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

server.listen(PORT, HOST, () => console.log(`Claude Hub → http://localhost:${PORT}`));

// What a chat agent can do in Supersept. Shared by the `supersept` CLI (used through Bash) and the
// MCP server (blocked by some enterprise policies, kept for when it's allowed).
const BASE = () => process.env.SUPERSEPT_URL || 'http://127.0.0.1:4317';
const AGENT = () => process.env.SUPERSEPT_AGENT || null;

async function call(method, path, body) {
  const res = await fetch(BASE() + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Supersept-Agent': AGENT() || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const STATUS = { working: 'en cours', waiting: 'attend une réponse', review: 'terminée, à revoir', idle: 'inactive', done: 'terminée' };
const brief = (w, projects = []) => ({
  id: w.id,
  nom: w.name,
  projet: projects.find((p) => p.id === w.project_id)?.name ?? null,
  statut: STATUS[w.status] || w.status,
  tourne: w.running,
  dernier_message: w.last_message ? w.last_message.slice(0, 600) : null,
  branche: w.branch,
  dossier: w.cwd,
  modifications: w.stats ? `+${w.stats.add} −${w.stats.del} (${w.stats.files} fichiers)` : null,
  lancee_par_toi: !!AGENT() && w.owner_agent === AGENT(),
});

export async function listProjects() {
  const s = await call('GET', '/api/state');
  return s.projects.map((p) => ({
    id: p.id, nom: p.name, dossier: p.path, github: p.github,
    sessions: s.workspaces.filter((w) => w.project_id === p.id && !w.archived).map((w) => ({ id: w.id, nom: w.name, statut: STATUS[w.status] || w.status })),
  }));
}

export async function createProject({ name, github, folder }) {
  if (!name) throw new Error('il faut un nom (--name)');
  const p = github ? await call('POST', '/api/projects/clone', { repo: github, name })
    : folder ? await call('POST', '/api/projects', { path: folder, name, force: true })
    : await call('POST', '/api/projects/empty', { name });
  return { id: p.id, nom: p.name, dossier: p.path };
}

export async function startSession({ project, task, name, mode, agent }) {
  if (!task) throw new Error('il faut une mission (--task)');
  const w = await call('POST', '/api/workspaces', { projectId: project || null, prompt: task, name, worktree: mode === 'worktree', agent, ownerAgent: AGENT() });
  return { id: w.id, nom: w.name, dossier: w.cwd, branche: w.branch, statut: 'lancée' };
}

export async function listSessions({ project, mine }) {
  const s = await call('GET', '/api/state');
  return s.workspaces.filter((w) => !w.archived && (!project || w.project_id === project) && (!mine || w.owner_agent === AGENT())).map((w) => brief(w, s.projects));
}

export async function getSession(id) {
  const s = await call('GET', '/api/state');
  const w = s.workspaces.find((x) => x.id === id);
  if (!w) throw new Error('session introuvable');
  const events = await call('GET', `/api/workspaces/${id}/events`);
  return { ...brief(w, s.projects), activite: events.slice(0, 8).map((e) => ({ type: e.kind, texte: (e.text || '').slice(0, 400) })) };
}

export const sendToSession = (id, message) => call('POST', `/api/workspaces/${id}/send`, { text: message });
export async function archiveSession(id) { await call('PATCH', `/api/workspaces/${id}`, { archived: true }); return { id, statut: 'archivée' }; }
export const readMemory = async (project) => (await call('GET', `/api/projects/${project}/memory`)).content;
export async function writeMemory(project, content) { await call('PUT', `/api/projects/${project}/memory`, { content }); return { projet: project, statut: 'mémoire mise à jour' }; }

export async function listAgents() {
  const list = await call('GET', '/api/agents');
  return list.map((a) => ({ id: a.slug, nom: a.label, role: a.description, coordinatrice: !!a.manager }));
}
export async function askAgent(slug, mission) {
  if (!slug || !mission) throw new Error("il faut l'identifiant de l'agent et la mission");
  await call('POST', `/api/agents/${slug}/chat`, { text: mission });
  return { agent: slug, statut: 'mission confiée — sa réponse te sera transmise automatiquement' };
}
export async function createAgent({ name, description, prompt, model, avatar }) {
  const a = await call('PUT', '/api/agents/new', { label: name, slug: name, description, prompt, model, avatar });
  return { id: a.slug, nom: a.label, statut: 'agent créé' };
}

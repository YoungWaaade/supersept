import { useEffect, useMemo, useRef, useState } from 'react';
import { LuSearch, LuPlay, LuBrain } from 'react-icons/lu';
import { api, ago } from '../api.js';
import { ProjectThumbnail } from './ui.jsx';

export function PageHeader({ title, children }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      <div className="page-head-actions">{children}</div>
    </header>
  );
}

// Markdown memory file shared by every agent of a project (or by free sessions).
export function MemoryEditor({ memoryId }) {
  const [mem, setMem] = useState(null);
  const [saved, setSaved] = useState(true);
  const timer = useRef(null);
  const load = () => api.get(`/api/projects/${memoryId}/memory`).then((m) => { setMem(m); setSaved(true); });
  useEffect(() => { load(); }, [memoryId]);
  // Agents edit this file too: pick up their changes when coming back to the window.
  useEffect(() => {
    const onFocus = () => saved && load();
    addEventListener('focus', onFocus);
    return () => removeEventListener('focus', onFocus);
  }, [saved, memoryId]);

  const change = (content) => {
    setMem({ ...mem, content });
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api.put(`/api/projects/${memoryId}/memory`, { content }).then(() => setSaved(true)), 600);
  };
  if (!mem) return null;
  return (
    <div className="memory">
      <div className="memory-head">
        <p>Injectée au lancement de chaque agent. Claude la complète lui-même quand il apprend quelque chose de durable.</p>
        <span className="memory-path">{saved ? 'Enregistré' : 'Modification…'} · {mem.path.replace(/^\/Users\/[^/]+/, '~')}</span>
      </div>
      <textarea spellCheck={false} value={mem.content} onChange={(e) => change(e.target.value)} placeholder="# Conventions, décisions, commandes utiles…" />
    </div>
  );
}

export function MemoryPage({ projects, initial }) {
  const [sel, setSel] = useState(initial || projects[0]?.id || 'sessions');
  return (
    <div className="page">
      <PageHeader title="Mémoire" />
      <div className="split-page">
        <nav className="split-nav">
          {projects.map((p) => (
            <button key={p.id} className={`split-nav-item ${sel === p.id ? 'active' : ''}`} onClick={() => setSel(p.id)}>
              <ProjectThumbnail project={p} /> <span className="fade-r">{p.name}</span>
            </button>
          ))}
          <button className={`split-nav-item ${sel === 'sessions' ? 'active' : ''}`} onClick={() => setSel('sessions')}>
            <span className="thumb"><LuBrain size={10} /></span> <span>Sessions libres</span>
          </button>
        </nav>
        <div className="split-body"><MemoryEditor key={sel} memoryId={sel} /></div>
      </div>
    </div>
  );
}

export function SessionList({ sessions, projectsById, onResume, highlight }) {
  const [busy, setBusy] = useState(null);
  return (
    <div className="list">
      {sessions.map((s) => (
        <div key={s.sessionId} className={`list-row ${highlight === s.sessionId ? 'highlight' : ''}`}>
          <span className="list-title fade-r" title={s.firstPrompt || s.title}>{s.title}</span>
          {projectsById && <span className="list-meta">{projectsById[s.projectId]?.name ?? s.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>}
          <span className="list-meta">{s.prompts} msg</span>
          <span className="list-time">{ago(s.updatedAt)}</span>
          {s.imported ? <span className="tag">dans le hub</span> : (
            <button className="btn-ghost" disabled={busy === s.sessionId} onClick={async () => { setBusy(s.sessionId); try { await onResume(s); } finally { setBusy(null); } }}>
              <LuPlay size={12} /> Reprendre
            </button>
          )}
        </div>
      ))}
      {!sessions.length && <p className="empty-note">Aucune conversation trouvée.</p>}
    </div>
  );
}

export async function resumeSession(s, go) {
  try {
    const w = await api.post('/api/workspaces', { projectId: s.projectId, name: s.title.slice(0, 80), resumeSessionId: s.sessionId });
    go({ kind: 'ws', id: w.id });
  } catch (e) {
    alert(e.message);
  }
}

export function HistoryPage({ projects, go, routeId }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [project, setProject] = useState(routeId?.startsWith('p-') ? routeId.slice(2) : 'all');
  const highlight = routeId?.startsWith('p-') ? null : routeId;
  useEffect(() => { api.get('/api/history').then(setList); }, []);
  const projectsById = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects]);
  const filtered = (list || []).filter((s) =>
    (project === 'all' || (project === 'none' ? !s.projectId : s.projectId === project)) &&
    (!q || (s.title + ' ' + (s.firstPrompt || '')).toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="page">
      <PageHeader title="Historique">
        <div className="search-field">
          <LuSearch size={14} />
          <input placeholder={`Rechercher dans ${list?.length ?? '…'} conversations`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </PageHeader>
      <div className="chips">
        <button className={`chip ${project === 'all' ? 'on' : ''}`} onClick={() => setProject('all')}>Tout</button>
        {projects.map((p) => (
          <button key={p.id} className={`chip ${project === p.id ? 'on' : ''}`} onClick={() => setProject(p.id)}><ProjectThumbnail project={p} size={14} /> {p.name}</button>
        ))}
        <button className={`chip ${project === 'none' ? 'on' : ''}`} onClick={() => setProject('none')}>Hors projet</button>
      </div>
      <div className="page-scroll">
        {list ? <SessionList sessions={filtered} projectsById={projectsById} highlight={highlight} onResume={(s) => resumeSession(s, go)} /> : <p className="empty-note">Lecture de ~/.claude/projects…</p>}
      </div>
    </div>
  );
}

export function SettingsPage({ me }) {
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  const rows = me ? [
    ['Serveur', `http://localhost:${me.port}`],
    ['Claude Code', me.claude],
    ['Données', `${me.hubDir} — base, mémoires, worktrees`],
    ['Historique lu depuis', `${me.home}/.claude/projects`],
  ] : [];
  return (
    <div className="page">
      <PageHeader title="Réglages" />
      <div className="page-scroll">
        <div className="settings">
          <section>
            <h2>Notifications</h2>
            <div className="settings-row">
              <span>Prévenir quand un agent a fini ou attend une réponse</span>
              {perm === 'granted' ? <span className="tag green">activées</span> : (
                <button className="btn-ghost" onClick={() => Notification.requestPermission().then(setPerm)} disabled={perm === 'unsupported'}>Activer</button>
              )}
            </div>
          </section>
          <RemoteAccess />
          <section>
            <h2>Emplacements</h2>
            {rows.map(([k, v]) => (
              <div key={k} className="settings-row"><span>{k}</span><code>{v}</code></div>
            ))}
          </section>
          <section>
            <h2>Raccourcis</h2>
            {[['⌘N', 'Nouvel espace de travail'], ['⌘K', 'Rechercher'], ['⌘T', 'Nouveau terminal'], ['⌘D', 'Diviser le panneau'], ['⌘⌥1…9', 'Aller à l\'espace n'], ['⇧↵', 'Nouvelle ligne dans Claude']].map(([k, v]) => (
              <div key={k} className="settings-row"><span>{v}</span><kbd className="sb-kbd visible">{k}</kbd></div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

// Phone access: the Mac listens on the network, a QR code carries the pairing token.
function RemoteAccess() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/remote').then(setSt).catch(() => {}); }, []);
  const call = async (url, body) => {
    setBusy(true);
    try { setSt(await api.post(url, body)); } catch (e) { alert(e.message); }
    setBusy(false);
  };
  if (!st) return null;
  return (
    <section>
      <h2>Accès depuis le téléphone</h2>
      <div className="settings-row">
        <span>Piloter tes sessions depuis ton iPhone (Safari, puis « Sur l'écran d'accueil »)</span>
        {st.enabled
          ? <button className="btn-ghost" disabled={busy} onClick={() => call('/api/remote', { enabled: false })}>Désactiver</button>
          : <button className="btn-ghost" disabled={busy} onClick={() => call('/api/remote', { enabled: true })}>Activer</button>}
      </div>
      {st.enabled && (
        <>
          {!st.addresses.length && <p className="remote-hint">Aucun réseau détecté. Connecte le Mac au Wi‑Fi ou à Tailscale.</p>}
          <div className="remote-qrs">
            {st.addresses.map((a) => (
              <div key={a.address} className="remote-qr">
                <div className="remote-qr-img" dangerouslySetInnerHTML={{ __html: a.qr }} />
                <strong>{a.label}</strong>
                <code>{a.address}</code>
                <span className="muted">{a.tailscale ? 'Marche partout, chiffré' : 'Même Wi‑Fi uniquement'}</span>
              </div>
            ))}
          </div>
          <p className="remote-hint">
            Scanne avec l'appareil photo de l'iPhone, puis dans Safari : Partager → Sur l'écran d'accueil.
            Ce QR code donne un accès complet à tes sessions, ne le partage pas.
            {!st.addresses.some((a) => a.tailscale) && <> Pour y accéder hors de chez toi, installe <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> sur le Mac et l'iPhone.</>}
          </p>
          <div className="settings-row">
            <span>Déconnecter tous les téléphones reliés (nouveau QR code)</span>
            <button className="btn-ghost" disabled={busy} onClick={() => confirm('Déconnecter tous les téléphones ?') && call('/api/remote/rotate')}>Révoquer</button>
          </div>
        </>
      )}
    </section>
  );
}

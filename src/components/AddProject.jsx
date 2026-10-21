import { useEffect, useMemo, useState } from 'react';
import { VscFolderOpened, VscGithubAlt, VscNewFolder } from 'react-icons/vsc';
import { HiMiniPlus } from 'react-icons/hi2';
import { LuSearch, LuLock, LuCheck, LuLoaderCircle } from 'react-icons/lu';
import { api, ago } from '../api.js';
import { Modal } from './ui.jsx';

const TABS = [
  ['folder', 'Ouvrir un dossier', VscFolderOpened],
  ['github', 'Cloner depuis GitHub', VscGithubAlt],
  ['empty', 'Nouveau projet vide', VscNewFolder],
];
const REPO_RE = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

// tab: which way to add a project. linkProject: link an existing project to a GitHub repo instead.
export default function AddProject({ tab: initialTab = 'folder', linkProject = null, onClose, onAdded }) {
  const [tab, setTab] = useState(linkProject ? 'github' : initialTab);
  const title = linkProject ? `Relier « ${linkProject.name} » à GitHub` : 'Ajouter un projet';
  return (
    <Modal title={title} onClose={onClose} className="modal-wide">
      {!linkProject && (
        <div className="ap-tabs">
          {TABS.map(([k, label, Icon]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon size={14} /> {label}</button>
          ))}
        </div>
      )}
      {tab === 'folder' && <FolderTab onClose={onClose} onAdded={onAdded} />}
      {tab === 'github' && <GitHubTab linkProject={linkProject} onClose={onClose} onAdded={onAdded} />}
      {tab === 'empty' && <EmptyTab onClose={onClose} onAdded={onAdded} />}
    </Modal>
  );
}

function FolderTab({ onClose, onAdded }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [found, setFound] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/api/discover').then(setFound); }, []);
  const add = async (p = path, n = name) => {
    setError(null);
    try { onAdded(await api.post('/api/projects', { path: p, name: n })); } catch (e) { setError(e.message); }
  };
  const pick = async () => {
    const r = await api.post('/api/pick-folder');
    if (r.path) { setPath(r.path); setName(r.path.split('/').pop()); }
  };
  return (
    <>
      <form className="form" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label>Dossier
          <div className="input-row">
            <input autoFocus className="mono" placeholder="~/mon-projet" value={path} onChange={(e) => { setPath(e.target.value); setName(e.target.value.replace(/\/$/, '').split('/').pop()); }} />
            <button type="button" className="btn-ghost" onClick={pick}><VscFolderOpened size={14} /> Parcourir</button>
          </div>
        </label>
        <label>Nom
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <div className="error-bar">{error}</div>}
        <div className="form-foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn-primary" disabled={!path}>Ajouter</button>
        </div>
      </form>
      {found.length > 0 && (
        <div className="discover">
          <div className="discover-title">Dossiers avec un historique Claude Code</div>
          {found.slice(0, 12).map((f) => (
            <div key={f.path} className="list-row clickable" onClick={() => add(f.path, f.path.split('/').pop())}>
              <span className="list-title mono fade-r">{f.path.replace(/^\/Users\/[^/]+/, '~')}</span>
              <span className="list-meta">{f.sessions} sessions</span>
              <span className="list-time">{ago(f.updatedAt)}</span>
              <HiMiniPlus size={14} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function GitHubTab({ linkProject, onClose, onAdded }) {
  const [owners, setOwners] = useState([]);
  const [owner, setOwner] = useState('');
  const [repos, setRepos] = useState(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null); // owner/name
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/github/owners').then((o) => { setOwners(o); setOwner(o[0] || ''); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!owner) return;
    setRepos(null);
    api.get(`/api/github/repos?owner=${encodeURIComponent(owner)}`).then(setRepos).catch((e) => { setRepos([]); setError(e.message); });
  }, [owner]);

  // Pasting a URL or owner/name selects it directly, even outside the list.
  const typed = REPO_RE.exec(q.trim());
  const list = useMemo(() => (repos || []).filter((r) => !q || r.nameWithOwner.toLowerCase().includes(q.toLowerCase()) || (r.description || '').toLowerCase().includes(q.toLowerCase())), [repos, q]);
  const chosen = sel || (typed ? `${typed[1]}/${typed[2]}` : null);
  const repoName = chosen?.split('/')[1] || '';
  useEffect(() => { if (!linkProject) setDest(repoName ? `~/claude sessions/${repoName}` : ''); }, [repoName]);

  const submit = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const p = linkProject
        ? await api.post(`/api/projects/${linkProject.id}/github`, { repo: chosen })
        : await api.post('/api/projects/clone', { repo: chosen, dest });
      onAdded(p);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="form gh">
      {linkProject && (
        <p className="gh-note">
          Si le dossier du projet est vide, le repo y est cloné. Si c'est déjà un repo git sans remote, GitHub devient son <span className="mono">origin</span>.
          Dossier : <span className="mono">{linkProject.path.replace(/^\/Users\/[^/]+/, '~')}</span>
        </p>
      )}
      <div className="gh-bar">
        <select value={owner} onChange={(e) => { setOwner(e.target.value); setSel(null); }} disabled={!owners.length}>
          {owners.map((o) => <option key={o}>{o}</option>)}
        </select>
        <div className="gh-search">
          <LuSearch size={14} />
          <input autoFocus placeholder="Rechercher, ou coller owner/repo ou une URL GitHub" value={q} onChange={(e) => { setQ(e.target.value); setSel(null); }} />
        </div>
      </div>
      <div className="gh-list">
        {!repos && !error && <div className="empty-note"><LuLoaderCircle size={12} className="spin" /> Chargement de tes repos via gh…</div>}
        {typed && !list.some((r) => r.nameWithOwner === chosen) && (
          <button className={`gh-row ${chosen ? 'selected' : ''}`} onClick={() => setSel(`${typed[1]}/${typed[2]}`)}>
            <VscGithubAlt size={16} /> <span className="gh-main"><span className="gh-name">{typed[1]}/{typed[2]}</span><span className="gh-desc">Repo collé</span></span>
          </button>
        )}
        {list.map((r) => (
          <button key={r.nameWithOwner} className={`gh-row ${sel === r.nameWithOwner ? 'selected' : ''}`} onClick={() => setSel(r.nameWithOwner)} disabled={r.cloned && !linkProject}>
            <VscGithubAlt size={16} />
            <span className="gh-main">
              <span className="gh-name">{r.name} {r.isPrivate && <LuLock size={11} className="gh-lock" />}</span>
              {r.description && <span className="gh-desc fade-r">{r.description}</span>}
            </span>
            {r.cloned ? <span className="tag">déjà un projet</span> : <span className="list-time">{ago(Date.parse(r.updatedAt))}</span>}
            {sel === r.nameWithOwner && <LuCheck size={14} />}
          </button>
        ))}
        {repos && !list.length && !typed && <div className="empty-note">Aucun repo ne correspond.</div>}
      </div>
      {!linkProject && (
        <label>Cloner dans
          <input className="mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="~/claude sessions/mon-repo" />
        </label>
      )}
      {error && <div className="error-bar">{error}</div>}
      <div className="form-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Annuler</button>
        <button className="btn-primary" disabled={!chosen || busy} onClick={submit}>
          {busy ? <><LuLoaderCircle size={12} className="spin" /> {linkProject ? 'Liaison…' : 'Clonage…'}</> : linkProject ? `Relier à ${chosen || '…'}` : `Cloner ${chosen || ''}`}
        </button>
      </div>
    </div>
  );
}

function EmptyTab({ onClose, onAdded }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try { onAdded(await api.post('/api/projects/empty', { name })); } catch (err) { setError(err.message); }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>Nom du projet
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Brand refresh" />
      </label>
      <p className="gh-note">Crée <span className="mono">~/claude sessions/{name || '…'}</span>. Tu pourras le relier à GitHub plus tard (clic droit sur le projet).</p>
      {error && <div className="error-bar">{error}</div>}
      <div className="form-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Annuler</button>
        <button className="btn-primary" disabled={!name.trim()}>Créer</button>
      </div>
    </form>
  );
}

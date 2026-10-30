import { useEffect, useRef, useState } from 'react';
import { LuChevronLeft, LuPlus, LuArrowUp, LuZap, LuGitBranch } from 'react-icons/lu';
import { api, ago, STATUS } from '../api.js';
import Terminal, { sendInput, restartTerminal } from './Terminal.jsx';
import { StatusIndicator, ProjectThumbnail, AsciiSpinner, DiffStats } from './ui.jsx';

// Keys Claude Code needs that the iOS keyboard doesn't have.
const KEYS = [
  ['Esc', '\x1b'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['⏎', '\r'], ['⇧Tab', '\x1b[Z'], ['Tab', '\t'],
  ['1', '1'], ['2', '2'], ['3', '3'], ['^C', '\x03'],
];

// iOS lays the keyboard over the page: size the app to what is actually visible.
function useVisualViewport() {
  const [vv, setVv] = useState(() => ({ height: innerHeight, top: 0 }));
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const on = () => setVv({ height: v.height, top: v.offsetTop });
    v.addEventListener('resize', on);
    v.addEventListener('scroll', on);
    return () => { v.removeEventListener('resize', on); v.removeEventListener('scroll', on); };
  }, []);
  return vv;
}

export default function MobileApp({ data, projectsById, route, go, connected, load }) {
  const vv = useVisualViewport();
  // A relayed session (context full) opens the one that took over.
  let current = route.kind === 'ws' ? data.workspaces.find((w) => w.id === route.id) : null;
  for (let i = 0; current?.successor && i < 50; i++) current = data.workspaces.find((w) => w.id === current.successor) || null;
  let screen;
  if (current) screen = <WorkspaceScreen key={current.id} ws={current} project={projectsById[current.project_id]} go={go} />;
  else if (route.kind === 'new') screen = <NewScreen projects={data.projects} go={go} load={load} />;
  else screen = <ListScreen data={data} projectsById={projectsById} go={go} connected={connected} />;
  return <div className="m-app" style={{ height: vv.height, transform: `translateY(${vv.top}px)` }}>{screen}</div>;
}

function ListScreen({ data, projectsById, go, connected }) {
  const live = data.workspaces.filter((w) => !w.archived);
  const groups = [
    ['À traiter', live.filter((w) => ['waiting', 'review', 'error'].includes(w.status))],
    ['En cours', live.filter((w) => w.status === 'working')],
    ['Autres', live.filter((w) => !['waiting', 'review', 'working', 'error'].includes(w.status)).sort((a, b) => b.updated_at - a.updated_at)],
  ];
  return (
    <>
      <header className="m-head">
        <h1>Supersept</h1>
        <span className={`m-conn ${connected ? 'on' : ''}`} title={connected ? 'Connecté au Mac' : 'Mac injoignable'} />
        <button className="m-iconbtn" onClick={() => go({ kind: 'new' })} aria-label="Nouvel espace"><LuPlus size={20} /></button>
      </header>
      <div className="m-scroll">
        {!connected && <p className="m-note">Connexion au Mac… Vérifie qu'il est allumé et sur le même réseau (ou Tailscale).</p>}
        {groups.map(([title, list]) => list.length > 0 && (
          <section key={title}>
            <h2 className="m-section">{title}</h2>
            {list.map((w) => <Row key={w.id} ws={w} project={projectsById[w.project_id]} onClick={() => go({ kind: 'ws', id: w.id })} />)}
          </section>
        ))}
        {!live.length && <p className="m-note">Aucun espace de travail. Touche + pour en lancer un.</p>}
      </div>
    </>
  );
}

function Row({ ws, project, onClick }) {
  return (
    <button className="m-row" onClick={onClick}>
      <span className="m-row-icon">{ws.status === 'working' ? <AsciiSpinner /> : project ? <ProjectThumbnail project={project} size={20} /> : <span className="thumb" style={{ width: 20, height: 20 }}>·</span>}</span>
      <span className="m-row-body">
        <span className="m-row-top">
          <span className="m-row-name">{ws.name}</span>
          <StatusIndicator status={ws.status} />
          <span className="m-row-ago">{ago(ws.status_since || ws.updated_at)}</span>
        </span>
        <span className="m-row-sub">
          {project?.name || 'Session libre'}{ws.branch ? ` · ${ws.branch}` : ''} <DiffStats stats={ws.stats} />
        </span>
        {ws.last_message && ['waiting', 'review', 'error'].includes(ws.status) && <span className="m-row-msg">{ws.last_message}</span>}
      </span>
    </button>
  );
}

function WorkspaceScreen({ ws, project, go }) {
  const key = `${ws.id}:agent`;
  const [text, setText] = useState('');
  const input = useRef(null);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    // Newlines become Claude Code's own "new line" (what ⇧↵ sends), then submit.
    sendInput(key, t.replace(/\n/g, '\x1b\r'));
    setTimeout(() => sendInput(key, '\r'), 60);
    setText('');
  };
  useEffect(() => {
    const el = input.current;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  return (
    <>
      <header className="m-head">
        <button className="m-iconbtn" onClick={() => go({ kind: 'board' })} aria-label="Retour"><LuChevronLeft size={22} /></button>
        <div className="m-head-title">
          <span className="m-head-name">{ws.name}</span>
          <span className="m-head-sub">{STATUS[ws.status]?.label}{project ? ` · ${project.name}` : ''}{ws.branch ? <> · <LuGitBranch size={10} /> {ws.branch}</> : null}</span>
        </div>
        <button className="m-iconbtn" onClick={() => confirm(ws.running ? 'Relancer Claude ?' : 'Lancer Claude ?') && restartTerminal(key)} aria-label="Relancer Claude"><LuZap size={18} /></button>
      </header>
      <div className="m-term"><Terminal termKey={key} active={false} keyboard={false} /></div>
      <div className="m-keys">
        {KEYS.map(([label, seq]) => (
          <button key={label} className="m-key" onPointerDown={(e) => e.preventDefault()} onClick={() => sendInput(key, seq)}>{label}</button>
        ))}
      </div>
      <div className="m-composer">
        <textarea ref={input} rows={1} value={text} placeholder="Répondre à Claude…" onChange={(e) => setText(e.target.value)} />
        <button className="m-send" disabled={!text.trim()} onPointerDown={(e) => e.preventDefault()} onClick={send} aria-label="Envoyer"><LuArrowUp size={18} /></button>
      </div>
    </>
  );
}

function NewScreen({ projects, go, load }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || null);
  const [worktree, setWorktree] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const w = await api.post('/api/workspaces', { projectId, prompt: prompt.trim(), worktree: !!projectId && worktree });
      await load();
      go({ kind: 'ws', id: w.id });
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <>
      <header className="m-head">
        <button className="m-iconbtn" onClick={() => go({ kind: 'board' })} aria-label="Retour"><LuChevronLeft size={22} /></button>
        <h1>Nouvel espace</h1>
      </header>
      <div className="m-scroll m-form">
        <textarea className="m-prompt" autoFocus value={prompt} placeholder="Décris la tâche…" onChange={(e) => setPrompt(e.target.value)} />
        <h2 className="m-section">Projet</h2>
        <div className="m-chips">
          {projects.map((p) => (
            <button key={p.id} className={`m-chip ${projectId === p.id ? 'on' : ''}`} onClick={() => setProjectId(p.id)}><ProjectThumbnail project={p} /> {p.name}</button>
          ))}
          <button className={`m-chip ${projectId === null ? 'on' : ''}`} onClick={() => setProjectId(null)}>Session libre</button>
        </div>
        {projectId && (
          <>
            <h2 className="m-section">Où</h2>
            <div className="m-chips">
              <button className={`m-chip ${worktree ? 'on' : ''}`} onClick={() => setWorktree(true)}>Worktree (branche isolée)</button>
              <button className={`m-chip ${!worktree ? 'on' : ''}`} onClick={() => setWorktree(false)}>Local</button>
            </div>
          </>
        )}
        {error && <div className="error-bar">{error}</div>}
        <button className="m-primary" disabled={busy} onClick={create}>{busy ? 'Création…' : 'Lancer Claude'}</button>
      </div>
    </>
  );
}

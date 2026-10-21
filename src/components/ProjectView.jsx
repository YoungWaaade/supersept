import { useEffect, useRef, useState } from 'react';
import { api, ago } from '../api.js';
import { Icon, StatusDot, Stats } from './ui.jsx';

export default function ProjectView({ project, workspaces, go, onNew }) {
  const [tab, setTab] = useState('memory');
  const [renaming, setRenaming] = useState(false);
  const [info, setInfo] = useState(null);
  useEffect(() => { api.get(`/api/projects/${project.id}/info`).then(setInfo).catch(() => {}); }, [project.id]);

  const rename = (name) => {
    setRenaming(false);
    if (name.trim() && name !== project.name) api.patch(`/api/projects/${project.id}`, { name: name.trim() });
  };
  const remove = async () => {
    if (!confirm(`Retirer le projet « ${project.name} » de Claude Hub ?\nLes fichiers, worktrees et la mémoire restent sur le disque.`)) return;
    await api.del(`/api/projects/${project.id}`);
    go({ kind: 'board' });
  };

  return (
    <div className="projview">
      <header className="wshead">
        <div className="crumbs">
          <span className="swatch big" style={{ background: project.color }} />
          {renaming ? (
            <input className="rename" defaultValue={project.name} autoFocus onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename(e.target.value)} />
          ) : (
            <h2 onDoubleClick={() => setRenaming(true)} title="Double-clic pour renommer">{project.name}</h2>
          )}
          {info?.repo && <span className="chip mono"><Icon name="branch" /> {info.branch}</span>}
          <span className="chip mono dim">{project.path.replace(/^\/Users\/[^/]+/, '~')}</span>
        </div>
        <div className="actions">
          <button className="primary" onClick={onNew}><Icon name="plus" /> Nouveau workspace</button>
          <button className="ghost danger" title="Retirer le projet" onClick={remove}><Icon name="trash" /></button>
        </div>
      </header>
      <div className="tabs">
        <button className={tab === 'memory' ? 'on' : ''} onClick={() => setTab('memory')}><Icon name="brain" /> Mémoire</button>
        <button className={tab === 'workspaces' ? 'on' : ''} onClick={() => setTab('workspaces')}><Icon name="board" /> Workspaces <span className="pcount">{workspaces.length}</span></button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}><Icon name="history" /> Historique Claude Code</button>
      </div>
      <div className="pane scroll">
        {tab === 'memory' && <Memory project={project} />}
        {tab === 'workspaces' && <WorkspaceList workspaces={workspaces} go={go} />}
        {tab === 'history' && <History project={project} go={go} />}
      </div>
    </div>
  );
}

function Memory({ project }) {
  const [mem, setMem] = useState(null);
  const [saved, setSaved] = useState(true);
  const timer = useRef(null);
  const load = () => api.get(`/api/projects/${project.id}/memory`).then((m) => { setMem(m); setSaved(true); });
  useEffect(() => { load(); }, [project.id]);
  // Agents edit this file too: pick up their changes when coming back to the tab.
  useEffect(() => {
    const onFocus = () => saved && load();
    addEventListener('focus', onFocus);
    return () => removeEventListener('focus', onFocus);
  }, [saved, project.id]);

  const change = (content) => {
    setMem({ ...mem, content });
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api.put(`/api/projects/${project.id}/memory`, { content }).then(() => setSaved(true)), 600);
  };
  if (!mem) return null;
  return (
    <div className="memory">
      <div className="memory-head">
        <p>
          Mémoire partagée par toutes les sessions de ce projet : injectée au lancement de chaque agent, et Claude la met à jour lui-même quand il apprend quelque chose de durable.
        </p>
        <span className="dim mono small">{saved ? 'Enregistré' : 'Modification…'} · {mem.path.replace(/^\/Users\/[^/]+/, '~')}</span>
      </div>
      <textarea className="mono" spellCheck={false} value={mem.content} onChange={(e) => change(e.target.value)} placeholder="# Conventions, décisions, commandes utiles…" />
    </div>
  );
}

function WorkspaceList({ workspaces, go }) {
  if (!workspaces.length) return <p className="dim pad">Aucun workspace.</p>;
  return (
    <div className="rows">
      {workspaces.map((w) => (
        <div key={w.id} className={`row ${w.archived ? 'archived' : ''}`} onClick={() => go({ kind: 'ws', id: w.id })}>
          <StatusDot status={w.status} running={w.running} />
          <span className="row-title">{w.name}</span>
          <span className="mono dim">{w.branch}</span>
          <Stats stats={w.stats} />
          <span className="row-msg">{w.last_message}</span>
          <span className="time">{ago(w.updated_at)}</span>
        </div>
      ))}
    </div>
  );
}

function History({ project, go }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  useEffect(() => { api.get(`/api/projects/${project.id}/history`).then(setList); }, [project.id]);
  const resume = async (s) => {
    setBusy(s.sessionId);
    try {
      const w = await api.post('/api/workspaces', { projectId: project.id, name: s.title.slice(0, 60), resumeSessionId: s.sessionId });
      go({ kind: 'ws', id: w.id });
    } catch (e) {
      alert(e.message);
      setBusy(null);
    }
  };
  if (!list) return <p className="dim pad">Lecture de ~/.claude/projects…</p>;
  const filtered = list.filter((s) => !q || (s.title + ' ' + (s.firstPrompt || '')).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="history">
      <div className="search inline">
        <Icon name="search" />
        <input placeholder={`Rechercher dans ${list.length} sessions…`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!filtered.length && <p className="dim pad">Aucune session Claude Code trouvée dans ce dossier.</p>}
      <div className="rows">
        {filtered.map((s) => (
          <div key={s.sessionId} className="row">
            <span className="row-title">{s.title}</span>
            <span className="dim small">{s.prompts} msg</span>
            {s.cwd !== project.path && <span className="mono dim small">{s.cwd.replace(project.path, '.')}</span>}
            <span className="time">{ago(s.updatedAt)}</span>
            {s.imported ? <span className="tag">dans le hub</span> : (
              <button className="ghost" disabled={busy === s.sessionId} onClick={() => resume(s)}><Icon name="play" /> Reprendre</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

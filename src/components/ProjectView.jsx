import { useEffect, useState } from 'react';
import { LuGitBranch, LuPlus, LuTrash2 } from 'react-icons/lu';
import { api, ago } from '../api.js';
import { ProjectThumbnail, WorkspaceIcon, DiffStats } from './ui.jsx';
import { MemoryEditor, SessionList, resumeSession } from './Pages.jsx';

export default function ProjectView({ project, workspaces, go, onNew }) {
  const [tab, setTab] = useState('workspaces');
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
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <ProjectThumbnail project={project} size={20} />
          {renaming ? (
            <input className="inline-rename" defaultValue={project.name} autoFocus onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename(e.target.value)} />
          ) : (
            <h1 onDoubleClick={() => setRenaming(true)} title="Double-clic pour renommer">{project.name}</h1>
          )}
          {info?.repo && <span className="rp-chip"><LuGitBranch size={12} /> {info.branch}</span>}
          <span className="rp-chip muted">{project.path.replace(/^\/Users\/[^/]+/, '~')}</span>
        </div>
        <div className="page-head-actions">
          <button className="btn-primary" onClick={onNew}><LuPlus size={14} /> Nouvel espace</button>
          <button className="iconbtn size-7 danger" title="Retirer le projet" onClick={remove}><LuTrash2 size={14} /></button>
        </div>
      </header>
      <div className="page-tabs">
        <button className={tab === 'workspaces' ? 'on' : ''} onClick={() => setTab('workspaces')}>Espaces <span className="count">{workspaces.filter((w) => !w.archived).length}</span></button>
        <button className={tab === 'memory' ? 'on' : ''} onClick={() => setTab('memory')}>Mémoire</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>Historique Claude Code</button>
      </div>
      <div className={tab === 'memory' ? 'page-fill' : 'page-scroll'}>
        {tab === 'memory' && <MemoryEditor memoryId={project.id} />}
        {tab === 'workspaces' && (
          <div className="list">
            {workspaces.map((w) => (
              <div key={w.id} className={`list-row clickable ${w.archived ? 'archived' : ''}`} onClick={() => go({ kind: 'ws', id: w.id })}>
                <span className="list-icon"><WorkspaceIcon ws={w} /></span>
                <span className="list-title fade-r">{w.name}</span>
                <span className="list-meta mono">{w.branch}</span>
                <DiffStats stats={w.stats} active />
                <span className="list-msg fade-r">{w.last_message}</span>
                <span className="list-time">{ago(w.updated_at)}</span>
              </div>
            ))}
            {!workspaces.length && <p className="empty-note">Aucun espace de travail. <a onClick={onNew}>En créer un</a></p>}
          </div>
        )}
        {tab === 'history' && <ProjectHistory project={project} go={go} />}
      </div>
    </div>
  );
}

function ProjectHistory({ project, go }) {
  const [list, setList] = useState(null);
  useEffect(() => { api.get(`/api/projects/${project.id}/history`).then(setList); }, [project.id]);
  if (!list) return <p className="empty-note">Lecture de ~/.claude/projects…</p>;
  return <SessionList sessions={list} onResume={(s) => resumeSession({ ...s, projectId: project.id }, go)} />;
}

import { useState } from 'react';
import { LuGitBranch } from 'react-icons/lu';
import { ago } from '../api.js';
import { WorkspaceIcon, DiffStats, ProjectThumbnail } from './ui.jsx';
import { PageHeader } from './Pages.jsx';

const COLUMNS = [
  { key: 'progress', title: 'En cours', match: (w) => w.status === 'working' || w.status === 'waiting' },
  { key: 'review', title: 'À revoir', match: (w) => w.status === 'review' },
  { key: 'idle', title: 'Inactifs', match: (w) => w.status === 'idle' },
  { key: 'done', title: 'Terminés', match: (w) => w.status === 'done' },
];

export default function Board({ data, projectsById, go, onContextMenu }) {
  const [project, setProject] = useState('all');
  const list = data.workspaces.filter((w) => !w.archived && (project === 'all' || (project === 'none' ? !w.project_id : w.project_id === project)));
  return (
    <div className="page">
      <PageHeader title="Espaces de travail" />
      <div className="chips">
        <button className={`chip ${project === 'all' ? 'on' : ''}`} onClick={() => setProject('all')}>Tous</button>
        {data.projects.map((p) => (
          <button key={p.id} className={`chip ${project === p.id ? 'on' : ''}`} onClick={() => setProject(p.id)}><ProjectThumbnail project={p} size={14} /> {p.name}</button>
        ))}
        {data.workspaces.some((w) => !w.project_id) && <button className={`chip ${project === 'none' ? 'on' : ''}`} onClick={() => setProject('none')}>Sessions</button>}
      </div>
      <div className="columns">
        {COLUMNS.map((c) => {
          const items = list.filter(c.match).sort((a, b) => b.status_since - a.status_since);
          return (
            <div className="column" key={c.key}>
              <div className="column-head">{c.title} <span className="count">{items.length}</span></div>
              {items.map((w) => {
                const p = projectsById[w.project_id];
                return (
                  <div className={`card ${w.status}`} key={w.id} onClick={() => go({ kind: 'ws', id: w.id })} onContextMenu={(e) => { e.preventDefault(); onContextMenu(w, e); }}>
                    <div className="card-top">
                      <span className="card-icon"><WorkspaceIcon ws={w} active /></span>
                      <span className="card-title fade-r">{w.name}</span>
                      <span className="list-time">{ago(w.status_since)}</span>
                    </div>
                    <div className="card-meta">
                      <span className="card-project">{p ? <><ProjectThumbnail project={p} size={14} /> {p.name}</> : 'Session'}</span>
                      {w.branch && <span className="card-branch"><LuGitBranch size={11} /> <span className="fade-r">{w.branch}</span></span>}
                      <DiffStats stats={w.stats} active />
                    </div>
                    {w.last_message && <p className="card-msg">{w.last_message}</p>}
                  </div>
                );
              })}
              {!items.length && <div className="column-empty">—</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

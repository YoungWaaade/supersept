import { useState } from 'react';
import { ago } from '../api.js';
import { StatusDot, Stats, Icon } from './ui.jsx';

const COLUMNS = [
  { key: 'progress', title: 'En cours', match: (w) => w.status === 'working' || w.status === 'waiting' },
  { key: 'review', title: 'À revoir', match: (w) => w.status === 'review' },
  { key: 'idle', title: 'Inactifs', match: (w) => w.status === 'idle' },
  { key: 'done', title: 'Terminés', match: (w) => w.status === 'done' },
];

export default function Board({ data, projectsById, go }) {
  const [project, setProject] = useState('all');
  const list = data.workspaces.filter((w) => !w.archived && (project === 'all' || w.project_id === project));
  return (
    <div className="board">
      <header className="board-head">
        <h2>Tableau</h2>
        <div className="filters">
          <button className={project === 'all' ? 'on' : ''} onClick={() => setProject('all')}>Tous</button>
          {data.projects.map((p) => (
            <button key={p.id} className={project === p.id ? 'on' : ''} onClick={() => setProject(p.id)}>
              <span className="swatch" style={{ background: p.color }} /> {p.name}
            </button>
          ))}
        </div>
      </header>
      <div className="columns">
        {COLUMNS.map((c) => {
          const items = list.filter(c.match).sort((a, b) => b.status_since - a.status_since);
          return (
            <div className="column" key={c.key}>
              <div className="col-head">{c.title} <span className="pcount">{items.length}</span></div>
              {items.map((w) => {
                const p = projectsById[w.project_id];
                return (
                  <div className={`card ${w.status}`} key={w.id} onClick={() => go({ kind: 'ws', id: w.id })}>
                    <div className="card-top">
                      <StatusDot status={w.status} running={w.running} />
                      <span className="card-title">{w.name}</span>
                      <span className="time">{ago(w.status_since)}</span>
                    </div>
                    <div className="card-meta">
                      <span className="proj"><span className="swatch" style={{ background: p?.color }} />{p?.name}</span>
                      {w.branch && <span className="mono dim"><Icon name="branch" /> {w.branch}</span>}
                      <Stats stats={w.stats} />
                    </div>
                    {w.last_message && <p className="card-msg">{w.last_message}</p>}
                  </div>
                );
              })}
              {!items.length && <div className="col-empty">—</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

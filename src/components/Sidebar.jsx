import { useState } from 'react';
import { ago } from '../api.js';
import { StatusDot, Stats, Icon } from './ui.jsx';

export default function Sidebar({ data, route, go, connected, onNew, onAddProject }) {
  const [collapsed, setCollapsed] = useState(() => JSON.parse(localStorage.getItem('collapsed') || '{}'));
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState('');
  const toggle = (id) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    localStorage.setItem('collapsed', JSON.stringify(next));
  };
  const q = filter.trim().toLowerCase();
  const active = data.workspaces.filter((w) => !w.archived);
  const count = (s) => active.filter((w) => w.status === s).length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo"><Icon name="logo" /></div>
        <span>Claude Hub</span>
        <span className={`conn ${connected ? 'on' : ''}`} title={connected ? 'Connecté' : 'Déconnecté'} />
      </div>

      <button className="primary wide" onClick={() => onNew(route.kind === 'project' ? route.id : data.workspaces.find((w) => w.id === route.id)?.project_id || data.projects[0]?.id)} disabled={!data.projects.length}>
        <Icon name="plus" /> Nouveau workspace <kbd>⌘N</kbd>
      </button>

      <nav className="nav">
        <a className={route.kind === 'board' ? 'active' : ''} onClick={() => go({ kind: 'board' })}>
          <Icon name="board" /> Tableau
          <span className="counts">
            {count('working') > 0 && <span className="pill blue">{count('working')}</span>}
            {count('waiting') > 0 && <span className="pill orange">{count('waiting')}</span>}
            {count('review') > 0 && <span className="pill green">{count('review')}</span>}
          </span>
        </a>
      </nav>

      <div className="search">
        <Icon name="search" />
        <input placeholder="Filtrer…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      <div className="projects">
        {data.projects.map((p) => {
          const list = data.workspaces
            .filter((w) => w.project_id === p.id && (showArchived || !w.archived))
            .filter((w) => !q || w.name.toLowerCase().includes(q) || (w.branch || '').toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
          if (q && !list.length && !p.name.toLowerCase().includes(q)) return null;
          const open = !collapsed[p.id] || q;
          return (
            <div className="project" key={p.id}>
              <div className={`project-head ${route.kind === 'project' && route.id === p.id ? 'active' : ''}`}>
                <button className="chev" onClick={() => toggle(p.id)}><Icon name={open ? 'down' : 'right'} /></button>
                <span className="swatch" style={{ background: p.color }} />
                <a className="pname" onClick={() => go({ kind: 'project', id: p.id })}>{p.name}</a>
                <span className="pcount">{list.filter((w) => !w.archived).length}</span>
                <button className="ghost icon" title="Nouveau workspace" onClick={() => onNew(p.id)}><Icon name="plus" /></button>
              </div>
              {open && (
                <ul className="ws-list">
                  {list.map((w) => (
                    <li key={w.id} className={`${route.kind === 'ws' && route.id === w.id ? 'active' : ''} ${w.archived ? 'archived' : ''}`} onClick={() => go({ kind: 'ws', id: w.id })}>
                      <StatusDot status={w.status} running={w.running} />
                      <div className="ws-main">
                        <div className="ws-name">{w.name}</div>
                        <div className="ws-sub">
                          {w.is_worktree && <Icon name="branch" />}
                          <span className="mono">{w.branch || '—'}</span>
                        </div>
                      </div>
                      <div className="ws-side">
                        <Stats stats={w.stats} />
                        <span className="time">{ago(w.status_since)}</span>
                      </div>
                    </li>
                  ))}
                  {!list.length && <li className="empty-ws" onClick={() => onNew(p.id)}>+ Lancer une session</li>}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <button className="ghost" onClick={onAddProject}><Icon name="folder" /> Ajouter un projet</button>
        <label className="toggle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archivés
        </label>
      </div>
    </aside>
  );
}

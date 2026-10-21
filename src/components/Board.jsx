import { useEffect, useMemo, useRef, useState } from 'react';
import { LuSearch, LuX, LuFolder, LuListFilter, LuArrowDownUp, LuList, LuSquareKanban, LuChevronDown, LuChevronRight, LuGitBranch, LuCircleAlert, LuTrash2, LuTerminal, LuCheck, LuLayers, LuSearchX } from 'react-icons/lu';
import { CgLaptop } from 'react-icons/cg';
import { HiChevronDown, HiCheck } from 'react-icons/hi2';
import { api } from '../api.js';
import { ProjectThumbnail } from './ui.jsx';
import { deleteWorkspace } from './RightPanel.jsx';

const COLUMNS = [
  { key: 'idle', label: 'Inactif' },
  { key: 'working', label: 'En cours' },
  { key: 'attention', label: 'Nécessite votre attention' },
  { key: 'review', label: 'Revue requise' },
];
const column = (w) => (w.status === 'waiting' ? 'attention' : w.status === 'working' ? 'working' : w.status === 'review' ? 'review' : 'idle');
const STATUS_FILTERS = [['idle', 'Inactif'], ['working', 'En cours'], ['attention', 'Nécessite votre attention'], ['review', 'Revue requise']];
const SORTS = [['recent', 'Activité récente'], ['created', 'Date de création'], ['name', 'Nom'], ['branch', 'Branche']];

// Superset's compact relative time ("2d ago").
export function compactAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  if (s < 30 * 86400) return `${Math.floor(s / (7 * 86400))}w ago`;
  if (s < 365 * 86400) return `${Math.floor(s / (30 * 86400))}mo ago`;
  return `${Math.floor(s / (365 * 86400))}y ago`;
}

// Linear-style status glyphs used by Superset's board.
export function BoardStatusIcon({ col, size = 12 }) {
  if (col === 'attention') return <LuCircleAlert size={16} className="bsi attention" />;
  const progress = col === 'working' ? 50 : col === 'review' ? 75 : 0;
  const dash = (progress / 100) * 2 * Math.PI * 2;
  return (
    <svg className={`bsi ${col}`} width={size} height={size} viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
      {progress > 0 && <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="4" strokeDasharray={`${dash} ${2 * Math.PI * 2 - dash}`} transform="rotate(-90 7 7)" />}
    </svg>
  );
}

function usePersisted(key, init) {
  const [v, setV] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) ?? init; } catch { return init; } });
  useEffect(() => localStorage.setItem(key, JSON.stringify(v)), [key, v]);
  return [v, setV];
}

function Popover({ open, onClose, children, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.parentElement?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    addEventListener('mousedown', close);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); };
  }, [open, onClose]);
  return open ? <div ref={ref} className={`popover ${className}`}>{children}</div> : null;
}

export default function Board({ data, projectsById, go, onContextMenu }) {
  const [view, setView] = usePersisted('board-view', 'board');
  const [q, setQ] = useState('');
  const [projects, setProjects] = usePersisted('board-projects', []);
  const [statuses, setStatuses] = usePersisted('board-statuses', []);
  const [sort, setSort] = usePersisted('board-sort', 'recent');
  const [archived, setArchived] = usePersisted('board-archived', false);
  const [menu, setMenu] = useState(null);
  const toggleMenu = (m) => setMenu((x) => (x === m ? null : m));

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.workspaces
      .filter((w) => archived || !w.archived)
      .filter((w) => !projects.length || projects.includes(w.project_id ?? '__sessions__'))
      .filter((w) => !statuses.length || statuses.includes(column(w)))
      .filter((w) => !t || [w.name, w.branch, projectsById[w.project_id]?.name ?? 'Sessions'].some((s) => (s || '').toLowerCase().includes(t)))
      .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name)
        : sort === 'branch' ? (a.branch || '').localeCompare(b.branch || '')
        : sort === 'created' ? b.created_at - a.created_at
        : b.updated_at - a.updated_at);
  }, [data.workspaces, q, projects, statuses, sort, archived, projectsById]);
  const filtered = !!(q || projects.length || statuses.length);

  const projectLabel = !projects.length ? 'Dans tous les projets'
    : (projects[0] === '__sessions__' ? 'Sessions' : projectsById[projects[0]]?.name ?? '?') + (projects.length > 1 ? ` +${projects.length - 1}` : '');
  const toggleIn = (arr, set, v) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="wsp">
      <div className="wsp-header">
        <div className="wsp-title-row">
          <span className="menu-anchor">
            <button className="wsp-host" onClick={() => toggleMenu('host')}><CgLaptop size={16} /> <span>Cet appareil</span> <LuChevronDown size={16} className="wsp-host-chev" /></button>
            <Popover open={menu === 'host'} onClose={() => setMenu(null)} className="wsp-host-menu">
              <button className="popover-item select-item selected" onClick={() => setMenu(null)}><CgLaptop size={14} /> Cet appareil <LuCheck size={16} className="select-check" /></button>
            </Popover>
          </span>
          <button className="wsp-create" onClick={() => go({ kind: 'new' })}>Créer un espace de travail</button>
        </div>
        <div className="wsp-toolbar">
          <div className="wsp-search">
            <LuSearch size={16} />
            <input placeholder="Rechercher des espaces de travail" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && <button className="iconbtn size-6" aria-label="Effacer la recherche" onClick={() => setQ('')}><LuX size={14} /></button>}
          </div>
          <span className="flex-1" />
          <span className="menu-anchor">
            <button className={`wsp-ghost ${projects.length ? 'active' : ''}`} onClick={() => toggleMenu('projects')}><LuFolder size={14} /> <span className="wsp-ghost-label">{projectLabel}</span> <HiChevronDown size={12} className="wsp-chev" /></button>
            <Popover open={menu === 'projects'} onClose={() => setMenu(null)} className="wsp-filter-menu">
              {data.projects.map((p) => (
                <button key={p.id} className="popover-item" onClick={() => toggleIn(projects, setProjects, p.id)}>
                  <ProjectThumbnail project={p} /> <span className="flex-1 fade-r">{p.name}</span> {projects.includes(p.id) && <HiCheck size={14} />}
                </button>
              ))}
              <button className="popover-item" onClick={() => toggleIn(projects, setProjects, '__sessions__')}>
                <LuTerminal size={14} /> <span className="flex-1">Sessions</span> {projects.includes('__sessions__') && <HiCheck size={14} />}
              </button>
              {projects.length > 0 && <><div className="popover-sep" /><button className="popover-item center muted" onClick={() => setProjects([])}>Effacer</button></>}
            </Popover>
          </span>
          <span className="wsp-divider" />
          <span className="menu-anchor">
            <button className={`wsp-ghost ${statuses.length ? 'active' : ''}`} onClick={() => toggleMenu('filter')}><LuListFilter size={14} /> Filtrer{statuses.length ? ` · ${statuses.length}` : ''}</button>
            <Popover open={menu === 'filter'} onClose={() => setMenu(null)} className="wsp-filter-menu">
              <div className="popover-label">Agent</div>
              {STATUS_FILTERS.map(([k, label]) => (
                <button key={k} className="popover-item" onClick={() => toggleIn(statuses, setStatuses, k)}>
                  <span className="bsi-slot"><BoardStatusIcon col={k} /></span> <span className="flex-1">{label}</span> {statuses.includes(k) && <HiCheck size={14} />}
                </button>
              ))}
              {statuses.length > 0 && <><div className="popover-sep" /><button className="popover-item center muted" onClick={() => setStatuses([])}>Effacer</button></>}
            </Popover>
          </span>
          <span className="menu-anchor">
            <button className="wsp-ghost" onClick={() => toggleMenu('display')}><LuArrowDownUp size={14} /> Affichage</button>
            <Popover open={menu === 'display'} onClose={() => setMenu(null)} className="wsp-filter-menu">
              <div className="popover-label">Trier par</div>
              {SORTS.map(([k, label]) => (
                <button key={k} className="popover-item" onClick={() => setSort(k)}><span className="flex-1">{label}</span> {sort === k && <HiCheck size={14} />}</button>
              ))}
              <div className="popover-sep" />
              <button className="popover-item" onClick={() => setArchived(!archived)}><span className="flex-1">Afficher les archivés</span> {archived && <HiCheck size={14} />}</button>
            </Popover>
          </span>
          <div className="wsp-segmented">
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}><LuList size={14} /> Liste</button>
            <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}><LuSquareKanban size={14} /> Kanban</button>
          </div>
        </div>
      </div>

      {!list.length ? (
        <div className="wsp-empty">
          <span className="wsp-empty-icon">{filtered ? <LuSearchX size={28} /> : <LuLayers size={28} />}</span>
          <h3>{filtered ? 'Aucun espace ne correspond à tes filtres' : 'Aucun espace de travail'}</h3>
          <p>{filtered ? 'Essaie une autre recherche.' : 'Les espaces de travail de cet appareil apparaîtront ici.'}</p>
          {filtered && <button className="btn-ghost" onClick={() => { setQ(''); setProjects([]); setStatuses([]); }}>Effacer les filtres</button>}
        </div>
      ) : view === 'board' ? (
        <div className="kb-scroll">
          <div className="kb">
            {COLUMNS.map((c) => {
              const items = list.filter((w) => column(w) === c.key);
              return (
                <div className="kb-col" key={c.key}>
                  <div className="kb-col-head"><span className="bsi-slot"><BoardStatusIcon col={c.key} /></span><span className="kb-col-label">{c.label}</span><span className="kb-col-count">{items.length}</span></div>
                  <div className="kb-cards">
                    {items.map((w) => <Card key={w.id} ws={w} col={c.key} project={projectsById[w.project_id]} go={go} onContextMenu={onContextMenu} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <ListView list={list} projectsById={projectsById} go={go} onContextMenu={onContextMenu} />
      )}
    </div>
  );
}

function Card({ ws, col, project, go, onContextMenu }) {
  return (
    <button className={`kb-card ${ws.archived ? 'archived' : ''}`} onClick={() => go({ kind: 'ws', id: ws.id })} onContextMenu={(e) => { e.preventDefault(); onContextMenu(ws, e); }}>
      <div className="kb-card-top">
        <span className="kb-card-project">
          {project ? <ProjectThumbnail project={project} /> : <span className="thumb"><LuTerminal size={10} /></span>}
          <span className="kb-card-pname">{project?.name ?? 'Sessions'}</span>
          {project && !ws.is_worktree && <CgLaptop size={14} />}
        </span>
        <span className="kb-card-time">{compactAgo(ws.created_at)}</span>
      </div>
      <div className="kb-card-title">{ws.name || ws.branch}</div>
      {ws.branch && <div className="kb-card-branch"><LuGitBranch size={12} /> <span>{ws.branch}</span></div>}
      <div className="kb-card-foot">
        {ws.stats && (ws.stats.add || ws.stats.del) ? <span className="kb-diff"><span className="add">+{ws.stats.add}</span><span className="del">−{ws.stats.del}</span></span> : <span />}
        <span className="bsi-slot"><BoardStatusIcon col={col} /></span>
      </div>
    </button>
  );
}

function ListView({ list, projectsById, go, onContextMenu }) {
  const [closed, setClosed] = usePersisted('list-closed', {});
  const groups = useMemo(() => {
    const m = new Map();
    for (const w of list) {
      const k = w.project_id ?? '__sessions__';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(w);
    }
    return [...m].sort((a, b) => Math.max(...b[1].map((w) => w.created_at)) - Math.max(...a[1].map((w) => w.created_at)));
  }, [list]);
  return (
    <div className="lv">
      <table className="lv-table">
        <colgroup><col style={{ width: 24 }} /><col /><col style={{ width: 224 }} /><col style={{ width: 176 }} /><col style={{ width: 56 }} /></colgroup>
        <thead><tr><th /><th>Nom</th><th>Branche</th><th>Créé</th><th /></tr></thead>
        {groups.map(([pid, items]) => {
          const p = projectsById[pid];
          const open = !closed[pid];
          return (
            <tbody key={pid}>
              <tr className="lv-group">
                <td colSpan={5}>
                  <button onClick={() => setClosed({ ...closed, [pid]: open })}>
                    {open ? <LuChevronDown size={12} /> : <LuChevronRight size={12} />}
                    {p ? <ProjectThumbnail project={p} size={20} /> : <span className="thumb" style={{ width: 20, height: 20 }}><LuTerminal size={12} /></span>}
                    <span className="lv-group-name">{p?.name ?? 'Sessions'}</span>
                    <span className="lv-group-count">{items.length}</span>
                  </button>
                </td>
              </tr>
              {open && items.map((w) => (
                <tr key={w.id} className="lv-row" tabIndex={0} onClick={() => go({ kind: 'ws', id: w.id })} onKeyDown={(e) => e.key === 'Enter' && go({ kind: 'ws', id: w.id })} onContextMenu={(e) => { e.preventDefault(); onContextMenu(w, e); }}>
                  <td />
                  <td><span className="lv-name">
                    <span className="bsi-slot"><BoardStatusIcon col={column(w)} /></span>
                    {p && !w.is_worktree && <CgLaptop size={14} className="muted" title="Espace principal" />}
                    <span className="lv-name-text">{w.name || w.branch}</span>
                    {w.stats && (w.stats.add || w.stats.del) ? <span className="kb-diff"><span className="add">+{w.stats.add}</span><span className="del">−{w.stats.del}</span></span> : null}
                  </span></td>
                  <td><span className="lv-branch">{w.branch && <><LuGitBranch size={12} /> <span className="mono">{w.branch}</span></>}</span></td>
                  <td className="lv-created">{compactAgo(w.created_at)}</td>
                  <td>
                    <button className="lv-delete" aria-label="Supprimer l'espace" onClick={(e) => { e.stopPropagation(); deleteWorkspace(w, () => {}); }}><LuTrash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { LuPanelLeft, LuPanelLeftClose, LuPanelLeftOpen, LuArrowLeft, LuArrowRight, LuPlus, LuSearch, LuLayers, LuBrain, LuHistory } from 'react-icons/lu';
import { HiChevronRight, HiMiniPlus, HiMiniXMark, HiOutlineCog6Tooth } from 'react-icons/hi2';
import { VscNewFolder, VscFolderOpened, VscListFilter } from 'react-icons/vsc';
import { WorkspaceIcon, ProjectThumbnail, DiffStats } from './ui.jsx';

const DEFAULT_WIDTH = 271;
const MIN_WIDTH = 220;
const MAX_WIDTH = 400;
const COLLAPSED_WIDTH = 52;

const NAV = [
  { kind: 'search', label: 'Rechercher', Icon: LuSearch, kbd: '⌘K' },
  { kind: 'board', label: 'Espaces de travail', Icon: LuLayers },
  { kind: 'memory', label: 'Mémoire', Icon: LuBrain },
  { kind: 'history', label: 'Historique', Icon: LuHistory },
];

const SORTS = [
  ['manual', 'Ordre d\'ajout'],
  ['recent', 'Activité récente'],
  ['name', 'Nom'],
];

const persisted = (key, init) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? init; } catch { return init; }
};

export default function Sidebar({ data, route, go, connected, me, onNew, onNewSession, onAddProject, onSearch, onCloseWorkspace, onContextMenu }) {
  const [width, setWidth] = useState(() => persisted('sb-width', DEFAULT_WIDTH));
  const [collapsed, setCollapsed] = useState(() => persisted('sb-collapsed', false));
  const [closedProjects, setClosedProjects] = useState(() => persisted('sb-closed-projects', {}));
  const [closedSections, setClosedSections] = useState(() => persisted('sb-closed-sections', {}));
  const [sort, setSort] = useState(() => persisted('sb-sort', 'manual'));
  const [filtering, setFiltering] = useState(false);
  const [filter, setFilter] = useState('');
  const [hoverToggle, setHoverToggle] = useState(false);

  useEffect(() => localStorage.setItem('sb-width', JSON.stringify(width)), [width]);
  useEffect(() => localStorage.setItem('sb-collapsed', JSON.stringify(collapsed)), [collapsed]);
  useEffect(() => localStorage.setItem('sb-closed-projects', JSON.stringify(closedProjects)), [closedProjects]);
  useEffect(() => localStorage.setItem('sb-closed-sections', JSON.stringify(closedSections)), [closedSections]);
  useEffect(() => localStorage.setItem('sb-sort', JSON.stringify(sort)), [sort]);

  const visible = data.workspaces.filter((w) => !w.archived);
  const q = filter.trim().toLowerCase();
  const matches = (w) => !q || w.name.toLowerCase().includes(q) || (w.branch || '').toLowerCase().includes(q);
  const sessions = visible.filter((w) => !w.project_id && matches(w));
  const lastActivity = (p) => Math.max(p.created_at, ...visible.filter((w) => w.project_id === p.id).map((w) => w.updated_at));
  const projects = [...data.projects]
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'recent' ? lastActivity(b) - lastActivity(a) : 0))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || visible.some((w) => w.project_id === p.id && matches(w)));

  const activeWs = route.kind === 'ws' ? route.id : null;
  const shortcut = new Map(visible.slice(0, 9).map((w, i) => [w.id, `⌘⌥${i + 1}`]));

  const row = (w) => (
    <WorkspaceRow key={w.id} ws={w} active={activeWs === w.id} shortcut={shortcut.get(w.id)} onClick={() => go({ kind: 'ws', id: w.id })} onClose={() => onCloseWorkspace(w)} onContextMenu={(e) => { e.preventDefault(); onContextMenu(w, e); }} />
  );

  if (collapsed) {
    return (
      <aside className="sb collapsed" style={{ width: COLLAPSED_WIDTH }}>
        <div className="sb-inner">
          <div className="sb-header">
            <div className="sb-toprow">
              <button className="sb-iconbtn size-8" title="Afficher la sidebar" onClick={() => setCollapsed(false)}><LuPanelLeftOpen size={16} strokeWidth={1.5} /></button>
            </div>
            <button className="sb-rail-btn" title="Nouvel espace de travail" onClick={() => onNew()}><span className="sb-plusbox"><LuPlus size={12} strokeWidth={2} /></span></button>
            {NAV.map(({ kind, label, Icon }) => (
              <button key={kind} className={`sb-rail-btn ${route.kind === kind ? 'active' : ''}`} title={label} onClick={() => (kind === 'search' ? onSearch() : go({ kind }))}><Icon size={16} strokeWidth={1.5} /></button>
            ))}
          </div>
          <div className="sb-scroll">
            {[...sessions, ...projects.flatMap((p) => visible.filter((w) => w.project_id === p.id))].map((w) => (
              <button key={w.id} className={`sb-rail-btn ${activeWs === w.id ? 'active' : ''}`} title={w.name} onClick={() => go({ kind: 'ws', id: w.id })}>
                <WorkspaceIcon ws={w} active={activeWs === w.id} />
              </button>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sb" style={{ width }}>
      <div className="sb-inner">
        <div className="sb-header">
          <div className="sb-toprow">
            <span className="sb-spacer" />
            <button className="sb-iconbtn size-8" title="Masquer la sidebar" onMouseEnter={() => setHoverToggle(true)} onMouseLeave={() => setHoverToggle(false)} onClick={() => setCollapsed(true)}>
              {hoverToggle ? <LuPanelLeftClose size={16} strokeWidth={1.5} /> : <LuPanelLeft size={16} strokeWidth={1.5} />}
            </button>
            <div className="sb-navctl">
              <button className="sb-iconbtn size-7" title="Retour" onClick={() => history.back()}><LuArrowLeft size={16} strokeWidth={1.5} /></button>
              <button className="sb-iconbtn size-7" title="Suivant" onClick={() => history.forward()}><LuArrowRight size={16} strokeWidth={1.5} /></button>
            </div>
          </div>

          <button className="sb-new" onClick={() => onNew()}>
            <span className="sb-plusbox"><LuPlus size={12} strokeWidth={2} /></span>
            <span className="sb-new-label">Nouvel espace de travail</span>
            <kbd className="sb-kbd">⌘N</kbd>
          </button>

          {NAV.map(({ kind, label, Icon, kbd }) => (
            <button key={kind} className={`sb-nav ${route.kind === kind ? 'active' : ''}`} onClick={() => (kind === 'search' ? onSearch() : go({ kind }))}>
              <Icon className="sb-nav-icon" size={16} strokeWidth={1.5} />
              <span className="sb-nav-label">{label}</span>
              {kbd && <kbd className="sb-kbd">{kbd}</kbd>}
            </button>
          ))}
        </div>

        <div className="sb-scroll">
          <div className="sb-section">
            <SectionHeader label="Sessions" closed={closedSections.sessions} onToggle={() => setClosedSections({ ...closedSections, sessions: !closedSections.sessions })}>
              <button className="sb-iconbtn size-6" title="Nouvelle session" onClick={onNewSession}><LuPlus size={14} /></button>
            </SectionHeader>
            {!closedSections.sessions && sessions.map(row)}
          </div>

          <SectionHeader label="Projets" closed={closedSections.projects} onToggle={() => setClosedSections({ ...closedSections, projects: !closedSections.projects })}>
            <button className={`sb-iconbtn size-6 ${filtering ? 'on' : ''}`} title="Filtrer" onClick={() => { setFiltering(!filtering); setFilter(''); }}><LuSearch size={14} /></button>
            <SortButton sort={sort} setSort={setSort} />
            <button className="sb-iconbtn size-6 addrepo" title="Ajouter un projet" onClick={onAddProject}>
              <VscNewFolder className="i-closed" size={14} /><VscFolderOpened className="i-open" size={14} />
            </button>
          </SectionHeader>
          {filtering && (
            <div className="sb-filter">
              <input autoFocus placeholder="Filtrer les projets et espaces…" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setFiltering(false), setFilter(''))} />
            </div>
          )}

          {!closedSections.projects && projects.map((p) => {
            const list = visible.filter((w) => w.project_id === p.id && (matches(w) || p.name.toLowerCase().includes(q)));
            const open = !closedProjects[p.id] || !!q;
            return (
              <div className="sb-project" key={p.id}>
                <div className={`sb-project-row ${route.kind === 'project' && route.id === p.id ? 'active' : ''}`} role="button"
                  onClick={() => setClosedProjects({ ...closedProjects, [p.id]: !closedProjects[p.id] })}>
                  <div className="sb-project-main">
                    <span className="sb-thumb-slot">
                      <ProjectThumbnail project={p} />
                      <HiChevronRight className={`sb-thumb-chevron ${open ? 'open' : ''}`} size={16} />
                    </span>
                    <a className="sb-project-name" onClick={(e) => { e.stopPropagation(); go({ kind: 'project', id: p.id }); }}>{p.name}</a>
                  </div>
                  <span className="sb-project-add">
                    <button title="Nouvel espace de travail" onClick={(e) => { e.stopPropagation(); onNew(p.id); }}><HiMiniPlus size={16} /></button>
                  </span>
                </div>
                {open && <div className="sb-project-children">{list.map(row)}</div>}
              </div>
            );
          })}
        </div>

        <footer className="sb-footer">
          <button className="sb-account" onClick={() => go({ kind: 'settings' })}>
            <span className="sb-avatar">{initials(me?.name)}</span>
            <span className="sb-account-name">{me?.name || 'Claude Hub'}</span>
          </button>
          <span className={`sb-pill ${connected ? '' : 'error'}`} title={connected ? 'Serveur local connecté — les sessions tournent' : 'Serveur local injoignable'}>
            {connected ? <span className="sb-pill-dot" /> : null}
            <span>{connected ? 'connecté' : '↻ hors ligne'}</span>
          </span>
          <button className={`sb-iconbtn size-8 ${route.kind === 'settings' ? 'on' : ''}`} title="Réglages" onClick={() => go({ kind: 'settings' })}><HiOutlineCog6Tooth size={14} /></button>
        </footer>
      </div>
      <ResizeHandle width={width} setWidth={setWidth} />
    </aside>
  );
}

function initials(name) {
  const words = (name || 'Claude Hub').trim().split(/\s+/);
  return ((words[0]?.[0] || '') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

function SectionHeader({ label, closed, onToggle, children }) {
  return (
    <div className="sb-section-header" role="button" tabIndex={0} onClick={onToggle}>
      <span className="sb-section-label">{label}</span>
      <HiChevronRight className={`sb-section-chevron ${closed ? 'closed' : ''}`} size={12} />
      <span className="flex-1" />
      <span className="sb-section-actions" onClick={(e) => e.stopPropagation()}>{children}</span>
    </div>
  );
}

function SortButton({ sort, setSort }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    addEventListener('mousedown', close);
    return () => removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span className="sb-menu-wrap" ref={ref}>
      <button className={`sb-iconbtn size-6 ${open ? 'on' : ''}`} title="Trier les projets" onClick={() => setOpen(!open)}><VscListFilter size={14} /></button>
      {open && (
        <div className="popover sb-sort-menu">
          {SORTS.map(([k, label]) => (
            <button key={k} className={`popover-item ${sort === k ? 'checked' : ''}`} onClick={() => { setSort(k); setOpen(false); }}>{label}</button>
          ))}
        </div>
      )}
    </span>
  );
}

function WorkspaceRow({ ws, active, shortcut, onClick, onClose, onContextMenu }) {
  const ref = useRef(null);
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [active]);
  return (
    <div ref={ref} className={`sb-ws ${active ? 'active' : ''}`}>
      <div className="sb-ws-inner" role="button" onClick={onClick} onContextMenu={onContextMenu} title={ws.cwd}>
        <span className="sb-ws-icon"><WorkspaceIcon ws={ws} active={active} /></span>
        <div className="sb-ws-grid">
          <span className="sb-ws-name fade-r">{ws.name || ws.branch}</span>
          <span className="sb-ws-right">
            {active && <DiffStats stats={ws.stats} active />}
            <span className="sb-ws-hover">
              {shortcut && <span className="sb-ws-shortcut">{shortcut}</span>}
              {(ws.is_worktree || !ws.project_id || ws.name !== 'local') && (
                <button className="sb-ws-close" title="Archiver" onClick={(e) => { e.stopPropagation(); onClose(); }}><HiMiniXMark size={14} /></button>
              )}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function ResizeHandle({ width, setWidth }) {
  const [dragging, setDragging] = useState(false);
  const start = (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    setDragging(true);
    const move = (ev) => setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w0 + ev.clientX - x0)));
    const up = () => { setDragging(false); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
  return <div className={`sb-resize ${dragging ? 'dragging' : ''}`} onMouseDown={start} onDoubleClick={() => setWidth(DEFAULT_WIDTH)} />;
}

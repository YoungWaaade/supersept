import { useEffect, useMemo, useRef, useState } from 'react';
import { LuChevronDown, LuChevronRight, LuFileText, LuSettings, LuPlay, LuSquare, LuX, LuFile, LuGitCompareArrows, LuMessageSquare, LuSearch, LuListTree, LuFolder, LuFolderOpen, LuFoldVertical, LuUnfoldVertical, LuRefreshCw, LuCheck, LuCircleCheck, LuArrowUpRight, LuLoaderCircle, LuMinus, LuFilePlus } from 'react-icons/lu';
import { VscGitPullRequestCreate, VscDiffAdded, VscDiffModified, VscDiffRemoved, VscDiffRenamed } from 'react-icons/vsc';
import { api, ago, STATUS } from '../api.js';
import { disposeTerminals } from './Terminal.jsx';

const DEFAULT_WIDTH = 340, MIN_WIDTH = 240, MAX_WIDTH = 640;

export async function deleteWorkspace(ws, go) {
  const msg = ws.is_worktree
    ? `Supprimer « ${ws.name} » ?\n\nLe worktree ${ws.cwd} sera supprimé. La branche ${ws.branch} est conservée.`
    : `Supprimer « ${ws.name} » ? La conversation reste dans l'historique Claude Code.`;
  if (!confirm(msg)) return false;
  await api.del(`/api/workspaces/${ws.id}${ws.is_worktree ? '?removeWorktree=1' : ''}`);
  disposeTerminals(ws.id + ':');
  go({ kind: 'board' });
  return true;
}

function Dropdown({ open, onClose, className = '', children }) {
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

const STATUS_ICON = {
  A: [VscDiffAdded, '#05df72'], '?': [VscDiffAdded, '#05df72'],
  M: [VscDiffModified, '#fdc700'], T: [VscDiffModified, '#fdc700'],
  D: [VscDiffRemoved, '#fb2c36'], R: [VscDiffRenamed, '#51a2ff'], C: [VscDiffRenamed, '#c27aff'],
};
const TINT = { A: '#00a63e', '?': '#00a63e', M: '#d08700', D: '#e7000b', R: '#3886c1' };

export default function RightPanel({ ws, project, go, onOpenDiff, onOpenFile, onRun, sendToAgent }) {
  const [width, setWidth] = useState(() => Number(localStorage.getItem('rp-width')) || DEFAULT_WIDTH);
  const [tab, setTab] = useState(() => localStorage.getItem('rp-tab') || 'changes');
  const [menu, setMenu] = useState(null);
  const [changes, setChanges] = useState(null);
  useEffect(() => localStorage.setItem('rp-width', String(width)), [width]);
  useEffect(() => localStorage.setItem('rp-tab', tab), [tab]);
  const loadChanges = () => api.get(`/api/workspaces/${ws.id}/changes`).then(setChanges).catch(() => setChanges({ files: [], commits: [], base: null }));
  useEffect(() => { loadChanges(); }, [ws.id, ws.status, ws.stats?.add, ws.stats?.del, ws.base_branch]);
  const compact = width < 260;
  const toggle = (m) => setMenu((x) => (x === m ? null : m));

  const createPR = (draft) => {
    setMenu(null);
    sendToAgent(`Pousse la branche ${ws.branch || 'courante'} et crée une pull request${draft ? ' en brouillon (draft)' : ''} avec gh pr create. Rédige un titre et une description clairs à partir des changements et des commits, puis donne-moi le lien.`);
  };
  const configureRun = () => {
    setMenu(null);
    if (!project) return alert("Les sessions hors projet n'ont pas de commande d'exécution.");
    const cmd = prompt(`Commande d'exécution pour ${project.name} (ex. npm run dev)`, project.run_command || '');
    if (cmd !== null) api.patch(`/api/projects/${project.id}`, { run_command: cmd });
  };
  const run = () => {
    if (!project?.run_command) return configureRun();
    if (ws.run_running) api.del(`/api/workspaces/${ws.id}/run`);
    else onRun();
  };

  return (
    <aside className="rs" style={{ width }}>
      <RsResize width={width} setWidth={setWidth} />
      <div className="rs-inner">
        <div className="rs-top">
          <span className="flex-1" />
          <span className="menu-anchor">
            <span className="rs-split">
              <button className="rs-split-main" disabled={!ws.branch} title={ws.is_worktree ? 'Créer une pull request avec Claude' : 'Passe sur une branche de fonctionnalité pour créer une PR'} onClick={() => createPR(false)}>
                <VscGitPullRequestCreate size={14} /> <span>Créer une PR</span>
              </button>
              <button className="rs-split-chev" disabled={!ws.branch} onClick={() => toggle('pr')}><LuChevronDown size={12} /></button>
            </span>
            <Dropdown open={menu === 'pr'} onClose={() => setMenu(null)} className="rs-menu">
              <button className="popover-item" onClick={() => createPR(true)}><VscGitPullRequestCreate size={14} /> Créer une PR brouillon</button>
            </Dropdown>
          </span>
          <button className="rs-doc" title={project ? `Mémoire de ${project.name}` : 'Mémoire des sessions'} onClick={() => go({ kind: 'memory', id: project?.id || 'sessions' })}><LuFileText size={12} /></button>
          <span className="menu-anchor">
            <span className={`rs-run ${ws.run_running ? 'running' : ''} ${project?.run_command ? 'set' : ''}`}>
              <button className="rs-run-main" onClick={run} aria-label={ws.run_running ? 'Arrêter la commande' : project?.run_command ? 'Exécuter la commande' : "Configurer la commande d'exécution"}>
                {ws.run_running ? <LuSquare size={12} /> : project?.run_command ? <LuPlay size={12} /> : <LuSettings size={12} />}
                <span>{ws.run_running ? 'Arrêter' : project?.run_command ? 'Exécuter' : "Définir l'exécution"}</span>
              </button>
              <button className="rs-run-chev" onClick={() => toggle('run')} aria-label="Options d'exécution"><LuChevronDown size={12} /></button>
            </span>
            <Dropdown open={menu === 'run'} onClose={() => setMenu(null)} className="rs-menu">
              {ws.run_running && <><button className="popover-item danger" onClick={() => { setMenu(null); api.del(`/api/workspaces/${ws.id}/run?force=1`); }}><LuX size={16} /> Forcer l'arrêt</button><div className="popover-sep" /></>}
              <button className="popover-item" onClick={configureRun}><LuSettings size={16} /> Configurer</button>
            </Dropdown>
          </span>
        </div>

        <div className="rs-tabs">
          {[['files', 'Fichiers', LuFile], ['changes', 'Modifications', LuGitCompareArrows], ['review', 'Revue', LuMessageSquare]].map(([k, label, Icon]) => (
            <button key={k} className={`rs-tab ${tab === k ? 'on' : ''} ${compact ? 'compact' : ''}`} onClick={() => setTab(k)} title={compact ? label : undefined}>
              <Icon size={12} /> {!compact && <span>{label}</span>}
              {k === 'changes' && changes?.files.length > 0 && <span className="rs-badge">{changes.files.length > 99 ? '99+' : changes.files.length}</span>}
            </button>
          ))}
        </div>

        <div className="rs-content">
          {tab === 'changes' && <ChangesTab ws={ws} changes={changes} reload={loadChanges} onOpenDiff={onOpenDiff} />}
          {tab === 'files' && <FilesTab ws={ws} changes={changes} onOpenFile={onOpenFile} />}
          {tab === 'review' && <ReviewTab ws={ws} />}
        </div>
      </div>
    </aside>
  );
}

function RsResize({ width, setWidth }) {
  const [drag, setDrag] = useState(false);
  const start = (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = width;
    setDrag(true);
    document.body.classList.add('resizing');
    const move = (ev) => requestAnimationFrame(() => setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w0 - (ev.clientX - x0)))));
    const up = () => { setDrag(false); document.body.classList.remove('resizing'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  };
  return <div className={`rs-resize ${drag ? 'dragging' : ''}`} onMouseDown={start} onDoubleClick={() => setWidth(DEFAULT_WIDTH)} />;
}

function ChangesTab({ ws, changes, reload, onOpenDiff }) {
  const [menu, setMenu] = useState(null);
  const [commit, setCommit] = useState(null); // null = all changes
  const [commitFiles, setCommitFiles] = useState(null);
  const [filter, setFilter] = useState(null);
  const [tree, setTree] = useState(() => localStorage.getItem('rs-tree') === '1');
  const [collapsed, setCollapsed] = useState({});
  const [branches, setBranches] = useState(null);
  const [bq, setBq] = useState('');
  useEffect(() => localStorage.setItem('rs-tree', tree ? '1' : '0'), [tree]);
  useEffect(() => {
    if (!commit) return setCommitFiles(null);
    api.get(`/api/workspaces/${ws.id}/commit/${commit.sha}`).then(({ patch }) => {
      const files = [];
      for (const line of patch.split('\n')) if (line.startsWith('diff --git')) files.push({ path: line.split(' b/').slice(1).join(' b/'), status: 'M' });
      setCommitFiles(files);
    });
  }, [commit?.sha]);
  useEffect(() => {
    if (menu === 'base' && !branches && ws.project_id) api.get(`/api/projects/${ws.project_id}/branches`).then(setBranches).catch(() => setBranches([]));
  }, [menu]);

  if (!changes) return <div className="rs-empty">Chargement des modifications…</div>;
  const files = (commitFiles ?? changes.files).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));
  const groups = new Map();
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  const allCollapsed = groups.size > 0 && [...groups.keys()].every((k) => collapsed[k]);

  return (
    <div className="ch">
      <div className="ch-toolbar">
        <span className="menu-anchor">
          <button className="ch-commits" onClick={() => setMenu(menu === 'commits' ? null : 'commits')}>
            <span className="ch-commits-label">{commit ? commit.short : 'Commits'}</span> {!commit && <span className="muted">{changes.commits.length}</span>} <LuChevronDown size={12} />
          </button>
          <Dropdown open={menu === 'commits'} onClose={() => setMenu(null)} className="rs-menu w-288 left">
            <button className="popover-item" onClick={() => { setCommit(null); setMenu(null); }}><span className="flex-1">Tous les changements</span> {!commit && <LuCheck size={14} />}</button>
            {changes.commits.length > 0 && <div className="popover-sep" />}
            {changes.commits.map((c) => (
              <button key={c.sha} className="popover-item commit-item" onClick={() => { setCommit(c); setMenu(null); }}>
                <span className="commit-main"><span className="fade-r">{c.subject}</span><small>{c.short} · {c.author} · {ago(c.at)}</small></span>
                {commit?.sha === c.sha && <LuCheck size={14} />}
              </button>
            ))}
          </Dropdown>
        </span>
        <span className="ch-vs">vs</span>
        <span className="menu-anchor">
          <button className="ch-base" onClick={() => setMenu(menu === 'base' ? null : 'base')} disabled={!ws.project_id}>{changes.base || 'HEAD'} <LuChevronDown size={12} /></button>
          <Dropdown open={menu === 'base'} onClose={() => setMenu(null)} className="rs-menu w-256 left cmdk">
            <div className="cmdk-input small"><input autoFocus placeholder="Rechercher une branche…" value={bq} onChange={(e) => setBq(e.target.value)} /></div>
            <div className="cmdk-list">
              {(branches || []).filter((b) => !b.remote && b.name.includes(bq)).map((b) => (
                <button key={b.name} className="popover-item" onClick={() => { setMenu(null); api.patch(`/api/workspaces/${ws.id}`, { base_branch: b.name }).then(reload); }}>
                  <span className="flex-1 fade-r">{b.name}</span> {b.name === changes.base && <LuCheck size={14} />}
                </button>
              ))}
              {branches && !branches.length && <div className="empty-note">Aucune branche</div>}
            </div>
          </Dropdown>
        </span>
        <span className="flex-1" />
        <button className={`iconbtn size-7 ${filter !== null ? 'on' : ''}`} title="Filtrer les fichiers" onClick={() => setFilter(filter === null ? '' : null)}><LuSearch size={14} /></button>
        <button className="iconbtn size-7" title={tree ? 'Vue par dossier' : 'Vue arborescente'} onClick={() => setTree(!tree)}>{tree ? <LuFolder size={14} /> : <LuListTree size={14} />}</button>
        <button className="iconbtn size-7" title={allCollapsed ? 'Tout déplier' : 'Tout replier'} onClick={() => setCollapsed(allCollapsed ? {} : Object.fromEntries([...groups.keys()].map((k) => [k, true])))}>
          {allCollapsed ? <LuUnfoldVertical size={14} /> : <LuFoldVertical size={14} />}
        </button>
      </div>
      {filter !== null && <div className="ch-filter"><input autoFocus placeholder="Filtrer les fichiers…" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>}
      {!files.length ? <div className="rs-empty">Aucune modification</div> : (
        <div className="ch-list">
          {tree ? <FileTree files={files} onOpen={(f) => onOpenDiff(f.path, commit?.sha)} statusOf={(p) => files.find((f) => f.path === p)?.status} rowHeight={24} indent={8} /> : (
            [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([dir, list]) => (
              <div key={dir}>
                <button className="ch-folder" onClick={() => setCollapsed({ ...collapsed, [dir]: !collapsed[dir] })} title={dir || 'Racine'}>
                  <span className="ch-folder-path" dir="rtl">{dir || 'Racine'}</span>
                  <span className="ch-folder-count">{list.length}</span>
                </button>
                {!collapsed[dir] && list.map((f) => <ChangeRow key={f.path} f={f} hideDir onClick={() => onOpenDiff(f.path, commit?.sha)} />)}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ChangeRow({ f, onClick }) {
  const [Icon, color] = STATUS_ICON[f.status] || STATUS_ICON.M;
  return (
    <button className="ch-file" onClick={onClick} title={f.path}>
      <LuFile size={14} className="ch-file-icon" />
      <span className="ch-file-name">{f.path.split('/').pop()}</span>
      <span className="ch-file-right"><Icon size={12} style={{ color }} /></span>
    </button>
  );
}

function buildTree(paths) {
  const root = { children: new Map() };
  for (const p of paths) {
    let node = root;
    const parts = p.split('/');
    parts.forEach((part, i) => {
      if (!node.children.has(part)) node.children.set(part, { name: part, path: parts.slice(0, i + 1).join('/'), children: new Map(), file: i === parts.length - 1 });
      node = node.children.get(part);
    });
  }
  return root;
}

function FileTree({ files, onOpen, statusOf, rowHeight = 28, indent = 10, collapseAll }) {
  const root = useMemo(() => buildTree(files.map((f) => f.path ?? f)), [files]);
  const [open, setOpen] = useState({});
  useEffect(() => { if (collapseAll) setOpen({}); }, [collapseAll]);
  const sorted = (node) => [...node.children.values()].sort((a, b) => (a.file - b.file) || a.name.localeCompare(b.name));
  const render = (node, depth) => sorted(node).map((n) => {
    const st = statusOf?.(n.path);
    const isOpen = open[n.path] ?? (files.length < 60);
    return (
      <div key={n.path}>
        <button className="ft-row" style={{ height: rowHeight, paddingLeft: 12 + depth * indent, color: n.file && st ? TINT[st] : undefined }}
          onClick={() => (n.file ? onOpen({ path: n.path, status: st }) : setOpen({ ...open, [n.path]: !isOpen }))}>
          {n.file ? <LuFile size={14} className="ft-icon" /> : isOpen ? <LuFolderOpen size={14} className="ft-icon" /> : <LuFolder size={14} className="ft-icon" />}
          <span className="ft-name">{n.name}</span>
        </button>
        {!n.file && isOpen && render(n, depth + 1)}
      </div>
    );
  });
  return <div className="ft">{render(root, 0)}</div>;
}

function FilesTab({ ws, changes, onOpenFile }) {
  const [files, setFiles] = useState(null);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [collapse, setCollapse] = useState(0);
  const load = () => { setFiles(null); api.get(`/api/workspaces/${ws.id}/files`).then(setFiles).catch(() => setFiles([])); };
  useEffect(() => { load(); }, [ws.id]);
  const status = useMemo(() => new Map((changes?.files || []).map((f) => [f.path, f.status])), [changes]);
  const shown = (files || []).filter((f) => !q || f.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="ch">
      <div className="fs-head">
        {searching ? (
          <input className="fs-search-input" autoFocus placeholder="Rechercher des fichiers" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => !q && setSearching(false)} onKeyDown={(e) => e.key === 'Escape' && (setQ(''), setSearching(false))} />
        ) : (
          <button className="fs-search" onClick={() => setSearching(true)}><LuSearch size={14} /> Rechercher des fichiers</button>
        )}
        <span className="fs-actions">
          <button className="iconbtn size-7" title="Rafraîchir" onClick={load}>{files ? <LuRefreshCw size={14} /> : <LuLoaderCircle size={14} className="spin" />}</button>
          <button className="iconbtn size-7" title="Tout replier" onClick={() => setCollapse((n) => n + 1)}><LuFoldVertical size={14} /></button>
        </span>
      </div>
      {!files ? <div className="rs-empty"><LuLoaderCircle size={14} className="spin" /> Chargement des fichiers…</div> : (
        <div className="ch-list fade-y">
          {q ? shown.slice(0, 300).map((f) => (
            <button key={f} className="ft-row" style={{ height: 28, paddingLeft: 12, color: TINT[status.get(f)] }} onClick={() => onOpenFile(f)}>
              <LuFile size={14} className="ft-icon" /><span className="ft-name">{f.split('/').pop()}</span><span className="ft-dir">{f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''}</span>
            </button>
          )) : <FileTree key={collapse} files={shown} onOpen={(f) => onOpenFile(f.path)} statusOf={(p) => status.get(p)} collapseAll={collapse} />}
        </div>
      )}
    </div>
  );
}

function ReviewTab({ ws }) {
  const [pr, setPr] = useState(undefined);
  const [events, setEvents] = useState([]);
  const [openChecks, setOpenChecks] = useState(true);
  useEffect(() => { setPr(undefined); api.get(`/api/workspaces/${ws.id}/pr`).then(setPr).catch(() => setPr(null)); }, [ws.id, ws.branch]);
  useEffect(() => { api.get(`/api/workspaces/${ws.id}/events`).then(setEvents); }, [ws.id, ws.status]);
  const st = STATUS[ws.status] || STATUS.idle;
  const checks = pr?.statusCheckRollup || [];
  const passed = checks.filter((c) => (c.conclusion || c.state) === 'SUCCESS').length;
  const decision = { APPROVED: ['Approuvée', 'approved'], CHANGES_REQUESTED: ['Changements demandés', 'changes'], REVIEW_REQUIRED: ['Revue en attente', 'pending'] }[pr?.reviewDecision];

  return (
    <div className="rv">
      {pr === undefined && <div className="rs-empty">Chargement de la revue…</div>}
      {pr === null && <div className="rv-nopr">Ouvre une pull request pour voir son statut, les checks et les commentaires.</div>}
      {pr && (
        <>
          <div className="rv-head">
            <a className="rv-title" href={pr.url} target="_blank" rel="noreferrer"><VscGitPullRequestCreate size={16} /> <span className="fade-r">#{pr.number} {pr.title}</span> <LuArrowUpRight size={14} className="rv-arrow" /></a>
            {decision && <span className={`rv-pill ${decision[1]}`}>{decision[0]}</span>}
          </div>
          <div className="rv-divider" />
          <button className="rv-section" onClick={() => setOpenChecks(!openChecks)}>
            <LuChevronRight size={12} className={openChecks ? 'rot' : ''} /> <span className="rv-section-title">Checks</span> <span className="rv-count">{checks.length}</span>
            <span className="rv-section-right">{checks.length ? `${passed}/${checks.length} checks OK` : 'Aucun check'}</span>
          </button>
          {openChecks && checks.map((c, i) => {
            const r = c.conclusion || c.state;
            return (
              <a key={i} className="rv-check" href={c.detailsUrl || c.targetUrl} target="_blank" rel="noreferrer">
                {r === 'SUCCESS' ? <LuCheck size={12} className="ok" /> : r === 'FAILURE' || r === 'ERROR' ? <LuX size={12} className="ko" /> : r ? <LuMinus size={12} /> : <LuLoaderCircle size={12} className="spin pending" />}
                <span className="fade-r">{c.name || c.context}</span>
              </a>
            );
          })}
          <div className="rv-divider" />
          <div className="rv-section static"><span className="rv-section-title">Commentaires</span> <span className="rv-count">{(pr.comments || []).length}</span></div>
          {(pr.comments || []).map((c, i) => (
            <div key={i} className="rv-comment"><span className="rv-author">{c.author?.login}</span> <span className="rv-age">{c.createdAt && ago(Date.parse(c.createdAt))}</span><p>{c.body}</p></div>
          ))}
          {!(pr.comments || []).length && <div className="rv-none">Aucun commentaire pour l'instant.</div>}
        </>
      )}
      <div className="rv-divider" />
      <div className="rv-section static"><span className="rv-section-title">Session Claude</span> <span className="rv-status" style={{ color: st.color }}>{st.label} · {ago(ws.status_since)}</span></div>
      {ws.status === 'review' && (
        <button className="btn-ghost rv-done" onClick={() => api.patch(`/api/workspaces/${ws.id}`, { status: 'done' })}><LuCircleCheck size={14} /> Marquer comme terminé</button>
      )}
      <div className="rv-events">
        {events.map((e) => (
          <div key={e.id} className={`event ${e.kind}`}>
            <div className="event-head"><span>{{ created: 'Créé', prompt: 'Toi', stop: 'Claude', waiting: 'Attente', error: 'Erreur' }[e.kind] || e.kind}</span><time>{ago(e.at)}</time></div>
            {e.text && <p>{e.text}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

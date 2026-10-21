import { useEffect, useMemo, useRef, useState } from 'react';
import { LuSettings2, LuHistory, LuLightbulb, LuChevronDown, LuGitPullRequest, LuPaperclip, LuArrowUp, LuCheck, LuGitFork, LuBox, LuSearch, LuFolderOpen, LuX, LuLaptop } from 'react-icons/lu';
import { HiChevronUpDown, HiOutlineComputerDesktop } from 'react-icons/hi2';
import { GoIssueOpened, GoGitBranch, GoGlobe } from 'react-icons/go';
import { VscFolderOpened } from 'react-icons/vsc';
import { api, ago } from '../api.js';
import { ProjectThumbnail } from './ui.jsx';
import claudeLogo from '../assets/claude.svg';

const PLACEHOLDERS = [
  'Nettoie les TODO obsolètes…',
  'Ajoute des tests pour le module de paiement…',
  'Corrige le bug de redirection après login…',
  'Explique-moi comment marche le build…',
  'Refactorise les composants dupliqués…',
];
const SUGGESTIONS = [
  ['Explique-moi comment fonctionne ce repo', 'Explique-moi comment fonctionne ce repository : son architecture, ses points d\'entrée, comment le lancer et le tester. Ajoute l\'essentiel à la mémoire du projet.'],
  ['Mettre à jour la mémoire du projet', 'Parcours le projet et mets à jour la mémoire du projet (Supersept) avec les conventions, commandes utiles et décisions importantes que tu trouves. Reste concis.'],
  ['Trouve un petit bug et corrige-le', 'Trouve un petit bug dans cette codebase et corrige-le. Explique ce que tu as trouvé et comment tu l\'as vérifié.'],
];
const MODELS = [['', 'Modèle par défaut'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORTS = [['', 'Effort par défaut'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'xHigh'], ['max', 'Max']];

// Own pixel mark in Superset's style: "[SP]" on a 15×6 grid.
const MARK = [
  'XX..XX.XX...XX.',
  'X..X...X.X...X.',
  'X...X..XX....X.',
  'X....X.X.....X.',
  'X....X.X.....X.',
  'XX.XX..X....XX.',
];
function PixelMark() {
  const cell = 9.0909;
  return (
    <svg className="nws-logo" viewBox={`0 0 ${15 * cell} ${6 * cell}`} fill="currentColor" aria-hidden="true">
      {MARK.flatMap((row, y) => [...row].map((c, x) => (c === 'X' ? <rect key={`${x}-${y}`} x={x * cell} y={y * cell} width={cell + 0.02} height={cell + 0.02} /> : null)))}
    </svg>
  );
}

// Upward-opening menu anchored to its trigger (the composer sits at the bottom of the screen).
function Menu({ open, onClose, className = '', children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.parentElement?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    addEventListener('mousedown', close);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={ref} className={`popover nws-menu ${className}`}>{children}</div>;
}

function useToggle() {
  const [open, setOpen] = useState(null);
  return [open, (k) => setOpen((o) => (o === k ? null : k)), () => setOpen(null)];
}

export default function NewWorkspacePage({ projects, initialProjectId, go, onAddProject, onCreated }) {
  const [projectId, setProjectId] = useState(() => {
    if (initialProjectId === 'none') return '';
    if (initialProjectId && projects.some((p) => p.id === initialProjectId)) return initialProjectId;
    const last = localStorage.getItem('nws-project');
    return last === '' ? '' : projects.some((p) => p.id === last) ? last : projects[0]?.id ?? '';
  });
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(() => localStorage.getItem('nws-model') || '');
  const [effort, setEffort] = useState(() => localStorage.getItem('nws-effort') || '');
  const [mode, setMode] = useState(() => localStorage.getItem('nws-mode') || 'worktree');
  const [branches, setBranches] = useState(null);
  const [base, setBase] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [links, setLinks] = useState([]); // { kind: 'issue'|'pr', number, title, body?, headRefName? }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ph, setPh] = useState(0);
  const [open, toggle, close] = useToggle();
  const editor = useRef(null);
  const fileInput = useRef(null);
  const project = projects.find((p) => p.id === projectId) || null;
  // Projects may arrive after the first render: pick the remembered/first one then.
  const picked = useRef(initialProjectId === 'none' || localStorage.getItem('nws-project') === '' || !!projectId);
  useEffect(() => {
    if (picked.current || !projects.length) return;
    picked.current = true;
    const last = localStorage.getItem('nws-project');
    setProjectId(projects.some((p) => p.id === last) ? last : projects[0].id);
  }, [projects]);
  const isRepo = !!branches?.length;

  useEffect(() => { const t = setInterval(() => setPh((n) => (n + 1) % PLACEHOLDERS.length), 5000); return () => clearInterval(t); }, []);
  useEffect(() => { editor.current?.focus(); }, []);
  useEffect(() => { if (projects.length) localStorage.setItem('nws-project', projectId); }, [projectId, projects.length]);
  useEffect(() => localStorage.setItem('nws-model', model), [model]);
  useEffect(() => localStorage.setItem('nws-effort', effort), [effort]);
  useEffect(() => localStorage.setItem('nws-mode', mode), [mode]);
  useEffect(() => {
    setBranches(null);
    setLinks([]);
    if (!projectId) return setBranches([]);
    api.get(`/api/projects/${projectId}/branches`).then((b) => {
      setBranches(b);
      setBase((b.find((x) => x.isDefault) || b[0])?.name || '');
    }).catch(() => setBranches([]));
  }, [projectId]);
  useEffect(() => {
    const el = editor.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(200, Math.max(80, el.scrollHeight)) + 'px';
  }, [prompt]);

  const effectiveMode = project && isRepo ? mode : 'local';
  const pr = links.find((l) => l.kind === 'pr');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let full = prompt.trim();
    for (const l of links.filter((x) => x.kind === 'issue')) full += `\n\nIssue GitHub #${l.number} — ${l.title}\n${l.url}\n${(l.body || '').slice(0, 4000)}`;
    if (pr) full += `\n\nTravaille à partir de la PR #${pr.number} — ${pr.title} (${pr.url}).`;
    if (attachments.length) full += `\n\nPièces jointes : ${attachments.map((a) => '@' + a.path).join(' ')}`;
    try {
      const w = await api.post('/api/workspaces', {
        projectId: projectId || null,
        prompt: full,
        name: prompt.trim().replace(/\s+/g, ' ').slice(0, 80) || (pr ? `PR #${pr.number}` : ''),
        worktree: effectiveMode === 'worktree',
        baseBranch: base,
        prBranch: effectiveMode === 'worktree' ? pr?.headRefName : undefined,
        model, effort,
      });
      setPrompt('');
      onCreated(w);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const upload = async (files) => {
    for (const f of [...files].slice(0, 5 - attachments.length)) {
      if (f.size > 10 * 1024 * 1024) { setError(`${f.name} dépasse 10 Mo`); continue; }
      const res = await fetch(`/api/attachments?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const a = await res.json();
      setAttachments((list) => [...list, a]);
    }
  };
  const [dragging, setDragging] = useState(false);

  return (
    <div className="nws-root"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => e.target === e.currentTarget && setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}>
      <div className="nws-topbar">
        {project && <button className="nws-top-btn" title={`Mémoire de ${project.name}`} onClick={() => go({ kind: 'memory', id: project.id })}><LuSettings2 size={16} /></button>}
        <span className="menu-anchor">
          <button className="nws-top-btn" title="Prompts précédents" onClick={() => toggle('history')}><LuHistory size={16} /></button>
          {open === 'history' && <PromptHistory onPick={(t) => { setPrompt(t); close(); editor.current?.focus(); }} onClose={close} />}
        </span>
      </div>

      <div className="nws-hero">
        <PixelMark />
        <h1 className="nws-title">Que construisons-nous ensuite ?</h1>
        <span className="nws-star-wrap">
          <button className="nws-star" onClick={() => go({ kind: 'history' })}><LuHistory size={14} /> <span>REPRENDRE UNE CONVERSATION</span></button>
          <span className="nws-corner tl" /><span className="nws-corner tr" /><span className="nws-corner bl" /><span className="nws-corner br" />
        </span>
      </div>

      <div className="nws-bottom">
        {!prompt && (
          <div className="nws-suggestions">
            {SUGGESTIONS.map(([label, text]) => (
              <button key={label} className="nws-suggestion" onClick={() => { setPrompt(text); editor.current?.focus(); }}>
                <LuLightbulb size={14} /> {label}
              </button>
            ))}
          </div>
        )}

        <form className="nws-card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {(attachments.length > 0 || links.length > 0) && (
            <div className="nws-chips">
              {links.map((l) => (
                <span key={l.kind + l.number} className="nws-chip">
                  {l.kind === 'pr' ? <LuGitPullRequest size={12} /> : <GoIssueOpened size={12} />} #{l.number} <span className="fade-r">{l.title}</span>
                  <button type="button" onClick={() => setLinks(links.filter((x) => x !== l))}><LuX size={12} /></button>
                </span>
              ))}
              {attachments.map((a) => (
                <span key={a.path} className="nws-chip"><LuPaperclip size={12} /> <span className="fade-r">{a.name}</span>
                  <button type="button" onClick={() => setAttachments(attachments.filter((x) => x !== a))}><LuX size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="nws-editor">
            <textarea ref={editor} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) { e.preventDefault(); submit(); } }} />
            {!prompt && <span key={ph} className="nws-placeholder">{PLACEHOLDERS[ph]}</span>}
          </div>
          <div className="nws-footer" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); editor.current?.focus(); } }}>
            <div className="nws-tools">
              <span className="menu-anchor">
                <button type="button" className="nws-pill" onClick={() => toggle('agent')}><img src={claudeLogo} alt="" className="nws-pill-logo" /> Claude <LuChevronDown size={16} className="nws-chev" /></button>
                <Menu open={open === 'agent'} onClose={close}>
                  <button type="button" className="popover-item checked" onClick={close}><img src={claudeLogo} alt="" className="preset-icon" /> Claude</button>
                </Menu>
              </span>
              <PillSelect id="model" value={model} options={MODELS} onChange={setModel} open={open} toggle={toggle} close={close} />
              <PillSelect id="effort" value={effort} options={EFFORTS} onChange={setEffort} open={open} toggle={toggle} close={close} />
            </div>
            <div className="nws-tools right">
              {project && isRepo && (
                <>
                  <span className="menu-anchor">
                    <button type="button" className="nws-round" title="Lier une issue GitHub" onClick={() => toggle('issue')}><GoIssueOpened size={14} /></button>
                    {open === 'issue' && <GitHubPicker projectId={projectId} kind="issues" onClose={close} onPick={(i) => { setLinks((l) => [...l.filter((x) => !(x.kind === 'issue' && x.number === i.number)), { ...i, kind: 'issue' }]); close(); }} />}
                  </span>
                  <span className="menu-anchor">
                    <button type="button" className="nws-round" title="Partir d'une pull request" onClick={() => toggle('pr')}><LuGitPullRequest size={14} /></button>
                    {open === 'pr' && <GitHubPicker projectId={projectId} kind="prs" onClose={close} onPick={(p) => { setLinks((l) => [...l.filter((x) => x.kind !== 'pr'), { ...p, kind: 'pr' }]); setMode('worktree'); close(); }} />}
                  </span>
                </>
              )}
              <button type="button" className="nws-round" title="Ajouter une pièce jointe" onClick={() => fileInput.current?.click()}><LuPaperclip size={14} /></button>
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
              <button type="submit" className="nws-submit" title="Lancer (⌘↵)" disabled={busy}><LuArrowUp size={14} /></button>
            </div>
          </div>
        </form>

        <div className="nws-pickers">
          <div className="nws-pickers-left">
            <span className="menu-anchor">
              <button type="button" className="nws-picker" onClick={() => toggle('device')}><HiOutlineComputerDesktop size={16} /> <span>Cet appareil</span> <HiChevronUpDown size={12} /></button>
              <Menu open={open === 'device'} onClose={close} className="w-288">
                <button type="button" className="popover-item checked" onClick={close}><HiOutlineComputerDesktop size={16} /> Cet appareil</button>
              </Menu>
            </span>
            <span className="menu-anchor">
              <button type="button" className="nws-picker" onClick={() => toggle('project')}>
                {project ? <ProjectThumbnail project={project} /> : <LuBox size={16} />}
                <span className="nws-picker-label">{project ? project.name : 'Aucun projet'}</span> <HiChevronUpDown size={12} />
              </button>
              {open === 'project' && (
                <ProjectPicker projects={projects} value={projectId} onClose={close}
                  onPick={(id) => { picked.current = true; setProjectId(id); close(); }} onAdd={() => { close(); onAddProject(); }} />
              )}
            </span>
            {project && isRepo && (
              <span className="menu-anchor">
                <button type="button" className="nws-picker" onClick={() => toggle('mode')}>
                  {effectiveMode === 'worktree' ? <LuGitFork size={12} /> : <LuLaptop size={12} />} <span>{effectiveMode === 'worktree' ? 'Worktree' : 'Local'}</span> <HiChevronUpDown size={12} />
                </button>
                <Menu open={open === 'mode'} onClose={close} className="w-288">
                  <button type="button" className={`popover-item ${mode === 'worktree' ? 'checked' : ''}`} onClick={() => { setMode('worktree'); close(); }}>
                    <LuGitFork size={16} /> <span className="nws-item-2l"><span>Worktree</span><small>Nouvelle branche isolée, ton checkout reste intact</small></span>
                  </button>
                  <button type="button" className={`popover-item ${mode === 'local' ? 'checked' : ''}`} onClick={() => { setMode('local'); close(); }}>
                    <LuLaptop size={16} /> <span className="nws-item-2l"><span>Local</span><small>Travaille directement dans {project.path.replace(/^\/Users\/[^/]+/, '~')}</small></span>
                  </button>
                </Menu>
              </span>
            )}
            {project && isRepo && effectiveMode === 'worktree' && !pr && (
              <span className="menu-anchor">
                <button type="button" className="nws-picker" onClick={() => toggle('branch')}><GoGitBranch size={12} /> <span className="mono">{base || '…'}</span> <HiChevronUpDown size={12} /></button>
                {open === 'branch' && <BranchPicker branches={branches} value={base} onClose={close} onPick={(b) => { setBase(b); close(); }} />}
              </span>
            )}
            {pr && <span className="nws-picker static"><LuGitPullRequest size={12} /> <span>basé sur la PR #{pr.number}</span></span>}
          </div>
        </div>
        {error && <div className="error-bar" onClick={() => setError(null)}>{error}</div>}
      </div>
      {dragging && <div className="nws-drop"><span>Déposer pour joindre</span></div>}
    </div>
  );
}

function PillSelect({ id, value, options, onChange, open, toggle, close }) {
  const label = options.find(([v]) => v === value)?.[1] ?? options[0][1];
  return (
    <span className="menu-anchor">
      <button type="button" className="nws-pill" onClick={() => toggle(id)}>{label} <LuChevronDown size={16} className="nws-chev" /></button>
      <Menu open={open === id} onClose={close}>
        {options.map(([v, l]) => (
          <button key={v} type="button" className={`popover-item select-item ${v === value ? 'selected' : ''}`} onClick={() => { onChange(v); close(); }}>
            {l} {v === value && <LuCheck size={16} className="select-check" />}
          </button>
        ))}
      </Menu>
    </span>
  );
}

function SearchList({ placeholder, width, onClose, children, query, setQuery }) {
  const ref = useRef(null);
  useEffect(() => {
    const closeIt = (e) => !ref.current?.parentElement?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    addEventListener('mousedown', closeIt);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', closeIt); removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div ref={ref} className="popover nws-menu cmdk" style={{ width }}>
      <div className="cmdk-input"><LuSearch size={16} /><input autoFocus placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <div className="cmdk-list">{children}</div>
    </div>
  );
}

function ProjectPicker({ projects, value, onPick, onAdd, onClose }) {
  const [q, setQ] = useState('');
  const list = projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <SearchList placeholder="Rechercher un projet…" width={240} onClose={onClose} query={q} setQuery={setQ}>
      <button type="button" className={`popover-item ${value === '' ? 'checked' : ''}`} onClick={() => onPick('')}><LuBox size={16} /> Aucun projet <span className="cmdk-tag">Session</span></button>
      {list.map((p) => (
        <button key={p.id} type="button" className={`popover-item ${value === p.id ? 'checked' : ''}`} onClick={() => onPick(p.id)}><ProjectThumbnail project={p} /> <span className="fade-r">{p.name}</span></button>
      ))}
      <div className="popover-sep" />
      <button type="button" className="popover-item" onClick={onAdd}><VscFolderOpened size={16} /> Ouvrir un dossier…</button>
    </SearchList>
  );
}

function BranchPicker({ branches, value, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const list = (branches || []).filter((b) => (tab === 'all' || b.worktree) && b.name.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  return (
    <SearchList placeholder="Rechercher une branche…" width={440} onClose={onClose} query={q} setQuery={setQ}>
      <div className="cmdk-tabs">
        <button type="button" className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>Toutes</button>
        <button type="button" className={tab === 'worktree' ? 'on' : ''} onClick={() => setTab('worktree')}>Worktree</button>
      </div>
      {list.map((b) => (
        <button key={b.name} type="button" className={`branch-row ${value === b.name ? 'selected' : ''}`} onClick={() => onPick(b.name)}>
          {b.worktree ? <LuFolderOpen size={16} className="branch-wt" /> : b.remote ? <GoGlobe size={16} className="branch-remote" /> : <GoGitBranch size={16} />}
          <span className="branch-main">
            <span className="branch-name fade-r">{b.name}</span>
            <span className="branch-sub">{[b.at ? ago(b.at) : null, b.isDefault && 'défaut', b.remote && 'distante', b.worktree && 'worktree'].filter(Boolean).join(' · ')}</span>
          </span>
          {value === b.name && <LuCheck size={14} />}
        </button>
      ))}
      {!list.length && <div className="empty-note">Aucune branche</div>}
    </SearchList>
  );
}

function GitHubPicker({ projectId, kind, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get(`/api/projects/${projectId}/github/${kind}`).then(setItems, (e) => setError(e.message)); }, [projectId, kind]);
  const list = (items || []).filter((i) => !q || i.title.toLowerCase().includes(q.toLowerCase()) || String(i.number).includes(q));
  return (
    <SearchList placeholder={kind === 'prs' ? 'Rechercher une pull request…' : 'Rechercher une issue…'} width={440} onClose={onClose} query={q} setQuery={setQ}>
      {error && <div className="empty-note">{error}</div>}
      {!items && !error && <div className="empty-note">Chargement via gh…</div>}
      {list.map((i) => (
        <button key={i.number} type="button" className="branch-row" onClick={() => onPick(i)}>
          {kind === 'prs' ? <LuGitPullRequest size={16} /> : <GoIssueOpened size={16} />}
          <span className="branch-main">
            <span className="branch-name fade-r">#{i.number} {i.title}</span>
            <span className="branch-sub">{[i.author?.login, i.headRefName, i.updatedAt && ago(Date.parse(i.updatedAt))].filter(Boolean).join(' · ')}</span>
          </span>
        </button>
      ))}
      {items && !list.length && <div className="empty-note">{kind === 'prs' ? 'Aucune pull request ouverte' : 'Aucune issue ouverte'}</div>}
    </SearchList>
  );
}

function PromptHistory({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  useEffect(() => { api.get('/api/prompts').then(setItems); }, []);
  const list = items.filter((i) => i.text.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="nws-history-anchor">
      <SearchList placeholder="Rechercher dans tes prompts…" width={440} onClose={onClose} query={q} setQuery={setQ}>
        <div className="cmdk-heading">Prompts récents</div>
        {list.map((i) => (
          <button key={i.text} type="button" className="history-row" onClick={() => onPick(i.text)}>
            <span className="history-text">{i.text}</span>
            <span className="branch-sub">{ago(i.at)}</span>
          </button>
        ))}
        {!list.length && <div className="empty-note">Les prompts que tu envoies apparaîtront ici.</div>}
      </SearchList>
    </div>
  );
}

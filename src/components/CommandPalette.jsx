import { useEffect, useMemo, useRef, useState } from 'react';
import { LuSearch, LuPlus, LuLayers, LuBrain, LuHistory, LuSettings } from 'react-icons/lu';
import { api, ago } from '../api.js';
import { WorkspaceIcon, ProjectThumbnail } from './ui.jsx';

// ⌘K: jump to a workspace, a project, a page, or an old Claude Code conversation.
export default function CommandPalette({ data, projectsById, go, onClose, onNew }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [history, setHistory] = useState([]);
  const list = useRef(null);
  useEffect(() => { api.get('/api/history').then(setHistory).catch(() => {}); }, []);

  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const has = (s) => !t || (s || '').toLowerCase().includes(t);
    const out = [];
    const actions = [
      { label: 'Nouvel espace de travail', icon: <LuPlus size={14} />, run: onNew, kbd: '⌘N' },
      { label: 'Espaces de travail', icon: <LuLayers size={14} />, run: () => go({ kind: 'board' }) },
      { label: 'Mémoire', icon: <LuBrain size={14} />, run: () => go({ kind: 'memory' }) },
      { label: 'Historique', icon: <LuHistory size={14} />, run: () => go({ kind: 'history' }) },
      { label: 'Réglages', icon: <LuSettings size={14} />, run: () => go({ kind: 'settings' }), kbd: '⌘,' },
    ];
    const ws = data.workspaces.filter((w) => !w.archived && (has(w.name) || has(w.branch) || has(projectsById[w.project_id]?.name)));
    if (ws.length) out.push({ group: 'Espaces de travail' }, ...ws.slice(0, 12).map((w) => ({
      label: w.name, hint: projectsById[w.project_id]?.name ?? 'Session', icon: <WorkspaceIcon ws={w} />, run: () => go({ kind: 'ws', id: w.id }),
    })));
    const ps = data.projects.filter((p) => has(p.name));
    if (ps.length) out.push({ group: 'Projets' }, ...ps.map((p) => ({ label: p.name, icon: <ProjectThumbnail project={p} />, run: () => go({ kind: 'project', id: p.id }) })));
    const acts = actions.filter((a) => has(a.label));
    if (acts.length) out.push({ group: 'Actions' }, ...acts);
    if (t) {
      const hs = history.filter((h) => !h.imported && (has(h.title) || has(h.firstPrompt))).slice(0, 8);
      if (hs.length) out.push({ group: 'Conversations Claude Code' }, ...hs.map((h) => ({
        label: h.title, hint: ago(h.updatedAt), icon: <LuHistory size={14} />, run: () => go({ kind: 'history', id: h.sessionId }),
      })));
    }
    return out;
  }, [q, data, history]);
  const selectable = items.filter((i) => !i.group);
  useEffect(() => setSel(0), [q]);
  useEffect(() => { list.current?.querySelector('.cmd-item.sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const onKey = (e) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(selectable.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter' && selectable[sel]) { onClose(); selectable[sel].run(); }
  };

  let idx = -1;
  return (
    <div className="overlay cmd-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmd">
        <div className="cmd-input">
          <LuSearch size={16} strokeWidth={1.5} />
          <input autoFocus placeholder="Rechercher un espace, un projet, une conversation…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
        </div>
        <div className="cmd-list" ref={list}>
          {items.map((it, i) => {
            if (it.group) return <div key={'g' + i} className="cmd-group">{it.group}</div>;
            idx++;
            const me = idx;
            return (
              <button key={i} className={`cmd-item ${me === sel ? 'sel' : ''}`} onMouseMove={() => setSel(me)} onClick={() => { onClose(); it.run(); }}>
                <span className="cmd-icon">{it.icon}</span>
                <span className="cmd-label fade-r">{it.label}</span>
                {it.hint && <span className="cmd-hint">{it.hint}</span>}
                {it.kbd && <kbd className="sb-kbd visible">{it.kbd}</kbd>}
              </button>
            );
          })}
          {!selectable.length && <div className="empty-note">Aucun résultat</div>}
        </div>
      </div>
    </div>
  );
}

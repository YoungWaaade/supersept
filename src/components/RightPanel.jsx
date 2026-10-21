import { useEffect, useState } from 'react';
import { LuGitBranch, LuExternalLink, LuArchive, LuArchiveRestore, LuTrash2, LuCircleCheck, LuChevronDown } from 'react-icons/lu';
import { api, ago, STATUS } from '../api.js';
import { disposeTerminals } from './Terminal.jsx';
import DiffView from './DiffView.jsx';
import { DiffStats } from './ui.jsx';
import { Dropdown } from './WorkspaceView.jsx';

const OPEN_IN = [
  ['vscode', 'VS Code'],
  ['cursor', 'Cursor'],
  ['finder', 'Finder'],
  ['terminal', 'Terminal'],
  ['iterm', 'iTerm'],
];

export async function deleteWorkspace(ws, go) {
  const msg = ws.is_worktree
    ? `Supprimer « ${ws.name} » ?\n\nLe worktree ${ws.cwd} sera supprimé. La branche ${ws.branch} est conservée.`
    : `Supprimer « ${ws.name} » ? La conversation reste dans l'historique Claude Code.`;
  if (!confirm(msg)) return false;
  await api.del(`/api/workspaces/${ws.id}${ws.is_worktree ? '?removeWorktree=1' : ''}`);
  disposeTerminals(ws.id + ':');
  go(ws.project_id ? { kind: 'project', id: ws.project_id } : { kind: 'board' });
  return true;
}

export default function RightPanel({ ws, project, go }) {
  const [tab, setTab] = useState('changes');
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState(null);
  const act = (fn) => { setError(null); Promise.resolve(fn()).catch((e) => setError(e.message)); };
  const st = STATUS[ws.status] || STATUS.idle;

  return (
    <aside className="rp">
      <div className="rp-head">
        <div className="rp-title">
          <span className="rp-name fade-r">{ws.name}</span>
          <span className="rp-status" style={{ '--c': st.color }}>{st.label} · {ago(ws.status_since)}</span>
        </div>
        <div className="rp-meta">
          {ws.branch && <span className="rp-chip"><LuGitBranch size={12} /> {ws.branch}{ws.base_branch && <span className="muted"> ← {ws.base_branch}</span>}</span>}
          <span className="rp-chip muted fade-r" title={ws.cwd}>{ws.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
        </div>
        <div className="rp-actions">
          <span className="menu-anchor">
            <button className="btn-ghost" onClick={() => setMenu(!menu)}><LuExternalLink size={14} /> Ouvrir <LuChevronDown size={12} /></button>
            {menu && (
              <Dropdown onClose={() => setMenu(false)}>
                {OPEN_IN.map(([k, label]) => (
                  <button key={k} className="popover-item" onClick={() => { setMenu(false); act(() => api.post(`/api/workspaces/${ws.id}/open`, { app: k })); }}>{label}</button>
                ))}
              </Dropdown>
            )}
          </span>
          {ws.status === 'review' && (
            <button className="btn-ghost" title="Marquer comme terminé" onClick={() => act(() => api.patch(`/api/workspaces/${ws.id}`, { status: 'done' }))}><LuCircleCheck size={14} /> Terminé</button>
          )}
          <span className="flex-1" />
          <button className="iconbtn size-7" title={ws.archived ? 'Désarchiver' : 'Archiver'} onClick={() => act(() => api.patch(`/api/workspaces/${ws.id}`, { archived: !ws.archived }))}>
            {ws.archived ? <LuArchiveRestore size={14} /> : <LuArchive size={14} />}
          </button>
          <button className="iconbtn size-7 danger" title="Supprimer" onClick={() => act(() => deleteWorkspace(ws, go))}><LuTrash2 size={14} /></button>
        </div>
        {error && <div className="error-bar" onClick={() => setError(null)}>{error}</div>}
      </div>

      {(ws.status === 'review' || ws.status === 'waiting') && ws.last_message && (
        <div className={`rp-last ${ws.status}`}>
          <span className="rp-last-label">{ws.status === 'waiting' ? 'Attend ton input' : 'Dernier message'}</span>
          <p>{ws.last_message}</p>
        </div>
      )}

      <div className="rp-tabs">
        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Changements <DiffStats stats={ws.stats} active /></button>
        <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activité</button>
      </div>
      <div className="rp-body">
        {tab === 'changes' ? <DiffView ws={ws} /> : <Activity ws={ws} />}
      </div>
    </aside>
  );
}

function Activity({ ws }) {
  const [events, setEvents] = useState([]);
  useEffect(() => { api.get(`/api/workspaces/${ws.id}/events`).then(setEvents); }, [ws.id, ws.status]);
  const LABEL = { created: 'Créé', prompt: 'Toi', stop: 'Claude', waiting: 'Attente' };
  return (
    <div className="activity">
      {events.map((e) => (
        <div key={e.id} className={`event ${e.kind}`}>
          <div className="event-head"><span>{LABEL[e.kind] || e.kind}</span><time>{new Date(e.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>
          {e.text && <p>{e.text}</p>}
        </div>
      ))}
      {!events.length && <p className="empty-note">Aucune activité pour l'instant.</p>}
    </div>
  );
}

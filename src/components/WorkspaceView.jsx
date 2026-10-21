import { useEffect, useRef, useState } from 'react';
import { api, ago, STATUS } from '../api.js';
import Terminal, { restartTerminal, disposeTerminals } from './Terminal.jsx';
import DiffView from './DiffView.jsx';
import { Icon, StatusDot, Stats } from './ui.jsx';

const OPEN_IN = [
  ['vscode', 'VS Code'],
  ['cursor', 'Cursor'],
  ['finder', 'Finder'],
  ['terminal', 'Terminal'],
  ['iterm', 'iTerm'],
];

export default function WorkspaceView({ ws, project, go }) {
  const [tab, setTab] = useState('agent');
  const [shellOpened, setShellOpened] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(null);
  const nameRef = useRef(null);

  useEffect(() => { if (tab === 'shell') setShellOpened(true); }, [tab]);

  const act = async (fn) => {
    setError(null);
    try { await fn(); } catch (e) { setError(e.message); }
  };
  const rename = () => {
    const name = nameRef.current.value.trim();
    setEditing(false);
    if (name && name !== ws.name) act(() => api.patch(`/api/workspaces/${ws.id}`, { name }));
  };
  const remove = () => act(async () => {
    const msg = ws.is_worktree
      ? `Supprimer « ${ws.name} » ?\n\nOK = supprimer aussi le worktree (${ws.cwd}). La branche ${ws.branch} est conservée.`
      : `Supprimer « ${ws.name} » ? La conversation reste dans l'historique Claude Code.`;
    if (!confirm(msg)) return;
    await api.del(`/api/workspaces/${ws.id}${ws.is_worktree ? '?removeWorktree=1' : ''}`);
    disposeTerminals(ws.id + ':');
    go({ kind: 'project', id: ws.project_id });
  });

  const st = STATUS[ws.status] || STATUS.idle;

  return (
    <div className="wsview">
      <header className="wshead">
        <div className="crumbs">
          <a onClick={() => go({ kind: 'project', id: project.id })}>
            <span className="swatch" style={{ background: project.color }} /> {project.name}
          </a>
          <span className="sep">/</span>
          {editing ? (
            <input ref={nameRef} className="rename" defaultValue={ws.name} autoFocus onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && rename()} />
          ) : (
            <h2 onDoubleClick={() => setEditing(true)} title="Double-clic pour renommer">{ws.name}</h2>
          )}
          <span className="status-chip" style={{ '--c': st.color }}>
            <StatusDot status={ws.status} running={ws.running} /> {st.label} · {ago(ws.status_since)}
          </span>
        </div>
        <div className="meta">
          {ws.branch && (
            <span className="chip mono"><Icon name="branch" /> {ws.branch}{ws.base_branch && <span className="dim"> ← {ws.base_branch}</span>}</span>
          )}
          <span className="chip mono dim" title={ws.cwd}>{ws.cwd.replace(/^\/Users\/[^/]+/, '~')}</span>
        </div>
        <div className="actions">
          {ws.status === 'review' && (
            <button className="ghost" onClick={() => act(() => api.patch(`/api/workspaces/${ws.id}`, { status: 'done' }))}><Icon name="check" /> Terminé</button>
          )}
          <div className="menu-wrap">
            <button className="ghost" onClick={() => setMenu(!menu)}><Icon name="open" /> Ouvrir <Icon name="down" /></button>
            {menu && (
              <div className="menu" onMouseLeave={() => setMenu(false)}>
                {OPEN_IN.map(([k, label]) => (
                  <button key={k} onClick={() => { setMenu(false); act(() => api.post(`/api/workspaces/${ws.id}/open`, { app: k })); }}>{label}</button>
                ))}
              </div>
            )}
          </div>
          {ws.running ? (
            <button className="ghost" title="Arrêter l'agent" onClick={() => act(() => api.post(`/api/workspaces/${ws.id}/stop`))}><Icon name="stop" /></button>
          ) : (
            <button className="ghost" title="Relancer / reprendre la session" onClick={() => { setTab('agent'); restartTerminal(`${ws.id}:agent`); }}><Icon name="play" /></button>
          )}
          <button className="ghost" title={ws.archived ? 'Désarchiver' : 'Archiver'} onClick={() => act(() => api.patch(`/api/workspaces/${ws.id}`, { archived: !ws.archived }))}><Icon name="archive" /></button>
          <button className="ghost danger" title="Supprimer" onClick={remove}><Icon name="trash" /></button>
        </div>
      </header>

      {error && <div className="error-bar" onClick={() => setError(null)}>{error}</div>}

      {(ws.status === 'review' || ws.status === 'waiting') && ws.last_message && (
        <div className={`last-msg ${ws.status}`}>
          <span className="label">{ws.status === 'waiting' ? 'Attend ton input' : 'Dernier message'}</span>
          <p>{ws.last_message}</p>
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'agent' ? 'on' : ''} onClick={() => setTab('agent')}><Icon name="agent" /> Claude</button>
        <button className={tab === 'shell' ? 'on' : ''} onClick={() => setTab('shell')}><Icon name="terminal" /> Terminal</button>
        <button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}><Icon name="diff" /> Changements <Stats stats={ws.stats} /></button>
        <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}><Icon name="history" /> Activité</button>
        {!ws.running && tab === 'agent' && (
          <span className="tab-note">
            Session arrêtée — <a onClick={() => restartTerminal(`${ws.id}:agent`)}>{ws.has_conversation ? 'reprendre la conversation' : 'relancer'}</a>
          </span>
        )}
      </div>

      <div className="panes">
        <div className="pane" style={{ display: tab === 'agent' ? 'flex' : 'none' }}>
          <Terminal termKey={`${ws.id}:agent`} active={tab === 'agent'} />
        </div>
        {shellOpened && (
          <div className="pane" style={{ display: tab === 'shell' ? 'flex' : 'none' }}>
            <Terminal termKey={`${ws.id}:shell`} active={tab === 'shell'} />
          </div>
        )}
        {tab === 'diff' && <div className="pane scroll"><DiffView ws={ws} /></div>}
        {tab === 'activity' && <div className="pane scroll"><Activity ws={ws} /></div>}
      </div>
    </div>
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
          <div className="event-head"><span>{LABEL[e.kind] || e.kind}</span><time>{new Date(e.at).toLocaleString('fr-FR')}</time></div>
          {e.text && <p>{e.text}</p>}
        </div>
      ))}
      {!events.length && <p className="dim">Aucune activité pour l'instant.</p>}
    </div>
  );
}

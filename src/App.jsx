import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, wsUrl, STATUS } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import WorkspaceView from './components/WorkspaceView.jsx';
import Board from './components/Board.jsx';
import ProjectView from './components/ProjectView.jsx';
import NewWorkspace from './components/NewWorkspace.jsx';
import AddProject from './components/AddProject.jsx';
import Empty from './components/Empty.jsx';

function parseHash() {
  const [, kind, id] = location.hash.split('/');
  return kind ? { kind, id } : { kind: 'board' };
}

export default function App() {
  const [data, setData] = useState({ projects: [], workspaces: [] });
  const [route, setRoute] = useState(parseHash);
  const [modal, setModal] = useState(null); // { type: 'new-ws', projectId } | { type: 'add-project' }
  const [connected, setConnected] = useState(false);
  const routeRef = useRef(route);
  routeRef.current = route;

  const load = useCallback(() => api.get('/api/state').then(setData), []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let sock, timer, dead = false;
    const connect = () => {
      sock = new WebSocket(wsUrl('/ws/events'));
      sock.onopen = () => { setConnected(true); load(); };
      sock.onclose = () => { setConnected(false); if (!dead) timer = setTimeout(connect, 1500); };
      sock.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'reload') load();
        if (m.type === 'workspace') {
          setData((d) => {
            const prev = d.workspaces.find((w) => w.id === m.workspace.id);
            if (prev && prev.status !== m.workspace.status) notify(m.workspace, d.projects, routeRef.current);
            return {
              ...d,
              workspaces: prev ? d.workspaces.map((w) => (w.id === m.workspace.id ? m.workspace : w)) : [m.workspace, ...d.workspaces],
            };
          });
        }
      };
    };
    connect();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    return () => { dead = true; clearTimeout(timer); sock?.close(); };
  }, [load]);

  const attention = data.workspaces.filter((w) => !w.archived && (w.status === 'review' || w.status === 'waiting')).length;
  useEffect(() => { document.title = attention ? `(${attention}) Claude Hub` : 'Claude Hub'; }, [attention]);

  const go = (r) => { location.hash = r.kind === 'board' ? '#/board' : `#/${r.kind}/${r.id}`; };

  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const active = data.workspaces.filter((w) => !w.archived);
      if (e.key === 'n' && !e.shiftKey) {
        e.preventDefault();
        const cur = active.find((w) => w.id === routeRef.current.id);
        setModal({ type: 'new-ws', projectId: cur?.project_id || routeRef.current.id || data.projects[0]?.id });
      } else if (/^[1-9]$/.test(e.key) && e.altKey) {
        const w = active[Number(e.key) - 1];
        if (w) { e.preventDefault(); go({ kind: 'ws', id: w.id }); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [data]);

  const projectsById = useMemo(() => Object.fromEntries(data.projects.map((p) => [p.id, p])), [data.projects]);
  const current = route.kind === 'ws' ? data.workspaces.find((w) => w.id === route.id) : null;

  let main;
  if (!data.projects.length) main = <Empty onAdd={() => setModal({ type: 'add-project' })} />;
  else if (route.kind === 'ws' && current) main = <WorkspaceView key={current.id} ws={current} project={projectsById[current.project_id]} go={go} />;
  else if (route.kind === 'project' && projectsById[route.id])
    main = <ProjectView key={route.id} project={projectsById[route.id]} workspaces={data.workspaces.filter((w) => w.project_id === route.id)} go={go} onNew={() => setModal({ type: 'new-ws', projectId: route.id })} />;
  else main = <Board data={data} projectsById={projectsById} go={go} />;

  return (
    <div className="app">
      <Sidebar
        data={data}
        route={route}
        go={go}
        connected={connected}
        onNew={(projectId) => setModal({ type: 'new-ws', projectId })}
        onAddProject={() => setModal({ type: 'add-project' })}
      />
      <main className="main">{main}</main>
      {modal?.type === 'new-ws' && (
        <NewWorkspace
          projects={data.projects}
          projectId={modal.projectId}
          onClose={() => setModal(null)}
          onCreated={(w) => { setModal(null); load().then(() => go({ kind: 'ws', id: w.id })); }}
        />
      )}
      {modal?.type === 'add-project' && (
        <AddProject onClose={() => setModal(null)} onAdded={(p) => { setModal(null); load().then(() => go({ kind: 'project', id: p.id })); }} />
      )}
    </div>
  );
}

function notify(ws, projects, route) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (ws.status !== 'review' && ws.status !== 'waiting') return;
  if (!document.hidden && route.kind === 'ws' && route.id === ws.id) return;
  const project = projects.find((p) => p.id === ws.project_id);
  const n = new Notification(`${project?.name ?? ''} · ${ws.name}`, {
    body: ws.status === 'waiting' ? ws.last_message || STATUS.waiting.label : (ws.last_message || 'Terminé, à revoir').slice(0, 180),
    tag: ws.id,
  });
  n.onclick = () => { focus(); location.hash = `#/ws/${ws.id}`; n.close(); };
}

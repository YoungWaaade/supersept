import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, wsUrl, STATUS } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import WorkspaceView from './components/WorkspaceView.jsx';
import Board from './components/Board.jsx';
import ProjectMenu from './components/ProjectMenu.jsx';
import { MemoryPage, HistoryPage, SettingsPage } from './components/Pages.jsx';
import NewWorkspacePage from './components/NewWorkspacePage.jsx';
import AddProject from './components/AddProject.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import WorkspaceMenu from './components/WorkspaceMenu.jsx';
import Empty from './components/Empty.jsx';

function parseHash() {
  const [, kind, id] = location.hash.split('/');
  return kind ? { kind, id } : { kind: 'board' };
}

export default function App() {
  const [data, setData] = useState({ projects: [], workspaces: [] });
  const [loaded, setLoaded] = useState(false);
  const [me, setMe] = useState(null);
  const [route, setRoute] = useState(parseHash);
  const [modal, setModal] = useState(null);
  const [menu, setMenu] = useState(null); // { ws, x, y }
  const [projectMenu, setProjectMenu] = useState(null); // { project, x, y }
  const [connected, setConnected] = useState(false);
  const [rightOpen, setRightOpen] = useState(() => localStorage.getItem('rp-open') === '1');
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => localStorage.setItem('rp-open', rightOpen ? '1' : '0'), [rightOpen]);
  const load = useCallback(() => api.get('/api/state').then((d) => { setData(d); setLoaded(true); }), []);
  useEffect(() => { api.get('/api/me').then(setMe).catch(() => {}); }, []);

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
  useEffect(() => { document.title = attention ? `(${attention}) Supersept` : 'Supersept'; }, [attention]);

  const go = (r) => { location.hash = r.id ? `#/${r.kind}/${r.id}` : `#/${r.kind}`; };
  const current = route.kind === 'ws' ? data.workspaces.find((w) => w.id === route.id) : null;
  const contextProject = current?.project_id || null;
  const newWorkspace = (projectId) => go({ kind: 'new', id: projectId === null ? 'none' : projectId ?? contextProject ?? undefined });

  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const active = data.workspaces.filter((w) => !w.archived);
      if (e.key === 'n' && !e.shiftKey) { e.preventDefault(); newWorkspace(); }
      else if (e.key === 'k') { e.preventDefault(); setModal((m) => (m?.type === 'search' ? null : { type: 'search' })); }
      else if (e.key === ',') { e.preventDefault(); go({ kind: 'settings' }); }
      else if (/^[1-9]$/.test(e.key) && e.altKey) {
        const w = active[Number(e.key) - 1];
        if (w) { e.preventDefault(); go({ kind: 'ws', id: w.id }); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [data, contextProject]);

  const fork = async (ws) => {
    try {
      const w = await api.post('/api/workspaces', { projectId: ws.project_id, forkFrom: ws.id, name: `${ws.name} (fork)` });
      await load();
      go({ kind: 'ws', id: w.id });
    } catch (e) { alert(e.message); }
  };

  const projectsById = useMemo(() => Object.fromEntries(data.projects.map((p) => [p.id, p])), [data.projects]);

  let main;
  if (route.kind === 'ws' && current) {
    main = <WorkspaceView key={current.id} ws={current} project={projectsById[current.project_id]} go={go} onFork={fork} rightOpen={rightOpen} setRightOpen={setRightOpen} />;
  } else if (route.kind === 'new') {
    main = <NewWorkspacePage key={route.id || 'new'} projects={data.projects} initialProjectId={route.id} go={go}
      onAddProject={() => setModal({ type: 'add-project' })} onCreated={(w) => load().then(() => go({ kind: 'ws', id: w.id }))} />;
  } else if (route.kind === 'memory') main = <MemoryPage key={route.id || 'memory'} projects={data.projects} initial={route.id} />;
  else if (route.kind === 'history') main = <HistoryPage key={route.id || 'history'} projects={data.projects} go={go} routeId={route.id} />;
  else if (route.kind === 'settings') main = <SettingsPage me={me} />;
  else if (loaded && !data.projects.length && !data.workspaces.length) main = <Empty onAdd={() => setModal({ type: 'add-project' })} onSession={() => newWorkspace(null)} />;
  else main = <Board data={data} projectsById={projectsById} go={go} onContextMenu={(ws, e) => setMenu({ ws, x: e.clientX, y: e.clientY })} />;

  return (
    <div className="app">
      <Sidebar
        data={data}
        route={route}
        go={go}
        me={me}
        connected={connected}
        onNew={newWorkspace}
        onNewSession={() => newWorkspace(null)}
        onAddProject={() => setModal({ type: 'add-project' })}
        onSearch={() => setModal({ type: 'search' })}
        onCloseWorkspace={(w) => api.patch(`/api/workspaces/${w.id}`, { archived: true })}
        onContextMenu={(ws, e) => setMenu({ ws, x: e.clientX, y: e.clientY })}
        onProjectMenu={(project, e) => setProjectMenu({ project, x: e.clientX, y: e.clientY })}
      />
      <main className="main">{main}</main>
      {modal?.type === 'add-project' && (
        <AddProject onClose={() => setModal(null)} onAdded={(p) => { setModal(null); load(); }} />
      )}
      {modal?.type === 'search' && <CommandPalette data={data} projectsById={projectsById} go={go} onClose={() => setModal(null)} onNew={() => newWorkspace()} />}
      {projectMenu && <ProjectMenu {...projectMenu} go={go} onNew={newWorkspace} onClose={() => setProjectMenu(null)} />}
      {menu && <WorkspaceMenu {...menu} go={go} onFork={fork} onClose={() => setMenu(null)} />}
    </div>
  );
}

function notify(ws, projects, route) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (ws.status !== 'review' && ws.status !== 'waiting') return;
  if (!document.hidden && route.kind === 'ws' && route.id === ws.id) return;
  const project = projects.find((p) => p.id === ws.project_id);
  const n = new Notification(`${project ? project.name + ' · ' : ''}${ws.name}`, {
    body: ws.status === 'waiting' ? ws.last_message || STATUS.waiting.label : (ws.last_message || 'Terminé, à revoir').slice(0, 180),
    tag: ws.id,
  });
  n.onclick = () => { focus(); location.hash = `#/ws/${ws.id}`; n.close(); };
}

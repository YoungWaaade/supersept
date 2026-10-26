import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { LuPlus, LuSettings, LuPanelRight, LuPanelRightOpen, LuPanelRightClose, LuZap, LuCopy, LuGitFork, LuSquarePen, LuSquareTerminal, LuX, LuCheck, LuGitCompareArrows, LuFile, LuPlay } from 'react-icons/lu';
import { HiMiniXMark, HiMiniCommandLine } from 'react-icons/hi2';
import { TbLayoutColumns } from 'react-icons/tb';
import { api } from '../api.js';
import Terminal, { restartTerminal, killTerminal, focusTerminal, useTerminalTitle, sendInput } from './Terminal.jsx';
import DiffView, { FileViewer } from './DiffView.jsx';
import RightPanel from './RightPanel.jsx';
import { StatusIndicator } from './ui.jsx';
import claudeLogo from '../assets/claude.svg';
import { AgentIcon } from './AgentsPage.jsx';

// Which custom agent runs in a pane: 'agent' = the workspace's main session, 'ag-<id>' = an agent tab.
const AgentsCtx = createContext({ agentOf: () => null });
const useAgentOf = () => useContext(AgentsCtx).agentOf;
function PaneIcon({ pane, size = 14 }) {
  const agent = useAgentOf()(pane);
  if (agent) return <AgentIcon agent={agent} size={size} />;
  return pane === 'agent' ? <img src={claudeLogo} alt="" className="preset-icon" /> : null;
}

const rid = () => Math.random().toString(36).slice(2, 8);
const DEFAULT_TABS = { tabs: [{ id: 'main', panes: ['agent'], active: 'agent' }], active: 'main' };

function useTabs(wsId) {
  const storageKey = `tabs:${wsId}`;
  const [state, setState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey)) || DEFAULT_TABS; } catch { return DEFAULT_TABS; }
  });
  useEffect(() => localStorage.setItem(storageKey, JSON.stringify(state)), [state, storageKey]);
  return [state, setState];
}

export default function WorkspaceView({ ws, project, agents, go, onFork, rightOpen, setRightOpen }) {
  const [state, setState] = useTabs(ws.id);
  const [agentTabs, setAgentTabs] = useState({}); // tab id → agent slug
  const loadAgentTabs = () => api.get(`/api/workspaces/${ws.id}/agent-tabs`).then((rows) => setAgentTabs(Object.fromEntries(rows.map((r) => [r.id, r.agent]))));
  useEffect(() => { loadAgentTabs(); }, [ws.id]);
  const bySlug = (slug) => agents.find((a) => a.slug === slug) || null;
  const agentOf = (pane) => (pane === 'agent' ? bySlug(ws.agent) : pane?.startsWith('ag-') ? bySlug(agentTabs[pane.slice(3)]) || { label: agentTabs[pane.slice(3)] || 'Agent' } : null);
  const openAgentTab = async (slug) => {
    try {
      const { pane, id } = await api.post(`/api/workspaces/${ws.id}/agent-tabs`, { agent: slug });
      setAgentTabs((t) => ({ ...t, [id]: slug }));
      openTab(pane);
    } catch (e) { alert(e.message); }
  };
  const [addMenu, setAddMenu] = useState(false);
  const [toggleHover, setToggleHover] = useState(false);
  const termKey = (pane) => `${ws.id}:${pane}`;
  const isTerminal = (pane) => pane === 'agent' || pane === 'run' || pane.startsWith('shell-') || pane.startsWith('ag-');

  const update = (fn) => setState((s) => fn(structuredClone(s)));
  const openTab = (pane) => {
    const id = rid();
    update((s) => ({ tabs: [...s.tabs, { id, panes: [pane], active: pane }], active: id }));
  };
  const showAgent = () => {
    const tab = state.tabs.find((t) => t.panes.includes('agent'));
    if (tab) update((s) => ({ ...s, active: tab.id, tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, active: 'agent' } : t)) }));
    else openTab('agent');
    if (!ws.running) restartTerminal(termKey('agent'));
    setTimeout(() => focusTerminal(termKey('agent')), 50);
  };
  // Open (or focus) a single-pane tab: diff viewer, file viewer, run output.
  const focusOrOpen = (pane, extra = {}) => update((s) => {
    const tab = s.tabs.find((t) => t.panes.includes(pane));
    if (tab) { Object.assign(tab, extra); tab.active = pane; return { ...s, active: tab.id }; }
    const id = rid();
    return { tabs: [...s.tabs, { id, panes: [pane], active: pane, ...extra }], active: id };
  });
  const openDiff = (path, sha) => focusOrOpen('diff', { focus: path, sha: sha || null, nonce: Date.now() });
  const openFile = (path) => focusOrOpen(`file:${path}`);
  const openRun = async () => {
    try { await api.post(`/api/workspaces/${ws.id}/run`); } catch (e) { return alert(e.message); }
    focusOrOpen('run');
  };
  const sendToAgent = (text) => {
    showAgent();
    setTimeout(() => sendInput(termKey('agent'), text + '\r'), ws.running ? 80 : 2500);
  };

  const closePane = (tabId, pane) => {
    // The agent keeps running in the background when its pane is closed, like Superset.
    if (pane !== 'agent' && pane !== 'run' && isTerminal(pane)) killTerminal(termKey(pane));
    // Closing an agent tab ends it; its conversation stays in the Claude Code history.
    if (pane.startsWith('ag-')) api.del(`/api/workspaces/${ws.id}/agent-tabs/${pane.slice(3)}`).catch(() => {});
    update((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      tab.panes = tab.panes.filter((p) => p !== pane);
      if (tab.active === pane) tab.active = tab.panes[0];
      if (!tab.panes.length) {
        const i = s.tabs.indexOf(tab);
        s.tabs.splice(i, 1);
        if (s.active === tabId) s.active = s.tabs[Math.max(0, i - 1)]?.id;
      }
      return s;
    });
  };
  const closeTab = (tab) => [...tab.panes].forEach((p) => closePane(tab.id, p));
  const split = (tabId) => {
    const pane = `shell-${rid()}`;
    update((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      tab.panes.push(pane);
      tab.active = pane;
      return s;
    });
  };
  const setActivePane = (tabId, pane) => update((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (tab && tab.active !== pane) tab.active = pane;
    return s;
  });

  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey) return;
      if (e.key === 't' && !e.shiftKey) { e.preventDefault(); openTab(`shell-${rid()}`); }
      if (e.key === 'd' && !e.shiftKey && state.active) { e.preventDefault(); split(state.active); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [state.active]);

  return (
    <AgentsCtx.Provider value={{ agentOf }}>
    <div className="wsv">
     <div className="wsv-col">
      <div className="tabbar">
        <div className="tabbar-scroll">
          <div className="tabbar-inner">
            {state.tabs.map((tab) => (
              <div className="tab-cell" key={tab.id}>
                <TabItem tab={tab} active={tab.id === state.active} termKey={termKey(tab.active)} onClick={() => update((s) => ({ ...s, active: tab.id }))} onClose={() => closeTab(tab)} />
              </div>
            ))}
            <div className="tab-add-cell">
              <span className="menu-anchor">
                <button className="tab-add" title="Nouvel onglet" onClick={() => setAddMenu(!addMenu)}><LuPlus size={14} strokeWidth={2} /></button>
                {addMenu && (
                  <Dropdown onClose={() => setAddMenu(false)} className="tab-add-menu">
                    <button className="popover-item" onClick={() => { setAddMenu(false); showAgent(); }}>
                      <img src={claudeLogo} alt="" className="preset-icon" /> Claude
                    </button>
                    <button className="popover-item" onClick={() => { setAddMenu(false); openTab(`shell-${rid()}`); }}>
                      <HiMiniCommandLine size={14} /> Terminal <kbd className="popover-kbd">⌘T</kbd>
                    </button>
                    {agents.length > 0 && <div className="popover-sep" />}
                    {agents.map((ag) => (
                      <button key={ag.slug} className="popover-item" onClick={() => { setAddMenu(false); openAgentTab(ag.slug); }}>
                        <AgentIcon agent={ag} /> <span className="flex-1 fade-r">{ag.label}</span>
                      </button>
                    ))}
                  </Dropdown>
                )}
              </span>
            </div>
            <div className="tab-filler" />
          </div>
        </div>
        <div className="tabbar-trailing">
          <button className="rs-toggle" title={rightOpen ? 'Masquer le panneau' : 'Afficher les changements'}
            onMouseEnter={() => setToggleHover(true)} onMouseLeave={() => setToggleHover(false)} onClick={() => setRightOpen(!rightOpen)}>
            {toggleHover ? (rightOpen ? <LuPanelRightClose size={16} strokeWidth={1.5} /> : <LuPanelRightOpen size={16} strokeWidth={1.5} />) : <LuPanelRight size={16} strokeWidth={1.5} />}
          </button>
        </div>
      </div>

      <div className="wsv-body">
        <div className="wsv-main">
          <div className="presets">
            <button className="preset-gear" title="Gérer les agents" onClick={() => go({ kind: 'agents' })}><LuSettings size={14} strokeWidth={2} /></button>
            <button className="preset" title={ws.running ? 'Afficher Claude' : ws.has_conversation ? 'Reprendre la conversation' : 'Lancer Claude'} onClick={showAgent}>
              <img src={claudeLogo} alt="" className="preset-icon" />
              <span>Claude</span>
            </button>
          </div>

          <div className="tab-panels">
            {state.tabs.map((tab) => (
              <div key={tab.id} className="tab-panel" style={{ display: tab.id === state.active ? 'flex' : 'none' }}>
                {tab.panes.map((pane) => !isTerminal(pane) ? (
                  <ViewerPane key={pane} ws={ws} pane={pane} tab={tab} onClose={() => closePane(tab.id, pane)} />
                ) : (
                  <Pane
                    key={pane}
                    ws={ws}
                    pane={pane}
                    termKey={termKey(pane)}
                    visible={tab.id === state.active}
                    split={tab.panes.length > 1}
                    focused={tab.active === pane}
                    onFocus={() => setActivePane(tab.id, pane)}
                    onSplit={() => split(tab.id)}
                    onClose={() => closePane(tab.id, pane)}
                    onFork={onFork}
                  />
                ))}
              </div>
            ))}
            {!state.tabs.length && (
              <div className="no-tabs">
                <p>Aucun onglet ouvert. {ws.running ? 'Claude tourne toujours en arrière-plan.' : ''}</p>
                <button className="preset" onClick={showAgent}><img src={claudeLogo} alt="" className="preset-icon" /> <span>Ouvrir Claude</span></button>
              </div>
            )}
          </div>
        </div>
      </div>
     </div>
      {rightOpen && <RightPanel ws={ws} project={project} go={go} onOpenDiff={openDiff} onOpenFile={openFile} onRun={openRun} sendToAgent={sendToAgent} />}
    </div>
    </AgentsCtx.Provider>
  );
}

function paneTitle(pane, osc) {
  if (pane === 'agent') return 'Claude';
  if (pane === 'run') return 'Run';
  if (pane === 'diff') return 'Modifications';
  if (pane.startsWith('file:')) return pane.slice(5).split('/').pop();
  return osc.replace(/^[^\w~/]+\s*/, '') || 'Terminal';
}

function ViewerPane({ ws, pane, tab, onClose }) {
  const isDiff = pane === 'diff';
  const path = pane.slice(5);
  return (
    <div className="pane">
      <div className="pane-header">
        <div className="pane-header-inner">
          <div className="pane-title-wrap">
            <button className="pane-title" title={isDiff ? 'Modifications' : path}>
              {isDiff ? <LuGitCompareArrows size={14} /> : <LuFile size={14} />}
              <span className="pane-title-text">{isDiff ? (tab.sha ? `Commit ${tab.sha.slice(0, 7)}` : 'Modifications') : path}</span>
            </button>
          </div>
          <div className="pane-actions">
            <button className="pane-action" title="Fermer" onClick={onClose}><HiMiniXMark size={14} /></button>
          </div>
        </div>
      </div>
      <div className="pane-content viewer">
        {isDiff ? <DiffView ws={ws} focus={tab.focus} sha={tab.sha} nonce={tab.nonce} /> : <FileViewer ws={ws} path={path} />}
      </div>
    </div>
  );
}

function TabItem({ tab, active, termKey, onClick, onClose }) {
  const osc = useTerminalTitle(termKey);
  const agentOf = useAgentOf();
  const main = tab.panes.includes('agent') ? 'agent' : tab.active || tab.panes[0];
  const title = agentOf(main)?.label || paneTitle(main, osc);
  const icon = agentOf(main) ? <PaneIcon pane={main} /> : tab.active === 'diff' ? <LuGitCompareArrows size={14} /> : tab.active?.startsWith('file:') ? <LuFile size={14} /> : tab.active === 'run' ? <LuPlay size={14} /> : null;
  return (
    <div className={`tab ${active ? 'active' : ''}`} onClick={onClick} title={title}>
      <div className="tab-title">{icon}<span className="tab-label fade-r">{title}</span></div>
      <div className="tab-close-slot">
        <button className="tab-close" title="Fermer l'onglet" onClick={(e) => { e.stopPropagation(); onClose(); }}><LuX size={14} /></button>
      </div>
    </div>
  );
}

function Pane({ ws, pane, termKey, visible, split, focused, onFocus, onSplit, onClose, onFork }) {
  const isAgent = pane === 'agent';
  const agent = useAgentOf()(pane);
  const osc = useTerminalTitle(termKey);
  const [renaming, setRenaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const input = useRef(null);
  const title = isAgent ? osc || ws.name : agent ? `${agent.label}${osc ? ` · ${osc}` : ''}` : pane === 'run' ? `Run · ${osc || 'commande du projet'}` : osc || 'Terminal';

  const rename = () => {
    const name = input.current.value.trim();
    setRenaming(false);
    if (name && name !== ws.name) api.patch(`/api/workspaces/${ws.id}`, { name });
  };
  const copyPath = async () => {
    await navigator.clipboard.writeText(ws.cwd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={`pane ${split && focused ? 'focused' : ''} ${focused ? '' : 'inactive'}`} onMouseDown={onFocus}>
      <div className="pane-header">
        <div className="pane-header-inner">
          <div className="pane-title-wrap">
            {renaming ? (
              <input ref={input} className="pane-rename" defaultValue={ws.name} autoFocus onBlur={rename}
                onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setRenaming(false); }} />
            ) : (
              <button className="pane-title" title={ws.cwd}>
                {isAgent || agent ? <PaneIcon pane={pane} /> : <LuSquareTerminal size={14} />}
                <span className="pane-title-text">{title}</span>
              </button>
            )}
            {isAgent && <StatusIndicator status={ws.status} />}
          </div>
          <div className="pane-actions">
            {isAgent && (
              <button className="pane-action" title={ws.running ? 'Relancer Claude' : ws.has_conversation ? 'Reprendre la conversation' : 'Lancer Claude'} onClick={() => restartTerminal(termKey)}><LuZap size={14} /></button>
            )}
            <button className="pane-action" title={copied ? 'Copié !' : 'Copier le chemin'} onClick={copyPath}>{copied ? <LuCheck size={14} /> : <LuCopy size={14} />}</button>
            {isAgent && <button className="pane-action" title="Forker la conversation dans un nouvel espace" onClick={() => onFork(ws)}><LuGitFork size={14} /></button>}
            {isAgent && <button className="pane-action strong" title="Renommer l'espace" onClick={() => setRenaming(true)}><LuSquarePen size={14} /></button>}
            <button className="pane-action strong" title="Diviser (⌘D)" onClick={onSplit}><TbLayoutColumns size={14} /></button>
            <button className="pane-action" title={isAgent ? 'Fermer le panneau (Claude continue en arrière-plan)' : 'Fermer le terminal'} onClick={onClose}><HiMiniXMark size={14} /></button>
          </div>
        </div>
      </div>
      <div className="pane-content">
        <div className="term-wrap">
          <Terminal termKey={termKey} active={visible && focused} />
        </div>
      </div>
    </div>
  );
}

export function Dropdown({ onClose, children, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    setTimeout(() => addEventListener('mousedown', close));
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); };
  }, [onClose]);
  return <div ref={ref} className={`popover ${className}`}>{children}</div>;
}

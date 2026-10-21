import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { wsUrl } from '../api.js';

// Superset's built-in "ember" dark theme.
const THEME = {
  background: '#151110',
  foreground: '#eae8e6',
  cursor: '#e07850',
  cursorAccent: '#151110',
  selectionBackground: 'rgba(224,120,80,0.25)',
  black: '#151110', red: '#dc6b6b', green: '#7ec699', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#eae8e6',
  brightBlack: '#5c5856', brightRed: '#e88888', brightGreen: '#98d1a8', brightYellow: '#ecd08f', brightBlue: '#7ec0f5', brightMagenta: '#d494e6', brightCyan: '#73c7d3', brightWhite: '#ffffff',
};
const FONT = '"JetBrains Mono", "JetBrainsMono Nerd Font", "MesloLGM Nerd Font", "MesloLGM NF", "MesloLGS NF", "MesloLGS Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "CaskaydiaCove Nerd Font", "Menlo", "Monaco", "Courier New", monospace';

// Terminals outlive the component that shows them, so switching workspace keeps scrollback and the socket.
const pool = new Map();

function create(key) {
  const el = document.createElement('div');
  el.className = 'xterm-host';
  const term = new XTerm({
    fontFamily: FONT,
    fontSize: 14,
    lineHeight: 1,
    letterSpacing: 0,
    fontWeight: 'normal',
    minimumContrastRatio: 1,
    cursorStyle: 'block',
    cursorBlink: true,
    cursorInactiveStyle: 'outline',
    allowProposedApi: true,
    scrollback: 10000,
    macOptionIsMeta: false,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => open(uri, '_blank')));
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  const entry = { key, el, term, fit, sock: null, opened: false, onExit: new Set() };
  term.onTitleChange((t) => {
    titles.set(key, t);
    titleSubs.get(key)?.forEach((f) => f(t));
  });

  const send = (m) => entry.sock?.readyState === 1 && entry.sock.send(JSON.stringify(m));
  entry.send = send;
  term.onData((d) => send({ type: 'input', data: d }));
  // Shift+Enter → newline in Claude Code instead of submit.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
      send({ type: 'input', data: '\x1b\r' });
      return false;
    }
    return true;
  });

  const connect = () => {
    const sock = new WebSocket(wsUrl(`/ws/term?key=${encodeURIComponent(key)}`));
    entry.sock = sock;
    sock.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'output') term.write(m.data);
      else if (m.type === 'reset') {
        term.reset();
        term.write(m.data);
        entry.alive = m.alive;
        // Nudge the TUI into a full redraw at our real size.
        const { cols, rows } = term;
        send({ type: 'resize', cols: Math.max(2, cols - 1), rows });
        setTimeout(() => send({ type: 'resize', cols, rows }), 60);
      } else if (m.type === 'exit') {
        entry.alive = false;
        entry.onExit.forEach((f) => f());
      }
    };
    sock.onclose = () => {
      if (pool.get(key) === entry) entry.retry = setTimeout(connect, 2000);
    };
  };
  entry.connect = connect;
  pool.set(key, entry);
  return entry;
}

// OSC window titles set by the program (Claude Code sets e.g. "✳ Fix login").
const titles = new Map();
const titleSubs = new Map();

export function useTerminalTitle(key) {
  const [title, setTitle] = useState(() => titles.get(key) || '');
  useEffect(() => {
    setTitle(titles.get(key) || '');
    if (!titleSubs.has(key)) titleSubs.set(key, new Set());
    titleSubs.get(key).add(setTitle);
    return () => titleSubs.get(key)?.delete(setTitle);
  }, [key]);
  return title;
}

export function killTerminal(key) {
  const e = pool.get(key);
  if (!e) return;
  e.send({ type: 'kill' });
  pool.delete(key);
  clearTimeout(e.retry);
  setTimeout(() => { e.sock?.close(); e.term.dispose(); }, 50);
}

export function focusTerminal(key) {
  pool.get(key)?.term.focus();
}

export function restartTerminal(key) {
  pool.get(key)?.send({ type: 'restart' });
}

export function disposeTerminals(prefix) {
  for (const [k, e] of pool) {
    if (!k.startsWith(prefix)) continue;
    pool.delete(k);
    clearTimeout(e.retry);
    e.sock?.close();
    e.term.dispose();
  }
}

export default function Terminal({ termKey, active = true }) {
  const box = useRef(null);
  useEffect(() => {
    const entry = pool.get(termKey) || create(termKey);
    box.current.appendChild(entry.el);
    if (!entry.opened) {
      entry.term.open(entry.el);
      entry.opened = true;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        entry.term.loadAddon(webgl);
      } catch {}
      entry.fit.fit();
      entry.connect();
    }
    const doFit = () => {
      if (!box.current?.offsetWidth) return;
      try {
        entry.fit.fit();
        entry.send({ type: 'resize', cols: entry.term.cols, rows: entry.term.rows });
      } catch {}
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(box.current);
    requestAnimationFrame(doFit);
    const host = box.current;
    return () => {
      ro.disconnect();
      if (entry.el.parentNode === host) host.removeChild(entry.el);
    };
  }, [termKey]);

  useEffect(() => {
    if (active) setTimeout(() => pool.get(termKey)?.term.focus(), 30);
  }, [active, termKey]);

  return <div className="term-box" ref={box} />;
}

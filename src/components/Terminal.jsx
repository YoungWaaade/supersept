import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { wsUrl } from '../api.js';

const THEME = {
  background: '#0c0c0e',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  selectionBackground: '#3b3f5c',
  black: '#1c1c21', red: '#ff6b6b', green: '#4fd1a5', yellow: '#f6c84d', blue: '#7c8cff', magenta: '#c792ea', cyan: '#5ec8f2', white: '#d4d4d8',
  brightBlack: '#5c5c66', brightRed: '#ff8787', brightGreen: '#6ee7b7', brightYellow: '#fde68a', brightBlue: '#a5b4fc', brightMagenta: '#e0aaff', brightCyan: '#93e1ff', brightWhite: '#fafafa',
};

// Terminals outlive the component that shows them, so switching workspace keeps scrollback and the socket.
const pool = new Map();

function create(key) {
  const el = document.createElement('div');
  el.className = 'xterm-host';
  const term = new XTerm({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 20000,
    macOptionIsMeta: true,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => open(uri, '_blank')));
  const entry = { key, el, term, fit, sock: null, opened: false, onExit: new Set() };

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

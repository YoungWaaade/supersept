import { useEffect } from 'react';
import { STATUS } from '../api.js';

const PATHS = {
  plus: 'M8 3v10M3 8h10',
  board: 'M2.5 3h3v10h-3zM6.5 3h3v6h-3zM10.5 3h3v8h-3z',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.5-3.5',
  down: 'M4 6l4 4 4-4',
  right: 'M6 4l4 4-4 4',
  branch: 'M5 3v10M5 13a1.5 1.5 0 1 0 0-.01M5 3a1.5 1.5 0 1 0 0 .01M11 5a1.5 1.5 0 1 0 0-.01M11 6.5c0 3-6 2-6 5',
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  x: 'M4 4l8 8M12 4l-8 8',
  play: 'M5 3.5l7 4.5-7 4.5z',
  stop: 'M4 4h8v8H4z',
  restart: 'M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5',
  archive: 'M2 3h12v3H2zM3 6v7h10V6M6.5 9h3',
  trash: 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9',
  open: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4',
  brain: 'M6 2.5a2.5 2.5 0 0 0-2.5 2.5A2.5 2.5 0 0 0 3 9.5a2.5 2.5 0 0 0 3 3.5V2.5zM10 2.5A2.5 2.5 0 0 1 12.5 5 2.5 2.5 0 0 1 13 9.5a2.5 2.5 0 0 1-3 3.5V2.5z',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5',
  terminal: 'M2 3h12v10H2zM4.5 6l2 2-2 2M8 10.5h3.5',
  agent: 'M8 2l1.6 4.4L14 8l-4.4 1.6L8 14l-1.6-4.4L2 8l4.4-1.6z',
  diff: 'M5 2v6M2 5h6M8 12.5h6M11 2.5v0',
  check: 'M3 8.5l3 3 7-7',
  logo: 'M3.5 5h9M3.5 8h6.5M3.5 11h4',
};

export function Icon({ name }) {
  return (
    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function StatusDot({ status, running }) {
  const s = STATUS[status] || STATUS.idle;
  if (status === 'working') return <span className="spinner" title={s.label} />;
  return <span className={`dot ${status} ${running ? 'live' : ''}`} style={{ '--c': s.color }} title={s.label + (running ? '' : ' · arrêté')} />;
}

export function Stats({ stats }) {
  if (!stats || (!stats.add && !stats.del)) return null;
  return (
    <span className="stats mono">
      <span className="add">+{stats.add}</span> <span className="del">−{stats.del}</span>
    </span>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="ghost icon" onClick={onClose}><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

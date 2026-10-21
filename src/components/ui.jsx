import { useEffect, useState } from 'react';
import { RxDot } from 'react-icons/rx';
import { CgLaptop } from 'react-icons/cg';
import { HiMiniXMark } from 'react-icons/hi2';
import { STATUS } from '../api.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function AsciiSpinner({ className = '' }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <span className={`ascii-spinner ${className}`} aria-hidden="true">{SPINNER_FRAMES[i]}</span>;
}

// Superset's StatusIndicator: waiting = yellow ping, review = static green.
export function StatusIndicator({ status, className = '' }) {
  if (status !== 'waiting' && status !== 'review' && status !== 'working') return null;
  return (
    <span className={`status-ind ${status} ${className}`} title={STATUS[status]?.label}>
      {status !== 'review' && <span className="status-ind-ping" />}
      <span className="status-ind-dot" />
    </span>
  );
}

export function WorkspaceIcon({ ws, active }) {
  if (ws.status === 'working') return <AsciiSpinner />;
  return (
    <span className={`ws-icon ${active ? 'active' : ''}`}>
      {ws.is_worktree || !ws.project_id ? <RxDot size={16} /> : <CgLaptop size={16} />}
      <StatusIndicator status={ws.status} className="overlay" />
    </span>
  );
}

export function ProjectThumbnail({ project, size = 16 }) {
  const [broken, setBroken] = useState(false);
  if (project.has_icon && !broken) {
    return (
      <span className="thumb img" style={{ width: size, height: size }}>
        <img src={`/api/projects/${project.id}/icon`} alt="" onError={() => setBroken(true)} />
      </span>
    );
  }
  return <span className="thumb" style={{ width: size, height: size, fontSize: size <= 16 ? 11 : 12 }}>{project.name.charAt(0).toUpperCase()}</span>;
}

export function DiffStats({ stats, active }) {
  if (!stats || (!stats.add && !stats.del)) return null;
  return (
    <span className={`diffstats ${active ? 'active' : ''}`}>
      <span className="add">+{stats.add}</span>
      <span className="del">−{stats.del}</span>
    </span>
  );
}

export function Modal({ title, onClose, children, className = '' }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`}>
        {title && (
          <div className="modal-head">
            <h3>{title}</h3>
            <button className="iconbtn size-6" onClick={onClose}><HiMiniXMark size={14} /></button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

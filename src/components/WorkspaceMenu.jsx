import { useEffect, useRef } from 'react';
import { LuExternalLink, LuGitFork, LuCircleCheck, LuArchive, LuArchiveRestore, LuTrash2, LuCopy, LuFolderOpen, LuPencil } from 'react-icons/lu';
import { api } from '../api.js';
import { deleteWorkspace } from './RightPanel.jsx';

// Right-click menu on a workspace row/card.
export default function WorkspaceMenu({ ws, x, y, go, onFork, onRename, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    addEventListener('mousedown', close);
    addEventListener('keydown', esc);
    addEventListener('blur', onClose);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); removeEventListener('blur', onClose); };
  }, [onClose]);

  const run = (fn) => () => { onClose(); Promise.resolve(fn()).catch((e) => alert(e.message)); };
  const open = (app) => run(() => api.post(`/api/workspaces/${ws.id}/open`, { app }));
  const style = { left: Math.min(x, innerWidth - 230), top: Math.min(y, innerHeight - 330) };

  return (
    <div ref={ref} className="popover context-menu" style={style}>
      <button className="popover-item" onClick={open('vscode')}><LuExternalLink size={14} /> Ouvrir dans VS Code</button>
      <button className="popover-item" onClick={open('cursor')}><LuExternalLink size={14} /> Ouvrir dans Cursor</button>
      <button className="popover-item" onClick={open('finder')}><LuFolderOpen size={14} /> Afficher dans le Finder</button>
      <button className="popover-item" onClick={open('terminal')}><LuExternalLink size={14} /> Ouvrir dans Terminal</button>
      <button className="popover-item" onClick={run(() => navigator.clipboard.writeText(ws.cwd))}><LuCopy size={14} /> Copier le chemin</button>
      <div className="popover-sep" />
      <button className="popover-item" onClick={run(() => onRename(ws))}><LuPencil size={14} /> Renommer</button>
      <button className="popover-item" onClick={run(() => onFork(ws))} disabled={!ws.has_conversation}><LuGitFork size={14} /> Forker la conversation</button>
      {ws.status !== 'done' && <button className="popover-item" onClick={run(() => api.patch(`/api/workspaces/${ws.id}`, { status: 'done' }))}><LuCircleCheck size={14} /> Marquer comme terminé</button>}
      <button className="popover-item" onClick={run(() => api.patch(`/api/workspaces/${ws.id}`, { archived: !ws.archived }))}>
        {ws.archived ? <LuArchiveRestore size={14} /> : <LuArchive size={14} />} {ws.archived ? 'Désarchiver' : 'Archiver'}
      </button>
      <div className="popover-sep" />
      <button className="popover-item danger" onClick={run(() => deleteWorkspace(ws, go))}><LuTrash2 size={14} /> Supprimer…</button>
    </div>
  );
}

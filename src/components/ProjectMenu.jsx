import { useEffect, useRef } from 'react';
import { LuPlus, LuBrain, LuHistory, LuPencil, LuFolderOpen, LuTrash2 } from 'react-icons/lu';
import { api } from '../api.js';

// Right-click menu on a project row (Superset has no project page).
export default function ProjectMenu({ project, x, y, go, onNew, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    addEventListener('mousedown', close);
    addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', esc); };
  }, [onClose]);

  const run = (fn) => () => { onClose(); Promise.resolve(fn()).catch((e) => alert(e.message)); };
  const rename = () => {
    const name = prompt('Nouveau nom du projet', project.name)?.trim();
    if (name && name !== project.name) return api.patch(`/api/projects/${project.id}`, { name });
  };
  const remove = async () => {
    if (!confirm(`Retirer « ${project.name} » de Claude Hub ?\nLes fichiers, worktrees et la mémoire restent sur le disque.`)) return;
    await api.del(`/api/projects/${project.id}`);
    go({ kind: 'board' });
  };

  return (
    <div ref={ref} className="popover context-menu" style={{ left: Math.min(x, innerWidth - 230), top: Math.min(y, innerHeight - 260) }}>
      <button className="popover-item" onClick={run(() => onNew(project.id))}><LuPlus size={14} /> Nouvel espace de travail</button>
      <button className="popover-item" onClick={run(() => go({ kind: 'memory', id: project.id }))}><LuBrain size={14} /> Mémoire du projet</button>
      <button className="popover-item" onClick={run(() => go({ kind: 'history', id: `p-${project.id}` }))}><LuHistory size={14} /> Historique Claude Code</button>
      <div className="popover-sep" />
      <button className="popover-item" onClick={run(rename)}><LuPencil size={14} /> Renommer</button>
      <button className="popover-item" onClick={run(() => api.post(`/api/projects/${project.id}/open`, { app: 'finder' }))}><LuFolderOpen size={14} /> Afficher dans le Finder</button>
      <div className="popover-sep" />
      <button className="popover-item danger" onClick={run(remove)}><LuTrash2 size={14} /> Retirer le projet…</button>
    </div>
  );
}

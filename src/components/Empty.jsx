import { VscNewFolder } from 'react-icons/vsc';
import { LuPlus } from 'react-icons/lu';
import claudeLogo from '../assets/claude.svg';

export default function Empty({ onAdd, onSession }) {
  return (
    <div className="empty">
      <img src={claudeLogo} alt="" width={40} height={40} />
      <h1>Toutes tes sessions Claude Code, au même endroit.</h1>
      <p>Ouvre un projet, lance des agents en parallèle dans des worktrees isolés, suis leur statut et garde une mémoire par projet.</p>
      <div className="empty-actions">
        <button className="btn-primary" onClick={onAdd}><VscNewFolder size={14} /> Ouvrir un projet</button>
        <button className="btn-ghost" onClick={onSession}><LuPlus size={14} /> Session libre</button>
      </div>
    </div>
  );
}

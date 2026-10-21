import { Icon } from './ui.jsx';

export default function Empty({ onAdd }) {
  return (
    <div className="empty">
      <div className="logo big"><Icon name="logo" /></div>
      <h1>Toutes tes sessions Claude Code, au même endroit.</h1>
      <p>Ajoute un projet, lance des agents en parallèle dans des worktrees isolés, suis leur statut et garde une mémoire par projet.</p>
      <button className="primary" onClick={onAdd}><Icon name="folder" /> Ajouter un premier projet</button>
    </div>
  );
}

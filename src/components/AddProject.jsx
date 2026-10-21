import { useEffect, useState } from 'react';
import { VscFolderOpened } from 'react-icons/vsc';
import { HiMiniPlus } from 'react-icons/hi2';
import { api, ago } from '../api.js';
import { Modal } from './ui.jsx';

export default function AddProject({ onClose, onAdded }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [found, setFound] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/api/discover').then(setFound); }, []);

  const add = async (p = path, n = name) => {
    setError(null);
    try { onAdded(await api.post('/api/projects', { path: p, name: n })); } catch (e) { setError(e.message); }
  };
  const pick = async () => {
    const r = await api.post('/api/pick-folder');
    if (r.path) { setPath(r.path); setName(r.path.split('/').pop()); }
  };

  return (
    <Modal title="Ouvrir un projet" onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label>Dossier
          <div className="input-row">
            <input autoFocus className="mono" placeholder="~/mon-projet" value={path} onChange={(e) => { setPath(e.target.value); setName(e.target.value.replace(/\/$/, '').split('/').pop()); }} />
            <button type="button" className="btn-ghost" onClick={pick}><VscFolderOpened size={14} /> Parcourir</button>
          </div>
        </label>
        <label>Nom
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <div className="error-bar">{error}</div>}
        <div className="form-foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn-primary" disabled={!path}>Ajouter</button>
        </div>
      </form>
      {found.length > 0 && (
        <div className="discover">
          <div className="discover-title">Dossiers avec un historique Claude Code</div>
          {found.slice(0, 12).map((f) => (
            <div key={f.path} className="list-row clickable" onClick={() => add(f.path, f.path.split('/').pop())}>
              <span className="list-title mono fade-r">{f.path.replace(/^\/Users\/[^/]+/, '~')}</span>
              <span className="list-meta">{f.sessions} sessions</span>
              <span className="list-time">{ago(f.updatedAt)}</span>
              <HiMiniPlus size={14} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

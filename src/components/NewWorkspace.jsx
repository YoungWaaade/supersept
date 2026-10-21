import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal } from './ui.jsx';

export default function NewWorkspace({ projects, projectId, onClose, onCreated }) {
  const [form, setForm] = useState({ projectId: projectId || projects[0]?.id, name: '', prompt: '', worktree: false, baseBranch: '' });
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    setInfo(null);
    api.get(`/api/projects/${form.projectId}/info`).then((i) => {
      setInfo(i);
      setForm((f) => ({ ...f, worktree: i.repo && f.worktree, baseBranch: i.branch || '' }));
    });
  }, [form.projectId]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.post('/api/workspaces', form));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Nouveau workspace" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Projet
          <select value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Nom
          <input autoFocus placeholder="ex. fix-login-redirect" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label>Tâche pour Claude <span className="dim">(optionnel — envoyée dès le lancement)</span>
          <textarea rows={4} placeholder="Décris ce que l'agent doit faire…" value={form.prompt} onChange={(e) => set('prompt', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.metaKey && submit(e)} />
        </label>
        <label className={`check ${info?.repo ? '' : 'disabled'}`}>
          <input type="checkbox" disabled={!info?.repo} checked={form.worktree} onChange={(e) => set('worktree', e.target.checked)} />
          <span>
            Worktree git isolé <span className="dim">— nouvelle branche, l'agent ne touche pas à ton dossier principal{!info?.repo && info ? ' (pas un repo git)' : ''}</span>
          </span>
        </label>
        {form.worktree && (
          <label>Branche de base
            <select value={form.baseBranch} onChange={(e) => set('baseBranch', e.target.value)}>
              {info.branches.map((b) => <option key={b}>{b}</option>)}
            </select>
          </label>
        )}
        {error && <div className="error-bar">{error}</div>}
        <div className="form-foot">
          <button type="button" className="ghost" onClick={onClose}>Annuler</button>
          <button className="primary" disabled={busy || !info}>{busy ? 'Création…' : 'Lancer Claude'} <kbd>⌘↵</kbd></button>
        </div>
      </form>
    </Modal>
  );
}

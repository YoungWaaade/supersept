import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal } from './ui.jsx';

export default function NewWorkspace({ projects, projectId, onClose, onCreated }) {
  const [form, setForm] = useState({ projectId: projectId ?? '', name: '', prompt: '', worktree: false, baseBranch: '', cwd: '~' });
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    setInfo(null);
    if (!form.projectId) return setInfo({ repo: false, branches: [] });
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
      onCreated(await api.post('/api/workspaces', { ...form, projectId: form.projectId || null }));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Nouvel espace de travail" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Projet
          <select value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="">— Session libre (hors projet)</option>
          </select>
        </label>
        {!form.projectId && (
          <label>Dossier
            <input value={form.cwd} onChange={(e) => set('cwd', e.target.value)} />
          </label>
        )}
        <label>Tâche pour Claude <span className="muted">optionnel — envoyée dès le lancement</span>
          <textarea autoFocus rows={4} placeholder="Décris ce que l'agent doit faire…" value={form.prompt} onChange={(e) => set('prompt', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.metaKey && submit(e)} />
        </label>
        <label>Nom <span className="muted">par défaut : la tâche</span>
          <input placeholder={form.worktree ? 'nouvel espace' : form.projectId ? 'local' : 'session'} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        {form.projectId && (
          <label className={`check ${info?.repo ? '' : 'disabled'}`}>
            <input type="checkbox" disabled={!info?.repo} checked={form.worktree} onChange={(e) => set('worktree', e.target.checked)} />
            <span>Worktree git isolé <span className="muted">— nouvelle branche, ton dossier principal reste intact{info && !info.repo ? ' (pas un repo git)' : ''}</span></span>
          </label>
        )}
        {form.worktree && (
          <label>Branche de base
            <select value={form.baseBranch} onChange={(e) => set('baseBranch', e.target.value)}>
              {info.branches.map((b) => <option key={b}>{b}</option>)}
            </select>
          </label>
        )}
        {error && <div className="error-bar">{error}</div>}
        <div className="form-foot">
          <button type="button" className="btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn-primary" disabled={busy || !info}>{busy ? 'Création…' : 'Lancer Claude'} <kbd className="kbd-inv">⌘↵</kbd></button>
        </div>
      </form>
    </Modal>
  );
}

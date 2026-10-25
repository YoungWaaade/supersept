import { useEffect, useState } from 'react';
import { LuPlus, LuTrash2, LuBot } from 'react-icons/lu';
import { api } from '../api.js';
import { PageHeader } from './Pages.jsx';

const MODELS = [['', 'Modèle par défaut'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORTS = [['', 'Effort par défaut'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'xHigh'], ['max', 'Max']];
const MODES = [['', 'Permissions par défaut'], ['manual', 'Demander à chaque action'], ['acceptEdits', 'Accepter les modifications de fichiers'], ['auto', 'Auto'], ['plan', 'Plan (lecture seule, propose un plan)']];
const EMPTY = { label: '', icon: '🤖', description: '', prompt: '', model: '', effort: '', permissionMode: '', tools: '', initialPrompt: '' };

export function AgentIcon({ agent, size = 14 }) {
  return agent?.icon ? <span className="agent-emoji" style={{ fontSize: size, minWidth: size }}>{agent.icon}</span> : <LuBot size={size} />;
}

export default function AgentsPage({ agents, initial }) {
  const [sel, setSel] = useState(initial || agents[0]?.slug || 'new');
  const current = agents.find((a) => a.slug === sel);
  return (
    <div className="page">
      <PageHeader title="Agents">
        <button className="btn-primary" onClick={() => setSel('new')}><LuPlus size={14} /> Nouvel agent</button>
      </PageHeader>
      <div className="split-page">
        <nav className="split-nav">
          {agents.map((a) => (
            <button key={a.slug} className={`split-nav-item ${sel === a.slug ? 'active' : ''}`} onClick={() => setSel(a.slug)}>
              <AgentIcon agent={a} /> <span className="flex-1 fade-r">{a.label}</span>
            </button>
          ))}
          {sel === 'new' && <button className="split-nav-item active"><LuPlus size={14} /> <span>Nouvel agent</span></button>}
          {!agents.length && sel !== 'new' && <p className="empty-note">Aucun agent.</p>}
        </nav>
        <div className="split-body">
          <AgentEditor key={`${sel}:${current ? 'loaded' : 'empty'}`} agent={current} onSaved={(a) => setSel(a.slug)} onDeleted={() => setSel(agents.find((a) => a.slug !== sel)?.slug || 'new')} />
        </div>
      </div>
    </div>
  );
}

function AgentEditor({ agent, onSaved, onDeleted }) {
  const [form, setForm] = useState(() => (agent ? { ...EMPTY, ...agent } : EMPTY));
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [form]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const a = await api.put(`/api/agents/${agent?.slug || 'new'}`, { ...form, slug: form.label || agent?.slug });
      setSaved(true);
      onSaved(a);
    } catch (err) { setError(err.message); }
  };
  const remove = async () => {
    if (!confirm(`Supprimer l'agent « ${agent.label} » ?\nSon fichier ~/.claude/agents/${agent.slug}.md sera effacé. Les conversations passées restent dans l'historique.`)) return;
    await api.del(`/api/agents/${agent.slug}`);
    onDeleted();
  };

  return (
    <form className="form agent-form" onSubmit={save}>
      <div className="agent-row">
        <label className="agent-icon-field">Icône
          <input value={form.icon} onChange={(e) => set('icon', e.target.value)} maxLength={4} />
        </label>
        <label className="flex-1">Nom
          <input autoFocus={!agent} value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="ex. Relecteur Brand DS" />
        </label>
      </div>
      <label>Quand l'utiliser <span className="muted">— aide Claude à l'appeler en renfort pendant une session</span>
        <input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="ex. Vérifie les écrans Figma contre les tokens du Brand DS Pennylane" />
      </label>
      <label>Instructions <span className="muted">— son rôle, ses règles, son ton</span>
        <textarea className="agent-prompt" value={form.prompt} onChange={(e) => set('prompt', e.target.value)} placeholder="Tu es… Ta mission… Règles…" />
      </label>
      <div className="agent-row">
        <label className="flex-1">Modèle
          <select value={form.model} onChange={(e) => set('model', e.target.value)}>{MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="flex-1">Effort
          <select value={form.effort} onChange={(e) => set('effort', e.target.value)}>{EFFORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="flex-1">Permissions
          <select value={form.permissionMode} onChange={(e) => set('permissionMode', e.target.value)}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
      </div>
      <label>Outils autorisés <span className="muted">— vide = tous ; ex. « Read, Grep, Glob » pour un agent en lecture seule</span>
        <input className="mono" value={form.tools} onChange={(e) => set('tools', e.target.value)} placeholder="Read, Grep, Glob, Bash" />
      </label>
      <label>Premier message <span className="muted">— envoyé automatiquement quand on lance l'agent (optionnel)</span>
        <input value={form.initialPrompt} onChange={(e) => set('initialPrompt', e.target.value)} placeholder="ex. Fais le point sur les changements en cours" />
      </label>
      {error && <div className="error-bar">{error}</div>}
      <div className="form-foot agent-foot">
        {agent && <span className="muted small mono">~/.claude/agents/{agent.slug}.md</span>}
        <span className="flex-1" />
        {agent && <button type="button" className="btn-ghost danger" onClick={remove}><LuTrash2 size={14} /> Supprimer</button>}
        <button className="btn-primary">{saved ? 'Enregistré' : agent ? 'Enregistrer' : "Créer l'agent"}</button>
      </div>
    </form>
  );
}

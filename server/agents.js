// Custom agents, stored in Claude Code's native format (~/.claude/agents/<slug>.md) so they
// also work outside Supersept (`claude --agent <slug>`, or as subagents inside a session).
// Supersept-only settings (icon, effort, permission mode, first message) live in the same
// frontmatter; Claude Code ignores keys it doesn't know.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FIELDS = ['name', 'description', 'model', 'tools', 'color', 'icon', 'effort', 'permissionMode', 'initialPrompt'];

export const isSlug = (s) => SLUG.test(String(s || ''));
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 62) || 'agent';

function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return { prompt: text.trim() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch {} }
    meta[kv[1]] = v;
  }
  return { ...meta, prompt: m[2].trim() };
}

// Values are written as JSON strings when needed, so multi-line or ':'-containing text survives.
const yamlValue = (v) => (/^[\w .,/()@#&+'’éèêàùçôîÉÀ-]*$/.test(v) && !/^\s|\s$/.test(v) ? v : JSON.stringify(v));

export function listAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).map((f) => {
    const slug = f.slice(0, -3);
    try {
      const a = parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
      return { slug, ...a, label: a.label || a.name || slug };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => a.label.localeCompare(b.label));
}

export const getAgent = (slug) => (isSlug(slug) ? listAgents().find((a) => a.slug === slug) || null : null);

export function saveAgent(slug, data) {
  if (!isSlug(slug)) throw new Error("identifiant d'agent invalide (minuscules, chiffres et tirets)");
  const meta = { ...data, name: slug };
  if (!String(data.description || '').trim()) throw new Error('ajoute une description : elle dit à Claude quand utiliser cet agent');
  if (!String(data.prompt || '').trim()) throw new Error("ajoute des instructions à l'agent");
  const lines = ['---'];
  for (const k of FIELDS) {
    const v = k === 'name' ? slug : String(meta[k] ?? '').trim();
    if (v) lines.push(`${k}: ${k === 'description' || k === 'initialPrompt' ? JSON.stringify(v) : yamlValue(v)}`);
  }
  // The display name may differ from the slug: keep it as a Supersept label.
  if (String(data.label || '').trim()) lines.push(`label: ${JSON.stringify(String(data.label).trim())}`);
  lines.push('---', '', String(data.prompt).trim(), '');
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(AGENTS_DIR, `${slug}.md`), lines.join('\n'));
  return getAgent(slug);
}

export function deleteAgent(slug) {
  if (!isSlug(slug)) throw new Error('agent invalide');
  fs.rmSync(path.join(AGENTS_DIR, `${slug}.md`), { force: true });
}

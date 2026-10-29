// Token usage of the Claude Code sessions run by Supersept, read from Claude Code's own transcripts
// (~/.claude/projects/**/*.jsonl, sub-agents included) and priced at the public API rates (pricing.json).
//
// Each assistant message carries message.usage; Claude Code writes one line per content block, so a
// message shows up several times (the first lines sometimes with a partial output count): records are
// merged per message id, keeping the largest value of each field. Files are scanned incrementally (byte
// offset) and the extracted records are kept in ~/.claude-hub/usage-cache.json, so a page load only reads
// what was appended since the last one.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { db, HUB_DIR, WORKTREES_DIR } from './db.js';
import { listAgents } from './agents.js';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const CACHE_FILE = path.join(HUB_DIR, 'usage-cache.json');
const CACHE_VERSION = 1;
const DEFAULT_PRICING = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pricing.json');
const USER_PRICING = path.join(HUB_DIR, 'pricing.json');
const AGENT_HOME = path.join(HUB_DIR, 'agent-home');
const DAY = 86_400_000;
// A message is counted for a session only from the moment Supersept knew it (a resumed old conversation
// keeps its earlier history in the same file); a little slack for clocks and the launch itself.
const SLACK = 2 * 60_000;

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

// Built-in rates, then ~/.claude-hub/pricing.json on top (merged model by model).
export function pricing() {
  const base = readJson(DEFAULT_PRICING, { models: {} }).models;
  const over = readJson(USER_PRICING, { models: {} }).models || {};
  const out = { ...base };
  for (const [id, p] of Object.entries(over)) out[id] = { ...(base[id] || {}), ...p };
  return out;
}

// "eu.anthropic.claude-opus-5-5", "claude-opus-5-5[1m]", "anthropic.claude-haiku-4-5-20251001-v1:0",
// "claude-haiku-4-5@20251001" → "claude-…" without platform prefix, date or version suffix.
export const canonicalModel = (model) => String(model || '')
  .replace(/^.*?(?=claude-)/, '').replace(/\[.*?\]$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/[@-]\d{8}$/, '');

// ---------- incremental scan ----------

let cache = null;
let scanning = null;

function loadCache() {
  const c = readJson(CACHE_FILE, null);
  return c?.version === CACHE_VERSION ? c : { version: CACHE_VERSION, files: {} };
}

function saveCache() {
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE_FILE);
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '');

// Record: [timestamp, model, input, cacheWrite5m, cacheWrite1h, cacheRead, output, fast].
function recordOf(o) {
  const u = o.message.usage;
  const write = u.cache_creation_input_tokens || 0;
  let w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  if (w1h > write) w1h = write;
  return [Date.parse(o.timestamp) || 0, o.message.model, u.input_tokens || 0, write - w1h, w1h, u.cache_read_input_tokens || 0, u.output_tokens || 0, u.speed === 'fast' ? 1 : 0];
}

function absorb(entry, line) {
  if (!line.startsWith('{')) return;
  const hasUsage = line.includes('"usage"');
  const needsMeta = !entry.cwd || entry.prompts.length < 3;
  if (!hasUsage && !(needsMeta && line.includes('"type":"user"'))) return;
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (o.type === 'assistant' && o.message?.usage) {
    if (o.message.model === '<synthetic>') return;
    const id = o.message.id || o.requestId;
    if (!id) return;
    const r = recordOf(o);
    const prev = entry.msgs[id];
    if (prev) for (let i = 2; i < 8; i++) prev[i] = Math.max(prev[i], r[i]);
    else entry.msgs[id] = r;
    entry.cwd ??= o.cwd || null;
    entry.firstTs ??= r[0] || null;
  } else if (o.type === 'user' && !o.isSidechain && !o.isMeta && !o.toolUseResult) {
    entry.cwd ??= o.cwd || null;
    entry.firstTs ??= Date.parse(o.timestamp) || null;
    const t = textOf(o.message?.content).trim();
    if (t && !t.startsWith('<') && entry.prompts.length < 3) entry.prompts.push(t.slice(0, 2000));
  }
}

async function scanFile(rel) {
  const file = path.join(ROOT, rel);
  const st = await fs.promises.stat(file);
  let entry = cache.files[rel];
  if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) return false;
  // Shrunk or rewritten: start over.
  if (!entry || st.size < entry.offset || st.ino !== entry.ino) entry = { ino: st.ino, offset: 0, cwd: null, firstTs: null, prompts: [], msgs: {} };
  const fh = await fs.promises.open(file, 'r');
  try {
    const CHUNK = 16 * 1024 * 1024;
    let pos = entry.offset;
    let carry = '';
    while (pos < st.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const text = carry + buf.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop();
      for (const line of lines) absorb(entry, line);
    }
    // An unfinished last line (being written) is read again next time.
    entry.offset = pos - Buffer.byteLength(carry);
  } finally {
    await fh.close();
  }
  entry.size = st.size;
  entry.mtimeMs = st.mtimeMs;
  cache.files[rel] = entry;
  return true;
}

// Brings the cache up to date with the transcripts on disk. Concurrent callers share one scan.
export function scan() {
  scanning ||= (async () => {
    cache ||= loadCache();
    let changed = false;
    const rels = fs.existsSync(ROOT) ? fs.readdirSync(ROOT, { recursive: true }).filter((f) => f.endsWith('.jsonl')) : [];
    const present = new Set(rels);
    for (const rel of Object.keys(cache.files)) if (!present.has(rel)) { delete cache.files[rel]; changed = true; }
    for (const rel of rels) {
      try { if (await scanFile(rel)) changed = true; } catch {}
    }
    if (changed) saveCache();
    cache.scannedAt = Date.now();
  })().finally(() => { scanning = null; });
  return scanning;
}

// ---------- attribution to Supersept sessions, agents and projects ----------

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

function owners() {
  const agents = Object.fromEntries(listAgents().map((a) => [a.slug, a.label]));
  const projects = Object.fromEntries(db.prepare('SELECT id, name FROM projects').all().map((p) => [p.id, p.name]));
  const workspaces = db.prepare('SELECT id, name, cwd, project_id, agent, owner_agent, session_id, created_at FROM workspaces').all();
  const wsById = Object.fromEntries(workspaces.map((w) => [w.id, w]));
  const bySession = new Map();
  const wsOwner = (w, agent = w.agent || w.owner_agent) => ({
    session: `ws:${w.id}`, name: w.name, kind: 'session', agent: agent || null, project: w.project_id || null, since: w.created_at,
  });
  const chatOwner = (agent, conv, title, since) => ({
    session: `chat:${agent}:${conv}`, name: `${agents[agent] || agent} · ${title || `conversation ${conv + 1}`}`, kind: 'chat', agent, project: null, since,
  });
  for (const w of workspaces) bySession.set(w.session_id, wsOwner(w));
  for (const t of db.prepare('SELECT workspace_id, agent, session_id, created_at FROM agent_tabs').all()) {
    const w = wsById[t.workspace_id];
    if (w) bySession.set(t.session_id, { ...wsOwner(w, t.agent), since: t.created_at });
  }
  const convs = db.prepare('SELECT agent, conversation, session_id, title, created_at FROM agent_convs').all();
  for (const c of convs) bySession.set(c.session_id, chatOwner(c.agent, c.conversation, c.title, c.created_at));
  for (const c of db.prepare('SELECT agent, session_id, conversation, created_at FROM agent_chats').all()) {
    if (!bySession.has(c.session_id)) bySession.set(c.session_id, chatOwner(c.agent, c.conversation, convs.find((x) => x.agent === c.agent && x.conversation === c.conversation)?.title, c.created_at));
  }
  // Sessions replaced by a relay: the chat keeps its number, a workspace keeps its own row.
  for (const r of db.prepare('SELECT kind, from_ref, old_session, new_session, at FROM relays').all()) {
    if (!r.old_session || bySession.has(r.old_session)) continue;
    const next = bySession.get(r.new_session);
    if (next) bySession.set(r.old_session, next);
    else if (r.kind !== 'chat' && wsById[r.from_ref]) bySession.set(r.old_session, wsOwner(wsById[r.from_ref]));
  }
  const hubStart = Math.min(...workspaces.map((w) => w.created_at), ...db.prepare('SELECT created_at FROM projects').all().map((p) => p.created_at), Date.now());
  // Conversations Supersept no longer points at (after /clear, or a chat reset): matched by their first
  // prompts (logged by the hooks), or by a folder only Supersept uses.
  const prompts = new Map();
  for (const e of db.prepare("SELECT e.text, w.id FROM events e JOIN workspaces w ON w.id = e.workspace_id WHERE e.kind = 'prompt' AND e.text IS NOT NULL").all()) {
    if (!prompts.has(e.text)) prompts.set(e.text, e.id);
  }
  const byCwd = new Map();
  for (const w of workspaces) if (real(w.cwd).startsWith(real(WORKTREES_DIR) + path.sep)) byCwd.set(real(w.cwd), byCwd.has(real(w.cwd)) ? null : w);
  const agentHome = real(AGENT_HOME) + path.sep;
  const fallback = (entry) => {
    for (const p of entry.prompts) {
      const w = wsById[prompts.get(p)];
      if (w && real(w.cwd) === real(entry.cwd || '')) return { ...wsOwner(w), since: hubStart };
    }
    if (!entry.cwd) return null;
    const cwd = real(entry.cwd);
    if (cwd.startsWith(agentHome)) {
      const slug = cwd.slice(agentHome.length).split(path.sep)[0];
      return { session: `chat:${slug}:old`, name: `${agents[slug] || slug} · anciennes conversations`, kind: 'chat', agent: slug, project: null, since: hubStart };
    }
    const w = byCwd.get(cwd);
    return w ? wsOwner(w) : null;
  };
  return { bySession, fallback, agents, projects, hubStart };
}

// "<dir>/<session>.jsonl" or "<dir>/<session>/subagents/agent-x.jsonl" → session id of the main conversation.
const sessionOf = (rel) => {
  const parts = rel.split(path.sep);
  return parts.length > 2 ? parts[1] : path.basename(rel, '.jsonl');
};

// ---------- aggregation ----------

function costOf(r, price) {
  const [, , input, w5m, w1h, read, output, fast] = r;
  const tier = price.longContext && input + w5m + w1h + read > price.longContext.above ? { ...price, ...price.longContext } : price;
  const mult = fast && price.fast ? price.fast : 1;
  const cost = (input * tier.input + w5m * tier.cacheWrite5m + w1h * tier.cacheWrite1h + read * tier.cacheRead + output * tier.output) / 1e6 * mult;
  const uncached = ((input + w5m + w1h + read) * tier.input + output * tier.output) / 1e6 * mult;
  return { cost, uncached };
}

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

const emptyBucket = () => ({ tokens: 0, cost: 0, unpriced: 0 });

// range: 7 | 30 | 90 | 'all'.
export async function report({ range = 30, refresh = false } = {}) {
  if (refresh || !cache?.scannedAt || Date.now() - cache.scannedAt > 15_000) await scan();
  const prices = pricing();
  const { bySession, fallback, agents, projects, hubStart } = owners();
  const now = Date.now();
  const days = range === 'all' ? Math.max(1, Math.round((startOfDay(now) - startOfDay(hubStart)) / DAY) + 1) : Number(range) || 30;
  const from = startOfDay(now) - (days - 1) * DAY;

  // Resolve each file's owner (sub-agents follow their parent), oldest files first so a message copied
  // into a later file (resume, fork) stays with the conversation that produced it.
  const files = Object.entries(cache.files).sort((a, b) => (a[1].firstTs || 0) - (b[1].firstTs || 0));
  const mainOwner = new Map();
  for (const [rel, entry] of files) {
    if (rel.split(path.sep).length > 2) continue;
    mainOwner.set(sessionOf(rel), bySession.get(sessionOf(rel)) || fallback(entry));
  }
  const seen = new Set();
  const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, uncached: 0, unpriced: 0 };
  const daily = new Map();
  for (let t = from; t <= now; t += DAY) daily.set(dayKey(t), emptyBucket());
  const groups = { model: new Map(), session: new Map(), agent: new Map(), project: new Map() };
  const sessionsCounted = new Set();
  let filesCounted = 0;
  const add = (map, key, name, tokens, cost, extra) => {
    const g = map.get(key) || { key, name, ...emptyBucket(), ...extra };
    g.tokens += tokens;
    if (cost == null) g.unpriced += tokens; else g.cost += cost;
    map.set(key, g);
  };
  for (const [rel, entry] of files) {
    const sid = sessionOf(rel);
    const owner = bySession.get(sid) || mainOwner.get(sid);
    if (!owner) continue;
    let counted = false;
    for (const [id, r] of Object.entries(entry.msgs)) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (r[0] < owner.since - SLACK || r[0] < from) continue;
      const model = canonicalModel(r[1]);
      const price = prices[model];
      const tokens = r[2] + r[3] + r[4] + r[5] + r[6];
      if (!tokens) continue;
      const c = price ? costOf(r, price) : null;
      totals.input += r[2]; totals.cacheWrite += r[3] + r[4]; totals.cacheRead += r[5]; totals.output += r[6];
      if (c) { totals.cost += c.cost; totals.uncached += c.uncached; } else totals.unpriced += tokens;
      const day = daily.get(dayKey(r[0]));
      if (day) { day.tokens += tokens; if (c) day.cost += c.cost; else day.unpriced += tokens; }
      add(groups.model, model, price?.label || model, tokens, c?.cost, { model, priced: !!price });
      add(groups.session, owner.session, owner.name, tokens, c?.cost, { kind: owner.kind });
      add(groups.agent, owner.agent || '-', owner.agent ? agents[owner.agent] || owner.agent : 'Sans agent', tokens, c?.cost);
      const pKey = owner.kind === 'chat' ? 'chats' : owner.project || '-';
      add(groups.project, pKey, pKey === 'chats' ? 'Chats des agents' : projects[owner.project] || (owner.project ? 'Projet supprimé' : 'Sessions libres'), tokens, c?.cost);
      sessionsCounted.add(owner.session);
      counted = true;
    }
    if (counted) filesCounted++;
  }
  const byCost = (a, b) => b.cost - a.cost || b.tokens - a.tokens;
  const list = (m) => [...m.values()].sort(byCost);
  const tokens = totals.input + totals.cacheWrite + totals.cacheRead + totals.output;
  return {
    range: range === 'all' ? 'all' : days,
    from,
    to: now,
    scannedAt: cache.scannedAt,
    totals: { ...totals, tokens, savings: totals.uncached - totals.cost },
    daily: [...daily.entries()].map(([day, b]) => ({ day, ...b })),
    models: list(groups.model),
    groups: { session: list(groups.session), agent: list(groups.agent), project: list(groups.project) },
    sessions: sessionsCounted.size,
    files: filesCounted,
  };
}

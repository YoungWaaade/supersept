// Automatic relay when a Claude conversation's context gets too full: past a threshold, Claude Code starts
// misbehaving (stuck turns, questions not shown, instructions ignored), so the work moves to a fresh session
// that starts from a handoff summary.
//
// Context size = usage of the last main-chain assistant message in the transcript (input + cache read +
// cache creation): it is what the model actually received on its last call. Model windows are learned from
// headless runs (stream-json `modelUsage.contextWindow`), since transcripts don't carry them.
import fs from 'node:fs';
import path from 'node:path';
import { HUB_DIR } from './db.js';

const CONFIG = path.join(HUB_DIR, 'relay.json');
const WINDOWS = path.join(HUB_DIR, 'context-windows.json');
const DEFAULTS = { enabled: true, percent: 75, maxTokens: null, windows: {} };
const DEFAULT_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

// percent: share of the model window; maxTokens: optional absolute cap (whichever comes first);
// windows: manual overrides, model id → window size.
export function config() {
  const c = { ...DEFAULTS, ...readJson(CONFIG, {}) };
  c.percent = Math.min(95, Math.max(1, Number(c.percent) || DEFAULTS.percent));
  c.maxTokens = Number(c.maxTokens) > 0 ? Math.round(Number(c.maxTokens)) : null;
  return c;
}

export function setConfig(patch = {}) {
  const c = { ...config() };
  if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
  if (patch.percent !== undefined) c.percent = patch.percent;
  if (patch.maxTokens !== undefined) c.maxTokens = patch.maxTokens || null;
  if (patch.windows && typeof patch.windows === 'object') c.windows = patch.windows;
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
  return config();
}

// "eu.anthropic.claude-opus-5-5" / "claude-opus-5-5[1m]" → "claude-opus-5-5".
const canonical = (model) => String(model || '').replace(/\[.*?\]$/, '').replace(/^.*?(?=claude-)/, '');

export const learnedWindows = () => readJson(WINDOWS, {});
export function learnWindow(model, size) {
  const id = canonical(model);
  if (!id || !(size > 0)) return;
  const known = learnedWindows();
  if (known[id] === size) return;
  fs.writeFileSync(WINDOWS, JSON.stringify({ ...known, [id]: size }, null, 2));
}

// Window of a model: manual override, then what Claude Code reported, then "[1m]" in the requested model,
// then the classic 200k. An observed context above that proves the window is the large one.
export function windowFor(model, { requested = null, used = 0 } = {}) {
  const id = canonical(model);
  const c = config();
  let size = c.windows[id] || c.windows[model] || learnedWindows()[id] || null;
  if (!size && /\[1m\]/i.test(`${requested || ''} ${model || ''}`)) size = LARGE_WINDOW;
  size ||= DEFAULT_WINDOW;
  if (used > size) size = LARGE_WINDOW;
  return size;
}

export function threshold(window) {
  const c = config();
  const byPercent = Math.round((window * c.percent) / 100);
  return c.maxTokens ? Math.min(byPercent, c.maxTokens) : byPercent;
}

export const contextOf = (usage) => (usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : 0);

// Last main-chain assistant call of a transcript: { tokens, model }. Only the tail is read.
export function transcriptUsage(transcriptPath) {
  try {
    const st = fs.statSync(transcriptPath);
    const size = Math.min(st.size, 2 * 1024 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    for (const line of buf.toString().split('\n').reverse()) {
      if (!line.includes('"usage"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type !== 'assistant' || o.isSidechain || !o.message?.usage || o.message.model === '<synthetic>') continue;
        return { tokens: contextOf(o.message.usage), model: o.message.model };
      } catch {}
    }
  } catch {}
  return null;
}

// { tokens, window, limit, over } for a conversation, or null when nothing is known yet.
export function measure({ tokens, model, requested = null, window = null }) {
  if (!tokens) return null;
  const w = window || windowFor(model, { requested, used: tokens });
  const limit = threshold(w);
  return { tokens, window: w, limit, over: config().enabled && tokens >= limit };
}

const SECTIONS = '1. Mission (le but final, avec les consignes et contraintes données par l\'utilisateur)\n2. État actuel (ce qui est fait, ce qui marche, ce qui a été testé)\n3. Fichiers, branches, commits et liens clés\n4. Points ouverts, décisions en attente, pièges rencontrés\n5. Prochaine étape (précise, actionnable)';

// Asked to the old conversation, in its last turn.
export const HANDOFF_REQUEST = `[Supersept] Ton contexte est presque plein : Supersept va relayer ce travail vers une nouvelle session, qui ne verra que ce que tu écris maintenant. Ne fais aucune autre action. Réponds uniquement par un résumé de passation complet et autonome, en Markdown, avec ces sections :\n${SECTIONS}`;

// First message of the new conversation.
export const handoffIntro = (summary, from, byClaude = true) => `[Supersept] Relais automatique : tu reprends ${from}, dont le contexte était plein. Voici ${byClaude ? 'le résumé de passation écrit par la session précédente' : 'ce que Supersept a pu récupérer de la session précédente (elle n\'a pas pu écrire de résumé)'}. Repars de la prochaine étape, sans refaire ce qui est déjà fait ; en cas de doute sur l'état réel, vérifie (git status, fichiers) avant d'agir.\n\n${summary.trim()}`;

// The handoff a relayed session was started with, without its header (for a relay of a relay).
export const stripIntro = (text) => String(text || '').replace(/^\[Supersept\] Relais automatique[^\n]*\n\n/, '').replace(/\n\nTranscript complet de la session précédente[\s\S]*$/, '');

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
// 200k cap by default: on 1M windows, 75 % (750k) is far too late, sessions misbehave well before.
// maxImageMB: images (screenshots, Read of .png/.jpg) stay in the context as base64 and the API refuses requests
// above ~32 MB ("400 Input is too long") long before the token window is full: relay well before that.
const DEFAULTS = { enabled: true, percent: 75, maxTokens: 200_000, maxImageMB: 20, windows: {} };
const DEFAULT_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

// percent: share of the model window; maxTokens: absolute cap, null to remove it (whichever comes first);
// windows: manual overrides, model id → window size.
export function config() {
  const c = { ...DEFAULTS, ...readJson(CONFIG, {}) };
  c.percent = Math.min(95, Math.max(1, Number(c.percent) || DEFAULTS.percent));
  c.maxTokens = Number(c.maxTokens) > 0 ? Math.round(Number(c.maxTokens)) : null;
  c.maxImageMB = Math.min(30, Math.max(1, Number(c.maxImageMB) || DEFAULTS.maxImageMB));
  return c;
}

export function setConfig(patch = {}) {
  const c = { ...config() };
  if (patch.enabled !== undefined) c.enabled = !!patch.enabled;
  if (patch.percent !== undefined) c.percent = patch.percent;
  if (patch.maxTokens !== undefined) c.maxTokens = patch.maxTokens || null;
  if (patch.maxImageMB !== undefined) c.maxImageMB = patch.maxImageMB;
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

// What a conversation's next request carries, read incrementally (transcripts reach 70 MB): last main-chain
// usage, and the base64 images still in the context (reset by a compaction). Also the trailing API error, if any.
const loads = new Map(); // transcript path → { offset, imageBytes, images, tokens, model, error }
const imageBytesOf = (x) => {
  if (!x || typeof x !== 'object') return [0, 0];
  if (x.type === 'image') return [String(x.source?.data || '').length, 1];
  let b = 0, n = 0;
  for (const v of Array.isArray(x) ? x : Object.values(x)) { const [vb, vn] = imageBytesOf(v); b += vb; n += vn; }
  return [b, n];
};
export const textOf = (content) => (typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
export function transcriptLoad(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let l = loads.get(file);
  if (!l || st.size < l.offset) l = { offset: 0, imageBytes: 0, images: 0, tokens: 0, model: null, error: null };
  if (st.size > l.offset) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - l.offset);
    fs.readSync(fd, buf, 0, buf.length, l.offset);
    fs.closeSync(fd);
    const end = buf.lastIndexOf(10); // only complete lines; the rest is read next time
    if (end >= 0) {
      for (const line of buf.subarray(0, end).toString().split('\n')) {
        if (!/"type":\s*"(user|assistant)"|compact_boundary/.test(line)) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.isSidechain) continue;
        if (o.type === 'system' && o.subtype === 'compact_boundary') { l.imageBytes = 0; l.images = 0; continue; }
        if (o.type !== 'user' && o.type !== 'assistant') continue;
        const [b, n] = imageBytesOf(o.message?.content);
        l.imageBytes += b;
        l.images += n;
        if (o.type === 'assistant') {
          const text = textOf(o.message?.content);
          l.error = o.isApiErrorMessage || (o.message?.model === '<synthetic>' && /^API Error/.test(text)) ? text : null;
          if (o.message?.usage && o.message.model !== '<synthetic>') { l.tokens = contextOf(o.message.usage); l.model = o.message.model; }
        } else if (o.message?.role === 'user' && textOf(o.message.content).trim()) l.error = null;
      }
      l.offset += end + 1;
    }
  }
  loads.set(file, l);
  return l;
}

export const imageBudget = () => config().maxImageMB * 1024 * 1024;

// "Input is too long", "prompt is too long", 413…: the conversation can't take one more request.
// Not "response exceeded the output token maximum": that one is about the answer, not the input.
export const isTooLong = (error) => /(input|prompt|request) is too (long|large)|request_too_large|\b413\b|context (length|window|limit)/i.test(String(error || ''));

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

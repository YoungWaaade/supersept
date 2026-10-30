// Reads Claude Code's own transcripts (~/.claude/projects) so past sessions can be listed and resumed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const cache = new Map(); // file -> { mtimeMs, info }

function readHead(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString();
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return '';
}

function parse(file) {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.info;
  let cwd = null, firstPrompt = null, title = null, startedAt = null, prompts = 0;
  for (const line of readHead(file).split('\n')) {
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    if (o.type === 'summary' && o.summary && !title) title = o.summary;
    if (o.type !== 'user' || o.isSidechain || o.isMeta) continue;
    cwd ??= o.cwd;
    startedAt ??= o.timestamp;
    const t = textOf(o.message?.content).trim();
    if (!t || t.startsWith('<') || o.toolUseResult) continue;
    prompts++;
    firstPrompt ??= t;
  }
  const info = {
    sessionId: path.basename(file, '.jsonl'),
    cwd,
    title: title || firstPrompt?.slice(0, 140) || '(session vide)',
    firstPrompt,
    prompts,
    startedAt: startedAt ? Date.parse(startedAt) : st.birthtimeMs,
    updatedAt: st.mtimeMs,
  };
  cache.set(file, { mtimeMs: st.mtimeMs, info });
  return info;
}

export function listSessions() {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const dir of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const info = parse(path.join(full, f));
        if (info.cwd && info.prompts > 0) out.push(info);
      } catch {}
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function lastAssistantText(transcriptPath) {
  try {
    const st = fs.statSync(transcriptPath);
    const size = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString().split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type !== 'assistant' || o.isSidechain) continue;
        const t = textOf(o.message?.content).trim();
        if (t) return t;
      } catch {}
    }
  } catch {}
  return null;
}

// Last few assistant texts of a transcript (newest last), for a handoff built without asking Claude.
export function recentAssistantTexts(transcriptPath, n = 3) {
  const out = [];
  try {
    const st = fs.statSync(transcriptPath);
    const size = Math.min(st.size, 8 * 1024 * 1024); // screenshots make lines huge
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    for (const line of buf.toString().split('\n').reverse()) {
      if (out.length >= n) break;
      if (!line.includes('"assistant"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type !== 'assistant' || o.isSidechain || o.isApiErrorMessage || o.message?.model === '<synthetic>') continue;
        const t = textOf(o.message?.content).trim();
        if (t) out.unshift(t);
      } catch {}
    }
  } catch {}
  return out;
}

export function firstPrompt(transcriptPath) {
  try { return parse(transcriptPath).firstPrompt; } catch { return null; }
}

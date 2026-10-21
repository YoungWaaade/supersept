import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

export async function git(cwd, ...args) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

export async function isRepo(dir) {
  try {
    return (await git(dir, 'rev-parse', '--is-inside-work-tree')).trim() === 'true';
  } catch {
    return false;
  }
}

export async function currentBranch(dir) {
  try {
    return (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
  } catch {
    return null;
  }
}

export async function branches(dir) {
  try {
    const out = await git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export async function addWorktree(repo, dest, branch, base) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await git(repo, 'worktree', 'add', '-b', branch, dest, base);
  // Untracked env files never make it into a fresh worktree; bring them along.
  for (const f of fs.readdirSync(repo)) {
    if (/^\.env/.test(f) && fs.statSync(path.join(repo, f)).isFile() && !fs.existsSync(path.join(dest, f))) {
      fs.copyFileSync(path.join(repo, f), path.join(dest, f));
    }
  }
}

// The owning repo is derived from the worktree itself, so this works even after the
// workspace was moved to another project.
export async function removeWorktree(dest) {
  let repo = null;
  try { repo = path.dirname(path.resolve(dest, (await git(dest, 'rev-parse', '--git-common-dir')).trim())); } catch {}
  try {
    if (!repo) throw new Error('no repo');
    await git(repo, 'worktree', 'remove', '--force', dest);
  } catch {
    fs.rmSync(dest, { recursive: true, force: true });
    if (repo) await git(repo, 'worktree', 'prune').catch(() => {});
  }
}

async function diffBase(ws) {
  if (ws.base_branch) {
    try {
      return (await git(ws.cwd, 'merge-base', 'HEAD', ws.base_branch)).trim();
    } catch {}
  }
  return 'HEAD';
}

async function untracked(cwd) {
  const out = await git(cwd, 'ls-files', '--others', '--exclude-standard');
  return out.split('\n').filter(Boolean);
}

export async function stats(ws) {
  if (!(await isRepo(ws.cwd))) return null;
  const base = await diffBase(ws);
  let add = 0, del = 0, files = 0;
  for (const line of (await git(ws.cwd, 'diff', '--numstat', base)).split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t');
    add += Number(a) || 0;
    del += Number(d) || 0;
    files++;
  }
  for (const f of await untracked(ws.cwd)) {
    files++;
    try {
      const buf = fs.readFileSync(path.join(ws.cwd, f));
      if (buf.length < 1_000_000 && !buf.includes(0)) add += buf.toString().replace(/\n$/, '').split('\n').length;
    } catch {}
  }
  return { add, del, files };
}

export async function diff(ws) {
  if (!(await isRepo(ws.cwd))) return { patch: '', base: null };
  const base = await diffBase(ws);
  let patch = await git(ws.cwd, 'diff', '--no-color', base);
  for (const f of await untracked(ws.cwd)) {
    try {
      const buf = fs.readFileSync(path.join(ws.cwd, f));
      if (buf.length > 500_000 || buf.includes(0)) {
        patch += `diff --git a/${f} b/${f}\nnew file\nBinary or large file\n`;
        continue;
      }
      const lines = buf.toString().replace(/\n$/, '').split('\n');
      patch += `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n`;
      patch += lines.map((l) => '+' + l).join('\n') + '\n';
    } catch {}
  }
  return { patch, base: base === 'HEAD' ? 'HEAD' : ws.base_branch };
}

export async function commits(ws) {
  if (!(await isRepo(ws.cwd)) || !ws.base_branch) return [];
  try {
    const out = await git(ws.cwd, 'log', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at', `${ws.base_branch}..HEAD`);
    return out.split('\n').filter(Boolean).map((l) => {
      const [sha, short, subject, author, at] = l.split('\x1f');
      return { sha, short, subject, author, at: Number(at) * 1000 };
    });
  } catch {
    return [];
  }
}

export async function showCommit(ws, sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('commit invalide');
  return git(ws.cwd, 'show', '--no-color', '--format=', sha);
}

// Changed paths with their status letter (M/A/D/R/?) relative to the diff base.
export async function changedFiles(ws) {
  if (!(await isRepo(ws.cwd))) return [];
  const base = await diffBase(ws);
  const files = new Map();
  for (const line of (await git(ws.cwd, 'diff', '--name-status', base)).split('\n').filter(Boolean)) {
    const [st, ...paths] = line.split('\t');
    files.set(paths[paths.length - 1], st[0]);
  }
  for (const f of await untracked(ws.cwd)) files.set(f, '?');
  return [...files].map(([path, status]) => ({ path, status }));
}

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache', '.venv', '__pycache__']);
export async function listFiles(dir) {
  if (await isRepo(dir)) {
    const out = await git(dir, 'ls-files', '-co', '--exclude-standard');
    return out.split('\n').filter(Boolean).slice(0, 20000);
  }
  const out = [];
  const walk = (rel) => {
    if (out.length >= 5000) return;
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('.DS_Store')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  try { walk(''); } catch {}
  return out;
}

// Local + origin branches, most recent first, for the branch picker.
export async function branchList(dir) {
  if (!(await isRepo(dir))) return [];
  const fmt = '%(refname)%1f%(refname:short)%1f%(committerdate:unix)';
  const out = await git(dir, 'for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes/origin');
  let def = null;
  try { def = (await git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).trim().replace(/^origin\//, ''); } catch {}
  const worktrees = new Set();
  try {
    for (const l of (await git(dir, 'worktree', 'list', '--porcelain')).split('\n')) if (l.startsWith('branch refs/heads/')) worktrees.add(l.slice(18));
  } catch {}
  const local = new Map(), remote = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, short, at] = line.split('\x1f');
    if (ref.startsWith('refs/heads/')) local.set(short, Number(at) * 1000);
    else if (!short.endsWith('/HEAD') && short !== 'origin') remote.set(short.replace(/^origin\//, ''), Number(at) * 1000);
  }
  def ??= local.has('main') ? 'main' : local.has('master') ? 'master' : null;
  const all = [...local].map(([name, at]) => ({ name, at, remote: false }));
  for (const [name, at] of remote) if (!local.has(name)) all.push({ name: `origin/${name}`, at, remote: true });
  return all
    .map((b) => ({ ...b, isDefault: b.name === def, worktree: worktrees.has(b.name) }))
    .sort((a, b) => (b.isDefault - a.isDefault) || b.at - a.at);
}

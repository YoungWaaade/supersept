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

export async function removeWorktree(repo, dest) {
  try {
    await git(repo, 'worktree', 'remove', '--force', dest);
  } catch {
    fs.rmSync(dest, { recursive: true, force: true });
    await git(repo, 'worktree', 'prune').catch(() => {});
  }
}

async function diffBase(ws) {
  if (ws.is_worktree && ws.base_branch) {
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

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const pty = createRequire(import.meta.url)('node-pty');
const SCROLLBACK = 400 * 1024;
const SHELL = process.env.SHELL || '/bin/zsh';

// Resolve the login-shell PATH once, so agents find the same tools as in a normal terminal
// even when the hub is started from a LaunchAgent with a minimal environment.
let loginPath = process.env.PATH;
try {
  loginPath = execFileSync(SHELL, ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 }) || loginPath;
} catch {}

export function which(bin) {
  try {
    return execFileSync('/usr/bin/which', [bin], { encoding: 'utf8', env: { PATH: loginPath } }).trim();
  } catch {
    return null;
  }
}

export function childEnv(extra) {
  const env = { ...process.env, PATH: loginPath, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extra };
  // Don't let agents think they are nested inside the Claude Code that may have started the hub.
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}

class Session {
  constructor(key, file, args, cwd, env, onExit) {
    this.key = key;
    this.buffer = '';
    this.clients = new Set();
    this.alive = true;
    this.proc = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 36, cwd, env: childEnv(env) });
    this.proc.onData((d) => {
      this.buffer += d;
      if (this.buffer.length > SCROLLBACK) this.buffer = this.buffer.slice(-SCROLLBACK);
      this.broadcast({ type: 'output', data: d });
    });
    this.proc.onExit(({ exitCode }) => {
      this.alive = false;
      const msg = `\r\n\x1b[2m[processus terminé · code ${exitCode}]\x1b[0m\r\n`;
      this.buffer += msg;
      this.broadcast({ type: 'output', data: msg });
      this.broadcast({ type: 'exit', exitCode });
      onExit?.(exitCode);
    });
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) ws.send(s);
  }
  write(d) { if (this.alive) this.proc.write(d); }
  resize(c, r) { if (this.alive && c > 0 && r > 0) try { this.proc.resize(c, r); } catch {} }
  kill() { if (this.alive) try { this.proc.kill(); } catch {} }
}

export const sessions = new Map();

export function spawn(key, file, args, cwd, { env, onExit } = {}) {
  sessions.get(key)?.kill();
  const s = new Session(key, file, args, cwd, env, () => {
    if (sessions.get(key) === s) onExit?.();
  });
  sessions.set(key, s);
  return s;
}

export function spawnShell(key, cwd) {
  return spawn(key, SHELL, ['-l'], cwd);
}

export function killWorkspace(wsId) {
  for (const [k, s] of sessions) if (k.startsWith(wsId + ':')) { s.kill(); sessions.delete(k); }
}

export const homedir = os.homedir();

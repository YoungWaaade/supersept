// node-pty ships spawn-helper without the exec bit on some installs
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve('node_modules/node-pty/prebuilds');
if (fs.existsSync(dir)) for (const d of fs.readdirSync(dir)) {
  const f = path.join(dir, d, 'spawn-helper');
  if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
}

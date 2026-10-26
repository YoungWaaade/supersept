#!/usr/bin/env node
// `supersept` command used by chat agents (through Claude Code's Bash tool) to drive Supersept.
import * as ops from './ops.js';

const HELP = `supersept — piloter Supersept

  supersept projects
  supersept create-project --name "Nom" [--github owner/repo | --folder ~/chemin]
  supersept start-session --task "mission complète" [--project ID] [--name "Nom"] [--mode local|worktree] [--agent slug]
  supersept sessions [--project ID] [--mine]
  supersept session ID
  supersept send ID "message"
  supersept archive ID
  supersept memory PROJECT_ID
  supersept set-memory PROJECT_ID --content "texte"   (ou le texte sur l'entrée standard)

Résultats en JSON.`;

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[k] = true;
    else { flags[k] = next; i++; }
  } else pos.push(a);
}
const stdin = async () => {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
};

const run = {
  projects: () => ops.listProjects(),
  'create-project': () => ops.createProject({ name: flags.name, github: flags.github, folder: flags.folder }),
  'start-session': () => ops.startSession({ project: flags.project, task: flags.task, name: flags.name, mode: flags.mode, agent: flags.agent }),
  sessions: () => ops.listSessions({ project: flags.project, mine: !!flags.mine }),
  session: () => ops.getSession(pos[0]),
  send: () => ops.sendToSession(pos[0], pos.slice(1).join(' ') || flags.message),
  archive: () => ops.archiveSession(pos[0]),
  memory: () => ops.readMemory(pos[0]),
  'set-memory': async () => ops.writeMemory(pos[0], flags.content ?? await stdin()),
};

if (!cmd || !run[cmd]) {
  console.log(HELP);
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
try {
  const out = await run[cmd]();
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`Erreur : ${e.message}`);
  process.exit(1);
}

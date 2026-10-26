import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HUB_DIR = process.env.CLAUDE_HUB_DIR || path.join(os.homedir(), '.claude-hub');
export const MEMORY_DIR = path.join(HUB_DIR, 'memory');
export const HOOKS_DIR = path.join(HUB_DIR, 'hooks');
export const WORKTREES_DIR = path.join(HUB_DIR, 'worktrees');
for (const d of [HUB_DIR, MEMORY_DIR, HOOKS_DIR, WORKTREES_DIR]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(path.join(HUB_DIR, 'hub.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    color TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    branch TEXT,
    base_branch TEXT,
    is_worktree INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL,
    has_conversation INTEGER NOT NULL DEFAULT 0,
    initial_prompt TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    status_since INTEGER NOT NULL,
    last_message TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT,
    at INTEGER NOT NULL
  );
`);
// v2: workspaces may live outside any project ("Sessions" section) → project_id becomes nullable.
const projectCol = db.prepare("SELECT \"notnull\" AS nn FROM pragma_table_info('workspaces') WHERE name = 'project_id'").get();
if (projectCol?.nn) {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON; -- keep events FK pointing at "workspaces"
    BEGIN;
    ALTER TABLE workspaces RENAME TO workspaces_old;
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      branch TEXT,
      base_branch TEXT,
      is_worktree INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      has_conversation INTEGER NOT NULL DEFAULT 0,
      initial_prompt TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      status_since INTEGER NOT NULL,
      last_message TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO workspaces SELECT * FROM workspaces_old;
    DROP TABLE workspaces_old;
    COMMIT;
  `);
}
db.exec('PRAGMA foreign_keys = ON');

// v3: several projects may share a folder (a project is a topic, e.g. several Figma tasks run from ~).
const projectsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()?.sql || '';
if (/path TEXT NOT NULL UNIQUE/.test(projectsSql)) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('projects')").all().map((c) => c.name).join(', ');
  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN;
    ALTER TABLE projects RENAME TO projects_old;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      color TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL${cols.includes('run_command') ? ',\n      run_command TEXT' : ''}
    );
    INSERT INTO projects (${cols}) SELECT ${cols} FROM projects_old;
    DROP TABLE projects_old;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `);
}

// Additive migrations.
const addColumn = (table, col, type) => {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
};
addColumn('workspaces', 'model', 'TEXT');
addColumn('workspaces', 'effort', 'TEXT');
addColumn('workspaces', 'permission_mode', 'TEXT');
addColumn('projects', 'run_command', 'TEXT');
addColumn('workspaces', 'autostart', 'INTEGER NOT NULL DEFAULT 0');
addColumn('workspaces', 'agent', 'TEXT');
addColumn('workspaces', 'owner_agent', 'TEXT');
// Chat agents: one ongoing Claude conversation per agent, and the messages shown in the chat.
db.exec(`CREATE TABLE IF NOT EXISTS agent_chats (
  agent TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT,
  meta TEXT,
  at INTEGER NOT NULL
)`);
// Agent that delegated the current mission (e.g. Nami): replies are forwarded to it.
addColumn('agent_chats', 'manager', 'TEXT');
// Conversations are numbered per agent: "Nouvelle conversation" archives instead of deleting.
addColumn('chat_messages', 'conversation', 'INTEGER NOT NULL DEFAULT 0');
addColumn('agent_chats', 'conversation', 'INTEGER NOT NULL DEFAULT 0');
// Set while a turn runs, so a turn cut by a hub restart can be picked up again at boot.
addColumn('agent_chats', 'running', 'INTEGER NOT NULL DEFAULT 0');
// Extra agent tabs inside a workspace: each one is its own Claude conversation.
db.exec(`CREATE TABLE IF NOT EXISTS agent_tabs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

export const memoryFile = (projectId) => path.join(MEMORY_DIR, `${projectId}.md`);

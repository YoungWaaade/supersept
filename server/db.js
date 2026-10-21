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
    path TEXT NOT NULL UNIQUE,
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

// Additive migrations.
const addColumn = (table, col, type) => {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
};
addColumn('workspaces', 'model', 'TEXT');
addColumn('workspaces', 'effort', 'TEXT');
addColumn('workspaces', 'permission_mode', 'TEXT');
addColumn('projects', 'run_command', 'TEXT');

export const memoryFile = (projectId) => path.join(MEMORY_DIR, `${projectId}.md`);

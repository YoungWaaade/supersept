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
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
db.exec('PRAGMA foreign_keys = ON');

export const memoryFile = (projectId) => path.join(MEMORY_DIR, `${projectId}.md`);

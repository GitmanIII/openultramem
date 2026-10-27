/**
 * `state.db` DDL. Derived, disposable, rebuildable: deleting the file loses no
 * history because every body is hydrated from the host database.
 */
import type { Database } from "bun:sqlite"

export const SCHEMA_VERSION = 2

export const DDL = `
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  directory TEXT NOT NULL,
  title TEXT,
  parent_id TEXT,
  model TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages(
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  created INTEGER NOT NULL,
  tool_name TEXT,
  chars INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_tri USING fts5(
  text,
  content='', contentless_delete=1,
  tokenize='trigram'
);

CREATE INDEX IF NOT EXISTS messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created);
CREATE INDEX IF NOT EXISTS messages_session_created ON messages(session_id, created);

-- Applied learn operations, for idempotency per operation hash.
CREATE TABLE IF NOT EXISTS learn_ops(
  hash TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  session_id TEXT
);
`

export function migrate(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(DDL)
  const current = db.query("SELECT value FROM meta WHERE key = 'schema'").get() as { value?: string } | null
  if (!current) {
    db.run("INSERT INTO meta(key, value) VALUES ('schema', ?)", [String(SCHEMA_VERSION)])
  }
}

export function metaGet(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | null
  return row?.value ?? null
}

export function metaSet(db: Database, key: string, value: string): void {
  db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
}

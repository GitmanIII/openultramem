# `state.db` schema and retrieval

Status: design. Not implemented.

`state.db` is a **derived index** over OpenCode's own session database. It is
disposable: deleting it loses no history. The host database is opened read-only
and never written.

Path: `<dataRoot>/state.db`, with `<dataRoot>` defaulting to
`~/.local/share/opencode/oum`. WAL, `synchronous=NORMAL`, `busy_timeout=5000`.

## DDL

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE sessions(
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

CREATE TABLE messages(
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,          -- user | assistant | tool | synthetic
  created INTEGER NOT NULL,
  tool_name TEXT,
  chars INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);

-- Word index: BM25 and phrase precision. Contentless: tokens only.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

-- Substring index: literal matching and high recall. Contentless: tokens only.
CREATE VIRTUAL TABLE messages_fts_tri USING fts5(
  text,
  content='', contentless_delete=1,
  tokenize='trigram'
);

CREATE INDEX messages_session_seq ON messages(session_id, seq);
CREATE INDEX messages_created ON messages(created);
```

Full text is hydrated from `opencode.db` by message ID. The indexes store tokens,
not message bodies.

## Ingest mapping (V2 only)

Source: `session_v2` + `session_message`.

| `session_message.type` | Stored as | Text |
|---|---|---|
| `user` | `user` | `data.text` |
| `assistant` | `assistant` | text blocks |
| assistant tool block | `tool` | tool name + bounded input/output |
| `synthetic` | `synthetic` | `data.text` unless it is an OUM/provider recall note |
| `system`, `idle`, `location-switched` | skipped | — |

- Reasoning blocks are skipped.
- `session_v2.parent_id` children get `hidden = 1`; searchable only with
  `include_children: true`.
- Every message upsert deletes and reinserts its FTS rows by `rid` in the same
  transaction.

Watermark: `(time_created, id)` in `meta`. Each sync re-scans a 60-second
overlap window. Upserts are idempotent by message ID.

Deletions: purge on `session.deleted` and on a full reconcile pass.

## Search

1. Sync (bounded, default 250 ms).
2. Word FTS and trigram FTS in parallel, top 50 each.
3. Reciprocal rank fusion (`k = 60`), dedupe by message ID, recency tiebreak.
4. Hydrate top hits; build snippets.
5. If sync fails or the index is empty, fall back to a bounded `LIKE` query over
   extracted host text.

Modes: `broad` (OR terms, default) and `exact` (phrase / substring).

## Invariants

- `opencode.db` is attached read-only (`mode=ro`).
- FTS tables are contentless; no duplicated message bodies.
- A vector/embedding index, if added later, records `model_id` and `dims`; a
  model change triggers a rebuild, not a silent mismatch.
- `state.db` corruption is recoverable by deletion and rebuild.

## Rebuild

```text
1. Stop the plugin.
2. Move state.db aside.
3. Start OUM; the first sync backfills V2 sessions.
```

No V1 session backfill is planned. Old V1 history stays in the host database but
is not indexed.

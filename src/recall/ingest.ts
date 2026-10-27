/**
 * V2 ingest: `session_v2` + `session_message` → `state.db`.
 *
 * Bounded by a time budget; idempotent by host message ID; each upsert replaces
 * that row's FTS entries in the same transaction.
 */
import type { Database } from "bun:sqlite"
import { metaGet, metaSet } from "./schema.ts"

const WATERMARK = "watermark"
const OVERLAP_MS = 60_000

export type Role = "user" | "assistant" | "tool" | "synthetic"

export interface Extracted {
  role: Role
  text: string
  toolName?: string
  /** Stable discriminator inside one host message (tool blocks). */
  block?: string
}

export interface SyncOptions {
  budgetMs: number
  maxChars: number
  batchSize?: number
}

export interface SyncResult {
  scanned: number
  upserted: number
  sessions: number
  ms: number
  stale: boolean
}

interface HostRow {
  id: string
  session_id: string
  type: string
  seq: number
  time_created: number
  data: string
}

interface Watermark {
  time: number
  id: string
}

const RECALL_NOTE = /^\s*<(provider-memory|oum-memory|oum[-_])/i

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max)
}

function toolText(block: Record<string, unknown>, max: number): string {
  const state = (block.state ?? {}) as Record<string, unknown>
  const input = state.input === undefined ? "" : JSON.stringify(state.input)
  let output = ""
  if (typeof state.output === "string") output = state.output
  else if (Array.isArray(state.content)) {
    output = state.content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("\n")
  }
  const name = typeof block.name === "string" ? block.name : "tool"
  return clip(`[tool:${name}]\n${clip(input, max / 3)}\n${clip(output, max / 2)}`, max)
}

/** Map one host message to zero or more index rows. */
export function extract(type: string, raw: string, maxChars: number): Extracted[] {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return []
  }

  switch (type) {
    case "user": {
      const text = typeof data.text === "string" ? data.text : ""
      return text.trim() ? [{ role: "user", text: clip(text, maxChars) }] : []
    }
    case "synthetic": {
      const text = typeof data.text === "string" ? data.text : ""
      if (!text.trim() || RECALL_NOTE.test(text)) return []
      return [{ role: "synthetic", text: clip(text, maxChars) }]
    }
    case "assistant": {
      const content = Array.isArray(data.content) ? data.content : []
      const out: Extracted[] = []
      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue
        const block = raw as Record<string, unknown>
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          out.push({ role: "assistant", text: clip(block.text, maxChars) })
        } else if (block.type === "tool") {
          const id = typeof block.id === "string" ? block.id : undefined
          out.push({ role: "tool", toolName: typeof block.name === "string" ? block.name : "tool", block: id, text: toolText(block, maxChars) })
        }
      }
      return out
    }
    default:
      // system, idle, location-switched
      return []
  }
}

export function hostRowId(messageId: string, block?: string): string {
  return block ? `${messageId}#${block}` : messageId
}

export function splitHostRowId(id: string): { messageId: string; block?: string } {
  const at = id.indexOf("#")
  return at === -1 ? { messageId: id } : { messageId: id.slice(0, at), block: id.slice(at + 1) }
}

function readWatermark(db: Database): Watermark {
  const raw = metaGet(db, WATERMARK)
  if (!raw) return { time: 0, id: "" }
  try {
    const parsed = JSON.parse(raw) as Partial<Watermark>
    return { time: Number(parsed.time ?? 0), id: String(parsed.id ?? "") }
  } catch {
    return { time: 0, id: "" }
  }
}

interface SessionRow {
  id: string
  project_id: string
  directory: string
  title: string | null
  parent_id: string | null
  model: string | null
  time_created: number
  time_updated: number
}

export function upsertSession(db: Database, host: Database, sessionID: string, known: Set<string>): boolean {
  if (known.has(sessionID)) return false
  const row = host
    .query("SELECT id, project_id, directory, title, parent_id, model, time_created, time_updated FROM session_v2 WHERE id = ?")
    .get(sessionID) as SessionRow | null
  if (!row) return false
  db.run(
    `INSERT INTO sessions(id, project_id, directory, title, parent_id, model, created, updated, hidden, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       project_id = excluded.project_id, directory = excluded.directory, title = excluded.title,
       parent_id = excluded.parent_id, model = excluded.model, updated = excluded.updated,
       hidden = excluded.hidden, indexed_at = excluded.indexed_at`,
    [
      row.id,
      row.project_id,
      row.directory,
      row.title,
      row.parent_id,
      row.model,
      row.time_created,
      row.time_updated,
      row.parent_id ? 1 : 0,
      Date.now(),
    ],
  )
  known.add(sessionID)
  return true
}

export function sync(db: Database, host: Database | null, options: SyncOptions): SyncResult {
  const started = Date.now()
  const budget = options.budgetMs
  const batch = options.batchSize ?? 500
  const maxChars = options.maxChars
  const result: SyncResult = { scanned: 0, upserted: 0, sessions: 0, ms: 0, stale: false }

  if (!host) {
    result.stale = true
    result.ms = Date.now() - started
    return result
  }

  const watermark = readWatermark(db)
  const from = Math.max(0, watermark.time - OVERLAP_MS)

  const select = host.query(
    `SELECT id, session_id, type, seq, time_created, data
       FROM session_message
      WHERE time_created > ? OR (time_created = ? AND id > ?)
      ORDER BY time_created, id
      LIMIT ?`,
  )

  const known = new Set<string>(
    (db.query("SELECT id FROM sessions").all() as { id: string }[]).map((row) => row.id),
  )

  const selectRid = db.query("SELECT rid FROM messages WHERE id = ?")
  const insertMessage = db.query(
    "INSERT INTO messages(id, session_id, seq, role, created, tool_name, chars, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const updateMessage = db.query(
    "UPDATE messages SET session_id = ?, seq = ?, role = ?, created = ?, tool_name = ?, chars = ?, indexed_at = ? WHERE rid = ?",
  )
  const deleteFts = db.query("DELETE FROM messages_fts WHERE rowid = ?")
  const deleteTri = db.query("DELETE FROM messages_fts_tri WHERE rowid = ?")
  const insertFts = db.query("INSERT INTO messages_fts(rowid, text) VALUES (?, ?)")
  const insertTri = db.query("INSERT INTO messages_fts_tri(rowid, text) VALUES (?, ?)")

  let cursorTime = from
  let cursorID = watermark.id

  const apply = db.transaction((rows: HostRow[]) => {
    for (const row of rows) {
      if (upsertSession(db, host, row.session_id, known)) result.sessions++
      const extracted = extract(row.type, row.data, maxChars)
      result.scanned++
      if (!extracted.length) continue

      for (const item of extracted) {
        const id = hostRowId(row.id, item.block)
        const existing = selectRid.get(id) as { rid: number } | null
        let rid: number
        if (existing) {
          rid = Number(existing.rid)
          updateMessage.run(row.session_id, row.seq, item.role, row.time_created, item.toolName ?? null, item.text.length, Date.now(), rid)
          deleteFts.run(rid)
          deleteTri.run(rid)
        } else {
          const inserted = insertMessage.run(
            id,
            row.session_id,
            row.seq,
            item.role,
            row.time_created,
            item.toolName ?? null,
            item.text.length,
            Date.now(),
          )
          rid = Number(inserted.lastInsertRowid)
        }
        insertFts.run(rid, item.text)
        insertTri.run(rid, item.text)
        result.upserted++
      }
    }
  })

  try {
    for (;;) {
      if (Date.now() - started >= budget) {
        result.stale = true
        break
      }
      const rows = select.all(cursorTime, cursorTime, cursorID, batch) as HostRow[]
      if (!rows.length) break
      apply(rows)
      const last = rows[rows.length - 1]!
      cursorTime = last.time_created
      cursorID = last.id
      metaSet(db, WATERMARK, JSON.stringify({ time: cursorTime, id: cursorID }))
      if (rows.length < batch) break
    }
  } catch (error) {
    result.stale = true
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { syncResult: result })
  } finally {
    result.ms = Date.now() - started
  }

  return result
}

export function purgeSession(db: Database, sessionID: string): number {
  const rids = db.query("SELECT rid FROM messages WHERE session_id = ?").all(sessionID) as { rid: number }[]
  const deleteFts = db.query("DELETE FROM messages_fts WHERE rowid = ?")
  const deleteTri = db.query("DELETE FROM messages_fts_tri WHERE rowid = ?")
  const remove = db.transaction(() => {
    for (const row of rids) {
      deleteFts.run(row.rid)
      deleteTri.run(row.rid)
    }
    db.run("DELETE FROM messages WHERE session_id = ?", [sessionID])
    db.run("DELETE FROM sessions WHERE id = ?", [sessionID])
  })
  remove()
  return rids.length
}

/** Drop mirror rows whose session no longer exists in the host. */
export function reconcile(db: Database, host: Database | null): number {
  if (!host) return 0
  const mirrored = db.query("SELECT id FROM sessions").all() as { id: string }[]
  let removed = 0
  for (const row of mirrored) {
    const exists = host.query("SELECT 1 FROM session_v2 WHERE id = ?").get(row.id)
    if (!exists) {
      purgeSession(db, row.id)
      removed++
    }
  }
  return removed
}

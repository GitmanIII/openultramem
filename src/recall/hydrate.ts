/**
 * Body hydration. `state.db` stores tokens only, so every hit's text comes from
 * the host database by message ID.
 */
import type { Database } from "bun:sqlite"
import { extract, splitHostRowId, type Role } from "./ingest.ts"
import type { Hit } from "./search.ts"
import { tokens } from "./search.ts"

export interface SessionMeta {
  id: string
  title: string | null
  directory: string
  projectID: string
  parentID: string | null
  created: number
  updated: number
  hidden: number
}

export interface HydratedHit extends Hit {
  session: SessionMeta | undefined
  text: string
  snippet: string
  link: string
}

interface HostMessage {
  data: string
  type: string
}

export function sessionMeta(db: Database, sessionID: string): SessionMeta | undefined {
  const row = db
    .query("SELECT id, title, directory, project_id, parent_id, created, updated, hidden FROM sessions WHERE id = ?")
    .get(sessionID) as
    | { id: string; title: string | null; directory: string; project_id: string; parent_id: string | null; created: number; updated: number; hidden: number }
    | null
  if (!row) return undefined
  return {
    id: row.id,
    title: row.title,
    directory: row.directory,
    projectID: row.project_id,
    parentID: row.parent_id,
    created: row.created,
    updated: row.updated,
    hidden: row.hidden,
  }
}

export function messageText(host: Database, id: string, maxChars: number): string {
  const { messageId, block } = splitHostRowId(id)
  const row = host.query("SELECT data, type FROM session_message WHERE id = ?").get(messageId) as HostMessage | null
  if (!row) return ""
  const parts = extract(row.type, row.data, maxChars)
  if (!parts.length) return ""
  if (block) {
    const match = parts.find((part) => part.block === block)
    return match?.text ?? parts.map((part) => part.text).join("\n")
  }
  return parts[0]!.text
}

export function snippet(text: string, query: string, width = 160): string {
  if (!text) return ""
  const flat = text.replace(/\s+/g, " ").trim()
  const terms = tokens(query)
  let at = -1
  const lower = flat.toLowerCase()
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found !== -1 && (at === -1 || found < at)) at = found
  }
  if (at === -1) return flat.length <= width * 2 ? flat : `${flat.slice(0, width * 2)}…`
  const start = Math.max(0, at - width / 2)
  const end = Math.min(flat.length, at + width * 1.5)
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`
}

export function hydrate(db: Database, host: Database, hits: Hit[], query: string, maxChars: number): HydratedHit[] {
  return hits.map((hit) => ({
    ...hit,
    session: sessionMeta(db, hit.sessionID),
    text: messageText(host, hit.id, maxChars),
    snippet: "",
    link: `@session/local/${hit.sessionID}`,
  })).map((hit) => ({ ...hit, snippet: snippet(hit.text, query) }))
}

export interface SessionRowsOptions {
  limit?: number
  aroundMessageID?: string
  maxChars?: number
}

export interface SessionRow {
  id: string
  seq: number
  role: Role | string
  created: number
  toolName: string | null
  text: string
}

/** Read a session (or a window around one message) in order. */
export function readSession(db: Database, host: Database, sessionID: string, options: SessionRowsOptions = {}): SessionRow[] {
  const limit = options.limit ?? 40
  const maxChars = options.maxChars ?? 8_000

  let anchor: number | null = null
  if (options.aroundMessageID) {
    const row = db
      .query("SELECT seq FROM messages WHERE session_id = ? AND (id = ? OR id LIKE ?) LIMIT 1")
      .get(sessionID, options.aroundMessageID, `${options.aroundMessageID}#%`) as { seq: number } | null
    anchor = row?.seq ?? null
  }

  const rows = (
    anchor === null
      ? db
          .query(
            `SELECT id, seq, role, created, tool_name FROM messages
              WHERE session_id = ? ORDER BY created, seq, rid LIMIT ?`,
          )
          .all(sessionID, limit)
      : db
          .query(
            `SELECT id, seq, role, created, tool_name FROM messages
              WHERE session_id = ? ORDER BY ABS(seq - ?), created LIMIT ?`,
          )
          .all(sessionID, anchor, limit)
  ) as { id: string; seq: number; role: string; created: number; tool_name: string | null }[]

  if (anchor !== null) rows.sort((a, b) => a.seq - b.seq || a.created - b.created)

  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    role: row.role,
    created: row.created,
    toolName: row.tool_name,
    text: messageText(host, row.id, maxChars),
  }))
}

export function recentSessions(db: Database, options: { limit?: number; includeChildren?: boolean; project?: string } = {}): SessionMeta[] {
  const rows = db
    .query(
      `SELECT id, title, directory, project_id, parent_id, created, updated, hidden
         FROM sessions
        WHERE (? = 1 OR hidden = 0)
          AND (? IS NULL OR project_id = ?)
        ORDER BY updated DESC
        LIMIT ?`,
    )
    .all(options.includeChildren ? 1 : 0, options.project ?? null, options.project ?? null, options.limit ?? 10) as {
    id: string
    title: string | null
    directory: string
    project_id: string
    parent_id: string | null
    created: number
    updated: number
    hidden: number
  }[]

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    directory: row.directory,
    projectID: row.project_id,
    parentID: row.parent_id,
    created: row.created,
    updated: row.updated,
    hidden: row.hidden,
  }))
}

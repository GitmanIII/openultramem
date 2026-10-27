/**
 * Hybrid search: word FTS + trigram FTS, merged with reciprocal rank fusion.
 *
 * Contentless FTS tables only yield rowids, so ranking happens here and bodies
 * are hydrated from the host afterwards.
 */
import type { Database } from "bun:sqlite"

export type Mode = "broad" | "exact"

export interface SearchOptions {
  limit?: number
  mode?: Mode
  includeChildren?: boolean
  project?: string
  trigram?: boolean
  perIndex?: number
}

export interface Hit {
  rid: number
  id: string
  sessionID: string
  seq: number
  role: string
  created: number
  toolName: string | null
  score: number
  matched: "word" | "trigram" | "both" | "like"
}

const RRF_K = 60

export function tokens(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16)
}

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function buildWordQuery(query: string, mode: Mode): string {
  if (mode === "exact") {
    const phrase = query.trim()
    return phrase ? quoted(phrase) : ""
  }
  return tokens(query).map(quoted).join(" OR ")
}

export function buildTrigramQuery(query: string, mode: Mode): string {
  if (mode === "exact") {
    const phrase = query.trim()
    return phrase.length >= 3 ? quoted(phrase) : ""
  }
  return tokens(query)
    .filter((token) => token.length >= 3)
    .map(quoted)
    .join(" OR ")
}

interface Ranked {
  rid: number
  score: number
}

// FTS5 bm25() and MATCH need the real table name, so the query is templated per index.
function runNamed(db: Database, table: "messages_fts" | "messages_fts_tri", query: string, options: SearchOptions, perIndex: number): Ranked[] {
  if (!query) return []
  try {
    return db
      .query(
        `SELECT ${table}.rowid AS rid, bm25(${table}) AS score
           FROM ${table}
           JOIN messages m ON m.rid = ${table}.rowid
           JOIN sessions s ON s.id = m.session_id
          WHERE ${table} MATCH ?
            AND (? = 1 OR s.hidden = 0)
            AND (? IS NULL OR s.project_id = ?)
          ORDER BY score
          LIMIT ?`,
      )
      .all(query, options.includeChildren ? 1 : 0, options.project ?? null, options.project ?? null, perIndex) as Ranked[]
  } catch {
    return []
  }
}

export function search(db: Database, query: string, options: SearchOptions = {}): Hit[] {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50)
  const perIndex = options.perIndex ?? 50
  const mode = options.mode ?? "broad"

  const word = runNamed(db, "messages_fts", buildWordQuery(query, mode), options, perIndex)
  const tri = options.trigram === false ? [] : runNamed(db, "messages_fts_tri", buildTrigramQuery(query, mode), options, perIndex)

  const fused = new Map<number, { score: number; word: number; tri: number }>()
  const add = (rows: Ranked[], kind: "word" | "tri") => {
    rows.forEach((row, index) => {
      const entry = fused.get(row.rid) ?? { score: 0, word: 0, tri: 0 }
      entry.score += 1 / (RRF_K + index + 1)
      entry[kind] = index + 1
      fused.set(row.rid, entry)
    })
  }
  add(word, "word")
  add(tri, "tri")

  if (!fused.size) return []

  const rids = [...fused.keys()]
  const placeholders = rids.map(() => "?").join(",")
  const rows = db
    .query(
      `SELECT rid, id, session_id, seq, role, created, tool_name
         FROM messages WHERE rid IN (${placeholders})`,
    )
    .all(...rids) as {
    rid: number
    id: string
    session_id: string
    seq: number
    role: string
    created: number
    tool_name: string | null
  }[]

  const hits: Hit[] = rows.map((row) => {
    const entry = fused.get(row.rid)!
    return {
      rid: row.rid,
      id: row.id,
      sessionID: row.session_id,
      seq: row.seq,
      role: row.role,
      created: row.created,
      toolName: row.tool_name,
      score: entry.score,
      matched: entry.word > 0 && entry.tri > 0 ? "both" : entry.word > 0 ? "word" : "trigram",
    }
  })

  hits.sort((a, b) => b.score - a.score || b.created - a.created)
  return hits.slice(0, limit)
}

export interface FallbackOptions {
  limit?: number
  includeChildren?: boolean
  project?: string
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
}

/** Bounded `LIKE` over host text, used when the index is empty or stale. */
export function searchHost(host: Database, query: string, options: FallbackOptions = {}): Hit[] {
  const terms = tokens(query).slice(0, 4)
  if (!terms.length) return []
  const limit = options.limit ?? 10
  const like = terms.map(() => "sm.data LIKE ? ESCAPE '\\'").join(" OR ")
  const params = terms.map((term) => `%${escapeLike(term)}%`)
  const rows = host
    .query(
      `SELECT sm.id, sm.session_id, sm.seq, sm.type, sm.time_created, s.parent_id, s.project_id
         FROM session_message sm
         JOIN session_v2 s ON s.id = sm.session_id
        WHERE (${like})
          AND (? = 1 OR s.parent_id IS NULL)
          AND (? IS NULL OR s.project_id = ?)
        ORDER BY sm.time_created DESC
        LIMIT ?`,
    )
    .all(...params, options.includeChildren ? 1 : 0, options.project ?? null, options.project ?? null, limit) as {
    id: string
    session_id: string
    seq: number
    type: string
    time_created: number
    parent_id: string | null
    project_id: string
  }[]

  return rows.map((row) => ({
    rid: -1,
    id: row.id,
    sessionID: row.session_id,
    seq: row.seq,
    role: row.type === "assistant" ? "assistant" : row.type,
    created: row.time_created,
    toolName: null,
    score: 1 / (RRF_K + 1),
    matched: "like" as const,
  }))
}

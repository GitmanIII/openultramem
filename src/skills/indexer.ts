/**
 * Internal skill index: dedupe before create, and candidate selection for the
 * learn module. Never exposed as a tool — native advertising is the search.
 */
import type { Database } from "bun:sqlite"
import type { DiscoveredSkill } from "./roots.ts"

export interface Duplicate {
  id: string
  description: string
  scope: string
}

export function indexSkills(db: Database, skills: DiscoveredSkill[]): void {
  const upsert = db.query(
    `INSERT INTO skills(id, name, description, scope, path, origin, pinned, sha, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description, scope = excluded.scope,
       path = excluded.path, origin = excluded.origin, pinned = excluded.pinned,
       sha = excluded.sha, updated = excluded.updated`,
  )
  const rid = db.query("SELECT rid FROM skills WHERE id = ?")
  const delFts = db.query("DELETE FROM skills_fts WHERE rowid = ?")
  const insFts = db.query("INSERT INTO skills_fts(rowid, id, name, description) VALUES (?, ?, ?, ?)")

  const apply = db.transaction(() => {
    const seen = new Set<string>()
    for (const skill of skills) {
      seen.add(skill.id)
      upsert.run(
        skill.id,
        skill.name,
        skill.description,
        skill.root.scope,
        skill.path,
        skill.origin,
        skill.pinned ? 1 : 0,
        skill.sha,
        Date.now(),
      )
      const row = rid.get(skill.id) as { rid: number } | null
      if (!row) continue
      delFts.run(row.rid)
      insFts.run(row.rid, skill.id, skill.name, skill.description)
    }

    for (const row of db.query("SELECT id FROM skills").all() as { id: string }[]) {
      if (seen.has(row.id)) continue
      const existing = rid.get(row.id) as { rid: number } | null
      if (existing) delFts.run(existing.rid)
      db.run("DELETE FROM skills WHERE id = ?", [row.id])
    }
  })
  apply()
}

/** Near-duplicate search over existing descriptions. */
export function findDuplicates(db: Database, text: string, limit = 3): Duplicate[] {
  const terms = (text.toLowerCase().match(/[a-z]{4,}/g) ?? []).slice(0, 8)
  if (!terms.length) return []
  const query = terms.map((term) => `"${term}"`).join(" OR ")
  try {
    return db
      .query(
        `SELECT s.id, s.description, s.scope
           FROM skills_fts f JOIN skills s ON s.rid = f.rowid
          WHERE skills_fts MATCH ?
          ORDER BY bm25(skills_fts)
          LIMIT ?`,
      )
      .all(query, limit) as Duplicate[]
  } catch {
    return []
  }
}

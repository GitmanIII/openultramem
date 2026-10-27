/**
 * Database handles.
 *
 * The host database is opened read-only and never written. `state.db` is ours.
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { migrate } from "./schema.ts"

export function openState(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  migrate(db)
  return db
}

/** Returns `null` when the host has no database yet (fresh install). */
export function openHost(path: string): Database | null {
  if (!existsSync(path)) return null
  return new Database(path, { readonly: true })
}

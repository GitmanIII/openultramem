/**
 * Skill audit trail: a JSONL ledger plus backups and the archive.
 *
 * Nothing under the skill roots is ever a hard delete: deletions move the
 * directory into `<dataRoot>/skill-archive/`.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Origin, Scope } from "./frontmatter.ts"

export interface LedgerRecord {
  ts: string
  action: "create" | "patch" | "write_file" | "remove_file" | "delete" | "promote" | "fork"
  id: string
  scope: Scope
  path: string
  origin?: Origin
  from?: string
  to?: string
  bytes?: number
  sha?: string
  note?: string
}

export class Ledger {
  constructor(private readonly path: string) {}

  append(record: Omit<LedgerRecord, "ts">): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n")
    } catch {
      // audit failure must not roll back a valid mutation
    }
  }

  read(): LedgerRecord[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerRecord]
        } catch {
          return []
        }
      })
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

/** Copy a skill directory aside before a destructive edit. */
export function backupSkill(dataRoot: string, id: string, dir: string): string {
  const target = join(dataRoot, "skill-backups", `${id}-${stamp()}`)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(dir, target, { recursive: true })
  return target
}

/** Move a deleted skill out of the library instead of unlinking it. */
export function archiveSkill(dataRoot: string, id: string, dir: string): string {
  const target = join(dataRoot, "skill-archive", `${id}-${stamp()}`)
  mkdirSync(dirname(target), { recursive: true })
  renameSync(dir, target)
  return target
}

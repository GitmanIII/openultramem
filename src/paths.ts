/**
 * Filesystem layout.
 *
 * Two roots, deliberately separate:
 *  - memoryRoot: user-owned Markdown that survives everything (config).
 *  - dataRoot:   OUM's derived state (cache): disposable, rebuildable.
 */
import { homedir } from "node:os"
import { join } from "node:path"

export function expandHome(input: string): string {
  if (input === "~") return homedir()
  if (input.startsWith("~/")) return join(homedir(), input.slice(2))
  return input
}

export function hostDatabase(): string {
  return join(homedir(), ".local", "share", "opencode", "opencode.db")
}

export function stateDatabase(dataRoot: string): string {
  return join(expandHome(dataRoot), "state.db")
}

export function memoryFile(memoryRoot: string): string {
  return join(expandHome(memoryRoot), "MEMORY.md")
}

export function userFile(memoryRoot: string): string {
  return join(expandHome(memoryRoot), "USER.md")
}

export function projectMemoryFile(memoryRoot: string, key: string): string {
  return join(expandHome(memoryRoot), "projects", key, "MEMORY.md")
}

/**
 * Project memory key.
 *
 * `project.id` alone is not unique for local-only repositories, which share the
 * global project id. Keying by the canonical directory keeps two unrelated local
 * directories from reading each other's notes; the id keeps it legible.
 */
export function projectMemoryKey(project: { id: string; canonical?: string; directory?: string }): string {
  const path = project.canonical || project.directory || ""
  if (!path) return project.id
  const digest = new Bun.CryptoHasher("sha256").update(path).digest("hex").slice(0, 10)
  return `${project.id}-${digest}`
}

export function policyFile(memoryRoot: string): string {
  return join(expandHome(memoryRoot), "POLICY.md")
}

export function ledgerFile(dataRoot: string): string {
  return join(expandHome(dataRoot), "skills-ledger.jsonl")
}

export function learnEventsFile(dataRoot: string): string {
  return join(expandHome(dataRoot), "learn-events.jsonl")
}

export function backupDir(dataRoot: string): string {
  return join(expandHome(dataRoot), "skill-backups")
}

export function archiveDir(dataRoot: string): string {
  return join(expandHome(dataRoot), "skill-archive")
}

/**
 * Canonical memory: two bounded Markdown files, `§`-joined entries.
 *
 * Rules from the design:
 *  - writes are atomic (temp + fsync + rename) and serialised by a lock file;
 *  - a change is planned against a fresh read, so external edits survive;
 *  - over-budget adds are refused with per-entry sizes and a consolidation hint;
 *  - entries may not contain the delimiter, be empty, or read like an injection.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { memoryFile, userFile } from "../paths.ts"

export type Target = "memory" | "user"

export const DELIMITER = "\n§\n"

export interface Entry {
  index: number
  text: string
  chars: number
}

export interface FileState {
  target: Target
  path: string
  entries: string[]
  chars: number
  budget: number
  percent: number
}

export interface MemoryOperation {
  action: "add" | "replace" | "remove"
  target: Target
  content?: string
  old_text?: string
}

export interface OpResult {
  action: string
  target: Target
  status: "applied" | "refused" | "skipped"
  message: string
}

export interface ApplyResult {
  ok: boolean
  results: OpResult[]
  memory: FileState
  user: FileState
}

const INJECTION = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /system\s+prompt\s*:/i,
  /<\s*\/?\s*(system|assistant|user)\s*>/i,
]

export function validate(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed) return "empty entry"
  if (content.includes("§")) return 'entry may not contain the "§" delimiter'
  if (INJECTION.some((pattern) => pattern.test(content))) return "entry reads like a prompt injection"
  return null
}

export function sizes(content: string, budget: number): { chars: number; percent: number } {
  const chars = [...content].length
  return { chars, percent: Math.round((chars / budget) * 100) }
}

export function parse(raw: string): string[] {
  return raw
    .split(DELIMITER)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function serialize(entries: string[]): string {
  return entries.join(DELIMITER) + (entries.length ? "\n" : "")
}

export class MemoryStore {
  private readonly paths: Record<Target, string>
  private readonly budgets: Record<Target, number>
  private readonly lockPath: string

  constructor(options: { memoryRoot: string; memoryChars: number; userChars: number }) {
    this.paths = { memory: memoryFile(options.memoryRoot), user: userFile(options.memoryRoot) }
    this.budgets = { memory: options.memoryChars, user: options.userChars }
    this.lockPath = join(dirname(this.paths.memory), ".write.lock")
  }

  path(target: Target): string {
    return this.paths[target]
  }

  budget(target: Target): number {
    return this.budgets[target]
  }

  readRaw(target: Target): string {
    const path = this.paths[target]
    if (!existsSync(path)) return ""
    return readFileSync(path, "utf8")
  }

  state(target: Target): FileState {
    const raw = this.readRaw(target)
    const entries = parse(raw)
    const { chars, percent } = sizes(serialize(entries), this.budgets[target])
    return { target, path: this.paths[target], entries, chars, budget: this.budgets[target], percent }
  }

  both(): { memory: FileState; user: FileState } {
    return { memory: this.state("memory"), user: this.state("user") }
  }

  /** Apply operations atomically: all or nothing, against one fresh read. */
  apply(operations: MemoryOperation[]): ApplyResult {
    const release = this.lock()
    try {
      const drafts: Record<Target, string[]> = {
        memory: parse(this.readRaw("memory")),
        user: parse(this.readRaw("user")),
      }
      const results: OpResult[] = []
      const touched = new Set<Target>()

      for (const op of operations) {
        const target = op.target
        if (target !== "memory" && target !== "user") {
          results.push({ action: op.action, target: target as Target, status: "refused", message: "unknown target" })
          continue
        }
        const entries = drafts[target]

        if (op.action === "add") {
          const content = (op.content ?? "").trim()
          const invalid = validate(content)
          if (invalid) {
            results.push({ action: "add", target, status: "refused", message: invalid })
            continue
          }
          if (entries.includes(content)) {
            results.push({ action: "add", target, status: "skipped", message: "already present" })
            continue
          }
          const next = [...entries, content]
          const budget = this.fit(target, next, entries, content)
          if (budget) {
            results.push({ action: "add", target, status: "refused", message: budget })
            continue
          }
          drafts[target] = next
          touched.add(target)
          results.push({ action: "add", target, status: "applied", message: `${[...content].length} chars added` })
          continue
        }

        const needle = op.old_text ?? ""
        const matches = entries.filter((entry) => entry.includes(needle))
        if (!needle.trim()) {
          results.push({ action: op.action, target, status: "refused", message: "old_text is required" })
          continue
        }
        if (matches.length === 0) {
          results.push({ action: op.action, target, status: "refused", message: "old_text not found" })
          continue
        }
        if (matches.length > 1) {
          results.push({ action: op.action, target, status: "refused", message: `old_text matches ${matches.length} entries; be more specific` })
          continue
        }
        const match = matches[0]!

        if (op.action === "remove") {
          drafts[target] = entries.filter((entry) => entry !== match)
          touched.add(target)
          results.push({ action: "remove", target, status: "applied", message: "entry removed" })
          continue
        }

        const content = (op.content ?? "").trim()
        const invalid = validate(content)
        if (invalid) {
          results.push({ action: "replace", target, status: "refused", message: invalid })
          continue
        }
        const next = entries.map((entry) => (entry === match ? content : entry))
        const budget = this.fit(target, next, entries, content)
        if (budget) {
          results.push({ action: "replace", target, status: "refused", message: budget })
          continue
        }
        drafts[target] = next
        touched.add(target)
        results.push({ action: "replace", target, status: "applied", message: "entry replaced" })
      }

      const refused = results.some((result) => result.status === "refused")
      if (refused) {
        // All-or-nothing: nothing is written when any operation is refused.
        return { ok: false, results, ...this.both() }
      }

      for (const target of touched) this.write(target, serialize(drafts[target]))
      return { ok: true, results, ...this.both() }
    } finally {
      release()
    }
  }

  /**
   * Returns an error message when the planned entries exceed budget. The list
   * shows *current* entries only; the refused candidate is reported separately
   * so it is never mistaken for something already stored.
   */
  private fit(target: Target, planned: string[], current: string[], candidate: string): string | null {
    const { chars, percent } = sizes(serialize(planned), this.budgets[target])
    if (chars <= this.budgets[target]) return null
    const perEntry = current
      .map((entry, index) => `  ${index + 1}. ${[...entry].length} chars — ${entry.slice(0, 60)}${entry.length > 60 ? "…" : ""}`)
      .join("\n")
    return [
      `${target}.md would be ${chars}/${this.budgets[target]} chars (${percent}%). Nothing was written.`,
      `Refused entry: ${[...candidate].length} chars — ${candidate.slice(0, 60)}${candidate.length > 60 ? "…" : ""}`,
      `Consolidate first: merge near-duplicates, drop stale facts, then retry.`,
      `Current entries (${current.length}):`,
      perEntry,
    ].join("\n")
  }

  private write(target: Target, content: string): void {
    const path = this.paths[target]
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    const fd = openSync(tmp, "w")
    try {
      writeFileSync(fd, content)
      // fsync the file so a crash cannot leave a torn entry list behind.
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  }

  private lock(timeoutMs = 2_000): () => void {
    const started = Date.now()
    for (;;) {
      try {
        mkdirSync(dirname(this.lockPath), { recursive: true })
        const fd = openSync(this.lockPath, "wx")
        closeSync(fd)
        break
      } catch {
        if (Date.now() - started > timeoutMs) {
          try {
            const age = Date.now() - statSync(this.lockPath).mtimeMs
            if (age > timeoutMs * 5) rmSync(this.lockPath, { force: true })
          } catch {}
          if (Date.now() - started > timeoutMs * 2) throw new Error("memory write lock timeout")
        }
        Bun.sleepSync(5)
      }
    }
    return () => {
      try {
        rmSync(this.lockPath, { force: true })
      } catch {}
    }
  }

  /** First-run migration from opencode-hermes, only when the target is empty. */
  migrateFrom(legacyRoot: string): boolean {
    let migrated = false
    for (const [target, file] of [
      ["memory", "MEMORY.md"],
      ["user", "USER.md"],
    ] as const) {
      if (this.readRaw(target).trim()) continue
      const legacy = join(legacyRoot, file)
      if (!existsSync(legacy)) continue
      const content = readFileSync(legacy, "utf8")
      this.write(target, content)
      migrated = true
    }
    return migrated
  }
}

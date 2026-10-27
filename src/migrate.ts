/**
 * Migration from opencode-hermes to OUM.
 *
 * Additive by policy: it copies canonical memory into the OUM root only when
 * that target is empty, records what it did, and verifies entry counts after
 * the copy. It never deletes or rewrites the source.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface FileReport {
  name: string
  source: string
  target: string
  exists: boolean
  chars: number
  entries: number
}

export interface MigrationReport {
  from: string
  to: string
  files: FileReport[]
  targetOccupied: boolean
  conflicts: string[]
}

const FILES = ["MEMORY.md", "USER.md", "POLICY.md"] as const

function count(raw: string): { chars: number; entries: number } {
  const trimmed = raw.trim()
  if (!trimmed) return { chars: 0, entries: 0 }
  return { chars: trimmed.length, entries: trimmed.split("\n§\n").filter((entry) => entry.trim()).length }
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

export function inspect(from: string, to: string): MigrationReport {
  const files: FileReport[] = []
  const conflicts: string[] = []
  let targetOccupied = false

  for (const name of FILES) {
    const source = join(from, name)
    const target = join(to, name)
    const sourceRaw = read(source)
    const targetRaw = read(target)
    const exists = existsSync(source)

    if (targetRaw.trim()) {
      targetOccupied = true
      if (sourceRaw && targetRaw.trim() !== sourceRaw.trim()) conflicts.push(name)
    }

    const counted = count(sourceRaw)
    files.push({
      name,
      source,
      target,
      exists,
      chars: counted.chars,
      entries: counted.entries,
    })
  }

  return { from, to, files, targetOccupied, conflicts }
}

export interface MigrateOptions {
  backupDir?: string
  /** Overwrite target files that already have content. */
  force?: boolean
}

export interface MigrateResult {
  ok: boolean
  copied: string[]
  skipped: string[]
  backup?: string
  error?: string
}

export function migrate(from: string, to: string, options: MigrateOptions = {}): MigrateResult {
  const report = inspect(from, to)
  const result: MigrateResult = { ok: false, copied: [], skipped: [] }

  if (!report.files.some((file) => file.exists)) return { ...result, error: `no memory files in ${from}` }
  if (report.targetOccupied && !options.force) {
    return { ...result, error: `${to} already has memory; refusing to overwrite (use force only after a backup)` }
  }

  mkdirSync(to, { recursive: true })

  let backup: string | undefined
  if (options.backupDir && report.targetOccupied) {
    backup = join(options.backupDir, `oum-${new Date().toISOString().replace(/[:.]/g, "-")}`)
    mkdirSync(backup, { recursive: true })
    for (const name of FILES) {
      const target = join(to, name)
      if (existsSync(target)) copyFileSync(target, join(backup, name))
    }
    writeFileSync(join(backup, "report.json"), JSON.stringify(report, null, 2))
  }

  for (const file of report.files) {
    if (!file.exists) {
      result.skipped.push(file.name)
      continue
    }
    copyFileSync(file.source, file.target)

    // Verify the copy, not just the intent.
    const source = count(read(file.source))
    const copied = count(read(file.target))
    if (source.entries !== copied.entries) {
      return { ...result, backup, error: `entry count mismatch for ${file.name}: ${source.entries} → ${copied.entries}` }
    }
    result.copied.push(file.name)
  }

  return { ...result, ok: true, backup }
}

/** Config rewrite: replace the hermes plugin entry with OUM, preserving the rest. */
export function pluginEntry(): string {
  return "file:///home/emil/Projects/openultramem"
}

export function summarize(report: MigrationReport): string {
  const lines: string[] = [`source: ${report.from}`, `target: ${report.to}`, ""]
  for (const file of report.files) {
    lines.push(
      `${file.name.padEnd(10)} ${file.exists ? "present" : "missing "} ${String(file.chars).padStart(5)} chars, ${file.entries} entries`,
    )
  }
  lines.push("")
  lines.push(`target occupied: ${report.targetOccupied ? "yes" : "no"}`)
  if (report.conflicts.length) lines.push(`conflicts: ${report.conflicts.join(", ")} (content differs)`)
  return lines.join("\n")
}

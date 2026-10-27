import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect, migrate, summarize } from "../src/migrate.ts"

function dirs(source?: string, target?: string) {
  const root = mkdtempSync(join(tmpdir(), "oum-migrate-"))
  const from = join(root, "from")
  const to = join(root, "to")
  const { mkdirSync } = require("node:fs") as typeof import("node:fs")
  mkdirSync(from, { recursive: true })
  mkdirSync(to, { recursive: true })
  if (source !== undefined) writeFileSync(join(from, "MEMORY.md"), source)
  if (target !== undefined) writeFileSync(join(to, "MEMORY.md"), target)
  return { root, from, to }
}

describe("inspect", () => {
  test("reports characters and entries", () => {
    const { from, to } = dirs("a\n§\nb\n§\nc\n")
    const report = inspect(from, to)
    const memory = report.files.find((file) => file.name === "MEMORY.md")!
    expect(memory.exists).toBe(true)
    expect(memory.entries).toBe(3)
    expect(memory.chars).toBeGreaterThan(0)
    expect(report.targetOccupied).toBe(false)
  })

  test("flags a conflicting target", () => {
    const { from, to } = dirs("a\n§\nb", "different")
    const report = inspect(from, to)
    expect(report.targetOccupied).toBe(true)
    expect(report.conflicts).toContain("MEMORY.md")
    expect(summarize(report)).toContain("conflicts")
  })
})

describe("migrate", () => {
  test("copies into an empty target and verifies entries", () => {
    const { from, to } = dirs("one\n§\ntwo\n")
    const result = migrate(from, to)
    expect(result.ok).toBe(true)
    expect(result.copied).toContain("MEMORY.md")
    expect(readFileSync(join(to, "MEMORY.md"), "utf8")).toContain("two")
  })

  test("refuses to overwrite a non-empty target without force", () => {
    const { from, to } = dirs("new", "old")
    const result = migrate(from, to)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("refusing to overwrite")
    expect(readFileSync(join(to, "MEMORY.md"), "utf8")).toBe("old")
  })

  test("force backs up the target before overwriting", () => {
    const { root, from, to } = dirs("new", "old")
    const result = migrate(from, to, { force: true, backupDir: join(root, "backups") })
    expect(result.ok).toBe(true)
    expect(result.backup).toBeTruthy()
    expect(existsSync(join(result.backup!, "MEMORY.md"))).toBe(true)
    expect(readFileSync(join(result.backup!, "MEMORY.md"), "utf8")).toBe("old")
    expect(readFileSync(join(to, "MEMORY.md"), "utf8")).toBe("new")
  })

  test("fails when there is nothing to migrate", () => {
    const { from, to } = dirs()
    expect(migrate(from, to).ok).toBe(false)
  })

  test("copies only the files that exist", () => {
    const { from, to } = dirs("only memory")
    const result = migrate(from, to)
    expect(result.copied).toEqual(["MEMORY.md"])
    expect(result.skipped).toContain("USER.md")
  })
})

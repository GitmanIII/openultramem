import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { silentLogger } from "../src/log.ts"
import { Ledger } from "../src/skills/ledger.ts"
import { SkillManager } from "../src/skills/manager.ts"
import { parseSkill, renderSkill } from "../src/skills/frontmatter.ts"
import { indexSkills, findDuplicates } from "../src/skills/indexer.ts"
import { openState } from "../src/recall/db.ts"

let manager: SkillManager
let ledger: Ledger
let globalRoot: string
let projectDir: string
let dataRoot: string
let nativeRoot: string

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "oum-skills-"))
  globalRoot = join(root, "global")
  projectDir = join(root, "project")
  dataRoot = join(root, "data")
  nativeRoot = join(root, "native")
  mkdirSync(projectDir, { recursive: true })

  const config = loadConfig({
    dataRoot,
    skills: { globalRoot, nativeRoot, descriptionBudget: 120 },
  })
  ledger = new Ledger(join(dataRoot, "ledger.jsonl"))
  manager = new SkillManager({
    config,
    projectDir,
    dataRoot,
    ledger,
    log: silentLogger,
    reload: async () => {},
  })
})

describe("frontmatter", () => {
  test("parses OUM provenance and preserves extra keys", () => {
    const raw = `---
name: My Skill
description: Do a thing
version: 2.0.0
metadata:
  oum:
    origin: self
    scope: global
    created: 2026-01-01
    updated: 2026-01-02
    pinned: true
---

Body here.
`
    const parsed = parseSkill(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.skill.name).toBe("My Skill")
    expect(parsed.skill.oum?.origin).toBe("self")
    expect(parsed.skill.oum?.pinned).toBe(true)
    expect(parsed.skill.extra.version).toBe("2.0.0")
    expect(parsed.skill.body.trim()).toBe("Body here.")
  })

  test("a skill without metadata.oum is user-authored", () => {
    const parsed = parseSkill("---\nname: X\ndescription: y\n---\n\nbody\n")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.skill.oum).toBeUndefined()
  })

  test("rejects an unterminated or incomplete file", () => {
    expect(parseSkill("no frontmatter").ok).toBe(false)
    expect(parseSkill("---\nname: X\n---\n").ok).toBe(false)
    expect(parseSkill("---\ndescription: y\n---\n").ok).toBe(false)
  })

  test("render roundtrips the body and metadata", () => {
    const parsed = parseSkill("---\nname: X\ndescription: y\nmetadata:\n  oum:\n    origin: self\n    scope: project\n    created: a\n    updated: b\n    pinned: false\n---\n\nhello\n")
    if (!parsed.ok) throw new Error("parse failed")
    const again = parseSkill(renderSkill(parsed.skill))
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.skill.body.trim()).toBe("hello")
    expect(again.skill.oum?.scope).toBe("project")
  })
})

describe("create", () => {
  test("writes a project skill with provenance and a ledger entry", () => {
    const result = manager.create({ id: "release-notes", description: "Write release notes", content: "Steps here." })
    expect(result.ok).toBe(true)
    const path = join(projectDir, ".opencode", "skills", "release-notes", "SKILL.md")
    expect(existsSync(path)).toBe(true)
    const parsed = parseSkill(readFileSync(path, "utf8"))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.skill.oum?.origin).toBe("self")
    expect(parsed.skill.oum?.scope).toBe("project")
    expect(parsed.skill.body.trim()).toBe("Steps here.")
    const entry = ledger.read().find((item) => item.action === "create" && item.id === "release-notes")
    expect(entry).toBeTruthy()
    // The ledger sha must be reusable as base_hash, so it matches discovery.
    expect(entry!.sha).toBe(result.skill?.sha)
  })

  test("refuses a duplicate id and names the existing path", () => {
    manager.create({ id: "dup", description: "first", content: "a" })
    const result = manager.create({ id: "dup", description: "second", content: "b" })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("already exists")
    expect(result.duplicates?.[0]?.id).toBe("dup")
  })

  test("refuses an unsafe id", () => {
    expect(manager.create({ id: "Bad_ID", description: "x", content: "a" }).ok).toBe(false)
    expect(manager.create({ id: "../escape", description: "x", content: "a" }).ok).toBe(false)
  })

  test("refuses a description over budget", () => {
    const result = manager.create({ id: "wordy", description: "x".repeat(200), content: "a" })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("budget is 120")
  })

  test("a global create lands in the global root", () => {
    const result = manager.create({ id: "portable", description: "works anywhere", content: "b", scope: "global" })
    expect(result.ok).toBe(true)
    expect(existsSync(join(globalRoot, "portable", "SKILL.md"))).toBe(true)
  })
})

describe("patch", () => {
  test("requires base_hash, then applies and backs up", () => {
    manager.create({ id: "patchme", description: "d", content: "old body" })
    const first = manager.patch({ id: "patchme", content: "new body" })
    expect(first.ok).toBe(false)
    expect(first.needsRead?.sha).toBeTruthy()
    expect(first.needsRead?.body).toContain("old body")

    const result = manager.patch({ id: "patchme", content: "new body", base_hash: first.needsRead!.sha })
    expect(result.ok).toBe(true)
    expect(result.skill?.body.trim()).toBe("new body")
    expect(existsSync(join(dataRoot, "skill-backups"))).toBe(true)
    const last = ledger.read().at(-1)!
    expect(last.sha).toBe(result.skill?.sha)
  })

  test("rejects a stale base_hash", () => {
    manager.create({ id: "stale", description: "d", content: "one" })
    const read = manager.patch({ id: "stale", content: "two" })
    const result = manager.patch({ id: "stale", content: "two", base_hash: "000000000000" })
    expect(read.ok).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.message).toContain("mismatch")
  })

  test("will not patch a user-authored skill by default", () => {
    const dir = join(globalRoot, "user-made")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), "---\nname: user-made\ndescription: by hand\n---\n\nbody\n")
    const result = manager.patch({ id: "user-made", content: "x", base_hash: "whatever" })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("user-authored")
  })
})

describe("files and deletion", () => {
  test("write_file creates a reference under the skill", () => {
    manager.create({ id: "docs", description: "d", content: "b" })
    const result = manager.writeFile({ id: "docs", path: "references/api.md", content: "# API" })
    expect(result.ok).toBe(true)
    expect(existsSync(join(projectDir, ".opencode", "skills", "docs", "references", "api.md"))).toBe(true)
  })

  test("path traversal is refused", () => {
    manager.create({ id: "safe", description: "d", content: "b" })
    expect(manager.writeFile({ id: "safe", path: "../escape.md", content: "x" }).ok).toBe(false)
    expect(manager.writeFile({ id: "safe", path: "/etc/passwd", content: "x" }).ok).toBe(false)
  })

  test("remove_file refuses SKILL.md", () => {
    manager.create({ id: "rm", description: "d", content: "b" })
    expect(manager.removeFile({ id: "rm", path: "SKILL.md" }).ok).toBe(false)
  })

  test("delete archives instead of unlinking", () => {
    manager.create({ id: "bye", description: "d", content: "b" })
    const read = manager.patch({ id: "bye", content: "b" })
    const result = manager.delete({ id: "bye", base_hash: read.needsRead!.sha })
    expect(result.ok).toBe(true)
    expect(existsSync(join(projectDir, ".opencode", "skills", "bye"))).toBe(false)
    expect(existsSync(join(dataRoot, "skill-archive"))).toBe(true)
  })
})

describe("promote and fork", () => {
  test("promote moves a project skill to the global root", () => {
    manager.create({ id: "grow", description: "d", content: "b" })
    const result = manager.promote({ id: "grow" })
    expect(result.ok).toBe(true)
    expect(existsSync(join(globalRoot, "grow", "SKILL.md"))).toBe(true)
    expect(existsSync(join(projectDir, ".opencode", "skills", "grow"))).toBe(false)
    const parsed = parseSkill(readFileSync(join(globalRoot, "grow", "SKILL.md"), "utf8"))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.skill.oum?.scope).toBe("global")
    expect(parsed.skill.oum?.promoted_from).toContain("grow")
  })

  test("promote refuses when the id already exists globally", () => {
    manager.create({ id: "clash", description: "d", content: "b", scope: "global" })
    manager.create({ id: "clash2", description: "d", content: "b" })
    const result = manager.promote({ id: "clash" })
    expect(result.ok).toBe(false)
  })

  test("fork copies a global skill into the project with origin fork", () => {
    manager.create({ id: "shared", description: "d", content: "body", scope: "global" })
    const result = manager.fork({ id: "shared" })
    expect(result.ok).toBe(true)
    const path = join(projectDir, ".opencode", "skills", "shared", "SKILL.md")
    expect(existsSync(path)).toBe(true)
    const parsed = parseSkill(readFileSync(path, "utf8"))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.skill.oum?.origin).toBe("fork")
    expect(parsed.skill.oum?.scope).toBe("project")
  })
})

describe("indexer", () => {
  test("indexes skills and finds near-duplicates", () => {
    manager.create({ id: "git-release", description: "Prepare release notes and version bumps", content: "b" })
    const db = openState(join(dataRoot, "state.db"))
    indexSkills(db, manager.list())

    const duplicates = findDuplicates(db, "prepare release version bumps for a project")
    expect(duplicates[0]?.id).toBe("git-release")

    const before = db.query("SELECT COUNT(*) AS n FROM skills").get() as { n: number }
    expect(before.n).toBe(1)
    manager.create({ id: "second", description: "another skill", content: "b" })
    indexSkills(db, manager.list())
    const after = db.query("SELECT COUNT(*) AS n FROM skills").get() as { n: number }
    expect(after.n).toBe(2)
    db.close()
  })
})

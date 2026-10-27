import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore } from "../src/memory/store.ts"
import { openState } from "../src/recall/db.ts"
import { applyPlan } from "../src/learn/apply.ts"
import { silentLogger } from "../src/log.ts"
import type { LearnPlan } from "../src/learn/plan.ts"

let store: MemoryStore
let db: ReturnType<typeof openState>

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "oum-apply-"))
  store = new MemoryStore({ memoryRoot: root, memoryChars: 2200, userChars: 1375 })
  db = openState(join(root, "state.db"))
})

const plan = (overrides: Partial<LearnPlan> = {}): LearnPlan => ({
  memory: [],
  skills: [],
  curation: [],
  ...overrides,
})

describe("applyPlan", () => {
  test("applies memory operations and records hashes", () => {
    const outcome = applyPlan({ store, db, log: silentLogger }, plan({
      memory: [
        { action: "add", target: "memory", content: "the build uses bun" },
        { action: "add", target: "user", content: "emil prefers tabs" },
      ],
    }), "ses_1")

    expect(outcome.applied).toBe(2)
    expect(store.state("memory").entries).toEqual(["the build uses bun"])
    expect(store.state("user").entries).toEqual(["emil prefers tabs"])
    const hashes = db.query("SELECT COUNT(*) AS n FROM learn_ops").get() as { n: number }
    expect(hashes.n).toBe(2)
  })

  test("re-applying the same plan writes nothing", () => {
    const input = plan({ memory: [{ action: "add", target: "memory", content: "one fact" }] })
    applyPlan({ store, db, log: silentLogger }, input, "ses_1")
    const again = applyPlan({ store, db, log: silentLogger }, input, "ses_1")
    expect(again.applied).toBe(0)
    expect(again.skipped).toBe(1)
    expect(store.state("memory").entries).toHaveLength(1)
  })

  test("maps supersede to replace", () => {
    store.apply([{ action: "add", target: "memory", content: "old decision" }])
    const outcome = applyPlan({ store, db, log: silentLogger }, plan({
      curation: [{ action: "supersede", target: "memory", old_text: "old decision", content: "new decision" }],
    }), "ses_1")
    expect(outcome.applied).toBe(1)
    expect(store.state("memory").entries).toEqual(["new decision"])
  })

  test("merge replaces one entry and removes the other", () => {
    store.apply([
      { action: "add", target: "memory", content: "tei runs on 8080" },
      { action: "add", target: "memory", content: "tei is in docker" },
    ])
    const outcome = applyPlan({ store, db, log: silentLogger }, plan({
      curation: [
        { action: "merge", target: "memory", old_text: "tei runs", old_text_b: "tei is in docker", content: "TEI: docker, port 8080" },
      ],
    }), "ses_1")
    expect(outcome.applied).toBe(2)
    expect(store.state("memory").entries).toEqual(["TEI: docker, port 8080"])
  })

  test("archive removes without touching the rest", () => {
    store.apply([
      { action: "add", target: "memory", content: "keep me" },
      { action: "add", target: "memory", content: "drop me" },
    ])
    applyPlan({ store, db, log: silentLogger }, plan({
      curation: [{ action: "archive", target: "memory", old_text: "drop me" }],
    }), "ses_1")
    expect(store.state("memory").entries).toEqual(["keep me"])
  })

  test("promote is refused, with a reason", () => {
    const outcome = applyPlan({ store, db, log: silentLogger }, plan({
      curation: [{ action: "promote", target: "memory", old_text: "x" }],
    }), "ses_1")
    expect(outcome.applied).toBe(0)
    expect(outcome.refused[0]?.reason).toContain("promote")
  })

  test("skill operations are counted as unsupported", () => {
    const outcome = applyPlan({ store, db, log: silentLogger }, plan({
      skills: [{ action: "create", id: "x", content: "body" }],
    }), "ses_1")
    expect(outcome.unsupported).toBe(1)
    expect(outcome.applied).toBe(0)
  })

  test("a refused operation does not block the valid ones", () => {
    const outcome = applyPlan({ store, db, log: silentLogger }, plan({
      memory: [
        { action: "add", target: "memory", content: "valid small fact" },
        { action: "add", target: "memory", content: "x".repeat(3000) },
      ],
    }), "ses_1")

    expect(outcome.applied).toBe(1)
    expect(outcome.refused).toHaveLength(1)
    expect(store.state("memory").entries).toEqual(["valid small fact"])
  })

  test("a replace whose old_text is missing is refused, not invented", () => {
    store.apply([{ action: "add", target: "memory", content: "real entry" }])
    const outcome = applyPlan({ store, db, log: silentLogger }, plan({
      memory: [{ action: "replace", target: "memory", old_text: "absent", content: "replacement" }],
    }), "ses_1")
    expect(outcome.applied).toBe(0)
    expect(outcome.refused[0]?.reason).toContain("not found")
    expect(store.state("memory").entries).toEqual(["real entry"])
  })
})

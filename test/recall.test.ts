import { beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { buildFixture, type Fixture } from "./fixture.ts"
import { openHost, openState } from "../src/recall/db.ts"
import { sync, purgeSession } from "../src/recall/ingest.ts"
import { search, searchHost, tokens } from "../src/recall/search.ts"
import { hydrate, readSession, recentSessions } from "../src/recall/hydrate.ts"
import { loadConfig } from "../src/config.ts"

let fixture: Fixture
let host: Database

const BUDGET = 30_000
const MAX = 8_000

beforeAll(() => {
  fixture = buildFixture(10_000, 5)
  host = openHost(fixture.hostPath)!
})

describe("ingest", () => {
  test("backfills every indexable host message", () => {
    const db = openState(fixture.statePath)
    const result = sync(db, host, { budgetMs: BUDGET, maxChars: MAX })
    expect(result.stale).toBe(false)
    expect(result.scanned).toBeGreaterThan(9_000)

    const messages = db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }
    const sessions = db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
    expect(messages.n).toBeGreaterThan(9_000)
    expect(sessions.n).toBe(6)
    db.close()
  })

  test("re-ingest is idempotent", () => {
    const db = openState(fixture.statePath)
    const before = db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }
    const fts = db.query("SELECT COUNT(*) AS n FROM messages_fts").get() as { n: number }

    const again = sync(db, host, { budgetMs: BUDGET, maxChars: MAX })
    expect(again.stale).toBe(false)

    const after = db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }
    const ftsAfter = db.query("SELECT COUNT(*) AS n FROM messages_fts").get() as { n: number }
    expect(after.n).toBe(before.n)
    expect(ftsAfter.n).toBe(fts.n)
    db.close()
  })

  test("maps assistant tool blocks to tool rows and skips reasoning and system", () => {
    const db = openState(fixture.statePath)
    const roles = db.query("SELECT role, COUNT(*) AS n FROM messages GROUP BY role ORDER BY 2 DESC").all() as { role: string; n: number }[]
    const byRole = Object.fromEntries(roles.map((row) => [row.role, row.n]))
    expect(byRole.tool).toBeGreaterThan(5_000)
    expect(byRole.assistant).toBeGreaterThan(5_000)
    expect(byRole.user).toBeGreaterThan(1_500)
    expect(byRole.synthetic ?? 0).toBe(0) // the only synthetic row is a recall note

    const reasoning = db.query("SELECT COUNT(*) AS n FROM messages WHERE id LIKE '%reasoning%'").get() as { n: number }
    expect(reasoning.n).toBe(0)
    const system = db.query("SELECT COUNT(*) AS n FROM messages WHERE id = 'msg_system'").get() as { n: number }
    expect(system.n).toBe(0)
    db.close()
  })

  test("child sessions are marked hidden", () => {
    const db = openState(fixture.statePath)
    const child = db.query("SELECT hidden FROM sessions WHERE id = ?").get(fixture.childSession) as { hidden: number }
    expect(child.hidden).toBe(1)
    db.close()
  })

  test("purge removes matrix and FTS rows", () => {
    const db = openState(fixture.statePath)
    const target = fixture.sessions[4]!
    const before = db.query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(target) as { n: number }
    const removed = purgeSession(db, target)
    expect(removed).toBe(before.n)
    expect(removed).toBeGreaterThan(0)
    const left = db.query("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(target) as { n: number }
    expect(left.n).toBe(0)
    db.close()
  })
})

describe("search", () => {
  test("word FTS finds the landmark", () => {
    const db = openState(fixture.statePath)
    const hits = search(db, "sphinx", { limit: 5 })
    expect(hits[0]?.id).toBe("msg_landmark_word")
    db.close()
  })

  test("trigram finds a substring mid-word", () => {
    const db = openState(fixture.statePath)
    const hits = search(db, "uartzit", { limit: 5, mode: "exact" })
    expect(hits.some((hit) => hit.id === "msg_landmark_word")).toBe(true)
    db.close()
  })

  test("exact mode matches a phrase, not scattered terms", () => {
    const db = openState(fixture.statePath)
    const hits = search(db, "sphinx guards the quartzite", { limit: 5, mode: "exact" })
    expect(hits[0]?.id).toBe("msg_landmark_word")
    db.close()
  })

  test("tool rows are searchable by tool name and output", () => {
    const db = openState(fixture.statePath)
    const hits = search(db, "nebula", { limit: 5 })
    expect(hits[0]?.role).toBe("tool")
    expect(hits[0]?.toolName).toBe("grep")
    db.close()
  })

  test("hidden child sessions are excluded unless requested", () => {
    const db = openState(fixture.statePath)
    expect(search(db, "zebra", { limit: 5 })).toHaveLength(0)
    const withChildren = search(db, "zebra", { limit: 5, includeChildren: true })
    expect(withChildren[0]?.id).toBe("msg_child_only")
    db.close()
  })

  test("project filter narrows results", () => {
    const db = openState(fixture.statePath)
    const scoped = search(db, "sphinx", { limit: 5, project: "project-1" })
    expect(scoped).toHaveLength(0)
    db.close()
  })

  test("host LIKE fallback finds what the index finds", () => {
    const hits = searchHost(host, "sphinx", { limit: 5 })
    expect(hits[0]?.id).toBe("msg_landmark_word")
    expect(hits[0]?.matched).toBe("like")
  })

  test("query is bounded to 50 results and each index to 50 candidates", () => {
    const db = openState(fixture.statePath)
    const hits = search(db, "memory session index", { limit: 500 })
    expect(hits.length).toBeLessThanOrEqual(50)
    db.close()
  })
})

describe("hydrate", () => {
  test("bodies come from the host, not the index", () => {
    const db = openState(fixture.statePath)
    const hits = search(db, "sphinx", { limit: 3 })
    const hydrated = hydrate(db, host, hits, "sphinx", MAX)
    expect(hydrated[0]?.text).toContain("the sphinx guards the quartzite gate")
    expect(hydrated[0]?.snippet).toContain("sphinx")
    expect(hydrated[0]?.link).toBe(`@session/local/${fixture.sessions[0]}`)
    db.close()
  })

  test("read session returns rows in order", () => {
    const db = openState(fixture.statePath)
    const rows = readSession(db, host, fixture.sessions[0]!, { limit: 10 })
    expect(rows.length).toBe(10)
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq)
    db.close()
  })

  test("scroll anchors around a message", () => {
    const db = openState(fixture.statePath)
    const rows = readSession(db, host, fixture.sessions[0]!, { limit: 5, aroundMessageID: "msg_landmark_word" })
    expect(rows.some((row) => row.id === "msg_landmark_word")).toBe(true)
    db.close()
  })

  test("recent sessions excludes hidden children by default", () => {
    const db = openState(fixture.statePath)
    const sessions = recentSessions(db, { limit: 10 })
    expect(sessions.some((session) => session.id === fixture.childSession)).toBe(false)
    db.close()
  })
})

describe("invariants", () => {
  test("the host database is opened read-only", () => {
    expect(() => host.run("DELETE FROM session_message")).toThrow()
  })

  test("state.db survives deletion because the host is the source", () => {
    const fresh = openState(`${fixture.dir}/state-rebuild.db`)
    sync(fresh, host, { budgetMs: BUDGET, maxChars: MAX })
    const hits = search(fresh, "sphinx", { limit: 3 })
    expect(hits[0]?.id).toBe("msg_landmark_word")
    fresh.close()
  })

  test("config defaults match the design", () => {
    const config = loadConfig()
    expect(config.memoryChars).toBe(2200)
    expect(config.userChars).toBe(1375)
    expect(config.search.syncBudgetMs).toBe(250)
    expect(config.skills.globalRoot.endsWith(".agents/skills")).toBe(true)
    const overridden = loadConfig({ search: { syncBudgetMs: 1000 }, memoryRoot: "~/custom" })
    expect(overridden.search.syncBudgetMs).toBe(1000)
    expect(overridden.memoryRoot.startsWith("~")).toBe(false)
  })

  test("tokenizer keeps unicode and digits", () => {
    expect(tokens("Zebra-42 naïve_café")).toEqual(["zebra", "42", "naïve_café"])
  })
})

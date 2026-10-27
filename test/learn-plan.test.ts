import { describe, expect, test } from "bun:test"
import { hashOp, isEmptyPlan, parsePlan } from "../src/learn/plan.ts"

describe("parsePlan", () => {
  test("accepts a complete plan", () => {
    const result = parsePlan(
      JSON.stringify({
        memory: [{ action: "add", target: "memory", content: "fact" }],
        curation: [{ action: "archive", target: "memory", old_text: "stale" }],
        skills: [],
        notes: "one fact",
        confidence: 0.8,
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.memory).toHaveLength(1)
    expect(result.plan.curation).toHaveLength(1)
    expect(isEmptyPlan(result.plan)).toBe(false)
  })

  test("accepts fenced JSON and surrounding prose", () => {
    const result = parsePlan('Sure!\n```json\n{"memory":[],"curation":[],"skills":[]}\n```\nDone.')
    expect(result.ok).toBe(true)
  })

  test("rejects unknown top-level keys", () => {
    const result = parsePlan(JSON.stringify({ memory: [], notes: "x", extra: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("unknown top-level key")
  })

  test("rejects add without content", () => {
    const result = parsePlan(JSON.stringify({ memory: [{ action: "add", target: "memory" }] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("content is required")
  })

  test("rejects replace without old_text", () => {
    const result = parsePlan(JSON.stringify({ memory: [{ action: "replace", target: "memory", content: "new" }] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("old_text is required")
  })

  test("rejects a bad target", () => {
    const result = parsePlan(JSON.stringify({ memory: [{ action: "add", target: "notes", content: "x" }] }))
    expect(result.ok).toBe(false)
  })

  test("rejects merge without old_text_b", () => {
    const result = parsePlan(JSON.stringify({ curation: [{ action: "merge", old_text: "a" }] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("old_text_b")
  })

  test("rejects supersede without content", () => {
    const result = parsePlan(JSON.stringify({ curation: [{ action: "supersede", old_text: "a" }] }))
    expect(result.ok).toBe(false)
  })

  test("rejects an unknown skill action", () => {
    const result = parsePlan(JSON.stringify({ skills: [{ action: "polish" }] }))
    expect(result.ok).toBe(false)
  })

  test("rejects a plan that is not JSON", () => {
    expect(parsePlan("I saved two facts.").ok).toBe(false)
  })

  test("defaults missing arrays to empty", () => {
    const result = parsePlan("{}")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.memory).toEqual([])
    expect(isEmptyPlan(result.plan)).toBe(true)
  })
})

describe("hashOp", () => {
  test("is stable across key order and ignores undefined fields", () => {
    const a = hashOp({ action: "add", target: "memory", content: "x" })
    const b = hashOp({ content: "x", target: "memory", action: "add", old_text: undefined } as never)
    expect(a).toBe(b)
  })

  test("differs when content differs", () => {
    expect(hashOp({ action: "add", target: "memory", content: "x" })).not.toBe(
      hashOp({ action: "add", target: "memory", content: "y" }),
    )
  })
})

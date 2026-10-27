import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LearnEvents, type LearnRecord } from "../src/learn/events.ts"
import { LearnController, type LearnSettings } from "../src/learn/trigger.ts"
import type { LearnInput, ModelRef } from "../src/learn/engine.ts"
import type { LearnPlan } from "../src/learn/plan.ts"
import { silentLogger } from "../src/log.ts"

const model: ModelRef = { providerID: "test", id: "model" }

interface Harness {
  controller: LearnController
  events: LearnEvents
  applied: LearnPlan[]
  tick: (ms: number) => void
  setPlan: (plan: LearnPlan | (() => Promise<LearnPlan>)) => void
  setModel: (model: ModelRef | undefined) => void
  records: () => LearnRecord[]
}

function harness(overrides: Partial<LearnSettings> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "oum-learn-"))
  const events = new LearnEvents(join(dir, "learn-events.jsonl"))
  let clock = 1_000_000
  let currentModel: ModelRef | undefined = model
  let nextPlan: LearnPlan | (() => Promise<LearnPlan>) = { memory: [], skills: [], curation: [] }
  const applied: LearnPlan[] = []

  const controller = new LearnController({
    settings: {
      enabled: true,
      turns: 2,
      toolIterations: 2,
      onCompaction: true,
      fallback: "next-prompt",
      throttleMs: 1_000,
      ...overrides,
    },
    engine: {
      plan: async (input: LearnInput) => {
        void input
        return typeof nextPlan === "function" ? await nextPlan() : nextPlan
      },
    },
    events,
    log: silentLogger,
    modelFor: () => currentModel,
    buildInput: async (sessionID, ref) => ({
      sessionID,
      model: ref,
      turns: 0,
      toolCalls: 0,
      project: { id: "project", directory: "/work" },
      transcript: "USER: do the thing",
      memory: { entries: [], chars: 0, budget: 2200 },
      user: { entries: [], chars: 0, budget: 1375 },
      policy: "",
      skills: [],
      skillsEnabled: false,
    }),
    apply: (plan) => {
      applied.push(plan)
      return { applied: plan.memory.length, skipped: 0, unsupported: 0, refused: [] }
    },
    now: () => clock,
  })

  return {
    controller,
    events,
    applied,
    tick: (ms) => {
      clock += ms
    },
    setPlan: (plan) => {
      nextPlan = plan
    },
    setModel: (value) => {
      currentModel = value
    },
    records: () => events.read(),
  }
}

describe("triggers", () => {
  test("runs on the turn threshold, and every trigger decision is logged", async () => {
    const h = harness()
    await h.controller.onPrompt("ses_1")
    expect(h.applied).toHaveLength(0)
    await h.controller.onPrompt("ses_1")

    expect(h.applied).toHaveLength(1)
    const reasons = h.records().map((record) => ("reason" in record ? record.reason : record.event))
    expect(reasons).toContain("not-due:turns")
    expect(reasons).toContain("due:turns")
    expect(reasons).toContain("run")
  })

  test("runs on the tool threshold", async () => {
    const h = harness()
    await h.controller.onToolCall("ses_1")
    expect(h.applied).toHaveLength(0)
    await h.controller.onToolCall("ses_1")
    expect(h.applied).toHaveLength(1)
    expect(h.records().some((record) => "reason" in record && record.reason === "due:tools")).toBe(true)
  })

  test("counter resets after a successful run", async () => {
    const h = harness()
    await h.controller.onPrompt("ses_1")
    await h.controller.onPrompt("ses_1")
    expect(h.applied).toHaveLength(1)

    h.tick(2_000)
    await h.controller.onPrompt("ses_1")
    expect(h.applied).toHaveLength(1) // 1 of 2 turns since the last run
    await h.controller.onPrompt("ses_1")
    expect(h.applied).toHaveLength(2)
  })

  test("throttle blocks a run that is otherwise due", async () => {
    const h = harness({ turns: 1 })
    await h.controller.onPrompt("ses_1")
    expect(h.applied).toHaveLength(1)

    h.tick(100)
    await h.controller.onPrompt("ses_1")
    expect(h.applied).toHaveLength(1)
    expect(h.records().some((record) => "reason" in record && record.reason === "not-due:throttle")).toBe(true)

    h.tick(2_000)
    await h.controller.onPrompt("ses_1")
    expect(h.applied).toHaveLength(2)
  })

  test("a trigger during a run coalesces into exactly one extra run", async () => {
    const h = harness({ turns: 1 })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.setPlan(async () => {
      await gate
      return { memory: [], skills: [], curation: [] }
    })

    const first = h.controller.onPrompt("ses_1")
    await Bun.sleep(1)
    await h.controller.onPrompt("ses_1") // in flight → dirty
    release()
    await first

    expect(h.applied).toHaveLength(2)
    expect(h.records().some((record) => "reason" in record && record.reason === "not-due:in-flight")).toBe(true)
  })

  test("a manual trigger during a run is replayed as manual, not as turns", async () => {
    const h = harness({ turns: 99 })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.setPlan(async () => {
      await gate
      return { memory: [], skills: [], curation: [] }
    })

    const first = h.controller.force("ses_1")
    await Bun.sleep(1)
    await h.controller.force("ses_1") // in flight: queue the manual intent
    release()
    await first

    expect(h.applied).toHaveLength(2)
    const manual = h.records().filter((record) => "reason" in record && record.reason === "due:manual")
    expect(manual).toHaveLength(2)
  })

  test("missed execution end is caught by the next prompt", async () => {
    const h = harness()
    await h.controller.onPrompt("ses_1") // 1/2, not due
    h.controller.onExecutionStart("ses_1")
    await h.controller.onPrompt("ses_1") // 2/2 and the end event never arrived

    expect(h.applied).toHaveLength(1)
    expect(h.records().some((record) => "reason" in record && record.reason === "due:fallback")).toBe(true)
    expect(h.controller.inspect("ses_1").missedEnds).toBe(1)
  })

  test("a real execution end is a boundary, not a forced run", async () => {
    const h = harness()
    h.controller.onExecutionStart("ses_1")
    await h.controller.onExecutionEnd("ses_1")
    expect(h.applied).toHaveLength(0)
    expect(h.records().some((record) => "reason" in record && record.reason === "not-due:turns")).toBe(true)
  })

  test("compaction triggers a review when enabled", async () => {
    const h = harness()
    await h.controller.onCompaction("ses_1")
    expect(h.applied).toHaveLength(1)
    expect(h.records().some((record) => "reason" in record && record.reason === "due:compaction")).toBe(true)
  })

  test("disabled logs skipped:disabled and never runs", async () => {
    const h = harness({ enabled: false })
    await h.controller.onPrompt("ses_1")
    await h.controller.onPrompt("ses_1")
    expect(h.applied).toHaveLength(0)
    expect(h.records().every((record) => "reason" in record && record.reason === "skipped:disabled")).toBe(true)
  })

  test("an unresolvable model is skipped, never defaulted", async () => {
    const h = harness({ turns: 1 })
    h.setModel(undefined)
    await h.controller.onPrompt("ses_1")
    expect(h.applied).toHaveLength(0)
    expect(h.records().some((record) => "reason" in record && record.reason === "skipped:model")).toBe(true)
  })

  test("force bypasses throttle", async () => {
    const h = harness({ turns: 1 })
    await h.controller.onPrompt("ses_1")
    h.tick(10)
    await h.controller.force("ses_1")
    expect(h.applied).toHaveLength(2)
    expect(h.records().some((record) => "reason" in record && record.reason === "due:manual")).toBe(true)
  })

  test("a failed run is recorded and does not throw", async () => {
    const h = harness({ turns: 1 })
    let calls = 0
    h.setPlan(async () => {
      calls++
      throw new Error("model exploded")
    })
    await h.controller.onPrompt("ses_1")
    await h.controller.force("ses_1") // forced retry after failure
    expect(calls).toBe(2)

    const runs = h.records().filter((record) => record.event === "run") as Extract<LearnRecord, { event: "run" }>[]
    expect(runs).toHaveLength(2)
    expect(runs[0]!.errors[0]).toContain("model exploded")
  })
})

test("event log records the model and outcome", async () => {
  const h = harness({ turns: 1 })
  h.setPlan({ memory: [{ action: "add", target: "memory", content: "fact" }], skills: [], curation: [] })
  await h.controller.onPrompt("ses_9")
  const run = h.records().find((record) => record.event === "run") as Extract<LearnRecord, { event: "run" }>
  expect(run.session).toBe("ses_9")
  expect(run.model).toBe("test/model")
  expect(run.memory).toBe(1)
  expect(run.applied).toBe(1)
})

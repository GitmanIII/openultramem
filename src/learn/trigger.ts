/**
 * Trigger accounting.
 *
 * Counters gate due-ness; the turn boundary is when a due review runs; the next
 * prompt is the mandatory fallback for a missed execution event. One run per
 * session at a time, with a dirty bit for triggers that arrive mid-run.
 */
import type { Logger } from "../log.ts"
import type { ApplyOutcome } from "./apply.ts"
import type { LearnEngine, LearnInput, ModelRef } from "./engine.ts"
import { LearnEvents, type TriggerReason } from "./events.ts"
import type { LearnPlan } from "./plan.ts"

export interface LearnSettings {
  enabled: boolean
  turns: number
  toolIterations: number
  onCompaction: boolean
  fallback: "next-prompt" | "none"
  throttleMs: number
}

export interface LearnControllerDeps {
  settings: LearnSettings
  engine: LearnEngine
  events: LearnEvents
  log: Logger
  modelFor: (sessionID: string) => ModelRef | undefined
  buildInput: (sessionID: string, model: ModelRef) => Promise<LearnInput>
  apply: (plan: LearnPlan, sessionID: string) => ApplyOutcome
  now?: () => number
}

interface SessionState {
  turns: number
  tools: number
  lastRunAt: number
  inFlight: boolean
  dirty: TriggerReason | false
  awaitingEnd: boolean
  missedEnds: number
  runs: number
}

function fresh(): SessionState {
  return { turns: 0, tools: 0, lastRunAt: 0, inFlight: false, dirty: false, awaitingEnd: false, missedEnds: 0, runs: 0 }
}

export class LearnController {
  private readonly state = new Map<string, SessionState>()
  private readonly now: () => number

  constructor(private readonly deps: LearnControllerDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  private stateOf(sessionID: string): SessionState {
    let value = this.state.get(sessionID)
    if (!value) {
      value = fresh()
      this.state.set(sessionID, value)
    }
    return value
  }

  /** A user turn started. Also the fallback boundary for a missed turn end. */
  async onPrompt(sessionID: string): Promise<void> {
    const state = this.stateOf(sessionID)
    state.turns++

    if (state.awaitingEnd) {
      // The execution-end event never arrived; the new prompt proves it ended.
      state.awaitingEnd = false
      state.missedEnds++
      const reason: TriggerReason = this.due(state) ? "due:fallback" : "not-due:turns"
      if (this.deps.settings.fallback === "next-prompt") {
        await this.decide(sessionID, reason, `missed execution end #${state.missedEnds}`)
        return
      }
    }

    await this.decide(sessionID, this.due(state) ? "due:turns" : "not-due:turns")
  }

  async onToolCall(sessionID: string): Promise<void> {
    const state = this.stateOf(sessionID)
    state.tools++
    if (state.tools % Math.max(1, this.deps.settings.toolIterations) !== 0) return
    await this.decide(sessionID, this.due(state) ? "due:tools" : "not-due:turns")
  }

  onExecutionStart(sessionID: string): void {
    this.stateOf(sessionID).awaitingEnd = true
  }

  async onExecutionEnd(sessionID: string): Promise<void> {
    const state = this.stateOf(sessionID)
    state.awaitingEnd = false
    await this.decide(sessionID, this.due(state) ? "due:turn-end" : "not-due:turns")
  }

  async onCompaction(sessionID: string): Promise<void> {
    if (!this.deps.settings.onCompaction) return
    await this.decide(sessionID, "due:compaction")
  }

  /** `/oum-reflect`: bypass counters and throttle, but never the in-flight guard. */
  async force(sessionID: string): Promise<void> {
    await this.decide(sessionID, "due:manual", "manual", true)
  }

  private due(state: SessionState): boolean {
    const { turns, toolIterations } = this.deps.settings
    return state.turns >= Math.max(1, turns) || state.tools >= Math.max(1, toolIterations)
  }

  private counters(sessionID: string): { turns: number; tools: number } {
    const state = this.stateOf(sessionID)
    return { turns: state.turns, tools: state.tools }
  }

  private async decide(sessionID: string, reason: TriggerReason, detail?: string, manual = false): Promise<void> {
    const { settings, events, log } = this.deps
    const state = this.stateOf(sessionID)

    if (!settings.enabled) {
      events.trigger(sessionID, "skipped:disabled", this.counters(sessionID))
      return
    }
    if (state.inFlight) {
      // Remember what was deferred, so the coalesced pass reports the true cause.
      state.dirty = reason === "not-due:turns" ? (state.dirty || "due:turns") : reason
      events.trigger(sessionID, "not-due:in-flight", this.counters(sessionID))
      return
    }
    if (reason !== "not-due:turns" && !manual) {
      const since = this.now() - state.lastRunAt
      if (state.lastRunAt && since < settings.throttleMs) {
        events.trigger(sessionID, "not-due:throttle", this.counters(sessionID), `${since}ms since last run`)
        return
      }
    }
    if (reason === "not-due:turns") {
      events.trigger(sessionID, "not-due:turns", this.counters(sessionID))
      return
    }

    const model = this.deps.modelFor(sessionID)
    if (!model) {
      events.trigger(sessionID, "skipped:model", this.counters(sessionID), "session model could not be resolved")
      return
    }

    await this.run(sessionID, reason, model, detail)
  }

  private async run(sessionID: string, reason: TriggerReason, model: ModelRef, detail?: string): Promise<void> {
    const { settings, engine, events, log, apply } = this.deps
    const state = this.stateOf(sessionID)
    state.inFlight = true
    events.trigger(sessionID, reason, this.counters(sessionID), detail)

    const started = this.now()
    const errors: string[] = []
    let plan: LearnPlan | undefined
    let outcome: ApplyOutcome | undefined

    try {
      const input = await this.deps.buildInput(sessionID, model)
      plan = await engine.plan(input)
      outcome = apply(plan, sessionID)
    } catch (error) {
      errors.push(String((error as Error)?.message ?? error))
      log.warn("learn run failed", { session: sessionID, message: errors[0] })
    } finally {
      state.inFlight = false
      state.lastRunAt = this.now()
      state.runs++

      events.run({
        session: sessionID,
        durationMs: this.now() - started,
        model: `${model.providerID}/${model.id}`,
        memory: plan?.memory.length ?? 0,
        curation: plan?.curation.length ?? 0,
        skills: plan?.skills.length ?? 0,
        applied: outcome?.applied ?? 0,
        refused: outcome?.refused.length ?? 0,
        errors,
        notes: plan?.notes,
        confidence: plan?.confidence,
      })

      if (!errors.length) {
        state.turns = 0
        state.tools = 0
      }

      const queued = state.dirty
      if (queued) {
        // A trigger arrived mid-run; counters were just reset, so run once more
        // explicitly, preserving the reason that was deferred.
        state.dirty = false
        if (!settings.enabled) return
        // The deferred trigger was already admitted, so it skips the throttle
        // window that starts when the current run finishes.
        await this.decide(sessionID, queued, "coalesced", true)
      }
    }
  }

  /** Test/diagnostic view. */
  inspect(sessionID: string): SessionState & { sessionID: string } {
    return { sessionID, ...this.stateOf(sessionID) }
  }

  reset(sessionID?: string): void {
    if (sessionID) this.state.delete(sessionID)
    else this.state.clear()
  }
}

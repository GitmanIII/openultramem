/**
 * Learn observability: one JSONL record per trigger decision and per run.
 *
 * The design rule is that silence is the failure mode, so a skipped review must
 * still leave a line explaining why.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { dirname } from "node:path"

export type TriggerReason =
  | "due:turns"
  | "due:tools"
  | "due:turn-end"
  | "due:manual"
  | "due:compaction"
  | "due:fallback"
  | "not-due:turns"
  | "not-due:throttle"
  | "not-due:in-flight"
  | "not-due:disabled"
  | "skipped:model"
  | "skipped:disabled"

export interface TriggerRecord {
  ts: string
  session: string
  instance?: string
  event: "trigger"
  reason: TriggerReason
  turns: number
  tools: number
  detail?: string
}

export interface RunRecord {
  ts: string
  session: string
  instance?: string
  event: "run"
  durationMs: number
  model: string
  memory: number
  curation: number
  skills: number
  applied: number
  refused: number
  errors: string[]
  notes?: string
  confidence?: number
}

export type LearnRecord = TriggerRecord | RunRecord

export class LearnEvents {
  constructor(
    private readonly path: string,
    private readonly instance?: string,
  ) {}

  append(record: LearnRecord): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, JSON.stringify(record) + "\n")
    } catch {
      // Observability must never break learning.
    }
  }

  trigger(session: string, reason: TriggerReason, counters: { turns: number; tools: number }, detail?: string): void {
    this.append({
      ts: new Date().toISOString(),
      session,
      instance: this.instance,
      event: "trigger",
      reason,
      turns: counters.turns,
      tools: counters.tools,
      detail,
    })
  }

  run(record: Omit<RunRecord, "ts" | "event">): void {
    this.append({ ts: new Date().toISOString(), event: "run", instance: this.instance, ...record })
  }

  read(): LearnRecord[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LearnRecord]
        } catch {
          return []
        }
      })
  }
}

export interface LearnSummary {
  since: string
  triggers: Record<string, number>
  runs: number
  applied: number
  refused: number
  errors: number
  averageMs: number
  notes: string[]
}

/** Weekly shape: what fired, what was skipped, what actually landed. */
export function summarize(records: LearnRecord[], sinceMs: number): LearnSummary {
  const recent = records.filter((record) => Date.parse(record.ts) >= sinceMs)
  const triggers: Record<string, number> = {}
  let runs = 0
  let applied = 0
  let refused = 0
  let errors = 0
  let totalMs = 0
  const notes: string[] = []

  for (const record of recent) {
    if (record.event === "trigger") {
      triggers[record.reason] = (triggers[record.reason] ?? 0) + 1
      continue
    }
    runs++
    applied += record.applied
    refused += record.refused
    errors += record.errors.length
    totalMs += record.durationMs
    if (record.notes) notes.push(record.notes)
  }

  return {
    since: new Date(sinceMs).toISOString(),
    triggers,
    runs,
    applied,
    refused,
    errors,
    averageMs: runs ? Math.round(totalMs / runs) : 0,
    notes: notes.slice(-10),
  }
}

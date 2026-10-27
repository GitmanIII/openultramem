/**
 * Host-side application of a learn plan.
 *
 * The engine proposes; this module validates against the live store, applies
 * atomically, and records an operation hash so a retried run cannot write the
 * same fact twice.
 */
import type { Database } from "bun:sqlite"
import type { Logger } from "../log.ts"
import type { MemoryOperation, MemoryStore, Target } from "../memory/store.ts"
import { hashOp, type CurationOp, type LearnPlan, type MemoryOp } from "./plan.ts"

export interface ApplyDeps {
  store: MemoryStore
  db: Database
  log: Logger
}

export interface Refusal {
  action: string
  target: string
  reason: string
}

export interface ApplyOutcome {
  applied: number
  skipped: number
  unsupported: number
  refused: Refusal[]
}

interface Derived {
  op: MemoryOperation
  hash: string
  source: string
}

/** Curation is expressed as memory operations; there is no separate note store. */
export function deriveOps(plan: LearnPlan): { derived: Derived[]; unsupported: Refusal[] } {
  const derived: Derived[] = []
  const unsupported: Refusal[] = []

  const push = (op: MemoryOperation, source: string) => {
    derived.push({ op, hash: hashOp(op), source })
  }

  for (const op of plan.memory) {
    push(
      {
        action: op.action,
        target: op.target,
        content: op.content,
        old_text: op.old_text,
      },
      "memory",
    )
  }

  for (const curation of plan.curation) {
    const target: Target = curation.target ?? "memory"
    const base = { target }
    switch (curation.action) {
      case "supersede":
        push({ ...base, action: "replace", old_text: curation.old_text, content: curation.content }, "supersede")
        break
      case "merge":
        push({ ...base, action: "replace", old_text: curation.old_text, content: curation.content }, "merge")
        if (curation.old_text_b) push({ ...base, action: "remove", old_text: curation.old_text_b }, "merge")
        break
      case "archive":
      case "demote":
        push({ ...base, action: "remove", old_text: curation.old_text }, curation.action)
        break
      case "promote":
        unsupported.push({ action: curation.action, target, reason: "promote needs note scopes, which this version does not have" })
        break
    }
  }

  return { derived, unsupported }
}

export function applyPlan(deps: ApplyDeps, plan: LearnPlan, sessionID: string): ApplyOutcome {
  const { store, db, log } = deps
  const outcome: ApplyOutcome = { applied: 0, skipped: 0, unsupported: 0, refused: [] }

  if (plan.skills.length) {
    outcome.unsupported += plan.skills.length
    log.warn("learn: skill operations are not supported yet", { session: sessionID, count: plan.skills.length })
  }

  const { derived, unsupported } = deriveOps(plan)
  outcome.refused.push(...unsupported)
  outcome.unsupported += unsupported.length

  const isApplied = (hash: string) => Boolean(db.query("SELECT 1 FROM learn_ops WHERE hash = ?").get(hash))
  const markApplied = db.query("INSERT OR IGNORE INTO learn_ops(hash, action, target, applied_at, session_id) VALUES (?, ?, ?, ?, ?)")

  const fresh = derived.filter((entry) => {
    if (isApplied(entry.hash)) {
      outcome.skipped++
      return false
    }
    return true
  })
  if (!fresh.length) return outcome

  let batch = fresh
  for (let round = 0; round < 2 && batch.length; round++) {
    batch = batch.filter((entry) => !isApplied(entry.hash))
    if (!batch.length) break

    const result = store.apply(batch.map((entry) => entry.op))
    if (result.ok) {
      for (const entry of batch) markApplied.run(entry.hash, entry.op.action, entry.op.target, Date.now(), sessionID)
      outcome.applied += batch.length
      break
    }

    // All-or-nothing was refused: drop the offending operations, keep the rest.
    const refusedIndexes = new Set<number>()
    result.results.forEach((entry, index) => {
      if (entry.status === "refused") {
        refusedIndexes.add(index)
        outcome.refused.push({ action: entry.action, target: entry.target, reason: entry.message })
      }
    })
    if (!refusedIndexes.size) break
    batch = batch.filter((_, index) => !refusedIndexes.has(index))
  }

  log.info("learn: applied", {
    session: sessionID,
    applied: outcome.applied,
    skipped: outcome.skipped,
    refused: outcome.refused.length,
    unsupported: outcome.unsupported,
  })
  return outcome
}

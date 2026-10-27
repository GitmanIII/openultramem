/**
 * The learn plan: what the engine proposes, and the host applies.
 *
 * Parsing is strict. Unknown actions, missing fields, and unknown keys are
 * errors, because a silent misread would write the wrong memory.
 */
import { createHash } from "node:crypto"

export type MemoryAction = "add" | "replace" | "remove"
export type Target = "memory" | "user" | "project"

export interface MemoryOp {
  action: MemoryAction
  target: Target
  content?: string
  old_text?: string
}

export type CurationAction = "supersede" | "merge" | "demote" | "promote" | "archive"

export interface CurationOp {
  action: CurationAction
  target?: Target
  old_text?: string
  old_text_b?: string
  content?: string
}

export interface SkillOp {
  action: "create" | "patch" | "write_file" | "remove_file" | "delete" | "promote" | "fork"
  id?: string
  description?: string
  content?: string
  path?: string
  scope?: "global" | "project"
  base_hash?: string
}

export interface LearnPlan {
  memory: MemoryOp[]
  skills: SkillOp[]
  curation: CurationOp[]
  notes?: string
  confidence?: number
}

export type ParseResult = { ok: true; plan: LearnPlan } | { ok: false; error: string }

const MEMORY_ACTIONS = new Set(["add", "replace", "remove"])
const TARGETS = new Set(["memory", "user", "project"])
const CURATION_ACTIONS = new Set(["supersede", "merge", "demote", "promote", "archive"])
const SKILL_ACTIONS = new Set(["create", "patch", "write_file", "remove_file", "delete", "promote", "fork"])
const TOP_KEYS = new Set(["memory", "skills", "curation", "notes", "confidence"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key))
}

export function parsePlan(output: string): ParseResult {
  const text = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return { ok: false, error: "no JSON object in output" }

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${String((error as Error).message)}` }
  }
  if (!isRecord(parsed)) return { ok: false, error: "plan must be a JSON object" }

  const extra = unknownKeys(parsed, TOP_KEYS)
  if (extra.length) return { ok: false, error: `unknown top-level key(s): ${extra.join(", ")}` }

  const memory: MemoryOp[] = []
  for (const [index, raw] of asArray(parsed.memory).entries()) {
    if (!isRecord(raw)) return { ok: false, error: `memory[${index}] must be an object` }
    const allowed = new Set(["action", "target", "content", "old_text"])
    const bad = unknownKeys(raw, allowed)
    if (bad.length) return { ok: false, error: `memory[${index}] unknown key(s): ${bad.join(", ")}` }
    if (typeof raw.action !== "string" || !MEMORY_ACTIONS.has(raw.action)) {
      return { ok: false, error: `memory[${index}].action must be one of add, replace, remove` }
    }
    if (typeof raw.target !== "string" || !TARGETS.has(raw.target)) {
      return { ok: false, error: `memory[${index}].target must be memory, user, or project` }
    }
    if (raw.action === "add" || raw.action === "replace") {
      if (typeof raw.content !== "string" || !raw.content.trim()) {
        return { ok: false, error: `memory[${index}].content is required for ${raw.action}` }
      }
    }
    if (raw.action === "replace" || raw.action === "remove") {
      if (typeof raw.old_text !== "string" || !raw.old_text.trim()) {
        return { ok: false, error: `memory[${index}].old_text is required for ${raw.action}` }
      }
    }
    memory.push({
      action: raw.action as MemoryAction,
      target: raw.target as Target,
      content: typeof raw.content === "string" ? raw.content : undefined,
      old_text: typeof raw.old_text === "string" ? raw.old_text : undefined,
    })
  }

  const curation: CurationOp[] = []
  for (const [index, raw] of asArray(parsed.curation).entries()) {
    if (!isRecord(raw)) return { ok: false, error: `curation[${index}] must be an object` }
    const allowed = new Set(["action", "target", "old_text", "old_text_b", "content"])
    const bad = unknownKeys(raw, allowed)
    if (bad.length) return { ok: false, error: `curation[${index}] unknown key(s): ${bad.join(", ")}` }
    if (typeof raw.action !== "string" || !CURATION_ACTIONS.has(raw.action)) {
      return { ok: false, error: `curation[${index}].action must be one of ${[...CURATION_ACTIONS].join(", ")}` }
    }
    if (raw.target !== undefined && (typeof raw.target !== "string" || !TARGETS.has(raw.target))) {
      return { ok: false, error: `curation[${index}].target must be memory, user, or project` }
    }
    if (raw.action !== "promote") {
      if (typeof raw.old_text !== "string" || !raw.old_text.trim()) {
        return { ok: false, error: `curation[${index}].old_text is required for ${raw.action}` }
      }
    }
    if (raw.action === "merge" && (typeof raw.old_text_b !== "string" || !raw.old_text_b.trim())) {
      return { ok: false, error: `curation[${index}].old_text_b is required for merge` }
    }
    if (raw.action === "supersede" && (typeof raw.content !== "string" || !raw.content.trim())) {
      return { ok: false, error: `curation[${index}].content is required for supersede` }
    }
    curation.push({
      action: raw.action as CurationAction,
      target: (raw.target as Target | undefined) ?? "memory",
      old_text: typeof raw.old_text === "string" ? raw.old_text : undefined,
      old_text_b: typeof raw.old_text_b === "string" ? raw.old_text_b : undefined,
      content: typeof raw.content === "string" ? raw.content : undefined,
    })
  }

  const skills: SkillOp[] = []
  for (const [index, raw] of asArray(parsed.skills).entries()) {
    if (!isRecord(raw)) return { ok: false, error: `skills[${index}] must be an object` }
    const allowed = new Set(["action", "id", "description", "content", "path", "scope", "base_hash"])
    const bad = unknownKeys(raw, allowed)
    if (bad.length) return { ok: false, error: `skills[${index}] unknown key(s): ${bad.join(", ")}` }
    if (typeof raw.action !== "string" || !SKILL_ACTIONS.has(raw.action)) {
      return { ok: false, error: `skills[${index}].action is not a known skill action` }
    }
    if (typeof raw.id !== "string" || !raw.id.trim()) {
      return { ok: false, error: `skills[${index}].id is required` }
    }
    if (raw.scope !== undefined && raw.scope !== "global" && raw.scope !== "project") {
      return { ok: false, error: `skills[${index}].scope must be global or project` }
    }
    if (raw.action === "create" && (typeof raw.description !== "string" || typeof raw.content !== "string")) {
      return { ok: false, error: `skills[${index}] create needs description and content` }
    }
    if (raw.action === "patch" && typeof raw.base_hash !== "string") {
      return { ok: false, error: `skills[${index}] patch needs base_hash from the candidate list` }
    }
    if ((raw.action === "write_file" || raw.action === "remove_file") && typeof raw.path !== "string") {
      return { ok: false, error: `skills[${index}] ${raw.action} needs path` }
    }
    if (raw.action === "delete" && typeof raw.base_hash !== "string") {
      return { ok: false, error: `skills[${index}] delete needs base_hash` }
    }
    skills.push({
      action: raw.action as SkillOp["action"],
      id: raw.id,
      description: typeof raw.description === "string" ? raw.description : undefined,
      content: typeof raw.content === "string" ? raw.content : undefined,
      path: typeof raw.path === "string" ? raw.path : undefined,
      scope: raw.scope as "global" | "project" | undefined,
      base_hash: typeof raw.base_hash === "string" ? raw.base_hash : undefined,
    })
  }

  if (parsed.notes !== undefined && typeof parsed.notes !== "string") {
    return { ok: false, error: "notes must be a string" }
  }
  if (parsed.confidence !== undefined && typeof parsed.confidence !== "number") {
    return { ok: false, error: "confidence must be a number" }
  }

  return {
    ok: true,
    plan: {
      memory,
      skills,
      curation,
      notes: parsed.notes as string | undefined,
      confidence: parsed.confidence as number | undefined,
    },
  }
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** Stable hash for idempotent application. */
export function hashOp(op: MemoryOp | CurationOp | SkillOp): string {
  const normalized = Object.fromEntries(
    Object.entries(op)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

export function isEmptyPlan(plan: LearnPlan): boolean {
  return plan.memory.length === 0 && plan.skills.length === 0 && plan.curation.length === 0
}

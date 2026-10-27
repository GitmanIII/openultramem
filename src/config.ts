/**
 * Configuration: defaults, `ctx.options`, and `OUM_*` env overrides.
 *
 * Precedence (low to high): defaults < env < plugin options.
 */
import { expandHome } from "./paths.ts"

export interface LearnTriggers {
  turns: number
  toolIterations: number
  onCompaction: boolean
  fallback: "next-prompt" | "none"
  /** Minimum gap between runs per session. */
  throttleMs: number
}

export interface OumConfig {
  memoryRoot: string
  dataRoot: string
  memoryChars: number
  userChars: number
  learn: {
    enabled: boolean
    model: "session" | string
    maxTranscriptChars: number
    triggers: LearnTriggers
    log: boolean
  }
  search: {
    trigram: boolean
    maxIndexedChars: number
    syncBudgetMs: number
  }
  skills: {
    globalRoot: string
    projectRoot: string
    nativeRoot: string
    descriptionBudget: number
    editUserSkills: boolean
  }
  coexistence: boolean
}

export const DEFAULTS: OumConfig = {
  memoryRoot: "~/.config/opencode/oum",
  dataRoot: "~/.local/share/opencode/oum",
  memoryChars: 2200,
  userChars: 1375,
  learn: {
    enabled: true,
    model: "session",
    maxTranscriptChars: 60_000,
    triggers: { turns: 10, toolIterations: 10, onCompaction: true, fallback: "next-prompt", throttleMs: 60_000 },
    log: true,
  },
  search: { trigram: true, maxIndexedChars: 8_000, syncBudgetMs: 250 },
  skills: {
    globalRoot: "~/.agents/skills",
    projectRoot: ".opencode/skills",
    nativeRoot: "~/.config/opencode/skills",
    descriptionBudget: 200,
    editUserSkills: false,
  },
  coexistence: false,
}

type Json = Record<string, unknown>

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function section(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {}
}

function fromEnv(env: Record<string, string | undefined> = process.env): Json {
  const out: Json = {}
  if (env.OUM_MEMORY_ROOT) out.memoryRoot = env.OUM_MEMORY_ROOT
  if (env.OUM_DATA_ROOT) out.dataRoot = env.OUM_DATA_ROOT
  if (env.OUM_LEARN_DISABLED === "1") out.learn = { enabled: false }
  if (env.OUM_SEARCH_TRIGRAM === "0") out.search = { trigram: false }
  return out
}

function merge(base: OumConfig, ...layers: Json[]): OumConfig {
  const result: OumConfig = structuredClone(base)

  for (const layer of layers) {
    if (!layer) continue
    result.memoryRoot = str(layer.memoryRoot, result.memoryRoot)
    result.dataRoot = str(layer.dataRoot, result.dataRoot)
    result.memoryChars = num(layer.memoryChars, result.memoryChars)
    result.userChars = num(layer.userChars, result.userChars)
    result.coexistence = bool(layer.coexistence, result.coexistence)

    const learn = section(layer.learn)
    result.learn.enabled = bool(learn.enabled, result.learn.enabled)
    result.learn.model = str(learn.model, result.learn.model)
    result.learn.maxTranscriptChars = num(learn.maxTranscriptChars, result.learn.maxTranscriptChars)
    result.learn.log = bool(learn.log, result.learn.log)
    const triggers = section(learn.triggers)
    result.learn.triggers.turns = num(triggers.turns, result.learn.triggers.turns)
    result.learn.triggers.toolIterations = num(triggers.toolIterations, result.learn.triggers.toolIterations)
    result.learn.triggers.onCompaction = bool(triggers.onCompaction, result.learn.triggers.onCompaction)
    result.learn.triggers.throttleMs = num(triggers.throttleMs, result.learn.triggers.throttleMs)
    if (triggers.fallback === "next-prompt" || triggers.fallback === "none") {
      result.learn.triggers.fallback = triggers.fallback
    }

    const search = section(layer.search)
    result.search.trigram = bool(search.trigram, result.search.trigram)
    result.search.maxIndexedChars = num(search.maxIndexedChars, result.search.maxIndexedChars)
    result.search.syncBudgetMs = num(search.syncBudgetMs, result.search.syncBudgetMs)

    const skills = section(layer.skills)
    result.skills.globalRoot = str(skills.globalRoot, result.skills.globalRoot)
    result.skills.projectRoot = str(skills.projectRoot, result.skills.projectRoot)
    result.skills.nativeRoot = str(skills.nativeRoot, result.skills.nativeRoot)
    result.skills.descriptionBudget = num(skills.descriptionBudget, result.skills.descriptionBudget)
    result.skills.editUserSkills = bool(skills.editUserSkills, result.skills.editUserSkills)
  }

  result.memoryRoot = expandHome(result.memoryRoot)
  result.dataRoot = expandHome(result.dataRoot)
  result.skills.globalRoot = expandHome(result.skills.globalRoot)
  result.skills.nativeRoot = expandHome(result.skills.nativeRoot)
  return result
}

export function loadConfig(options: Record<string, unknown> = {}, env?: Record<string, string | undefined>): OumConfig {
  return merge(DEFAULTS, fromEnv(env), options)
}

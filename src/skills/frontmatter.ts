/**
 * Skill frontmatter.
 *
 * OpenCode reads `name` and `description`; OUM adds `metadata.oum` for
 * provenance. Files without it are user-authored and must not be rewritten.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

export type Origin = "self" | "user" | "fork" | "compat"
export type Scope = "global" | "project"

export interface OumMeta {
  origin: Origin
  scope: Scope
  created: string
  updated: string
  pinned: boolean
  promoted_from?: string
}

export interface SkillFile {
  name: string
  description: string
  body: string
  oum?: OumMeta
  metadata: Record<string, unknown>
  extra: Record<string, unknown>
}

export type SkillParse = { ok: true; skill: SkillFile } | { ok: false; error: string }

const MAX_BODY = 100_000

export function parseSkill(raw: string): SkillParse {
  if (!raw.startsWith("---")) return { ok: false, error: "missing frontmatter" }
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return { ok: false, error: "unterminated frontmatter" }

  let data: unknown
  try {
    data = parseYaml(raw.slice(4, end))
  } catch (error) {
    return { ok: false, error: `invalid YAML: ${String((error as Error).message)}` }
  }
  if (typeof data !== "object" || data === null) return { ok: false, error: "frontmatter must be a mapping" }

  const record = data as Record<string, unknown>
  if (typeof record.name !== "string" || !record.name.trim()) return { ok: false, error: "name is required" }
  if (typeof record.description !== "string" || !record.description.trim()) return { ok: false, error: "description is required" }

  const body = raw.slice(end + 4).replace(/^\r?\n/, "")
  if (body.length > MAX_BODY) return { ok: false, error: `body exceeds ${MAX_BODY} chars` }

  const metadata = (record.metadata && typeof record.metadata === "object" ? record.metadata : {}) as Record<string, unknown>
  const oumRaw = metadata.oum
  let oum: OumMeta | undefined

  if (oumRaw && typeof oumRaw === "object") {
    const value = oumRaw as Record<string, unknown>
    const origin = ["self", "user", "fork", "compat"].includes(String(value.origin)) ? (String(value.origin) as Origin) : "user"
    oum = {
      origin,
      scope: value.scope === "project" ? "project" : "global",
      created: typeof value.created === "string" ? value.created : "",
      updated: typeof value.updated === "string" ? value.updated : "",
      pinned: value.pinned === true,
      promoted_from: typeof value.promoted_from === "string" ? value.promoted_from : undefined,
    }
  }

  const { name, description, metadata: _metadata, ...extra } = record
  return {
    ok: true,
    skill: {
      name,
      description,
      body,
      oum,
      metadata,
      extra,
    },
  }
}

export function renderSkill(skill: SkillFile): string {
  const front = {
    name: skill.name,
    description: skill.description,
    ...skill.extra,
    metadata: skill.oum ? { ...skill.metadata, oum: skill.oum } : skill.metadata,
  }
  return `---\n${stringifyYaml(front).trimEnd()}\n---\n\n${skill.body.trim()}\n`
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function newMeta(scope: Scope, origin: Origin, from?: string): OumMeta {
  const date = today()
  return { origin, scope, created: date, updated: date, pinned: false, ...(from ? { promoted_from: from } : {}) }
}

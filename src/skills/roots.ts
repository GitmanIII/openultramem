/**
 * Skill roots and discovery.
 *
 * OUM writes only to two roots: the global library (`~/.agents/skills`) and the
 * project's `.opencode/skills`. The native global root and compat roots are read
 * for collisions, never written.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import type { OumConfig } from "../config.ts"
import { parseSkill, type OumMeta, type Scope } from "./frontmatter.ts"

export interface SkillRoot {
  scope: "global" | "project" | "native" | "compat"
  path: string
  writable: boolean
  /** Higher wins when two roots expose the same id. */
  precedence: number
}

export interface DiscoveredSkill {
  id: string
  name: string
  description: string
  path: string
  dir: string
  root: SkillRoot
  oum?: OumMeta
  origin: "self" | "user" | "fork" | "compat"
  pinned: boolean
  body: string
  sha: string
  category?: string
}

export function roots(config: OumConfig, projectDir: string): SkillRoot[] {
  const list: SkillRoot[] = [
    { scope: "native", path: config.skills.nativeRoot, writable: false, precedence: 40 },
    { scope: "project", path: join(projectDir, config.skills.projectRoot), writable: true, precedence: 30 },
    { scope: "global", path: config.skills.globalRoot, writable: true, precedence: 20 },
    { scope: "compat", path: join(projectDir, ".claude", "skills"), writable: false, precedence: 10 },
    { scope: "compat", path: join(projectDir, ".agents", "skills"), writable: false, precedence: 9 },
  ]
  return list
}

export function sha(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12)
}

function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Directory form only: `<root>/<id>/SKILL.md` or `<root>/<category>/<id>/SKILL.md`. */
export function discoverIn(root: SkillRoot): DiscoveredSkill[] {
  if (!existsSync(root.path)) return []
  const found: DiscoveredSkill[] = []

  const add = (dir: string, id: string, category?: string) => {
    const file = join(dir, "SKILL.md")
    try {
      if (!statSync(file).isFile()) return
    } catch {
      return
    }
    const parsed = parseSkill(readFileSync(file, "utf8"))
    if (!parsed.ok) return
    found.push({
      id,
      name: parsed.skill.name,
      description: parsed.skill.description,
      path: file,
      dir,
      root,
      oum: parsed.skill.oum,
      origin: parsed.skill.oum?.origin ?? (root.scope === "compat" ? "compat" : "user"),
      pinned: parsed.skill.oum?.pinned ?? false,
      body: parsed.skill.body,
      sha: sha(parsed.skill.body),
      category,
    })
  }

  for (const entry of directories(root.path)) {
    const dir = join(root.path, entry)
    const file = join(dir, "SKILL.md")
    if (existsSync(file)) {
      add(dir, entry)
      continue
    }
    for (const child of directories(dir)) add(join(dir, child), child, entry)
  }

  return found
}

export interface Discovery {
  skills: DiscoveredSkill[]
  byID: Map<string, DiscoveredSkill[]>
}

export function discover(rootList: SkillRoot[]): Discovery {
  const all: DiscoveredSkill[] = []
  for (const root of rootList) all.push(...discoverIn(root))
  all.sort((a, b) => b.root.precedence - a.root.precedence)

  const byID = new Map<string, DiscoveredSkill[]>()
  for (const skill of all) {
    const list = byID.get(skill.id) ?? []
    list.push(skill)
    byID.set(skill.id, list)
  }
  return { skills: all, byID }
}

/** The copy OpenCode would load: highest precedence wins. */
export function effective(discovery: Discovery, id: string): DiscoveredSkill | undefined {
  return discovery.byID.get(id)?.[0]
}

export function projectRoot(config: OumConfig, projectDir: string): string {
  return join(projectDir, config.skills.projectRoot)
}

export function targetRoot(config: OumConfig, projectDir: string, scope: Scope): string {
  return scope === "global" ? config.skills.globalRoot : projectRoot(config, projectDir)
}

export function relativeTo(root: string, path: string): string {
  return relative(root, path)
}

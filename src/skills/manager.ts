/**
 * Skill mutations.
 *
 * Guards are the product here: ids are path-safe, descriptions are budgeted,
 * patch and delete require proof that the current body was read, user-authored
 * skills are protected, and every mutation is ledgered and reloaded natively.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { OumConfig } from "../config.ts"
import type { Logger } from "../log.ts"
import { newMeta, parseSkill, renderSkill, today, type Scope, type SkillFile } from "./frontmatter.ts"
import { archiveSkill, backupSkill, type Ledger } from "./ledger.ts"
import { discover, effective, projectRoot, sha, targetRoot, type DiscoveredSkill, type SkillRoot } from "./roots.ts"

export interface MutationResult {
  ok: boolean
  message: string
  skill?: DiscoveredSkill
  /** Set when a write needs the current body to be acknowledged first. */
  needsRead?: { sha: string; body: string; path: string }
  duplicates?: DiscoveredSkill[]
}

export interface SkillManagerDeps {
  config: OumConfig
  projectDir: string
  dataRoot: string
  ledger: Ledger
  log: Logger
  reload: () => Promise<void>
  afterMutation?: (skills: DiscoveredSkill[]) => void
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_BODY = 100_000
const MAX_FILE = 200_000

export class SkillManager {
  constructor(private readonly deps: SkillManagerDeps) {}

  roots(): SkillRoot[] {
    const { config, projectDir } = this.deps
    return [
      { scope: "native", path: config.skills.nativeRoot, writable: false, precedence: 40 },
      { scope: "project", path: projectRoot(config, projectDir), writable: true, precedence: 30 },
      { scope: "global", path: config.skills.globalRoot, writable: true, precedence: 20 },
      { scope: "compat", path: join(projectDir, ".claude", "skills"), writable: false, precedence: 10 },
      { scope: "compat", path: join(projectDir, ".agents", "skills"), writable: false, precedence: 9 },
    ]
  }

  discovery() {
    return discover(this.roots())
  }

  list(): DiscoveredSkill[] {
    return this.discovery().skills
  }

  get(id: string): DiscoveredSkill | undefined {
    return effective(this.discovery(), id)
  }

  create(input: { id: string; description: string; content: string; scope?: Scope }): MutationResult {
    const invalid = this.validateID(input.id)
    if (invalid) return { ok: false, message: invalid }
    const description = input.description.trim()
    if (!description) return { ok: false, message: "description is required" }
    if (description.length > this.deps.config.skills.descriptionBudget) {
      return {
        ok: false,
        message: `description is ${description.length} chars; budget is ${this.deps.config.skills.descriptionBudget}. State what the skill does and when to use it, tighter.`,
      }
    }
    if (input.content.length > MAX_BODY) return { ok: false, message: `body exceeds ${MAX_BODY} chars` }

    const discovery = this.discovery()
    const collisions = discovery.byID.get(input.id) ?? []
    if (collisions.length) {
      return {
        ok: false,
        message: `id "${input.id}" already exists at ${collisions.map((skill) => skill.path).join(", ")}. Patch it, fork it, or choose a different id.`,
        duplicates: collisions,
      }
    }

    const scope: Scope = input.scope ?? "project"
    const root = targetRoot(this.deps.config, this.deps.projectDir, scope)
    const dir = join(root, input.id)
    if (existsSync(dir)) return { ok: false, message: `${dir} already exists` }

    const skill: SkillFile = {
      name: input.id,
      description,
      body: input.content,
      oum: newMeta(scope, "self"),
      metadata: {},
      extra: {},
    }
    this.writeAtomic(join(dir, "SKILL.md"), renderSkill(skill))
    const stored = this.get(input.id)
    this.record({
      action: "create",
      id: input.id,
      scope,
      path: join(dir, "SKILL.md"),
      origin: "self",
      bytes: input.content.length,
      // The canonical sha is what discovery reports, so it can be reused as base_hash.
      sha: stored?.sha,
    })

    return {
      ok: true,
      message: `created ${input.id} in ${scope} root`,
      skill: stored,
      duplicates: this.nearDuplicates(discovery.skills, description, input.id),
    }
  }

  patch(input: { id: string; content?: string; description?: string; base_hash?: string }): MutationResult {
    const target = this.get(input.id)
    if (!target) return { ok: false, message: `skill "${input.id}" not found` }
    if (!target.root.writable) return { ok: false, message: `skill "${input.id}" lives in a read-only root (${target.root.scope})` }
    if (target.origin === "user" && !this.deps.config.skills.editUserSkills) {
      return { ok: false, message: `skill "${input.id}" is user-authored; set skills.editUserSkills to patch it` }
    }

    if (!input.base_hash) {
      return {
        ok: false,
        message: `read-before-write: pass base_hash after reading the skill.`,
        needsRead: { sha: target.sha, body: target.body, path: target.path },
      }
    }
    if (input.base_hash !== target.sha) {
      return {
        ok: false,
        message: `base_hash mismatch: the skill changed since it was read.`,
        needsRead: { sha: target.sha, body: target.body, path: target.path },
      }
    }

    const parsed = parseSkill(readFileSync(target.path, "utf8"))
    if (!parsed.ok) return { ok: false, message: parsed.error }

    const body = input.content ?? parsed.skill.body
    if (body.length > MAX_BODY) return { ok: false, message: `body exceeds ${MAX_BODY} chars` }
    const description = input.description?.trim() ?? parsed.skill.description
    if (description.length > this.deps.config.skills.descriptionBudget) {
      return { ok: false, message: `description is ${description.length} chars; budget is ${this.deps.config.skills.descriptionBudget}` }
    }

    backupSkill(this.deps.dataRoot, input.id, target.dir)
    const meta = { ...(parsed.skill.oum ?? newMeta(target.root.scope === "global" ? "global" : "project", target.origin)), updated: today() }
    this.writeAtomic(target.path, renderSkill({ ...parsed.skill, description, body, oum: meta }))
    const stored = this.get(input.id)
    this.record({ action: "patch", id: input.id, scope: meta.scope, path: target.path, origin: target.origin, bytes: body.length, sha: stored?.sha })

    return { ok: true, message: `patched ${input.id}`, skill: stored }
  }

  writeFile(input: { id: string; path: string; content: string }): MutationResult {
    const target = this.get(input.id)
    if (!target) return { ok: false, message: `skill "${input.id}" not found` }
    if (!target.root.writable) return { ok: false, message: "skill lives in a read-only root" }
    const path = this.safePath(target.dir, input.path)
    if (!path) return { ok: false, message: `unsafe path "${input.path}"` }
    if (input.content.length > MAX_FILE) return { ok: false, message: `file exceeds ${MAX_FILE} chars` }

    this.writeAtomic(path, input.content)
    this.record({ action: "write_file", id: input.id, scope: target.root.scope === "global" ? "global" : "project", path, origin: target.origin, bytes: input.content.length })
    return { ok: true, message: `wrote ${relative(target.dir, path)}`, skill: this.get(input.id) }
  }

  removeFile(input: { id: string; path: string }): MutationResult {
    const target = this.get(input.id)
    if (!target) return { ok: false, message: `skill "${input.id}" not found` }
    if (!target.root.writable) return { ok: false, message: "skill lives in a read-only root" }
    const path = this.safePath(target.dir, input.path)
    if (!path) return { ok: false, message: `unsafe path "${input.path}"` }
    if (basename(path) === "SKILL.md") return { ok: false, message: "SKILL.md is managed by patch/delete, not remove_file" }
    if (!existsSync(path)) return { ok: false, message: `${input.path} does not exist` }

    rmSync(path, { force: true })
    this.record({ action: "remove_file", id: input.id, scope: target.root.scope === "global" ? "global" : "project", path, origin: target.origin })
    return { ok: true, message: `removed ${input.path}` }
  }

  delete(input: { id: string; base_hash?: string }): MutationResult {
    const target = this.get(input.id)
    if (!target) return { ok: false, message: `skill "${input.id}" not found` }
    if (!target.root.writable) return { ok: false, message: "skill lives in a read-only root" }
    if (!input.base_hash) {
      return { ok: false, message: "read-before-write: pass base_hash after reading the skill.", needsRead: { sha: target.sha, body: target.body, path: target.path } }
    }
    if (input.base_hash !== target.sha) {
      return { ok: false, message: "base_hash mismatch: the skill changed since it was read.", needsRead: { sha: target.sha, body: target.body, path: target.path } }
    }

    const archived = archiveSkill(this.deps.dataRoot, input.id, target.dir)
    this.record({ action: "delete", id: input.id, scope: target.root.scope === "global" ? "global" : "project", path: target.dir, origin: target.origin, note: `archived to ${archived}` })
    return { ok: true, message: `archived ${input.id} to ${archived}` }
  }

  promote(input: { id: string }): MutationResult {
    const target = this.get(input.id)
    if (!target) return { ok: false, message: `skill "${input.id}" not found` }
    if (target.root.scope !== "project") return { ok: false, message: `only project skills can be promoted; ${input.id} is ${target.root.scope}` }
    if (target.origin === "user" && !this.deps.config.skills.editUserSkills) {
      return { ok: false, message: `skill "${input.id}" is user-authored; set skills.editUserSkills to promote it` }
    }

    const globalRoot = this.deps.config.skills.globalRoot
    const existing = this.discovery().byID.get(input.id)?.find((skill) => skill.root.scope === "global")
    if (existing) return { ok: false, message: `"${input.id}" already exists globally at ${existing.path}; patch it instead` }

    const destination = join(globalRoot, input.id)
    if (existsSync(destination)) return { ok: false, message: `${destination} already exists` }

    mkdirSync(globalRoot, { recursive: true })
    renameSync(target.dir, destination)
    this.rewriteMeta(join(destination, "SKILL.md"), (file) => ({
      ...file,
      oum: { ...(file.oum ?? newMeta("global", target.origin)), scope: "global", updated: today(), promoted_from: target.dir },
    }))
    this.record({ action: "promote", id: input.id, scope: "global", path: destination, origin: target.origin, from: target.dir, to: destination })
    return { ok: true, message: `promoted ${input.id} to ${globalRoot}`, skill: this.get(input.id) }
  }

  fork(input: { id: string }): MutationResult {
    const target = this.get(input.id)
    if (!target) return { ok: false, message: `skill "${input.id}" not found` }
    if (target.root.scope !== "global") return { ok: false, message: `only global skills can be forked; ${input.id} is ${target.root.scope}` }

    const dir = join(projectRoot(this.deps.config, this.deps.projectDir), input.id)
    if (existsSync(dir)) return { ok: false, message: `${dir} already exists; delete or rename the local copy first` }

    this.copyTree(target.dir, dir)
    this.rewriteMeta(join(dir, "SKILL.md"), (file) => ({
      ...file,
      oum: { ...(file.oum ?? newMeta("project", "fork")), origin: "fork", scope: "project", updated: today(), promoted_from: target.dir },
    }))
    this.record({ action: "fork", id: input.id, scope: "project", path: dir, origin: "fork", from: target.dir, to: dir })
    return { ok: true, message: `forked ${input.id} into the project root`, skill: this.get(input.id) }
  }

  // ---- helpers ----------------------------------------------------------

  private validateID(id: string): string | null {
    if (!ID.test(id)) return `id must be lowercase kebab-case, 1-64 chars, matching the directory (got "${id}")`
    return null
  }

  private nearDuplicates(skills: DiscoveredSkill[], description: string, id: string): DiscoveredSkill[] {
    const words = new Set(description.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    return skills
      .filter((skill) => skill.id !== id)
      .map((skill) => {
        const other = new Set(`${skill.id} ${skill.description}`.toLowerCase().match(/[a-z]{4,}/g) ?? [])
        let overlap = 0
        for (const word of words) if (other.has(word)) overlap++
        return { skill, overlap }
      })
      .filter((entry) => entry.overlap >= 3)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 3)
      .map((entry) => entry.skill)
  }

  private safePath(base: string, candidate: string): string | null {
    if (!candidate.trim() || isAbsolute(candidate)) return null
    const resolved = resolve(base, candidate)
    const baseResolved = realpathSync(base)
    const rel = relative(baseResolved, resolved)
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null

    // Reject symlinks in any existing path component.
    let cursor = baseResolved
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part)
      try {
        if (lstatSync(cursor).isSymbolicLink()) return null
      } catch {
        break
      }
    }
    return resolved
  }

  private writeAtomic(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  }

  private copyTree(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true })
  }

  private rewriteMeta(path: string, update: (file: SkillFile) => SkillFile): void {
    const parsed = parseSkill(readFileSync(path, "utf8"))
    if (!parsed.ok) return
    this.writeAtomic(path, renderSkill(update(parsed.skill)))
  }

  private record(entry: Parameters<Ledger["append"]>[0]): void {
    this.deps.ledger.append(entry)
    void this.deps
      .reload()
      .catch((error) => this.deps.log.warn("skill reload failed", { message: String(error?.message ?? error) }))
      .then(() => this.deps.afterMutation?.(this.list()))
  }
}

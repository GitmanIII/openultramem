/**
 * `oum_skill_manage`: create, patch, write_file, remove_file, delete, promote,
 * fork. OpenCode still owns discovery, the picker, and loading.
 */
import type { Logger } from "../log.ts"
import type { ToolCallContext } from "../recall/tool.ts"
import type { Scope } from "./frontmatter.ts"
import type { MutationResult, SkillManager } from "./manager.ts"

export interface SkillToolDeps {
  manager: SkillManager
  log: Logger
  permission: (input: {
    sessionID: string
    agent: string
    source: { type: "tool"; messageID: string; id: string }
    action: string
    resources: string[]
  }) => Promise<void>
}

export interface SkillInput {
  action: "create" | "patch" | "write_file" | "remove_file" | "delete" | "promote" | "fork"
  id?: string
  description?: string
  content?: string
  path?: string
  scope?: Scope
  base_hash?: string
}

function describe(result: MutationResult): string {
  if (result.ok) {
    const lines = [result.message]
    if (result.skill) lines.push(`now at ${result.skill.path} (sha ${result.skill.sha})`)
    if (result.duplicates?.length) {
      lines.push(`near-duplicate(s) to consider patching instead: ${result.duplicates.map((skill) => skill.id).join(", ")}`)
    }
    return lines.join("\n")
  }

  if (result.needsRead) {
    return [
      result.message,
      `current sha: ${result.needsRead.sha}`,
      `current body:`,
      result.needsRead.body.slice(0, 4000),
    ].join("\n")
  }
  if (result.duplicates?.length) {
    return `${result.message}\ncandidates: ${result.duplicates.map((skill) => `${skill.id} (${skill.path})`).join(", ")}`
  }
  return result.message
}

export function createSkillTool(deps: SkillToolDeps) {
  const { manager, log } = deps

  return {
    name: "skill_manage",
    description:
      "Author skills in OpenCode's native roots. action=create|patch|write_file|remove_file|delete|promote|fork. patch/delete require base_hash, which the tool returns together with the body when it is missing. Supports references/, templates/, scripts/ via write_file. Never call after loading a skill you intend to patch without re-reading its sha.",
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "patch", "write_file", "remove_file", "delete", "promote", "fork"],
        },
        id: { type: "string", description: "Lowercase kebab-case skill id, matching the directory." },
        description: { type: "string", description: "When to use this skill. Required for create; optional for patch." },
        content: { type: "string", description: "SKILL.md body, or file content for write_file." },
        path: { type: "string", description: "Relative path inside the skill directory (write_file/remove_file)." },
        scope: { type: "string", enum: ["global", "project"], description: "create only; default project." },
        base_hash: { type: "string", description: "sha of the body that was read; required for patch/delete." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    options: { namespace: "oum", codemode: true as const },

    execute: async (input: SkillInput, context: ToolCallContext) => {
      await deps.permission({
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
        action: "skill-write",
        resources: [input.id ?? "skills"],
      })

      const id = input.id?.trim() ?? ""
      let result: MutationResult

      switch (input.action) {
        case "create":
          if (!id) return { content: "id is required" }
          result = manager.create({
            id,
            description: input.description ?? "",
            content: input.content ?? "",
            scope: input.scope,
          })
          break
        case "patch":
          if (!id) return { content: "id is required" }
          result = manager.patch({ id, content: input.content, description: input.description, base_hash: input.base_hash })
          break
        case "write_file":
          if (!id || !input.path) return { content: "id and path are required" }
          result = manager.writeFile({ id, path: input.path, content: input.content ?? "" })
          break
        case "remove_file":
          if (!id || !input.path) return { content: "id and path are required" }
          result = manager.removeFile({ id, path: input.path })
          break
        case "delete":
          if (!id) return { content: "id is required" }
          result = manager.delete({ id, base_hash: input.base_hash })
          break
        case "promote":
          if (!id) return { content: "id is required" }
          result = manager.promote({ id })
          break
        case "fork":
          if (!id) return { content: "id is required" }
          result = manager.fork({ id })
          break
        default:
          return { content: `unknown action: ${String(input.action)}` }
      }

      log.info("skill mutation", { action: input.action, id, ok: result.ok })
      return { content: describe(result) }
    },
  }
}

/**
 * `oum_memory`: add, replace, remove, batch against MEMORY.md / USER.md.
 *
 * The tool never touches the current session's frozen snapshot; a write is
 * visible from the next session onwards by design.
 */
import type { Logger } from "../log.ts"
import type { MemoryOperation, MemoryStore, Target } from "./store.ts"
import { validate } from "./store.ts"
import type { ToolCallContext } from "../recall/tool.ts"

export interface MemoryToolDeps {
  store: MemoryStore
  log: Logger
  permission: (input: {
    sessionID: string
    agent: string
    source: { type: "tool"; messageID: string; id: string }
    action: string
    resources: string[]
  }) => Promise<void>
}

export interface MemoryInput {
  action: "add" | "replace" | "remove" | "batch"
  target?: Target
  content?: string
  old_text?: string
  operations?: MemoryOperation[]
}

export function createMemoryTool(deps: MemoryToolDeps) {
  const { store, log } = deps

  const describe = () => {
    const { memory, user, project } = store.both()
    const parts = [
      `memory: ${memory.percent}% — ${memory.chars}/${memory.budget} chars (${memory.entries.length} entries)`,
      `user: ${user.percent}% — ${user.chars}/${user.budget} chars (${user.entries.length} entries)`,
    ]
    if (project) parts.push(`project: ${project.percent}% — ${project.chars}/${project.budget} chars (${project.entries.length} entries)`)
    return parts.join(" · ")
  }

  return {
    name: "memory",
    description:
      "Manage canonical memory. action=add|replace|remove|batch with target=memory (machine-wide agent notes), user (who the user is), or project (facts for this project only). replace/remove match old_text exactly once and must be given the FULL new entry as content. Writes are refused, not truncated, when a file would exceed its budget.",
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "remove", "batch"] },
        target: { type: "string", enum: ["memory", "user", "project"] },
        content: { type: "string", description: "Entry text (full replacement text for replace)." },
        old_text: { type: "string", description: "Exact substring identifying one existing entry." },
        operations: {
          type: "array",
          description: "For action=batch. Applied atomically.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              target: { type: "string", enum: ["memory", "user", "project"] },
              content: { type: "string" },
              old_text: { type: "string" },
            },
            required: ["action", "target"],
            additionalProperties: false,
          },
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    options: { namespace: "oum", codemode: true as const },

    execute: async (input: MemoryInput, context: ToolCallContext) => {
      await deps.permission({
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
        action: "memory-write",
        resources: ["oum-memory"],
      })

      const operations: MemoryOperation[] = input.action === "batch" ? (input.operations ?? []) : [{
        action: input.action,
        target: (input.target ?? "memory") as Target,
        content: input.content,
        old_text: input.old_text,
      }]

      if (!operations.length) return { content: "No operations supplied." }

      for (const op of operations) {
        if (op.action !== "add") continue
        const invalid = validate(op.content ?? "")
        if (invalid) return { content: `Refused: ${invalid}. Nothing was written.` }
      }

      const result = store.apply(operations)
      const lines = result.results.map((entry) => `${entry.status}: ${entry.action} ${entry.target} — ${entry.message}`)
      log.info("memory write", { ok: result.ok, results: result.results.map((r) => `${r.status}:${r.action}:${r.target}`) })

      return {
        content: [
          ...lines,
          "",
          result.ok
            ? `Write saved. This session's prompt is unchanged (frozen snapshot); the entry appears in new sessions.`
            : `Nothing was written.`,
          describe(),
        ].join("\n"),
      }
    },
  }
}

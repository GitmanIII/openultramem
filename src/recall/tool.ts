/**
 * `oum_session_search`: discovery, scroll, read, browse over OpenCode's own
 * history. The index is an optimisation; the host database is the source.
 */
import type { Database } from "bun:sqlite"
import type { OumConfig } from "../config.ts"
import type { Logger } from "../log.ts"
import { sync } from "./ingest.ts"
import { search, searchHost, type Hit, type Mode } from "./search.ts"
import { hydrate, readSession, recentSessions, sessionMeta, type HydratedHit } from "./hydrate.ts"

export interface ToolCallContext {
  sessionID: string
  agent: string
  messageID: string
  id: string
}

export interface RecallDeps {
  db: Database
  host: () => Database | null
  config: OumConfig
  log: Logger
  permission: (input: {
    sessionID: string
    agent: string
    source: { type: "tool"; messageID: string; id: string }
    action: string
    resources: string[]
  }) => Promise<void>
}

export interface SearchInput {
  query?: string
  session_id?: string
  around_message_id?: string
  limit?: number
  detail?: "summary" | "full"
  include_children?: boolean
  project?: string
  mode?: Mode
}

function when(ms: number): string {
  const date = new Date(ms)
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`
}

function header(hit: HydratedHit): string {
  const title = hit.session?.title ? ` "${hit.session.title}"` : ""
  const role = hit.role === "tool" && hit.toolName ? `tool:${hit.toolName}` : hit.role
  return `- ${when(hit.created)} [${role}] ${hit.sessionID}${title} ${hit.link}`
}

export function formatDiscovery(query: string, hits: HydratedHit[], stale: boolean): string {
  if (!hits.length) return `No matches for "${query}".`
  const lines = [`Found ${hits.length} match(es) for "${query}"${stale ? " (index stale)" : ""}:`, ""]
  for (const hit of hits) {
    lines.push(header(hit))
    if (hit.snippet) lines.push(`  ${hit.snippet}`)
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export function createSessionSearch(deps: RecallDeps) {
  const { db, config, log } = deps
  const maxChars = () => config.search.maxIndexedChars

  const doSync = (host: Database): boolean => {
    try {
      const result = sync(db, host, { budgetMs: config.search.syncBudgetMs, maxChars: maxChars() })
      log.debug("sync", { scanned: result.scanned, upserted: result.upserted, ms: result.ms, stale: result.stale })
      return result.stale
    } catch (error) {
      log.warn("sync failed", { message: String((error as Error)?.message ?? error) })
      return true
    }
  }

  return {
    name: "session_search",
    description:
      "Search this OpenCode installation's past sessions. query = ranked discovery; session_id + around_message_id = scroll around a message; session_id alone = read the session; no arguments = browse recent sessions.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms. Omit when reading a session." },
        session_id: { type: "string", description: "Session to read, e.g. ses_..." },
        around_message_id: { type: "string", description: "Scroll window around this message id." },
        limit: { type: "number", description: "Max results (default 10, max 50)." },
        detail: { type: "string", enum: ["summary", "full"], description: "summary = snippets, full = whole messages." },
        include_children: { type: "boolean", description: "Include subagent/child sessions (hidden by default)." },
        project: { type: "string", description: "Restrict to one project id." },
        mode: { type: "string", enum: ["broad", "exact"], description: "broad = OR terms; exact = phrase/substring." },
      },
      additionalProperties: false,
    },
    options: { namespace: "oum", codemode: true as const },

    execute: async (input: SearchInput, context: ToolCallContext) => {
      await deps.permission({
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
        action: "session-search",
        resources: ["opencode-history"],
      })

      const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
      const host = deps.host()
      if (!host) return { content: "OpenCode's session database is unavailable; nothing to search." }

      if (input.session_id) {
        const meta = sessionMeta(db, input.session_id)
        const rows = readSession(db, host, input.session_id, {
          limit,
          aroundMessageID: input.around_message_id,
          maxChars: maxChars(),
        })
        if (!rows.length) return { content: `Session ${input.session_id} is not indexed yet.` }
        const lines = [
          `Session ${input.session_id}${meta?.title ? ` "${meta.title}"` : ""} (${rows.length} message(s))`,
          "",
          ...rows.map((row) => {
            const role = row.role === "tool" && row.toolName ? `tool:${row.toolName}` : row.role
            const body = input.detail === "full" ? row.text : row.text.replace(/\s+/g, " ").slice(0, 400)
            return `[${when(row.created)}] ${role}: ${body}`
          }),
        ]
        return { content: lines.join("\n") }
      }

      if (!input.query) {
        const sessions = recentSessions(db, { limit, includeChildren: input.include_children, project: input.project })
        if (!sessions.length) return { content: "No sessions indexed yet." }
        return {
          content: [
            `Recent sessions (${sessions.length}):`,
            "",
            ...sessions.map(
              (session) =>
                `- ${when(session.updated)} ${session.id}${session.title ? ` "${session.title}"` : ""} (${session.directory})`,
            ),
          ].join("\n"),
        }
      }

      const stale = doSync(host)
      let hits: Hit[] = search(db, input.query, {
        limit,
        mode: input.mode ?? "broad",
        includeChildren: input.include_children,
        project: input.project,
        trigram: config.search.trigram,
      })

      if (!hits.length || stale) {
        const fallback = searchHost(host, input.query, {
          limit,
          includeChildren: input.include_children,
          project: input.project,
        })
        const seen = new Set(hits.map((hit) => hit.id))
        hits = hits.concat(fallback.filter((hit) => !seen.has(hit.id))).slice(0, limit)
        if (fallback.length) log.debug("search fallback", { used: fallback.length, stale })
      }

      return { content: formatDiscovery(input.query, hydrate(db, host, hits, input.query, maxChars()), stale) }
    },
  }
}

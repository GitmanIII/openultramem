/**
 * Transcript builder for the learn module.
 *
 * The engine gets text, not tools: reasoning is stripped, tool output is
 * bounded, and recall notes are excluded. When over budget the oldest content
 * is dropped, because recent turns carry the decision.
 */
import type { Database } from "bun:sqlite"

export interface Transcript {
  text: string
  messages: number
  chars: number
  truncated: boolean
  turns: number
  toolCalls: number
}

const RECALL_NOTE = /^\s*<(provider-memory|oum-memory|oum[-_])/i

interface Row {
  type: string
  seq: number
  time_created: number
  data: string
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function toolLine(block: Record<string, unknown>, max: number): string {
  const state = (block.state ?? {}) as Record<string, unknown>
  const name = typeof block.name === "string" ? block.name : "tool"
  const input = state.input === undefined ? "" : JSON.stringify(state.input)
  let output = ""
  if (typeof state.output === "string") output = state.output
  else if (Array.isArray(state.content)) {
    output = state.content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("\n")
  }
  return `tool:${name}(${clip(input, max)}) → ${clip(output, max)}`
}

/** Render one host message as transcript lines. */
export function renderMessage(type: string, raw: string, maxChars: number): string[] {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return []
  }

  if (type === "user") {
    const text = typeof data.text === "string" ? data.text.trim() : ""
    return text ? [`USER: ${text}`] : []
  }

  if (type === "synthetic") {
    const text = typeof data.text === "string" ? data.text.trim() : ""
    if (!text || RECALL_NOTE.test(text)) return []
    return [`NOTE: ${clip(text, maxChars)}`]
  }

  if (type === "assistant") {
    const lines: string[] = []
    for (const raw of Array.isArray(data.content) ? data.content : []) {
      if (!raw || typeof raw !== "object") continue
      const block = raw as Record<string, unknown>
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        lines.push(`ASSISTANT: ${block.text.trim()}`)
      } else if (block.type === "tool") {
        lines.push(`  ${toolLine(block, Math.min(400, Math.floor(maxChars / 8)))}`)
      }
      // reasoning is deliberately dropped
    }
    return lines
  }

  return []
}

export function buildTranscript(host: Database, sessionID: string, maxChars: number): Transcript {
  const rows = host
    .query("SELECT type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY time_created, seq")
    .all(sessionID) as Row[]

  const lines: string[] = []
  let turns = 0
  let toolCalls = 0
  let messages = 0

  for (const row of rows) {
    const rendered = renderMessage(row.type, row.data, maxChars)
    if (!rendered.length) continue
    messages++
    if (row.type === "user") turns++
    for (const line of rendered) {
      if (line.startsWith("  tool:")) toolCalls++
      lines.push(line)
    }
  }

  let text = lines.join("\n")
  let truncated = false
  if (text.length > maxChars) {
    // Keep whole newest lines; only the single newest line may be cut.
    const marker = "[… earlier turns omitted]\n"
    const budget = Math.max(1, maxChars - marker.length)
    const kept: string[] = []
    let used = 0
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!
      const cost = line.length + (kept.length ? 1 : 0)
      if (used + cost > budget) {
        if (!kept.length) kept.unshift(line.slice(0, budget))
        break
      }
      kept.unshift(line)
      used += cost
    }
    text = marker + kept.join("\n")
    truncated = true
  }

  return { text, messages, chars: text.length, truncated, turns, toolCalls }
}

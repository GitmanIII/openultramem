import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HOST_DDL } from "./fixture.ts"
import { buildTranscript, renderMessage } from "../src/learn/transcript.ts"

function host(messages: { id: string; type: string; seq: number; time: number; data: unknown }[]): Database {
  const path = join(mkdtempSync(join(tmpdir(), "oum-transcript-")), "opencode.db")
  const db = new Database(path, { create: true })
  db.exec(HOST_DDL)
  db.run(
    "INSERT INTO session_v2(id, project_id, parent_id, directory, title, model, time_created, time_updated) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
    ["ses_t", "project", "/work", "Test", "test/model", 1, 2],
  )
  const insert = db.query("INSERT INTO session_message(id, session_id, type, seq, time_created, data) VALUES (?, 'ses_t', ?, ?, ?, ?)")
  for (const message of messages) insert.run(message.id, message.type, message.seq, message.time, JSON.stringify(message.data))
  return db
}

describe("renderMessage", () => {
  test("keeps user and assistant text, drops reasoning", () => {
    expect(renderMessage("user", JSON.stringify({ text: "hello" }), 8000)).toEqual(["USER: hello"])
    const assistant = renderMessage(
      "assistant",
      JSON.stringify({
        content: [
          { type: "reasoning", text: "secret thinking" },
          { type: "text", text: "visible answer" },
        ],
      }),
      8000,
    )
    expect(assistant).toEqual(["ASSISTANT: visible answer"])
    expect(assistant.join("\n")).not.toContain("secret thinking")
  })

  test("renders tool blocks with bounded input and output", () => {
    const line = renderMessage(
      "assistant",
      JSON.stringify({
        content: [{ type: "tool", name: "shell", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "files" }] } }],
      }),
      8000,
    )
    expect(line[0]).toContain("tool:shell")
    expect(line[0]).toContain("files")
  })

  test("skips recall notes and system messages", () => {
    expect(renderMessage("synthetic", JSON.stringify({ text: '<provider-memory source="embeddings">x</provider-memory>' }), 8000)).toEqual([])
    expect(renderMessage("synthetic", JSON.stringify({ text: "compaction summary" }), 8000)).toEqual(["NOTE: compaction summary"])
    expect(renderMessage("system", JSON.stringify({ text: "instructions" }), 8000)).toEqual([])
    expect(renderMessage("idle", JSON.stringify({}), 8000)).toEqual([])
  })

  test("survives malformed JSON", () => {
    expect(renderMessage("user", "{not json", 8000)).toEqual([])
  })
})

describe("buildTranscript", () => {
  test("counts turns and tool calls and keeps order", () => {
    const db = host([
      { id: "m1", type: "user", seq: 1, time: 10, data: { text: "first question" } },
      {
        id: "m2",
        type: "assistant",
        seq: 2,
        time: 20,
        data: { content: [{ type: "text", text: "answer" }, { type: "tool", name: "grep", state: { input: { pattern: "x" }, content: [{ type: "text", text: "y" }] } }] },
      },
      { id: "m3", type: "user", seq: 3, time: 30, data: { text: "second question" } },
    ])

    const transcript = buildTranscript(db, "ses_t", 8000)
    expect(transcript.turns).toBe(2)
    expect(transcript.toolCalls).toBe(1)
    expect(transcript.text.indexOf("first question")).toBeLessThan(transcript.text.indexOf("second question"))
    expect(transcript.truncated).toBe(false)
  })

  test("over budget keeps the newest content and marks truncation", () => {
    const db = host([
      { id: "m1", type: "user", seq: 1, time: 10, data: { text: "OLD-" + "a".repeat(500) } },
      { id: "m2", type: "user", seq: 2, time: 20, data: { text: "NEWEST-" + "b".repeat(500) } },
    ])
    const transcript = buildTranscript(db, "ses_t", 300)
    expect(transcript.truncated).toBe(true)
    expect(transcript.text).toContain("earlier turns omitted")
    expect(transcript.text).toContain("NEWEST-")
    expect(transcript.chars).toBeLessThanOrEqual(300)
  })

  test("an empty session produces an empty transcript", () => {
    const db = host([])
    const transcript = buildTranscript(db, "ses_t", 8000)
    expect(transcript.text).toBe("")
    expect(transcript.turns).toBe(0)
  })
})

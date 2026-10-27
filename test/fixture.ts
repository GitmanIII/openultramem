/**
 * Synthetic OpenCode V2 host database: the subset of columns OUM reads.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const HOST_DDL = `
CREATE TABLE session_v2(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  directory TEXT NOT NULL,
  title TEXT,
  model TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE TABLE session_message(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX session_message_time_created_idx ON session_message(time_created);
`

export interface Fixture {
  dir: string
  hostPath: string
  statePath: string
  sessions: string[]
  childSession: string
}

const WORDS = [
  "the", "build", "test", "memory", "session", "index", "search", "plugin", "hook", "database",
  "config", "schema", "token", "worker", "queue", "retry", "cache", "stream", "event", "file",
]

function sentence(seed: number, count = 12): string {
  const parts: string[] = []
  for (let i = 0; i < count; i++) parts.push(WORDS[(seed * 31 + i * 17) % WORDS.length]!)
  return parts.join(" ")
}

export function buildFixture(total = 10_000, sessionsCount = 5): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "oum-fixture-"))
  const hostPath = join(dir, "opencode.db")
  const statePath = join(dir, "state.db")
  const db = new Database(hostPath, { create: true })
  db.exec(HOST_DDL)

  const sessions: string[] = []
  const insertSession = db.query(
    "INSERT INTO session_v2(id, project_id, parent_id, directory, title, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const insertMessage = db.query(
    "INSERT INTO session_message(id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)",
  )

  let clock = 1_700_000_000_000
  const perSession = Math.ceil(total / sessionsCount)

  const write = db.transaction(() => {
    for (let s = 0; s < sessionsCount; s++) {
      const id = `ses_fixture${s.toString().padStart(4, "0")}`
      sessions.push(id)
      insertSession.run(id, `project-${s % 2}`, null, `/work/project-${s % 2}`, `Session ${s}`, "test/model", clock, clock)
    }

    const child = "ses_fixturechild0001"
    sessions.push(child)
    insertSession.run(child, "project-0", sessions[0]!, "/work/project-0", "Child session", "test/model", clock, clock)

    let seq = 0
    for (let s = 0; s < sessionsCount; s++) {
      const sessionID = sessions[s]!
      for (let i = 0; i < perSession; i++) {
        clock += 1000
        seq++
        const messageID = `msg_${s}_${i}`
        if (i % 5 === 0) {
          insertMessage.run(
            messageID,
            sessionID,
            "user",
            seq,
            clock,
            JSON.stringify({ time: { created: clock }, text: `${sentence(i)} question ${i}`, files: [] }),
          )
        } else {
          insertMessage.run(
            messageID,
            sessionID,
            "assistant",
            seq,
            clock,
            JSON.stringify({
              time: { created: clock },
              agent: "build",
              model: { id: "test/model", providerID: "test" },
              content: [
                { type: "reasoning", text: "hidden reasoning should never be indexed" },
                { type: "text", text: `${sentence(i + 3)} answer ${i}` },
                {
                  type: "tool",
                  id: `call_${s}_${i}`,
                  name: "shell",
                  state: { status: "completed", input: { command: `echo ${i}` }, content: [{ type: "text", text: `output ${i}` }] },
                  time: { created: clock },
                },
              ],
            }),
          )
        }
      }
    }

    // Landmarks for search assertions.
    clock += 1000
    insertMessage.run("msg_landmark_word", sessions[0]!, "user", 99_001, clock, JSON.stringify({ text: "the sphinx guards the quartzite gate" }))
    clock += 1000
    insertMessage.run("msg_landmark_tool", sessions[1]!, "assistant", 99_002, clock, JSON.stringify({
      content: [{ type: "tool", id: "call_landmark", name: "grep", state: { status: "completed", input: { pattern: "nebula" }, content: [{ type: "text", text: "nebula found in config" }] } }],
    }))
    clock += 1000
    insertMessage.run("msg_child_only", child, "user", 99_003, clock, JSON.stringify({ text: "subagent only zebra marker" }))
    // A recall note must never be indexed as memory evidence.
    clock += 1000
    insertMessage.run("msg_recall_note", sessions[2]!, "synthetic", 99_004, clock, JSON.stringify({ text: '<provider-memory source="embeddings">quartzite notes</provider-memory>' }))
    // system/idle must be skipped.
    clock += 1000
    insertMessage.run("msg_system", sessions[0]!, "system", 99_005, clock, JSON.stringify({ text: "system instruction quartzite" }))
  })

  write()
  db.close()

  return { dir, hostPath, statePath, sessions, childSession: "ses_fixturechild0001" }
}

# Pre-build verification — 2026-10-27

Answers to the four unknowns in [BUILD.md](BUILD.md), measured on **OpenCode
2.2.0** (Bun-shipped binary) with `@opencode/plugin` **2.2.0**. Probe: a throwaway
Promise plugin registered a namespaced Code Mode tool, subscribed to the event
stream, and called `ctx.experimental.generate.text`; a `opencode run` session then
invoked the tool. Probe removed after the run.

## 1. `session.execution.*` delivery

Exist and are delivered live:

```
session.execution.started    {"sessionID":"ses_e810..."}
session.execution.succeeded  {"sessionID":"ses_e810..."}
```

- The event catalog also carries `session.compaction.started|delta|ended|failed`,
  `session.tool.called|success|failed`, `session.step.*`, `session.idle`.
- Envelope is `durability: "durable"` with `aggregateID` and `seq`.
- **But there is no replay.** `event_sequence` tracks per-session sequence numbers
  (up to 706), while the `event` table holds only five legacy rows and zero
  execution events. Durable events are not retained host-side, so a missed event
  cannot be recovered by seq.
- Consequence: the **next-prompt fallback is mandatory**, exactly as designed.
  Do not build a replay reader; there is nothing to replay.

## 2. `ctx.tool.transform` + namespace + `codemode: true`

Works as designed.

```
tool.list: 25 tools, ours = [{"id":"oumprobe_echo","options":{"namespace":"oumprobe","codemode":true}}]
```

The model was given `tools.oumprobe.echo({ text: "hello" })` and called it through
Code Mode (`session.tool.called` shows the JS source, `executed: false`). Effective
ID is `namespace_name`; the namespace description and per-tool `options` survive.

## 3. `generate.text` with a pinned model

Works, and fails visibly.

```
generate.ok       {"ms":1250,"text":"PROBE-OK"}          # opencode-go/deepseek-v4.1-flash
generate.badmodel {"message":"Model not found: opencode-go/does-not-exist-probe"}
```

`ctx.generate.text` still exists but is deprecated in favour of
`ctx.experimental.generate.text({ model: { providerID, id }, prompt })`.

## 4. Read-only attach of the live WAL `opencode.db`

Works. `sqlite3 "file:...opencode.db?mode=ro"` read schema and rows while the
service was writing, and `bun:sqlite` `new Database(path, { readonly: true })` is
already used in production by `opencode-hermes` against the same file.

Host schema matches the design:

```
session_v2(id, project_id, parent_id, directory, title, model, time_created, time_updated, ...)
session_message(id, session_id, type, seq, time_created, data)   -- 7,051 rows
types: assistant 5472, user 767, synthetic 409, idle 265, location-switched 74, system 64
```

## Runtime facts

- Plugins execute inside the Bun binary, so `bun:sqlite` is available to the plugin
  itself. Local `bun` 1.4.2 is installed for tests.
- `ctx.options`, `ctx.location.{directory,project.id}` are available in `setup`.
- `session.hook("context", event)` gives `sessionID`, `agent`, `model`, mutable
  `system[]`, `tools`, `messages`, and `options` on every model call. This is the
  injection point for the frozen memory snapshot.
- V2 event names use dots; subscribe with `{ types: [...] }`.

## Still unmeasured

- Event **miss rate** in ordinary use (needs a live correlation over days, not a
  single probe). The fallback covers it; the event log makes the rate measurable.

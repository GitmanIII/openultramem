# Changelog

Semantic versioning. Tags are annotated (`v0.1.0`) and always match
`package.json` and `src/version.ts`.

## 0.4.0 — 2026-10-27

Migration, and the end of `opencode-hermes` on this machine.

- **`scripts/migrate.ts`** — dry-run inspection and `--apply` copy of canonical
  memory. Additive by policy: it refuses a non-empty target unless `--force`,
  backs the target up first, and verifies entry counts after copying.
- **`src/migrate.ts`** — the reusable plan/apply/verify logic behind it, with
  conflict detection between source and target.
- **Live migration** — memory consolidated from 2,184 to 1,892 chars (11 entries,
  308 headroom), `POLICY.md` written, `opencode.jsonc` switched from
  `opencode-hermes` to `openultramem`, and every check in `docs/MIGRATION.md`
  verified on a private server.
- **Documented operational detail** — the running service caches its plugin set,
  so `opencode service restart` is required for sessions that were open during
  the switch; new locations load OUM immediately.

## 0.3.0 — 2026-10-27

Procedural memory: OUM can author skills in OpenCode's own roots.

- **`oum_skill_manage`** — `create`, `patch`, `write_file`, `remove_file`,
  `delete`, `promote`, `fork`, with guards: kebab-case ids, a description budget,
  path safety (no `..`, no absolute paths, no symlink escape), and size limits.
- **Provenance** — `metadata.oum` records origin (`self`/`user`/`fork`/`compat`),
  scope, created/updated dates, pinning, and `promoted_from`. Files without it
  are treated as user-authored and left alone unless `skills.editUserSkills`.
- **Read-before-write** — `patch` and `delete` require `base_hash`. When it is
  missing the tool returns the current body and sha; the hash is the same one
  discovery reports, so it stays valid across calls and sessions.
- **Nothing is destroyed** — edits back up the skill directory, deletes move it
  to `skill-archive/`, and every mutation appends to `skills-ledger.jsonl`.
- **Promote and fork** — promote moves a project skill to the global library and
  records where it came from; fork copies a global skill into the project so
  project precedence wins locally. Learn plans may never promote.
- **Learn integration** — candidates now arrive with scope, sha, and body, so the
  engine can patch an umbrella precisely; `promote` remains an explicit action.
- **Dedupe index** — a `skills` table plus FTS in `state.db` surfaces near
  duplicates before a create, and is never exposed as a tool.

Known limitation: `globalRoot` must be a root OpenCode natively discovers
(`~/.agents/skills` by default). Pointing it elsewhere keeps the skill out of
`/skills` until it is promoted or the root is discovered.

## 0.2.0 — 2026-10-27

The learning loop: OUM now writes memory instead of waiting to be asked.

- **Learn module** — trigger accounting on user turns and tool calls, a per-session
  throttle, one in-flight run with a reasoned dirty bit, and turn-end boundaries
  from `session.execution.*`. A missed execution event is caught by the next
  prompt (the mandatory fallback).
- **Structured plans** — one pinned-model completion returns strict JSON
  (`memory`, `curation`, `skills`), validated field by field with one corrective
  retry. The engine never writes; the host applies.
- **Policy precedence** — `POLICY.md` is an input and outranks the transcript, so
  a mid-conversation decision cannot be encoded over a standing rule.
- **Curation** — `supersede`, `merge`, and `archive`/`demote` map onto memory
  edits; `promote` is refused until note scopes exist.
- **Idempotency** — every applied operation is hashed into `state.db`, so a
  retried run cannot duplicate a fact.
- **Observability** — `learn-events.jsonl` records every trigger decision with a
  reason and every run with model, counts, duration, and errors; `bun run
  scripts/summary.ts` prints the weekly shape.
- **`/oum-reflect`** — a command that forces a review, bypassing counters and
  throttle but never the in-flight guard.

## 0.1.0 — 2026-10-27

First release: the two halves of memory that do not need a model.

- **Session recall** — disposable `state.db` index over OpenCode's own V2 history.
  Contentless word + trigram FTS5, reciprocal rank fusion, bodies hydrated from
  the host read-only. `oum_session_search` covers discovery, scroll, read, and
  browse; search falls back to a bounded `LIKE` when the index is stale.
- **Canonical memory** — bounded `MEMORY.md`/`USER.md` with `§` entries, atomic
  writes, a lock file, and per-entry budget refusals instead of silent
  truncation. `oum_memory` supports add, replace, remove, and atomic batch.
- **Frozen snapshot** — the memory block is read once per session and reused for
  every request, so a mid-session write cannot change the prompt under the model.
- **First-run migration** — copies `MEMORY.md`/`USER.md` from `opencode-hermes`
  when the OUM roots are empty; never overwrites.
- **Coexistence guard** — warns and skips injection while `opencode-hermes` is
  active, unless `coexistence: true`.
- **Verification** — the four OpenCode 2.2.0 unknowns are measured and recorded
  in `docs/VERIFICATION.md`; 38 tests plus a 10k-message benchmark (query p95
  15 ms against a 50 ms budget).

Not in this release: the learn module (M3), skills (M4), and migration
completion (M5).

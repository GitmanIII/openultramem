# Changelog

Semantic versioning. Tags are annotated (`v0.1.0`) and always match
`package.json` and `src/version.ts`.

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

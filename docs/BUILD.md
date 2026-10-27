# Build kickoff

Status: design locked. Start here on the first implementation session.

Read order: [DESIGN.md](DESIGN.md) → [SCHEMA.md](SCHEMA.md) →
[SKILLS.md](SKILLS.md) → [MIGRATION.md](MIGRATION.md).

## Before coding

1. Update OpenCode and record the exact version.
2. Verify the four unknowns with a throwaway probe plugin or a clean-room
   `opencode acp` run:
   - `session.execution.*` delivery and miss rate;
   - `ctx.tool.transform` + namespace + `codemode: true` catalog;
   - `generate.text` with a pinned model;
   - read-only attach of a live WAL `opencode.db`.
3. Initialize git and commit the docs:
   `git init -b main && git add . && git commit -m "docs: lock OUM design"`.

## Milestone 1 — retrieval core

- Scaffold `package.json`, `tsconfig.json`, `src/{config,paths,log}.ts`.
- `src/recall/{db,schema,ingest,search,hydrate,tool}.ts`.
- V2 ingest only: `session_v2` + `session_message`.
- Dual contentless FTS5: word + trigram; RRF merge; hydrate from the host DB.
- `oum_session_search` with discovery / scroll / read / browse.
- Test fixture: build a small `opencode.db` with V2 schema and synthetic
  messages.
- Tests: idempotent re-ingest, watermark overlap, FTS+trigram fusion, hydrate,
  LIKE fallback, no host writes.

Acceptance: 10k-message fixture, query under 50 ms, idempotent re-ingest, host
database opened read-only.

## Non-negotiables

- Host database is read-only; `state.db` is disposable.
- No V1 adapter, no V1 session ingest.
- Three namespaced Code Mode tools: `oum_memory`, `oum_session_search`,
  `oum_skill_manage`.
- Every learn trigger and run is logged with a reason.
- No changes to native tools, prompts, models, compaction, or skills discovery.

## Open questions

- Execution-event miss rate on the target V2.
- Package name: `openultramem` or `@gitmaniii/openultramem`.
- Whether to publish to npm in Milestone 5.

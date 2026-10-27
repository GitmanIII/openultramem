# Migrating from `opencode-hermes`

Status: design. The old plugin stays intact until OUM passes Milestone 5.

## Preconditions

1. Update OpenCode to the target V2 release.
2. Verify the four unknowns from the design:
   - `session.execution.*` delivery and miss rate;
   - `ctx.tool.transform` + namespace + `codemode: true` catalog;
   - `generate.text` model pinning;
   - read-only attach of a live WAL `opencode.db`.
3. Back up:
   - `~/.config/opencode/memories/`
   - `~/.agents/skills/`
   - `~/.config/opencode/opencode.jsonc`

## Steps

### 1. Import canonical memory

Copy `MEMORY.md` and `USER.md` from `~/.config/opencode/memories/` to
`~/.config/opencode/oum/`. The format is identical (`§` entries, same caps).
Do not copy provider state or the old embeddings database.

### 2. Skills

No move. Both plugins use `~/.agents/skills`. OUM reads the existing library and
indexes it for dedupe; it does not rewrite user-authored skills.

### 3. Coexistence

Do not run both memory plugins at once. Two plugins would inject two memory
blocks and write to the same files.

- Disable `opencode-hermes` in `opencode.jsonc`.
- Enable `openultramem`.
- Restart the background service (`opencode service restart`).
- OUM refuses to inject if it detects `opencode-hermes` in the active plugin
  list, unless `coexistence: true`.

### 4. State

OUM indexes V2 sessions only. There is no V1 backfill. Old V1 history remains in
the host database but is not searchable through OUM.

### 5. Verify

- `MEMORY.md` and `USER.md` blocks appear once in a new session.
- `oum_session_search` returns a known recent message.
- `oum_memory` add/replace/remove works and respects caps.
- `oum_skill_manage` creates and patches a skill; it appears in `/skills` and
  loads via the native `skill` tool.
- A forced learn run logs a trigger and a run record in `learn-events.jsonl`.
- No learn run happens without a logged reason.

## Rollback

- Disable `openultramem`.
- Re-enable `opencode-hermes`.
- Restart the service.
- The old files are untouched; only OUM's new data root (`~/.config/opencode/oum`,
  `~/.local/share/opencode/oum`) needs removal if a clean rollback is wanted.

## Non-goals

- Importing the old embeddings store.
- Rewriting existing skills.
- Migrating V1 session history.

# Migrating from `opencode-hermes`

Status: **completed 2026-10-27** on OpenCode 2.2.0. This document stays as the
record and the rollback plan.

## What was done

1. Backed up `~/.config/opencode/memories`, `~/.agents/skills`, `opencode.jsonc`,
   and the OUM root to `~/.config/opencode/backups/oum-migration-<timestamp>`.
2. Consolidated `MEMORY.md` from 2,184 to 1,892 chars (11 entries, 308 headroom)
   without dropping a fact; copied the result to both roots so a rollback is
   consistent.
3. Wrote `~/.config/opencode/oum/POLICY.md` (memory scope, skill scope, version
   and migration rules, coexistence).
4. Ran `bun run scripts/migrate.ts --apply --force`. It copied `MEMORY.md` and
   `USER.md`, verified entry counts after the copy, and backed up the target.
5. Replaced the `opencode-hermes` plugin entry with `openultramem` in
   `opencode.jsonc`; `opencode-jev` was left untouched.
6. Verified on a fresh server (`opencode run --standalone`): one memory block
   (86% / 94%), all three OUM tools, session search hits, memory add/remove back
   to baseline, a skill created → loaded by the native `skill` tool → archived,
   and a learn trigger and run in `learn-events.jsonl`.

## Verification results

| Check | Result |
|---|---|
| MEMORY/USER blocks appear once | 86% (1,892/2,200) and 94% (1,287/1,375) |
| `oum_session_search` | returned historical sessions for "PigeonHater calibration margin histogram" |
| `oum_memory` add/replace/remove | add applied, remove applied, usage returned to baseline |
| `oum_skill_manage` create/patch | created in `~/.agents/skills`, loaded by native `skill`, deleted to `skill-archive/` |
| Learn trigger and run | `due:tools` at 10 tool calls; run recorded with notes and confidence |
| No unreasoned learn run | every row in `learn-events.jsonl` carries a reason |

## Remaining step

The running service caches the plugin set, so the TUI keeps the old set until:

```sh
opencode service restart
```

New locations already load OUM (verified with a private server), so the restart
only refreshes sessions that were open during the switch.

## Preconditions (historical)

1. Update OpenCode to the target V2 release.
2. Verify the four unknowns from the design.
3. Back up:
   - `~/.config/opencode/memories/`
   - `~/.agents/skills/`
   - `~/.config/opencode/opencode.jsonc`

## Import canonical memory

`bun run scripts/migrate.ts` (dry run) and `--apply` (copy). Additive: it refuses
a non-empty target unless `--force`, backs up first, and verifies entries.

## Skills

No move. Both plugins use `~/.agents/skills`. OUM reads the existing library and
indexes it for dedupe; it does not rewrite user-authored skills.

## Coexistence

Do not run both memory plugins at once. Two plugins would inject two memory
blocks and write to the same files.

- Disable `opencode-hermes` in `opencode.jsonc`.
- Enable `openultramem`.
- Restart the background service (`opencode service restart`).
- OUM refuses to inject if it detects `opencode-hermes` in the active plugin
  list, unless `coexistence: true`.

## State

OUM indexes V2 sessions only. There is no V1 backfill. Old V1 history remains in
the host database but is not searchable through OUM.

## Rollback

- Disable `openultramem`.
- Re-enable `opencode-hermes`.
- Restart the service.
- The old files are untouched; only OUM's new data root needs removal for a clean
  rollback. The backup directory holds the pre-migration state.

## Non-goals

- Importing the old embeddings store.
- Rewriting existing skills.
- Migrating V1 session history.

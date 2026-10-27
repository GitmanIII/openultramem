# Skills in OUM

Status: design. Not implemented.

OpenCode owns discovery, the `/skills` picker, and the `skill` loader. OUM owns
authoring and curation only. It never implements a library, picker, viewer, or
loader.

## Ownership

| Concern | Owner |
|---|---|
| Discover skills | OpenCode (`ctx.skill.list()`, `/api/skill`) |
| Show/select in the TUI | OpenCode `/skills` |
| Load a skill body | OpenCode `skill` tool |
| Create/patch a skill | OUM `oum_skill_manage` |
| Decide what to create | OUM learn module |
| Dedupe and candidate selection | OUM internal index |
| Provenance and audit | OUM frontmatter + ledger |

## Roots

| Scope | Path | OUM writes |
|---|---|---|
| global | `~/.agents/skills` | promote / global create |
| project | `<project>/.opencode/skills` | project create / fork |
| native global | `~/.config/opencode/skills` | no (left to the user) |
| compat | `.claude/skills`, project `.agents/skills` | no |

`.agents/skills` is the canonical global library because that is where the
existing library lives and it is portable across agents. Configurable via
`skills.globalRoot`.

## Advertised, not loaded

OpenCode advertises only ID, name, and description. A body loads only when the
model calls `skill` or the user picks it via `/skills`. OUM does not hide skills
by default. `metadata.opencode/autoinvoke: false` is an explicit opt-in.

Descriptions are the retrieval key. OUM enforces
`skills.descriptionBudget` (default 200 chars) and requires a specific,
action-oriented description.

## Layout

```text
<root>/[category/]<id>/SKILL.md
<root>/[category/]<id>/references/<topic>.md
<root>/[category/]<id>/templates/<name>.<ext>
<root>/[category/]<id>/scripts/<name>.<ext>
```

- Directory form only.
- IDs are lowercase kebab-case, 1–64 chars, matching the directory.
- No state, ledgers, backups, temp files, or hidden directories inside the
  library. Those live under `<dataRoot>`:
  - `state.db`
  - `skills-ledger.jsonl`
  - `skill-backups/<hash>/`
  - `skill-archive/`

## Frontmatter

```yaml
---
name: Git Release
description: Prepare release notes, version bumps, and GitHub releases
metadata:
  oum:
    origin: self | user | fork | compat
    scope: global | project
    created: 2026-10-21
    updated: 2026-10-21
    pinned: false
    promoted_from: <project id or path>
---
```

OpenCode ignores `metadata.oum`. `origin: user` skills are never patched by the
learn module unless `skills.editUserSkills` is true.

## Actions

`oum_skill_manage`:

- `create`
- `patch`
- `write_file`
- `remove_file`
- `delete` (archives)
- `promote`
- `fork`

Guards:

- Read-before-write for patch/delete.
- Path safety: no `..`, no absolute paths, no symlink escape.
- Duplicate name refusal.
- Size and frontmatter validation.
- Description budget.
- Ledger append.
- `ctx.skill.reload()` after every mutation.
- Collision with a higher-precedence source is refused, not overwritten.

## Promote and fork

- `promote`: move `<project>/.opencode/skills/<id>` to the global root. Refuse if
  the ID exists globally (offer patch). Detect a project-local duplicate and
  explain precedence. Record `promoted_from` and `promoted_at`.
- `fork`: copy a global skill into the current project, mark `origin: fork`.
  Project precedence makes the fork win locally.

## Scope policy

- Project-specific procedure → project root.
- Portable class-level technique → global root.
- Ambiguous → project root; promote later on demand.
- The learn module never promotes silently.

## Learn module interactions

- The learn module receives candidate skill bodies as **input**. It does not get
  a read tool.
- It may patch `origin: self` and `origin: fork` skills by default.
- It creates class-level umbrellas, never session-artifact names.
- It must honor `POLICY.md` over the transcript.
- A changed decision must supersede or patch the old skill; contradictory
  guidance is a bug.

## Clean-library rules

- Dedupe before create; patch an existing umbrella instead of adding a near
  duplicate.
- Keep global skills portable; no project paths or secrets.
- Descriptions are short and specific; bodies can be rich.
- Archive, don't hard-delete, user-authored skills.

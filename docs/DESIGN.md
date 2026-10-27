# OpenUltraMem (OUM) — Design

Status: design locked 2026-10-21. Not implemented.
Target: OpenCode V2 only. V1 is out of scope.

## 1. What it is

A V2-native memory system for OpenCode with three parts:

1. **Canonical memory** — bounded `MEMORY.md` + `USER.md`, injected as a frozen
   per-session snapshot.
2. **Session recall** — a disposable `state.db` index over OpenCode's own
   session history, with ranked full-text search.
3. **Procedural memory** — learn-driven skill authoring into OpenCode's native
   skill roots, with provenance, dedupe, and promotion.

The source of truth is always OpenCode's database and the Markdown files. Every
OUM index is derived, disposable, and rebuildable.

## 2. Non-goals

- Embeddings / vector recall in v1.
- A model-powered controller backend in v1 (interface only; see Appendix A).
- V1 session history or the V1 plugin API.
- Cross-tool (non-OpenCode) history.
- A parallel skill registry, picker, or loader.
- Cloud sync, GUI, or a daemon.

## 3. Canonical memory

- Files: `<memoryRoot>/MEMORY.md` (2,200 chars) and `<memoryRoot>/USER.md`
  (1,375 chars). Entries joined by `\n§\n`, same format as Hermes.
- `<memoryRoot>/POLICY.md`: user-owned design decisions and scope rules, read by
  the learn module. It is not injected into the session; it exists so the writer
  does not encode stale intermediate decisions.
- `memoryRoot` defaults to `~/.config/opencode/oum`. A migration copies the old
  `~/.config/opencode/memories` files on first run if the new root is empty.
- **Frozen snapshot:** at `session.created`, read both files and cache the
  rendered block by session ID. The `context` hook appends that exact text on
  every model request for the session. Mid-session file edits hit disk but do not
  change the prompt. Evict on `session.deleted`.
- **Tool:** `oum_memory` with `add`, `replace`, `remove`, `batch`.
  - `add` refuses when the target is over budget and returns per-entry sizes plus
    a consolidation instruction.
  - `replace` and `remove` match `old_text` exactly once.
  - Batch operations apply atomically.
- **Writes:** temp file + fsync + rename, guarded by a lock file. A write that
  observes an external change re-reads and re-plans before applying.
- **Validation:** reject entries containing the `§` delimiter, empty entries, and
  content matching the prompt-injection scanner.
- No `demote`, no vector mirror. If a fact matters it belongs in the file; if it
  does not, session search finds the transcript.

## 4. Session recall

### 4.1 Store

`state.db` at `<dataRoot>/state.db`, WAL, `synchronous=NORMAL`,
`busy_timeout=5000`. `dataRoot` defaults to `~/.local/share/opencode/oum`.

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE sessions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  directory TEXT NOT NULL,
  title TEXT,
  parent_id TEXT,
  model TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE messages(
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,          -- user | assistant | tool | synthetic
  created INTEGER NOT NULL,
  tool_name TEXT,
  chars INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);

-- Word index: BM25 and phrase precision. Contentless: tokens only.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

-- Substring index: literal matching and high recall. Contentless: tokens only.
CREATE VIRTUAL TABLE messages_fts_tri USING fts5(
  text,
  content='', contentless_delete=1,
  tokenize='trigram'
);

CREATE INDEX messages_session_seq ON messages(session_id, seq);
CREATE INDEX messages_created ON messages(created);
```

The indexes are contentless. Full message bodies are hydrated from
`opencode.db` by message ID. Deleting `state.db` loses no history.

### 4.2 Ingest

V2 only: `session_v2` + `session_message`.

- `user` → `data.text`.
- `assistant` → text blocks; tool blocks become role `tool` rows with the tool
  name and a bounded prefix of input/output. Reasoning blocks are skipped.
- `synthetic` → include unless it is an OUM/provider recall note; compaction
  summaries are included as `synthetic`.
- `system`, `idle`, `location-switched` → skipped.
- `session_v2.parent_id` children are `hidden = 1`; searchable only with
  `include_children: true`.

Watermark: `(time_created, id)` in `meta`. Every sync re-scans a 60-second
overlap window; upserts are idempotent by message ID. Each message upsert
deletes and reinserts its FTS rows by `rid` in the same transaction.

Deletions: purge on `session.deleted` and on a full reconcile pass. A reconcile
compares mirror session IDs against the host.

Sync is bounded (`search.syncBudgetMs`, default 250 ms). If it fails or exceeds
the budget, search proceeds on the existing index and reports `stale: true`.

### 4.3 Search

1. Sync (bounded).
2. Word FTS and trigram FTS in parallel, top 50 each.
3. Reciprocal rank fusion (`k = 60`), dedupe by message ID, recency tiebreak.
4. Hydrate top hits from `opencode.db`; build snippets around the match.
5. Fallback to a bounded `LIKE` query over extracted host text if both indexes
   are empty or stale.

Modes: `broad` (OR terms, default), `exact` (phrase / substring).

### 4.4 Tool

`oum_session_search` keeps the Hermes shape:

- `query` → discovery.
- `session_id` + `around_message_id` → scroll.
- `session_id` alone → read.
- no args → browse.

Extra fields: `limit`, `detail` (`summary` | `full`), `include_children`,
`project`. Results include session ID, title, directory, time, matched role,
message ID, snippet, and a `@session/local/<id>` link.

## 5. Skills

OpenCode owns discovery, the `/skills` picker, and the `skill` loader. OUM owns
authoring and curation only.

### 5.1 Roots

| Scope         | Path                                       | OUM writes              |
| ------------- | ------------------------------------------ | ----------------------- |
| global        | `~/.agents/skills`                         | promote / global create |
| project       | `<project>/.opencode/skills`               | project create / fork   |
| native global | `~/.config/opencode/skills`                | no (left to the user)   |
| compat        | `.claude/skills`, project `.agents/skills` | no                      |

`.agents/skills` is the canonical global library because that is where the
existing library lives and it is portable across agents. It is configurable via
`skills.globalRoot`.

### 5.2 Advertised, not loaded

OpenCode advertises only ID, name, and description. A body loads only when the
model calls `skill` or the user picks it via `/skills`. OUM does not hide skills
by default; `metadata.opencode/autoinvoke: false` is an explicit opt-in, not a
policy.

Descriptions are the retrieval key. OUM enforces `skills.descriptionBudget`
(default 200 chars) and requires a specific, action-oriented description.

### 5.3 Layout and cleanliness

- Directory form only: `<root>/[category/]<id>/SKILL.md` plus `references/`,
  `templates/`, `scripts/`.
- IDs are lowercase kebab-case, 1–64 chars, matching the directory.
- No state, ledgers, backups, temp files, or hidden directories inside the
  library. Those live under `<dataRoot>`:
  - `state.db`
  - `skills-ledger.jsonl`
  - `skill-backups/<hash>/`
  - `skill-archive/`
- Deleting a skill archives it to `<dataRoot>/skill-archive/`; it never
  hard-deletes a user-authored skill.
- Collisions: if the same ID exists in a higher-precedence source
  (`~/.config/opencode/skills`, project scope, explicit `skills` entries), OUM
  warns and refuses to create; the user chooses patch, fork, or rename.

### 5.4 Scope policy

- Project-specific procedure → project root.
- Portable class-level technique → global root.
- Ambiguous → project root; promote later on demand.
- The learn module never promotes silently.

### 5.5 Promote and fork

- `promote`: move `<project>/.opencode/skills/<id>` to the global root. Refuse if
  the ID exists globally (offer patch). Detect a project-local duplicate and
  explain precedence. Record `promoted_from` and `promoted_at`.
- `fork`: copy a global skill into the current project, mark
  `origin: fork`. Project precedence makes the fork win locally.

### 5.6 Frontmatter

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

### 5.7 Tool

`oum_skill_manage` actions:

- `create`, `patch`, `write_file`, `remove_file`
- `delete` (archives)
- `promote`, `fork`

Guards: read-before-write for patch/delete, path safety (no `..`, no absolute
paths, no symlink escape), duplicate name refusal, size and frontmatter
validation, ledger append, `ctx.skill.reload()` after every mutation.

### 5.8 Index

Internal only: a `skills` table + FTS in `state.db`. Used for dedupe before
create and for candidate selection in the learn module. Not exposed as a tool. Native
advertising is the search.

## 6. Learn module

The learn module is the memory system's writer: it decides what to save, what to
consolidate, and which skills to create or patch. It is a module, not a hook
callback, because the decision logic must be testable without a live host.

### 6.1 Contract

```ts
interface LearnEngine {
  plan(input: LearnInput): Promise<LearnPlan>
}

interface LearnInput {
  transcript: Transcript
  project: ProjectContext
  memory: MemorySnapshot
  skills: SkillCandidate[]
  policy: string
  budget: LearnBudget
}

interface LearnPlan {
  memory: MemoryOperation[]
  skills: SkillOperation[]
  curation: CurationOperation[]
  notes?: string
  confidence?: number
}
```

The host applies the plan; the engine never writes. `apply(plan)` is
transactional, idempotent per operation hash, and validates every operation
against the current store before applying.

### 6.2 Triggers

- Memory nudge: every `learn.triggers.turns` user turns (default 10), counted in
  `prompt`.
- Skill nudge: every `learn.triggers.toolIterations` tool calls (default 10), counted in
  `tool.execute.after`.
- Turn end: `session.execution.succeeded | failed | interrupted`. If the event
  stream misses it, the **next `prompt` hook** reviews the previous turn. This
  fallback is mandatory.
- Compaction: enqueue a flush; do not block or replace compaction.
- Manual: `/oum-reflect` forces a review.
- Coalesce: one in-flight learn run per session; newer triggers set a dirty bit.

Every trigger decision is logged with a reason: `due`, `not-due:turns`,
`not-due:throttle`, `not-due:in-flight`, `skipped:model`, `skipped:disabled`.

### 6.3 Execution

A single `generate.text` call, pinned to the reviewed session's model. If the
model cannot be resolved, skip and log; never fall back silently to a global
default.

Input: a bounded transcript (`learn.maxTranscriptChars`, default 60,000 chars)
built from user text, assistant text, tool names and bounded tool results.
Reasoning is stripped. The plugin reads candidate skill bodies from disk and
includes them; the engine **does not get a read tool**, so there are no
permission errors and no exploratory reads.

Output: strict JSON matching `LearnPlan`. Validation is strict. Apply in one
transaction; retry once with the validation error appended. A failed learn run
never throws into the host.

### 6.4 Policy input

The engine receives the current `POLICY.md` (design decisions, conventions,
scope rules) and the current MEMORY/notes index. **Policy beats transcript.**
If the conversation appears to contradict the current policy, the engine flags
it instead of writing a skill that encodes the old decision.

This exists because the V2 run captured a mid-conversation statement
("never write to `~/.agents/skills`") that a later decision reversed. Without a
policy input, skills encode stale guidance.

### 6.5 Curation

The learn plan can include curation operations:

- `supersede(old, new)` — new note/skill wins; old is marked, not silently kept.
- `merge(a, b)` — consolidate near-duplicates, preserving provenance.
- `demote(note)` — move an always-on fact to a note, or mark it stale.
- `promote(note)` — move a project fact to global (only with a promote policy).
- `archive(note)` — remove from active retrieval; keep the evidence.

The engine proposes; the host validates and applies. A reconcile pass on
startup and compaction rebuilds indexes from canonical files and flags orphans.

### 6.6 Observability

Append one JSONL record per trigger and per run to
`<dataRoot>/learn-events.jsonl`:

```json
{"ts":"...","session":"...","event":"trigger","reason":"due","turns":12,"tools":31}
{"ts":"...","session":"...","event":"run","durationMs":24000,"model":"...","memory":2,"skills":2,"errors":[],"tokens":{}}
```

A weekly summary logs runs, writes, dedupe rate, stale rate, and skipped
reasons. No TUI toasts.

### 6.7 Prompts

- Memory: declarative facts only — environment, conventions, corrections,
  stable preferences. No procedures; procedures belong in skills. Respect the
  budget and consolidate rather than overflow.
- Skills: class-level umbrellas; patch a loaded skill first, then an existing
  umbrella, then add a support file, then create. Strong description. Decide
  scope. Never invent session-artifact names.
- Both: "nothing to save" is allowed but not the default; no secrets, no
  transcripts, no one-off task state.

### 6.8 Lessons from the V2 run

The 2026-10-21 V2 run produced a good class-level skill and two memory entries,
and consolidated to stay under the cap. It also exposed the failure modes this
module must fix:

- The trigger is the product: one run in three days is not learning.
- Silence is the default failure: no skip log means no diagnosis.
- Read tools in a restricted review session produce avoidable errors; pass the
  files instead.
- Mid-conversation decisions get captured; policy must be an input.
- Consolidation works; keep it, and make it observable.

## 7. Native interop contract

| V2 surface | OUM behavior |
|---|---|
| Tool catalog | 3 namespaced tools, registered once at setup. No conditional tools. |
| Code Mode | `codemode: true`, namespace `oum`. |
| Tool descriptions | Compact; enums; `additionalProperties: false`. |
| Context hook | Only append the frozen memory block to `event.system`. |
| Prompt hook | Count turns only. Never rewrite the prompt. |
| Compaction | Read and enqueue. Never set `event.result` or edit messages. |
| Event stream | Queue work only; bounded queue; drain worker; reconnect with backoff. |
| Session lifecycle | Never create, remove, move, rename, or reprompt a user session. |
| Host DB | Read-only attach (`mode=ro`). Never write OpenCode's database. |
| Model/provider | Never set model, provider, headers, or request options. |
| Native skills | Write only to OUM roots; call `ctx.skill.reload()` after writes. |
| Existing skills | Learn module edits `origin: self|fork` only by default. |
| Permissions | Every tool calls `ctx.permission.assert`; no blanket deny; no bypass. |
| Coexistence | If `opencode-hermes` is active, log and disable unless explicitly allowed. |
| Failure isolation | Every hook wrapped; sync/search time-bounded; corrupt index recreated. |
| UI | Log only. No toasts, titles, or session metadata. |

## 8. Tools

- `oum_memory`
- `oum_session_search`
- `oum_skill_manage`

Namespace `oum`, Code Mode. No `provider_memory`, no `skill_search`, no
`skill_view` (native `skill` loads bodies).

## 9. Repo layout

```
openultramem/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── paths.ts
│   ├── log.ts
│   ├── memory/{store,snapshot,tool,prompts}.ts
│   ├── recall/{db,schema,ingest,search,hydrate,tool}.ts
│   ├── skills/{roots,frontmatter,manager,indexer,ledger,policy,tool}.ts
│   └── learn/{engine,trigger,transcript,apply,curate,events,policy,prompts}.ts
├── test/{fixtures,harness}/
├── scripts/{backfill,migrate,bench,e2e}.ts
└── docs/{README,DESIGN,SCHEMA,SKILLS,MIGRATION}.md
```

## 10. Config

Defaults; every value overridable by `ctx.options` and `OUM_*` env.

```jsonc
{
  "memoryRoot": "~/.config/opencode/oum",
  "dataRoot": "~/.local/share/opencode/oum",
  "memoryChars": 2200,
  "userChars": 1375,
  "learn": {
    "enabled": true,
    "model": "session",
    "maxTranscriptChars": 60000,
    "triggers": {
      "turns": 10,
      "toolIterations": 10,
      "onCompaction": true,
      "fallback": "next-prompt",
      "throttleMs": 60000
    },
    "log": true
  },
  "search": {
    "trigram": true,
    "maxIndexedChars": 8000,
    "syncBudgetMs": 250
  },
  "skills": {
    "globalRoot": "~/.agents/skills",
    "projectRoot": ".opencode/skills",
    "descriptionBudget": 200,
    "editUserSkills": false
  },
  "coexistence": false
}
```

## 11. Milestones

1. **Retrieval core** — schema, V2 ingest, dual FTS + RRF, `oum_session_search`.
   Accept: 10k-message fixture, <50 ms query, idempotent re-ingest.
2. **Canonical memory** — store, snapshot, `oum_memory`, caps and atomic writes.
   Accept: one injection per session, actionable cap errors.
3. **Learn module** — contract, triggers (including next-prompt fallback),
   transcript, structured JSON, apply, curation, event log. Accept: fixture
   transcript produces valid ops; every trigger decision is logged; disabled
   flag works; no read-tool dependency.
4. **Skills** — roots, manager, provenance, ledger, dedupe, promote/fork,
   `oum_skill_manage`, skill learn pass. Accept: create/patch/promote; read-before-
   write; native reload; user skills untouched by default.
5. **Migration** — import old memory, disable `opencode-hermes`, docs, e2e.
6. **Optional** — description budget analytics, curator, trigram tuning.
7. **Optional controller backend** — `MemoryController` seam, `RuleController`,
   Laya adapter, labeled decision benchmark. Accept: no regression vs rules,
   local-only, bounded latency.

## 12. Open questions

Resolved on 2026-10-27 against OpenCode 2.2.0 — see
[VERIFICATION.md](VERIFICATION.md) for the measurements.

- ~~Does `ctx.tool.transform` + namespace + `codemode: true` expose the expected
  catalog?~~ Yes; effective ID `namespace_name`, `tools.<ns>.<tool>` in Code Mode.
- ~~Does `generate.text` accept a pinned model and fail visibly?~~ Yes; a bad model
  raises `Model not found: <provider>/<model>`. Use
  `ctx.experimental.generate.text`.
- ~~Does read-only attach of a live WAL `opencode.db` work without locking it?~~ Yes.
- ~~How often do `session.execution.*` events get missed on the current V2?~~
  Delivery is live, but **durable events are not retained host-side** (`event` is
  empty of them, `event_sequence` only counts). There is no replay, so the
  next-prompt fallback is mandatory and the miss rate stays unmeasured until the
  event log accumulates.

Remaining:

- Repo/package name: `openultramem` / `@gitmaniii/openultramem`?
- npm publication and release process.

## 13. Decisions log

- 2026-10-21 — V2 only; drop the V1 adapter and V1 session ingest.
- 2026-10-21 — Hybrid search: contentless word FTS + trigram FTS + RRF, hydrate
  from the host DB. Keeps freshness, literal matching, recall, ranking,
  precision, schema isolation, and no duplicated bodies.
- 2026-10-21 — Bun SQLite 3.53.2 verified: FTS5, `contentless_delete=1`, and
  trigram all work.
- 2026-10-21 — No embeddings in v1; optional provider seam later, preferably on
  session search rather than note recall.
- 2026-10-21 — Three tools, namespace `oum`, Code Mode.
- 2026-10-21 — `.agents/skills` is the canonical global library; project skills
  live in `.opencode/skills`; `~/.config/opencode/skills` is untouched.
- 2026-10-21 — Skills are advertised, not loaded; descriptions are budgeted.
- 2026-10-21 — Learn module is a structured completion, not a restricted session.
- 2026-10-21 — No `autoinvoke` hiding by default; no `skill_search` tool.
- 2026-10-21 — Promote/fork instead of symlinks or a parallel registry.
- 2026-10-21 — Controller seam accepted; model backend deferred. Jev/Laya are
  optional, advisory, local-first; no full graph in v1.
- 2026-10-22 — Learn module is explicit (`LearnEngine` + host `apply`), every
  trigger/skip/run logged to `learn-events.jsonl`; policy input beats transcript;
  the engine receives skill bodies as input, not a read tool.
- 2026-10-27 — Turn end is the *boundary* at which a due review runs; the turn and
  tool counters gate due-ness. This keeps one review per N turns instead of one
  per turn, while still using the execution event as the natural cut-off.
- 2026-10-27 — Per-session `throttleMs` (default 60 s). A trigger that arrives
  during a run is queued with its own reason and skips the throttle window, since
  it was admitted before that window began.
- 2026-10-27 — A failed run is logged, does not reset the counters, and never
  throws into the host; the next boundary retries.
- 2026-10-27 — Curation has no note store to act on: `supersede`, `merge`, and
  `archive`/`demote` map to memory edits, and `promote` is refused until note
  scopes exist.
- 2026-10-27 — Read-before-write is `base_hash`: the sha of the body at read
  time. The tool returns the sha with the body when it is missing, and learn
  candidates carry their sha so a patch can cite one.
- 2026-10-27 — `promote` is never applied from a learn plan. It is an explicit
  tool action because promotion changes where a skill lives.
- 2026-10-27 — Deletes move the directory into `<dataRoot>/skill-archive/`; the
  library never holds backups, ledgers, or hidden state.
- 2026-10-27 — Migration is a script, not plugin setup: it inspects, refuses a
  non-empty target, backs up, copies, and verifies entry counts. Setup still
  migrates opportunistically on an empty OUM root.
- 2026-10-27 — Milestone 5 completed: OUM replaced `opencode-hermes` on
  2026-10-27 after a consolidated 1,892-char memory and a verified switch.

## Appendix A. Optional controller backend (Jev / Laya)

Status: deferred; interface only in v1.

OUM's memory decisions are structured: what to save, which scope, whether it is
a duplicate, how notes relate, how to route a query, and when evidence is
sufficient. v1 uses deterministic rules plus FTS. A model-powered controller can
replace the rules later without changing the store or the plugin surface.

### A.1 Interface

```ts
interface MemoryController {
  classify(note: Observation, ctx: DecisionContext): Promise<Classification>
  relate(note: Observation, candidates: Note[]): Promise<NoteEdge[]>
  route(query: string, ctx: DecisionContext): Promise<QueryRoute>
  score(query: string, candidates: Chunk[]): Promise<CandidateScore[]>
  assess(query: string, evidence: Chunk[]): Promise<EvidenceAssessment>
  consolidate(note: Note, neighbors: Note[]): Promise<ConsolidationPlan>
}
```

- `RuleController` is the default.
- `LayaController` uses the local `laya-serve` endpoint
  (`POST /v1/systemone`) with typed Noul/Choice questions. Local only.
- `JevController` uses the hosted TypeSafe API. Disabled by default; explicit
  opt-in with a data-egress warning.

### A.2 Rules

1. **Advisory only.** The controller proposes; OUM validates and applies. It
   never writes memory, skills, or files directly.
2. **Bounded.** A maximum number of decisions per learn run, a per-call timeout,
   and fail-open to `RuleController`.
3. **Local by default.** No project data leaves the machine. Hosted Jev requires
   an explicit, documented opt-in.
4. **Reproducible.** Store backend ID, model hash, and decision-schema version
   with every applied decision.
5. **Off the critical path.** Run at ingest, learn, and compaction; cache
   results. Never on the per-request path.
6. **Earned, not assumed.** Enable only after a labeled benchmark beats the rule
   baseline on decision accuracy and learn quality. Laya base checkpoints are
   near chance zero-shot on typed decisions (0.362 vs a 0.461 majority-class
   baseline in the model card); fine-tuning and temperature calibration are
   prerequisites, not optional.

### A.3 What to borrow from Jev-Mem

- Typed decisions with bounded output spaces, batched.
- Preserve canonical observations with provenance; defer selectivity to
  retrieval.
- Hybrid anchors, bounded expansion, and explicit stopping (sufficiency,
  expected utility, contradiction).
- Periodic consolidation for redundancy, contradiction, and obsolescence.
- Decision traces for debugging.

### A.4 What not to borrow

- The full four-view graph in v1. Start with a small relation layer:
  `depends_on`, `supersedes`, `caused_by`, `same_module`, `fixes`.
- The hosted Jev API for private code.
- LoCoMo-tuned thresholds or benchmark claims.

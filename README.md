# OpenUltraMem (OUM)

Memory that survives the session — for OpenCode V2.

OUM adds three things to OpenCode:

- **Canonical memory** — bounded `MEMORY.md` and `USER.md`, injected as a stable
  per-session snapshot.
- **Session recall** — a disposable `state.db` index over OpenCode's own session
  history, with ranked full-text search.
- **Procedural memory** — learn-driven skill authoring into OpenCode's native
  skill roots, with provenance, dedupe, and promotion.

OpenCode remains the source of truth. Every OUM index is derived, disposable, and
rebuildable. No embeddings, no duplicated transcripts, no V1 compatibility layer.

Status: **v0.1.0** — retrieval core and canonical memory are built and tested.
The learn module, skill authoring, and migration completion are next (see
[docs/BUILD.md](docs/BUILD.md)).

## Install

OpenCode V2 only (tested on 2.2.0). Add the plugin to `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///home/you/Projects/openultramem"]
}
```

Nothing else is required: the plugin ships TypeScript sources and runs inside
OpenCode's Bun runtime. Configuration is read from plugin `options` or `OUM_*`
environment variables — for example:

```jsonc
{
  "plugins": [
    {
      "package": "file:///home/you/Projects/openultramem",
      "options": { "memoryRoot": "~/.config/opencode/oum" }
    }
  ]
}
```

| Path | Purpose |
|---|---|
| `~/.config/opencode/oum/MEMORY.md`, `USER.md` | canonical memory; survives everything |
| `~/.local/share/opencode/oum/state.db` | derived session index; safe to delete |
| `~/.local/share/opencode/oum/oum.log` | diagnostics (no TUI toasts) |

Do not run OUM and `opencode-hermes` together: both inject a memory block and
write the same files. OUM warns and skips injection while hermes is active
unless `coexistence: true`.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture, the native-interop
contract, the data schema, and the milestones. Release history is in
[CHANGELOG.md](CHANGELOG.md).

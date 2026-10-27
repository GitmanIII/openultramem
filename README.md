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

Status: **implementation in progress** — retrieval core and canonical memory are
built and tested (see [docs/BUILD.md](docs/BUILD.md)); learn module, skills, and
migration are next.

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture, the native-interop
contract, the data schema, and the milestones.

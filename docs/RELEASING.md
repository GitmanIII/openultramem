# Releasing

Semantic versioning, annotated tags, one tag per shipped state. The tag, the
`package.json` version, and `src/version.ts` must always agree —
`test/version.test.ts` fails the suite if they drift.

## Checklist

1. `bun test` and `bunx tsc --noEmit` are green.
2. `bun run scripts/bench.ts` still passes the retrieval budget.
3. Bump the version in three places: `package.json`, `src/version.ts`, and a new
   `CHANGELOG.md` section.
4. Commit: `chore(release): vX.Y.Z`.
5. Annotated tag with the short feature list as the message:
   `git tag -a vX.Y.Z -m "vX.Y.Z"` then `git push origin main --follow-tags`.
6. Create the GitHub release from the tag; the body is the changelog section.

## Version rules

- `0.x`: the plugin surface may change; `x` increments for breaking changes to
  tools, config, or on-disk layout.
- Patch releases fix behaviour without changing the tool surface.
- No pre-1.0 `1.0.0` claims: 1.0 waits for the learn module and skill authoring
  to be live, not merely designed.

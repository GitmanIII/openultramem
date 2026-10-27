/**
 * Retrieval benchmark: Milestone 1 acceptance is a 10k-message fixture with
 * queries under 50 ms, including the first (cold) sync.
 *
 *   bun run scripts/bench.ts [messages]
 */
import { Database } from "bun:sqlite"
import { buildFixture } from "../test/fixture.ts"
import { openState } from "../src/recall/db.ts"
import { sync } from "../src/recall/ingest.ts"
import { search } from "../src/recall/search.ts"
import { hydrate } from "../src/recall/hydrate.ts"

const total = Number(process.argv[2] ?? 10_000)
const fixture = buildFixture(total, 5)
const db = openState(fixture.statePath)
const host = new Database(fixture.hostPath, { readonly: true })

const syncStart = performance.now()
const ingested = sync(db, host, { budgetMs: 60_000, maxChars: 8_000 })
const syncMs = performance.now() - syncStart

const queries = ["sphinx", "quartzite gate", "memory session index", "nebula", "worker queue retry", "uartzit"]
const timings: { query: string; ms: number; hits: number }[] = []

for (let round = 0; round < 5; round++) {
  for (const query of queries) {
    const started = performance.now()
    const hits = search(db, query, { limit: 10 })
    hydrate(db, host, hits, query, 8_000)
    const ms = performance.now() - started
    if (round > 0) timings.push({ query, ms, hits: hits.length })
  }
}

const sorted = timings.map((entry) => entry.ms).sort((a, b) => a - b)
const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!

const rows = (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n
const fts = (db.query("SELECT COUNT(*) AS n FROM messages_fts").get() as { n: number }).n

console.log(`fixture:        ${total} host messages → ${rows} index rows (${fts} FTS rows)`)
console.log(`cold sync:      ${syncMs.toFixed(0)} ms (stale=${ingested.stale})`)
console.log(`query p50:      ${p(0.5).toFixed(2)} ms`)
console.log(`query p95:      ${p(0.95).toFixed(2)} ms`)
console.log(`query max:      ${sorted[sorted.length - 1]!.toFixed(2)} ms`)
console.log(`samples:        ${timings.length}`)

const worst = timings.reduce((worst, entry) => (entry.ms > worst.ms ? entry : worst))
console.log(`slowest:        "${worst.query}" ${worst.ms.toFixed(2)} ms`)

const budget = 50
if (p(0.95) > budget) {
  console.error(`FAIL: p95 ${p(0.95).toFixed(2)} ms exceeds ${budget} ms`)
  process.exit(1)
}
console.log(`PASS: p95 within ${budget} ms`)

db.close()
host.close()

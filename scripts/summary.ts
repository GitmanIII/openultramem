/**
 * Weekly learn summary: what fired, what was skipped, what landed.
 *
 *   bun run scripts/summary.ts [days]
 */
import { learnEventsFile } from "../src/paths.ts"
import { LearnEvents, summarize } from "../src/learn/events.ts"
import { loadConfig } from "../src/config.ts"

const days = Number(process.argv[2] ?? 7)
const config = loadConfig()
const path = learnEventsFile(config.dataRoot)
const events = new LearnEvents(path)
const records = events.read()

if (!records.length) {
  console.log(`No learn events at ${path}.`)
  process.exit(0)
}

const since = Date.now() - days * 24 * 60 * 60 * 1000
const summary = summarize(records, since)

console.log(`learn events — last ${days} day(s) — ${path}`)
console.log(`runs:     ${summary.runs}`)
console.log(`applied:  ${summary.applied} operation(s)`)
console.log(`refused:  ${summary.refused}`)
console.log(`errors:   ${summary.errors}`)
console.log(`avg run:  ${summary.averageMs} ms`)

const reasons = Object.entries(summary.triggers).sort((a, b) => b[1] - a[1])
if (reasons.length) {
  console.log("triggers:")
  for (const [reason, count] of reasons) console.log(`  ${reason.padEnd(24)} ${count}`)
}

if (summary.notes.length) {
  console.log("notes:")
  for (const note of summary.notes) console.log(`  - ${note}`)
}

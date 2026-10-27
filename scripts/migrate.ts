/**
 * Migrate canonical memory from opencode-hermes to OUM.
 *
 *   bun run scripts/migrate.ts            # dry run
 *   bun run scripts/migrate.ts --apply    # copy (refuses a non-empty target)
 *
 * Back up first: ~/.config/opencode/memories, ~/.agents/skills, opencode.jsonc.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { migrate, inspect, summarize } from "../src/migrate.ts"

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const force = args.includes("--force")
const from = arg("--from") ?? join(homedir(), ".config", "opencode", "memories")
const to = arg("--to") ?? join(homedir(), ".config", "opencode", "oum")
const backupDir = join(homedir(), ".config", "opencode", "backups", "oum")

function arg(name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const report = inspect(from, to)
console.log("== memory migration plan ==")
console.log(summarize(report))

if (!apply) {
  console.log("\ndry run: pass --apply to copy")
  process.exit(report.conflicts.length ? 2 : 0)
}

const result = migrate(from, to, { backupDir, force })
if (!result.ok) {
  console.error(`\nFAILED: ${result.error}`)
  process.exit(1)
}

console.log(`\ncopied: ${result.copied.join(", ") || "(none)"}`)
if (result.skipped.length) console.log(`skipped: ${result.skipped.join(", ")}`)
if (result.backup) console.log(`backup: ${result.backup}`)

const after = inspect(from, to)
console.log("\nverification:")
for (const file of after.files) console.log(`  ${file.name}: ${file.exists ? `${file.chars} chars` : "missing"}`)
console.log("\nnext:")
console.log("  1. disable opencode-hermes and enable openultramem in ~/.config/opencode/opencode.jsonc")
console.log("  2. restart the OpenCode service")
console.log("  3. open a new session and check: one memory block, oum_session_search, oum_memory, oum_skill_manage, learn-events.jsonl")

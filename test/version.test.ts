import { expect, test } from "bun:test"
import { join } from "node:path"
import { VERSION } from "../src/version.ts"

const root = join(import.meta.dir, "..")

test("package.json version matches src/version.ts", async () => {
  const pkg = (await Bun.file(join(root, "package.json")).json()) as { version: string }
  expect(pkg.version).toBe(VERSION)
})

test("the changelog has a section for the current version", async () => {
  const changelog = await Bun.file(join(root, "CHANGELOG.md")).text()
  expect(changelog).toContain(`## ${VERSION} —`)
})

test("the latest annotated tag, when present, matches the version", async () => {
  const tag = Bun.spawnSync(["git", "describe", "--tags", "--abbrev=0"], { cwd: root })
  if (tag.exitCode !== 0) return // no tags yet (pre-release checkout)
  expect(tag.stdout.toString().trim()).toBe(`v${VERSION}`)
})

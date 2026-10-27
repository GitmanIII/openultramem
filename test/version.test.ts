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

function parse(tag: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = tag.replace(/^v/, "").split(".").map(Number)
  return [major, minor, patch]
}

test("the version is never behind the latest tag", async () => {
  const tag = Bun.spawnSync(["git", "describe", "--tags", "--abbrev=0"], { cwd: root })
  if (tag.exitCode !== 0) return // no tags yet (pre-release checkout)

  const [tmajor, tminor, tpatch] = parse(tag.stdout.toString().trim())
  const [vmajor, vminor, vpatch] = parse(VERSION)

  // Ahead of the last tag is legal while a release is in progress; behind is not.
  const behind =
    vmajor < tmajor || (vmajor === tmajor && vminor < tminor) || (vmajor === tmajor && vminor === tminor && vpatch < tpatch)
  expect(behind).toBe(false)
})

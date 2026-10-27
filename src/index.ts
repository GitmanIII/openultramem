/**
 * OpenUltraMem (OUM) — OpenCode V2 plugin entrypoint.
 *
 * The host database is read-only; `state.db` is disposable. Every hook is
 * wrapped so a memory failure can never break a session.
 */
import { Plugin } from "@opencode/plugin"
import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.ts"
import { createLogger } from "./log.ts"
import { hostDatabase, stateDatabase } from "./paths.ts"
import { openHost, openState } from "./recall/db.ts"
import { reconcile, sync } from "./recall/ingest.ts"
import { startBackfill, type BackfillHandle } from "./recall/backfill.ts"
import { createSessionSearch } from "./recall/tool.ts"
import { MemoryStore } from "./memory/store.ts"
import { SnapshotCache } from "./memory/snapshot.ts"
import { createMemoryTool } from "./memory/tool.ts"

export default Plugin.define({
  id: "openultramem",
  async setup(ctx) {
    const config = loadConfig(ctx.options as Record<string, unknown>)
    const log = createLogger(config.dataRoot)

    let host: Database | null = null
    let hostOpened = false
    const getHost = (): Database | null => {
      if (!hostOpened) {
        host = openHost(hostDatabase())
        hostOpened = true
      }
      return host
    }

    let db: Database
    try {
      db = openState(stateDatabase(config.dataRoot))
    } catch (error) {
      log.error("state.db unavailable", { message: String((error as Error)?.message ?? error) })
      throw error
    }

    log.info("initialized", {
      version: ctx.app.version,
      directory: ctx.location.directory,
      project: ctx.location.project.id,
      dataRoot: config.dataRoot,
      memoryRoot: config.memoryRoot,
    })

    // Coexistence: two memory plugins would inject two blocks and write the same files.
    let hermesActive = false
    try {
      const active = await ctx.plugin.list()
      hermesActive = (active.data ?? []).some((plugin) => String(plugin.id ?? "").toLowerCase().includes("hermes"))
      if (hermesActive) log.warn("coexistence: opencode-hermes is active", { allowed: config.coexistence })
    } catch {
      // plugin.list is advisory only
    }

    const store = new MemoryStore(config)
    if (!config.coexistence && store.both().memory.entries.length === 0 && store.both().user.entries.length === 0) {
      try {
        if (store.migrateFrom(join(homedir(), ".config", "opencode", "memories"))) log.info("migrated memory from opencode-hermes")
      } catch (error) {
        log.warn("memory migration failed", { message: String((error as Error)?.message ?? error) })
      }
    }
    const snapshots = new SnapshotCache(store)
    const injectMemory = !hermesActive || config.coexistence

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "oum", description: "OpenUltraMem: session recall and memory" })
      editor.add(
        createSessionSearch({
          db,
          host: getHost,
          config,
          log,
          permission: (input) => ctx.permission.assert(input),
        }) as never,
      )
      editor.add(
        createMemoryTool({
          store,
          log,
          permission: (input) => ctx.permission.assert(input),
        }) as never,
      )
    })

    // Frozen snapshot: read once per session, appended unchanged on every request.
    const contextHook = await ctx.session.hook("context", (event) => {
      if (!injectMemory) return
      try {
        const block = snapshots.freeze(event.sessionID)
        if (block) event.system.push({ type: "text", text: block })
      } catch (error) {
        log.warn("memory injection failed", { message: String((error as Error)?.message ?? error) })
      }
    })

    // Two memory plugins must not both inject.
    if (!injectMemory) log.warn("memory injection disabled: opencode-hermes is active and coexistence is false")

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: controller.signal })) {
          const id = (event as { data?: { sessionID?: string } }).data?.sessionID
          if (id) snapshots.evict(id)
        }
      } catch {
        // eviction is best-effort; the cache is capped anyway
      }
    })()

    // Warm the index, then keep catching up in the background. Search-time sync
    // is too short to backfill 10k messages, so a fresh install would stay stale.
    let backfill: BackfillHandle | undefined
    try {
      const database = getHost()
      if (database) {
        const result = sync(db, database, { budgetMs: 250, maxChars: config.search.maxIndexedChars })
        const removed = reconcile(db, database)
        log.info("warm sync", { scanned: result.scanned, upserted: result.upserted, ms: result.ms, stale: result.stale, removed })
        if (result.stale) backfill = startBackfill(db, database, config, log)
      }
    } catch (error) {
      log.warn("warm sync failed", { message: String((error as Error)?.message ?? error) })
    }

    return () => {
      backfill?.stop()
      controller.abort()
      void contextHook.dispose()
      try {
        host?.close()
      } catch {}
      try {
        db.close()
      } catch {}
    }
  },
})

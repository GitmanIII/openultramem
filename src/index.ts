/**
 * OpenUltraMem (OUM) — OpenCode V2 plugin entrypoint.
 *
 * The host database is read-only; `state.db` is disposable. Every hook is
 * wrapped so a memory failure can never break a session.
 */
import { Plugin } from "@opencode/plugin"
import type { Database } from "bun:sqlite"
import { loadConfig } from "./config.ts"
import { createLogger } from "./log.ts"
import { hostDatabase, stateDatabase } from "./paths.ts"
import { openHost, openState } from "./recall/db.ts"
import { reconcile, sync } from "./recall/ingest.ts"
import { startBackfill, type BackfillHandle } from "./recall/backfill.ts"
import { createSessionSearch } from "./recall/tool.ts"

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
    try {
      const active = await ctx.plugin.list()
      const hermes = (active.data ?? []).some((plugin) => String(plugin.id ?? "").toLowerCase().includes("hermes"))
      if (hermes) log.warn("coexistence: opencode-hermes is active", { allowed: config.coexistence })
    } catch {
      // plugin.list is advisory only
    }

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
    })

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
      try {
        host?.close()
      } catch {}
      try {
        db.close()
      } catch {}
    }
  },
})

/**
 * OpenUltraMem (OUM) — OpenCode V2 plugin entrypoint.
 *
 * The host database is read-only; `state.db` is disposable. Every hook is
 * wrapped so a memory failure can never break a session.
 */
import { Plugin } from "@opencode/plugin"
import type { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.ts"
import { createLogger } from "./log.ts"
import { hostDatabase, learnEventsFile, policyFile, stateDatabase } from "./paths.ts"
import { openHost, openState } from "./recall/db.ts"
import { reconcile, sync } from "./recall/ingest.ts"
import { startBackfill, type BackfillHandle } from "./recall/backfill.ts"
import { createSessionSearch } from "./recall/tool.ts"
import { MemoryStore } from "./memory/store.ts"
import { SnapshotCache } from "./memory/snapshot.ts"
import { createMemoryTool } from "./memory/tool.ts"
import { applyPlan } from "./learn/apply.ts"
import { StructuredEngine, type LearnInput, type ModelRef } from "./learn/engine.ts"
import { LearnEvents } from "./learn/events.ts"
import { buildTranscript } from "./learn/transcript.ts"
import { LearnController } from "./learn/trigger.ts"
import { VERSION } from "./version.ts"

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
      oum: VERSION,
      host: ctx.app.version,
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

    // The reviewed session's model must come from that session, never a global default.
    const sessionModels = new Map<string, ModelRef>()

    // Frozen snapshot: read once per session, appended unchanged on every request.
    const contextHook = await ctx.session.hook("context", (event) => {
      try {
        sessionModels.set(event.sessionID, event.model as ModelRef)
        if (!injectMemory) return
        const block = snapshots.freeze(event.sessionID)
        if (block) event.system.push({ type: "text", text: block })
      } catch (error) {
        log.warn("memory injection failed", { message: String((error as Error)?.message ?? error) })
      }
    })

    if (!injectMemory) log.warn("memory injection disabled: opencode-hermes is active and coexistence is false")

    // ---- Learn module -----------------------------------------------------
    const events = new LearnEvents(learnEventsFile(config.dataRoot))
    const engine = new StructuredEngine({
      generate: async ({ prompt, model }) =>
        ctx.experimental.generate.text({
          prompt,
          model: { providerID: model.providerID, id: model.id, variant: model.variant },
        }),
      log,
    })

    const resolveModel = (sessionID: string): ModelRef | undefined => {
      if (config.learn.model !== "session") {
        const [providerID, ...rest] = config.learn.model.split("/")
        const id = rest.join("/")
        return providerID && id ? { providerID, id } : undefined
      }
      return sessionModels.get(sessionID)
    }

    const buildInput = async (sessionID: string, model: ModelRef): Promise<LearnInput> => {
      const database = getHost()
      if (!database) throw new Error("host session database unavailable")
      const transcript = buildTranscript(database, sessionID, config.learn.maxTranscriptChars)
      const { memory, user } = store.both()

      let skills: { id: string; description: string }[] = []
      try {
        const listed = await ctx.skill.list()
        skills = (listed.data ?? []).map((skill) => ({ id: String(skill.id), description: skill.description ?? "" }))
      } catch {
        // skills are context, not a prerequisite
      }

      const policyPath = policyFile(config.memoryRoot)
      const policy = existsSync(policyPath) ? readFileSync(policyPath, "utf8") : ""

      return {
        sessionID,
        model,
        turns: transcript.turns,
        toolCalls: transcript.toolCalls,
        project: { id: ctx.location.project.id, directory: ctx.location.directory },
        transcript: transcript.text,
        memory: { entries: memory.entries, chars: memory.chars, budget: memory.budget },
        user: { entries: user.entries, chars: user.chars, budget: user.budget },
        policy,
        skills,
        skillsEnabled: false,
      }
    }

    const controller = new LearnController({
      settings: {
        enabled: config.learn.enabled,
        turns: config.learn.triggers.turns,
        toolIterations: config.learn.triggers.toolIterations,
        onCompaction: config.learn.triggers.onCompaction,
        fallback: config.learn.triggers.fallback,
        throttleMs: config.learn.triggers.throttleMs,
      },
      engine,
      events,
      log,
      modelFor: resolveModel,
      buildInput,
      apply: (plan, sessionID) => applyPlan({ store, db, log }, plan, sessionID),
    })

    const promptHook = await ctx.session.hook("prompt", (event) => {
      void controller
        .onPrompt(event.sessionID)
        .catch((error) => log.warn("learn prompt accounting failed", { message: String(error?.message ?? error) }))
    })

    const toolHook = await ctx.tool.hook("execute.after", (event) => {
      void controller
        .onToolCall(event.sessionID)
        .catch((error) => log.warn("learn tool accounting failed", { message: String(error?.message ?? error) }))
    })

    const command = await ctx.command.transform((editor) => {
      editor.add({
        name: "oum-reflect",
        description: "Force an OpenUltraMem learn review for this session",
        execute: async ({ sessionID }) => {
          await controller.force(sessionID)
        },
      })
    })
    log.info("learn ready", {
      enabled: config.learn.enabled,
      triggers: config.learn.triggers,
      command: "oum-reflect",
    })

    // ---- Events -----------------------------------------------------------
    const subscription = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.deleted",
            "session.execution.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.compaction.started",
          ],
          signal: subscription.signal,
        })) {
          const id = (event as { data?: { sessionID?: string } }).data?.sessionID
          switch (event.type) {
            case "session.deleted":
              if (id) {
                snapshots.evict(id)
                sessionModels.delete(id)
                controller.reset(id)
              }
              break
            case "session.execution.started":
              if (id) controller.onExecutionStart(id)
              break
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
              if (id) void controller.onExecutionEnd(id)
              break
            case "session.compaction.started":
              if (id) void controller.onCompaction(id)
              break
          }
        }
      } catch {
        // eviction and accounting are best-effort; the caches are capped anyway
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
      subscription.abort()
      void contextHook.dispose()
      void promptHook.dispose()
      void toolHook.dispose()
      void command.dispose()
      try {
        host?.close()
      } catch {}
      try {
        db.close()
      } catch {}
    }
  },
})

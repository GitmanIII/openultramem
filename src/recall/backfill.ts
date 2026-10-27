/**
 * Background backfill.
 *
 * Search-time sync is deliberately short (250 ms). On a fresh index that can
 * never catch up, so setup starts a low-priority loop that keeps applying
 * bounded batches until the watermark reaches the host head.
 */
import type { Database } from "bun:sqlite"
import type { OumConfig } from "../config.ts"
import type { Logger } from "../log.ts"
import { sync } from "./ingest.ts"

export interface BackfillOptions {
  batchMs?: number
  idleMs?: number
  retryMs?: number
}

export interface BackfillHandle {
  stop(): void
  done: Promise<void>
}

export function startBackfill(
  db: Database,
  host: Database,
  config: OumConfig,
  log: Logger,
  options: BackfillOptions = {},
): BackfillHandle {
  const batchMs = options.batchMs ?? 150
  const idleMs = options.idleMs ?? 10
  const retryMs = options.retryMs ?? 5_000

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const done = new Promise<void>((resolve) => {
    const finish = () => {
      if (timer) clearTimeout(timer)
      resolve()
    }

    const tick = () => {
      if (stopped) return finish()
      try {
        const result = sync(db, host, { budgetMs: batchMs, maxChars: config.search.maxIndexedChars })
        if (result.scanned > 0) {
          timer = setTimeout(tick, idleMs)
          return
        }
        log.info("backfill complete", { ms: result.ms })
        finish()
      } catch (error) {
        log.warn("backfill failed; retrying", {
          message: String((error as Error)?.message ?? error),
          retryMs,
        })
        timer = setTimeout(tick, retryMs)
      }
    }

    timer = setTimeout(tick, 0)
  })

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    done,
  }
}

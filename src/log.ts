/**
 * File logger. OUM never uses TUI toasts; everything observable goes to
 * `<dataRoot>/oum.log` (and stderr when enabled).
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

export type Level = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  child(scope: string): Logger
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function createLogger(dataRoot: string, scope = "oum", minimum: Level = "info"): Logger {
  const file = join(dataRoot, "oum.log")
  let ready = false

  const write = (level: Level, message: string, data?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minimum]) return
    const line = JSON.stringify({ t: new Date().toISOString(), level, scope, message, ...data })
    try {
      if (!ready) {
        mkdirSync(dirname(file), { recursive: true })
        ready = true
      }
      appendFileSync(file, line + "\n")
    } catch {
      // A logger must never break the host.
    }
    if (process.env.OUM_LOG_STDERR === "1") process.stderr.write(line + "\n")
  }

  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
    child: (prefix) => createLogger(dataRoot, `${scope}.${prefix}`, minimum),
  }
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger
  },
}

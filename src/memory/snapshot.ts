/**
 * Frozen memory snapshot.
 *
 * The block is read once per session and reused for every request, so a
 * mid-session write hits disk but cannot change the prompt under the model.
 */
import type { FileState } from "./store.ts"
import { MemoryStore } from "./store.ts"

const RULE = "═".repeat(46)
const MAX_SESSIONS = 256

export function render(memory: FileState, user: FileState): string {
  const blocks: string[] = []

  const section = (title: string, state: FileState) => {
    if (!state.entries.length) return
    blocks.push(
      [RULE, `${title} [${state.percent}% — ${state.chars}/${state.budget} chars]`, RULE, state.entries.join("\n§\n")].join("\n"),
    )
  }

  section("MEMORY (your personal notes)", memory)
  section("USER PROFILE (who the user is)", user)
  return blocks.join("\n\n")
}

export class SnapshotCache {
  private readonly cache = new Map<string, string>()

  constructor(private readonly store: MemoryStore) {}

  /** Read once per session; later calls return the frozen text. */
  freeze(sessionID: string): string {
    const existing = this.cache.get(sessionID)
    if (existing !== undefined) return existing
    const { memory, user } = this.store.both()
    const block = render(memory, user)
    if (this.cache.size >= MAX_SESSIONS) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(sessionID, block)
    return block
  }

  peek(sessionID: string): string | undefined {
    return this.cache.get(sessionID)
  }

  evict(sessionID: string): void {
    this.cache.delete(sessionID)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

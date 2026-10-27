/**
 * The learn engine: a single structured completion, validated strictly.
 *
 * It never touches the store. A failed run is logged and swallowed; a learn
 * failure must not surface as a session error.
 */
import type { Logger } from "../log.ts"
import { parsePlan, type LearnPlan } from "./plan.ts"
import { buildLearnPrompt, type LearnPromptInput } from "./prompts.ts"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface LearnInput extends LearnPromptInput {
  sessionID: string
  model: ModelRef
  turns: number
  toolCalls: number
}

export interface LearnEngine {
  plan(input: LearnInput): Promise<LearnPlan>
}

export type GenerateText = (input: { prompt: string; model: ModelRef }) => Promise<{ text: string }>

export class StructuredEngine implements LearnEngine {
  constructor(
    private readonly deps: {
      generate: GenerateText
      log: Logger
      maxAttempts?: number
    },
  ) {}

  async plan(input: LearnInput): Promise<LearnPlan> {
    const attempts = this.deps.maxAttempts ?? 2
    let prompt = buildLearnPrompt(input)
    let lastError = ""

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const started = Date.now()
      const response = await this.deps.generate({ prompt, model: input.model })
      const parsed = parsePlan(response.text)
      if (parsed.ok) {
        this.deps.log.info("learn: plan", {
          session: input.sessionID,
          attempt,
          ms: Date.now() - started,
          memory: parsed.plan.memory.length,
          curation: parsed.plan.curation.length,
          skills: parsed.plan.skills.length,
        })
        return parsed.plan
      }

      lastError = parsed.error
      this.deps.log.warn("learn: invalid plan", { session: input.sessionID, attempt, error: lastError })
      prompt = `${prompt}\n\nYour previous output was rejected: ${lastError}\nReturn only the corrected JSON object.`
    }

    throw new Error(`learn plan invalid after ${attempts} attempt(s): ${lastError}`)
  }
}

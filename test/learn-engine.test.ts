import { describe, expect, test } from "bun:test"
import { StructuredEngine, type GenerateText, type LearnInput } from "../src/learn/engine.ts"
import { buildLearnPrompt } from "../src/learn/prompts.ts"
import { silentLogger } from "../src/log.ts"

const input: LearnInput = {
  sessionID: "ses_1",
  model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
  turns: 3,
  toolCalls: 2,
  project: { id: "project-1", directory: "/work/project" },
  transcript: "USER: we decided to pin bun\nASSISTANT: noted",
  memory: { entries: ["machine is arch"], chars: 14, budget: 2200 },
  user: { entries: [], chars: 0, budget: 1375 },
  policy: "Never write project paths into global memory.",
  skills: [{ id: "git-release", description: "Prepare releases" }],
  skillsEnabled: false,
}

describe("buildLearnPrompt", () => {
  test("includes the policy, memory sizes, skills, and transcript", () => {
    const prompt = buildLearnPrompt(input)
    expect(prompt).toContain("POLICY.md is authoritative")
    expect(prompt).toContain("Never write project paths into global memory.")
    expect(prompt).toContain("14/2200 chars")
    expect(prompt).toContain("git-release: Prepare releases")
    expect(prompt).toContain("USER: we decided to pin bun")
  })

  test("says skill authoring is unavailable when disabled", () => {
    expect(buildLearnPrompt(input)).toContain('"skills": []')
    expect(buildLearnPrompt({ ...input, skillsEnabled: true })).not.toContain('"skills": []')
  })
})

describe("StructuredEngine", () => {
  const good = JSON.stringify({
    memory: [{ action: "add", target: "memory", content: "bun is pinned" }],
    skills: [],
    curation: [],
    notes: "decision",
    confidence: 0.7,
  })

  test("returns a validated plan and pins the reviewed model", async () => {
    const seen: { prompt: string; model: string }[] = []
    const generate: GenerateText = async (request) => {
      seen.push({ prompt: request.prompt, model: `${request.model.providerID}/${request.model.id}` })
      return { text: good }
    }
    const engine = new StructuredEngine({ generate, log: silentLogger })
    const plan = await engine.plan(input)

    expect(plan.memory[0]?.content).toBe("bun is pinned")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.model).toBe("opencode-go/deepseek-v4.1-flash")
    expect(seen[0]!.prompt).toContain("USER: we decided to pin bun")
  })

  test("retries once with the validation error appended", async () => {
    const prompts: string[] = []
    let call = 0
    const generate: GenerateText = async (request) => {
      prompts.push(request.prompt)
      call++
      return { text: call === 1 ? '{"memory":[{"action":"add","target":"memory"}],"skills":[],"curation":[]}' : good }
    }
    const engine = new StructuredEngine({ generate, log: silentLogger })
    const plan = await engine.plan(input)

    expect(call).toBe(2)
    expect(plan.memory).toHaveLength(1)
    expect(prompts[1]).toContain("previous output was rejected")
    expect(prompts[1]).toContain("content is required")
  })

  test("throws after two invalid responses", async () => {
    const engine = new StructuredEngine({ generate: async () => ({ text: "not json" }), log: silentLogger })
    await expect(engine.plan(input)).rejects.toThrow(/invalid after 2 attempt/)
  })

  test("propagates a model failure to the caller (the controller logs it)", async () => {
    const engine = new StructuredEngine({
      generate: async () => {
        throw new Error("Model not found: opencode-go/nope")
      },
      log: silentLogger,
    })
    await expect(engine.plan(input)).rejects.toThrow(/Model not found/)
  })
})

/**
 * Learn prompts.
 *
 * Two rules dominate: policy beats transcript, and procedures never go into
 * canonical memory. "Nothing to save" is allowed but not the default.
 */

export interface PromptMemory {
  entries: string[]
  chars: number
  budget: number
}

export interface LearnPromptInput {
  project: { id: string; directory: string }
  transcript: string
  memory: PromptMemory
  user: PromptMemory
  policy: string
  skills: { id: string; description: string }[]
  skillsEnabled: boolean
}

function memoryBlock(title: string, memory: PromptMemory): string {
  const list = memory.entries.length
    ? memory.entries.map((entry, index) => `${index + 1}. [${[...entry].length} chars] ${entry}`).join("\n")
    : "(empty)"
  return `${title} — ${memory.chars}/${memory.budget} chars\n${list}`
}

export function buildLearnPrompt(input: LearnPromptInput): string {
  const skillsSchema = input.skillsEnabled
    ? '  "skills": [ { "action": "create", "id": "kebab-case-id", "content": "..." } ],'
    : '  "skills": [],'
  const schema = [
    "{",
    '  "memory": [ { "action": "add", "target": "memory", "content": "..." } ],',
    '  "curation": [ { "action": "supersede", "target": "memory", "old_text": "...", "content": "..." } ],',
    skillsSchema,
    '  "notes": "optional short note for the log",',
    '  "confidence": 0.0',
    "}",
  ].join("\n")

  return `You are the memory writer for OpenUltraMem, a memory plugin for OpenCode.
Read the transcript and decide what deserves to persist. Output STRICT JSON only —
no prose, no markdown fences.

## Rules

1. MEMORY holds declarative facts only: environment, conventions, corrections,
   stable preferences, decisions with a date. Never procedures, task state,
   session artifacts, secrets, or transcript excerpts.
2. Keep entries short and self-contained. Respect the character budgets: if an
   add would overflow, consolidate first (merge near-duplicates, drop stale
   facts) and then add. Never exceed the budget.
3. "Nothing to save" is allowed but it is not the default. Most real sessions
   contain at least one durable fact or none at all; do not invent filler.
4. POLICY.md is authoritative. If the transcript contradicts it, do not encode
   the transcript's version; say so in "notes".
5. Prefer correcting an existing entry (replace) over appending a near-duplicate.
6. Curation actions: replace an outdated entry (supersede), merge two
   near-duplicates (merge with old_text_b), drop stale entries (archive/demote).
   "promote" is unavailable in this version.
7. ${
    input.skillsEnabled
      ? "Skills: create a class-level umbrella or patch an existing one; never name a skill after this session's artifacts."
      : 'Skill authoring is not available in this version: always return "skills": [].'
  }
8. Output valid JSON matching the schema exactly. Unknown keys are rejected.

## Project

id: ${input.project.id}
directory: ${input.project.directory}

## Current canonical memory

${memoryBlock("MEMORY.md", input.memory)}

${memoryBlock("USER.md", input.user)}

## POLICY.md

${input.policy.trim() || "(no policy file)"}

## Existing skills

${input.skills.length ? input.skills.map((skill) => `- ${skill.id}: ${skill.description}`).join("\n") : "(none)"}

## Transcript

${input.transcript}

## Output schema

${schema}

Return the JSON object now.`
}

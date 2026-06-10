// Pilot 2: verified-answer — the Ax-image self-improving loop as five-slot data.
//
//   goal, rubric -> answer, verdict
//   steps:  answer (LLM produces a value)
//        -> grade  (INDEPENDENT LLM judge, structured verdict)
//   policy: until(verdict.passed, max 3 iterations, feedback threaded back)
//
// The producer never sees the rubric — only the goal and, after a failed
// grade, the verifier's feedback. The verifier holds the rubric. That split
// is what makes the verification independent (Ax's `grade`, not
// self-critique) and a first-iteration failure genuinely possible, so the
// loop-back path is real, not decorative.
//
// This is the generalizability proof for the kernel: a non-coding,
// iterate-until-verified loop in the SAME five slots as Pilot 0 (script)
// and Pilot 1 (coding) — no engine special-casing for the domain.

import { z } from "zod"
import { retryPolicy, until } from "../kernel/policy.js"
import { noEffects, sig, type Loop, type PromptTemplate } from "../kernel/types.js"

const LOOP_ID = "verified-answer"
const LOOP_VERSION = "0.1.0"

// ------------------------------------------------------------------ verdict

/**
 * The verifier signature's output: rubric, evidence -> passed, feedback,
 * missing. This zod object is the ONE source of truth — the engine derives
 * the judge's provider-facing JSON schema from it (structuredOutput: true);
 * no hand-written schema exists anywhere for this step.
 */
export const verdictOutput = z.object({
  passed: z.boolean(),
  feedback: z.string(),
  missing: z.array(z.string()),
})
export type Verdict = z.infer<typeof verdictOutput>

/** Render a failed verdict as the feedback the next iteration's producer sees. */
export function feedbackFromVerdict(output: Readonly<Record<string, unknown>>): string {
  const feedback = typeof output.feedback === "string" ? output.feedback : ""
  const missing = Array.isArray(output.missing) ? output.missing.filter((m): m is string => typeof m === "string") : []
  return [feedback, ...missing.map((m) => `- missing: ${m}`)].filter(Boolean).join("\n")
}

// ------------------------------------------------------------------ prompts

const answerPrompt: PromptTemplate = (spec) => {
  const goal = String(spec.inputs.goal)
  const feedback = spec.retryHint
    ? `
An independent verifier rejected your previous answer against a rubric you cannot see.
Verifier feedback — address every point:
${spec.retryHint}
`
    : ""
  return `You are the answering agent for loop \`${spec.loopId}\`.

Goal:
${goal}
${feedback}
Rules:
- Respond with the answer text only — no preamble, no meta-commentary.
- Do not use tools. Do not read or write files.
`
}

/** The independent verifier's prompt. Exported: Pilot 3 grades with the same words. */
export const gradePrompt: PromptTemplate = (spec) => {
  const rubric = String(spec.inputs.rubric)
  const answer = String(spec.inputs.answer)
  return `You are an INDEPENDENT verifier for loop \`${spec.loopId}\`. You did not write the answer below; grade it against the rubric exactly as written.

Rubric:
${rubric}

Candidate answer (the only evidence):
"""
${answer}
"""

Rules:
- passed = true ONLY if every rubric requirement is met. Be strict.
- feedback: one to three sentences the producer can act on without seeing the rubric.
- missing: each unmet rubric requirement, verbatim enough to act on; empty when passed.
- Do not use tools. Do not read or write files. Return only the structured verdict.
`
}

// --------------------------------------------------------------------- loop

/** Pilot 2 as data: `goal, rubric -> answer, verdict`. */
export const verifiedAnswerLoop: Loop<{ goal: string; rubric: string }, { answer: string; verdict: string }> = {
  id: LOOP_ID,
  version: LOOP_VERSION,
  signature: sig(z.object({ goal: z.string(), rubric: z.string() }), z.object({ answer: z.string(), verdict: z.string() })),
  steps: [
    {
      id: "answer",
      signature: sig(z.object({ goal: z.string() }), z.object({ answer: z.string() })), // no rubric: the producer is graded blind
      executor: "codex",
      effects: noEffects(), // the loop produces a value, not files; any write escalates
      prompt: answerPrompt,
      // The model's text IS the answer — a deterministic projection, no
      // second structured-output turn for a value the engine already has.
      outputFrom: (result) => (typeof result.output.text === "string" ? { answer: result.output.text } : {}),
      timeoutMs: 300_000,
    },
    {
      id: "grade",
      signature: sig(z.object({ rubric: z.string(), answer: z.string() }), verdictOutput),
      executor: "judge", // a distinct executor invocation — fresh context, never self-critique
      effects: noEffects(),
      prompt: gradePrompt,
      structuredOutput: true, // engine derives the JSON schema from verdictOutput above
      timeoutMs: 300_000,
    },
  ],
  policy: until((verdict) => verdict.passed === true, {
    maxIterations: 3,
    restartAt: "answer",
    feedbackFrom: feedbackFromVerdict,
    base: retryPolicy({ maxAttempts: 2 }), // transient/contract failures stay same-step retries
  }),
  trust: "active",
  ledger: {},
}

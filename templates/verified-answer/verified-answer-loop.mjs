// The verified-answer template: iterate-until-verified as five-slot data.
//
//   goal, rubric -> answer, verdict
//   steps:  answer (an agent produces a value)
//        -> grade  (an INDEPENDENT LLM judge, structured verdict)
//   policy: until(verdict.passed, max 3 iterations, feedback threaded back)
//
// The producer never sees the rubric — only the goal and, after a failed
// grade, the verifier's feedback. The verifier holds the rubric. That split
// is what makes the verification independent (never self-critique) and a
// first-iteration failure genuinely possible, so the loop-back path is
// real, not decorative. It descends from vernier's live Pilot 2 — the
// generalizability proof: a non-coding, iterate-until-verified loop in the
// SAME five slots as a script loop and a coding loop.
//
// NO PROVIDER IS SPECIAL HERE. The answer step declares the executor id
// `agent` — a binding target; the shipped vernier.config.json points it at
// codex, and any wired provider can fill it (the step is effect-free, so
// even the read-only providers qualify):
//
//   vernier run verified-answer --executor answer=claude ...
//
// `judge` is vernier's built-in independent structured-output executor —
// each invocation is a fresh provider conversation (codex-backed by
// default; the backing provider is a constructor binding, see the README).

import { noEffects, retryPolicy, sig, until } from "vernier"
import { z } from "zod"

const LOOP_ID = "verified-answer"
const LOOP_VERSION = "0.2.0" // 0.1.0 + any-agent role id for the producer

// ------------------------------------------------------------------ verdict

/**
 * The verifier's output: rubric, evidence -> passed, feedback, missing.
 * This zod object is the ONE source of truth — the engine derives the
 * judge's provider-facing JSON schema from it (structuredOutput: true);
 * no hand-written schema exists anywhere for this step.
 */
export const verdictOutput = z.object({
  passed: z.boolean(),
  feedback: z.string(),
  missing: z.array(z.string()),
})

/** Render a failed verdict as the feedback the next iteration's producer sees. */
export function feedbackFromVerdict(output) {
  const feedback = typeof output.feedback === "string" ? output.feedback : ""
  const missing = Array.isArray(output.missing) ? output.missing.filter((m) => typeof m === "string") : []
  return [feedback, ...missing.map((m) => `- missing: ${m}`)].filter(Boolean).join("\n")
}

// ------------------------------------------------------------------ prompts

const answerPrompt = (spec) => {
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

/** The independent verifier's prompt. */
export const gradePrompt = (spec) => {
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

const loop = {
  id: LOOP_ID,
  version: LOOP_VERSION,
  signature: sig(z.object({ goal: z.string(), rubric: z.string() }), z.object({ answer: z.string(), verdict: z.string() })),
  steps: [
    {
      id: "answer",
      signature: sig(z.object({ goal: z.string() }), z.object({ answer: z.string() })), // no rubric: the producer is graded blind
      executor: "agent", // a binding target, not a provider — see the header
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

// ---------------------------------------------------------- registration

export default {
  loop,
  summary:
    "A bound agent answers, an independent judge grades against a hidden rubric, until passed (LIVE; the answer binding ships on codex — point it at any wired agent).",
  signature: "goal:string, rubric:string -> answer:string, verdict:string",
  live: true,
}

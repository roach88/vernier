// The self-improving template: compounding-answer — the FULL self-improving
// agent: consult memory first; produce; grade against the rubric
// (independent verifier); if it fails, self-correct with the verifier's
// feedback; when verified, DISTILL one reusable rule and remember it — so
// the NEXT run, on a related goal, recalls the rule and does better. Memory
// is what makes the loop compound ACROSS runs instead of merely converging
// within one. It descends from vernier's live Pilot 3.
//
//   goal, rubric -> answer, verdict, learnedRule
//   steps:  recall   (deterministic store read; runs once — restartAt skips it)
//        -> answer   (an agent; sees recalled rules + on-retry verifier feedback)
//        -> grade    (INDEPENDENT LLM judge; holds the rubric)
//        -> distill  (INDEPENDENT LLM; verified answer -> ONE general rule)
//        -> remember (deterministic store write; only reachable post-pass)
//   policy: until(grade.passed, at "grade", restartAt "answer", max 3)
//
// Verified-rules-only is enforced by SHAPE, not convention: remember sits
// after grade, and an unmet predicate iterates back to answer — there is no
// path to the store that does not pass through a passing verdict.
//
// NO PROVIDER IS SPECIAL HERE. The answer step declares the executor id
// `agent` — a binding target; the shipped vernier.config.json points it at
// codex, and any wired provider can fill it (the step is effect-free).
// `recall`/`remember` are vernier's built-in deterministic store operations;
// `grade` and `distill` both run on the built-in `judge` executor — the same
// independent, structured-output, read-only kind, and every invocation is a
// fresh provider conversation (rebind either step with --executor).

import { noEffects, retryPolicy, sig, until } from "vernier"
import { z } from "zod"

const LOOP_ID = "compounding-answer"
const LOOP_VERSION = "0.2.0" // 0.1.0 + any-agent role id for the producer; distill rides the judge executor

// -------------------------------------------------------------------- topic

/**
 * The recall/remember key, derived DETERMINISTICALLY from the goal inside
 * the step input signatures (a zod transform — the signature IS the
 * derivation, so no executor invents a topic). Normalized to the goal's
 * keywords; the store's retriever then matches RELATED goals ("write a
 * short note on X" recalls rules learned writing about Y).
 */
export function topicFrom(goal) {
  return [
    ...new Set(
      goal
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4),
    ),
  ].join(" ")
}

// ------------------------------------------------------------------ verdict

/**
 * The verifier's output — the one source of truth the engine derives the
 * judge's provider-facing JSON schema from (structuredOutput: true).
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

// ------------------------------------------------------------------ distill

/**
 * Distill's structured output: ONE reusable rule. As with the verdict, this
 * zod object is the one source of truth for the provider JSON schema.
 */
export const distilledRule = z.object({ rule: z.string() })

const distillPrompt = (spec) => {
  const goal = String(spec.inputs.goal)
  const answer = String(spec.inputs.answer)
  return `You are an INDEPENDENT rule distiller for loop \`${spec.loopId}\`. The answer below was just VERIFIED by a strict independent grader. Your job is to extract the lesson, not the content.

Goal the answer satisfied:
${goal}

Verified answer:
"""
${answer}
"""

Distill ONE reusable rule for future answers to RELATED goals (different subject, same kind of task):
- Identify every non-obvious property of this answer that a careless first draft for a related goal would miss — exact required phrasing, where that phrasing must appear, concrete specifics like a date or year, length discipline.
- Compress them into ONE imperative rule (clauses are fine). Where exact wording matters, quote it verbatim and say where it belongs (e.g. "as the final sentence, on its own").
- It must generalize: do NOT restate the answer's subject matter; a rule about its content is useless to the next goal.
- Do not use tools. Do not read or write files. Return only the structured rule.
`
}

// ------------------------------------------------------------------ prompts

const answerPrompt = (spec) => {
  const goal = String(spec.inputs.goal)
  const rules = Array.isArray(spec.inputs.rules) ? spec.inputs.rules.map(String) : []
  const remembered = rules.length
    ? `
Rules recalled from memory — distilled from previously VERIFIED answers to related goals. Apply every one of them:
${rules.map((r) => `- ${r}`).join("\n")}
`
    : ""
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
${remembered}${feedback}
Rules:
- Respond with the answer text only — no preamble, no meta-commentary.
- Do not use tools. Do not read or write files.
`
}

/** The independent verifier's prompt. */
const gradePrompt = (spec) => {
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
  signature: sig(
    z.object({ goal: z.string(), rubric: z.string() }),
    // `rule` (distill's field) surfaces as `learnedRule` in the loop's promise.
    z
      .object({ answer: z.string(), verdict: z.string(), rule: z.string() })
      .transform(({ answer, verdict, rule }) => ({ answer, verdict, learnedRule: rule })),
  ),
  steps: [
    {
      id: "recall",
      // Consult memory FIRST. The input signature derives the topic from the goal.
      signature: sig(
        z.object({ goal: z.string() }).transform(({ goal }) => ({ topic: topicFrom(goal) })),
        z.object({ rules: z.array(z.string()) }),
      ),
      executor: "recall", // built-in deterministic store read — no LLM
      effects: noEffects(),
    },
    {
      id: "answer",
      // No rubric: the producer is graded blind. It sees recalled rules and,
      // after a failed grade, the verifier's feedback (spec.retryHint).
      signature: sig(z.object({ goal: z.string(), rules: z.array(z.string()) }), z.object({ answer: z.string() })),
      executor: "agent", // a binding target, not a provider — see the header
      effects: noEffects(), // the loop produces values + memory records, not files
      prompt: answerPrompt,
      outputFrom: (result) => (typeof result.output.text === "string" ? { answer: result.output.text } : {}),
      timeoutMs: 300_000,
    },
    {
      id: "grade",
      signature: sig(z.object({ rubric: z.string(), answer: z.string() }), verdictOutput),
      executor: "judge", // independent: fresh context, holds the rubric, never self-critique
      effects: noEffects(),
      prompt: gradePrompt,
      structuredOutput: true, // engine derives the JSON schema from verdictOutput
      timeoutMs: 300_000,
    },
    {
      id: "distill",
      // Only reachable once the grade passed: distill sees a VERIFIED answer.
      // Same executor KIND as grade (independent, structured-output,
      // read-only) — and each judge invocation is a fresh conversation, so
      // riding the same `judge` id keeps the independence claim intact.
      signature: sig(z.object({ goal: z.string(), answer: z.string() }), distilledRule),
      executor: "judge",
      effects: noEffects(),
      prompt: distillPrompt,
      structuredOutput: true, // engine derives the JSON schema from distilledRule
      timeoutMs: 300_000,
    },
    {
      id: "remember",
      // Deterministic store write: the rule, with the verified answer as its
      // evidence, filed under the same goal-derived topic recall used.
      signature: sig(
        z
          .object({ goal: z.string(), rule: z.string(), answer: z.string() })
          .transform(({ goal, rule, answer }) => ({ topic: topicFrom(goal), rule, evidence: answer })),
        z.object({ stored: z.boolean(), id: z.string() }),
      ),
      executor: "remember", // built-in deterministic store write — no LLM
      effects: noEffects(),
    },
  ],
  policy: until((verdict) => verdict.passed === true, {
    at: "grade", // grade sits mid-sequence: predicate-met continues positionally to distill
    maxIterations: 3,
    restartAt: "answer", // recall runs once; loop-backs skip it
    feedbackFrom: feedbackFromVerdict,
    base: retryPolicy({ maxAttempts: 2 }), // transient/contract failures stay same-step retries
  }),
  trust: "active",
  ledger: {},
}

// ---------------------------------------------------------- registration
// The memory store is provided by the runtime (one durable store under the
// vernier root, shared across CLI invocations — sharing it across runs IS
// the compounding seam).

export default {
  loop,
  summary:
    "recall -> answer -> grade -> distill -> remember; memory compounds across runs (LIVE; the answer binding ships on codex — point it at any wired agent).",
  signature: "goal:string, rubric:string -> answer:string, verdict:string, learnedRule:string",
  live: true,
}

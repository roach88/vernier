// Pilot 2 end-to-end with scripted workers (no network, no auth): the
// verified-answer loop fails its first grade, iterates with the judge's
// feedback, and passes — through the REAL executors (CodexExecutor,
// JudgeExecutor) and the real tick engine. Plus the structured-output
// derivation proof: the schema the judge's provider receives is derived
// from the step's zod signature, not hand-written anywhere.

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { zodToJsonSchema } from "zod-to-json-schema"
import { runLoop } from "../src/engine/tick.js"
import { CodexExecutor } from "../src/executors/codex.js"
import { JudgeExecutor } from "../src/executors/judge.js"
import { executorRegistry } from "../src/executors/script.js"
import type { Worker, WorkerContext } from "../src/executors/vendor/omegacode/index.js"
import type { AgentResult, AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { derivedOutputSchema } from "../src/kernel/types.js"
import { Ledger } from "../src/ledger/ledger.js"
import { feedbackFromVerdict, verdictOutput, verifiedAnswerLoop } from "../src/pilot2/loop.js"

const GOAL = "Write a short note explaining why the Apollo 11 mission mattered."
const RUBRIC = "PASS only if the note states the year 1969."

/** A worker that replays a queue of results and records every AgentSpec it received. */
function scriptedWorker(queue: AgentResult[]): { worker: Worker; seen: AgentSpec[] } {
  const seen: AgentSpec[] = []
  let i = 0
  const worker: Worker = {
    id: "codex",
    async runAgent(s: AgentSpec, _ctx: WorkerContext) {
      seen.push(s)
      const result = queue[Math.min(i, queue.length - 1)]!
      i += 1
      return result
    },
    async shutdown() {},
  }
  return { worker, seen }
}

const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 }
const text = (t: string): AgentResult => ({ text: t, status: "completed", usage })
const verdict = (v: { passed: boolean; feedback: string; missing: string[] }): AgentResult => ({
  text: JSON.stringify(v),
  structured: v,
  status: "completed",
  usage,
})

function harness(answers: AgentResult[], verdicts: AgentResult[]) {
  const answerer = scriptedWorker(answers)
  const judge = scriptedWorker(verdicts)
  const ledgerRoot = mkdtempSync(join(tmpdir(), "looper-pilot2-ledger-"))
  const loop = { ...verifiedAnswerLoop, ledger: { root: ledgerRoot } }
  const deps = {
    executors: executorRegistry(new CodexExecutor({ worker: answerer.worker }), new JudgeExecutor({ worker: judge.worker })),
    contracts: new ContractRegistry(),
    workdir: mkdtempSync(join(tmpdir(), "looper-pilot2-work-")),
  }
  return { loop, deps, answerer, judge, ledgerRoot }
}

describe("pilot 2: verified-answer with scripted workers", () => {
  it("fails the first grade, iterates with the judge's feedback, passes the second", async () => {
    const { loop, deps, answerer, judge, ledgerRoot } = harness(
      [text("The moon landing was neat."), text("In 1969, Apollo 11 landed on the Moon.")],
      [
        verdict({ passed: false, feedback: "State the year of the landing.", missing: ["states the year 1969"] }),
        verdict({ passed: true, feedback: "", missing: [] }),
      ],
    )

    const outcome = await runLoop(loop, { goal: GOAL, rubric: RUBRIC }, deps)

    expect(outcome.state.status).toBe("done")
    expect(outcome.state.iteration).toBe(2)
    expect(outcome.output).toEqual({ answer: "In 1969, Apollo 11 landed on the Moon.", verdict: "success" })

    // Feedback threading: the second answer prompt carries the judge's words.
    expect(answerer.seen).toHaveLength(2)
    expect(answerer.seen[0]!.prompt).not.toContain("verifier rejected")
    expect(answerer.seen[1]!.prompt).toContain("State the year of the landing.")
    expect(answerer.seen[1]!.prompt).toContain("missing: states the year 1969")

    // Independence: the producer is graded blind — the rubric reaches only the judge.
    for (const s of answerer.seen) expect(s.prompt).not.toContain(RUBRIC)
    for (const s of judge.seen) {
      expect(s.prompt).toContain(RUBRIC)
      expect(s.sandbox).toBe("read-only")
    }
    // Each answer is judged: the candidate text appears in the judge prompt.
    expect(judge.seen[0]!.prompt).toContain("The moon landing was neat.")
    expect(judge.seen[1]!.prompt).toContain("In 1969, Apollo 11 landed on the Moon.")

    // The ledger journals both passes: two answers, two verdicts, iterate then stop.
    const entries = Ledger.load(join(ledgerRoot, "runs", outcome.state.runId, "journal.jsonl"))
    const starts = entries.filter((e) => e.type === "step_started")
    expect(starts.map((s) => (s.type === "step_started" ? `${s.stepId}@${s.iteration}` : ""))).toEqual([
      "answer@1",
      "grade@1",
      "answer@2",
      "grade@2",
    ])
    const decisions = entries.filter((e) => e.type === "decision").map((e) => (e.type === "decision" ? e.decision.kind : ""))
    expect(decisions).toEqual(["continue", "iterate", "continue", "stop"])
  })

  it("derives the judge's outputSchema from the step's zod signature — one source of truth, no hand-written copy", async () => {
    const { loop, deps, judge } = harness(
      [text("answer")],
      [verdict({ passed: true, feedback: "", missing: [] })],
    )
    await runLoop(loop, { goal: GOAL, rubric: RUBRIC }, deps)

    const grade = verifiedAnswerLoop.steps.find((s) => s.id === "grade")!
    expect(grade.structuredOutput).toBe(true)
    // What the provider received is exactly the engine derivation from the signature…
    expect(judge.seen[0]!.schema).toEqual(derivedOutputSchema(grade.signature))
    // …which is exactly the zod-to-json-schema rendering of the verdict zod object.
    const { $schema: _, ...expected } = zodToJsonSchema(verdictOutput, { $refStrategy: "none" }) as Record<string, unknown>
    expect(judge.seen[0]!.schema).toEqual(expected)
    expect(expected).toMatchObject({ type: "object", required: ["passed", "feedback", "missing"] })
  })

  it("escalates to needs_human when the verdict never passes (terminates at maxIterations)", async () => {
    const { loop, deps, answerer } = harness(
      [text("draft")],
      [verdict({ passed: false, feedback: "still missing the year", missing: ["states the year 1969"] })],
    )
    const outcome = await runLoop(loop, { goal: GOAL, rubric: RUBRIC }, deps)

    expect(outcome.state.status).toBe("needs_human")
    expect(outcome.state.iteration).toBe(3) // the loop's maxIterations
    expect(outcome.output).toBeNull()
    expect(answerer.seen).toHaveLength(3)
  })

  it("renders feedback from a verdict as actionable lines", () => {
    expect(feedbackFromVerdict({ passed: false, feedback: "Too vague.", missing: ["the year", "a question"] })).toBe(
      "Too vague.\n- missing: the year\n- missing: a question",
    )
  })

  it("declares the loop as data: five slots, judge step structured, producer blind", () => {
    expect(verifiedAnswerLoop.id).toBe("verified-answer")
    expect(verifiedAnswerLoop.steps.map((s) => s.id)).toEqual(["answer", "grade"])
    expect(verifiedAnswerLoop.steps.map((s) => s.executor)).toEqual(["codex", "judge"])
    expect(verifiedAnswerLoop.trust).toBe("active")
    // Both steps are effect-free: the loop produces a value, not files.
    for (const step of verifiedAnswerLoop.steps) expect(step.effects.allow).toEqual([])
  })
})

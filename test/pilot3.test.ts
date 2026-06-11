// Pilot 3 end-to-end with deterministic fakes (no network, no auth): the
// COMPOUNDING proof. Two runs of the compounding-answer loop share ONE
// memory store. Run 1 (goal A) misses the rubric's non-obvious requirement
// blind, self-corrects on the verifier's feedback, passes, distills a rule,
// remembers it. Run 2 (a RELATED goal B) recalls that rule, pre-empts the
// mistake, and passes in fewer iterations. The fake answerer is behavioral,
// not queue-scripted: it produces a compliant answer IFF its prompt names
// the requirement (via a recalled rule or verifier feedback) — so run 2
// passing first-try is CAUSED by the recalled rule, not by scripting order.

import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runLoop } from "../src/engine/tick.js"
import { CodexExecutor } from "../src/executors/codex.js"
import { JudgeExecutor } from "../src/executors/judge.js"
import { recallExecutor, rememberExecutor } from "../src/executors/memory.js"
import { executorRegistry } from "../src/executors/script.js"
import type { Worker, WorkerContext } from "../src/executors/vendor/omegacode/index.js"
import type { AgentResult, AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { derivedOutputSchema } from "../src/kernel/types.js"
import { Ledger } from "../src/ledger/ledger.js"
import { Memory, rulesPath } from "../src/memory/memory.js"
import { compoundingAnswerLoop, topicFrom } from "../src/pilot3/loop.js"

const GOAL_A = "Write a short note on why the Apollo 11 mission mattered."
const GOAL_B = "Write a short note on why the Hubble Space Telescope mattered." // related: shares write/short/note/mattered
const RUBRIC = `PASS only if ALL of the following hold:
1. Mentions at least one specific year.
2. The final sentence is exactly: "Further study is encouraged."`

// The non-obvious requirement a blind answer misses…
const SENTINEL = "Further study is encouraged."
// …and the reusable rule the fake distiller extracts once an answer passes.
const RULE = `End the answer with the exact sentence "${SENTINEL}"`

const BLIND_ANSWER = "The Apollo mission was a neat thing that people liked."
const COMPLIANT_ANSWER = `In 1969, it changed what humans believed possible. ${SENTINEL}`

const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 }

/** A worker whose result is a FUNCTION of the spec it received (and records every spec). */
function behavioralWorker(respond: (spec: AgentSpec) => AgentResult): { worker: Worker; seen: AgentSpec[] } {
  const seen: AgentSpec[] = []
  const worker: Worker = {
    id: "codex",
    async runAgent(s: AgentSpec, _ctx: WorkerContext) {
      seen.push(s)
      return respond(s)
    },
    async shutdown() {},
  }
  return { worker, seen }
}

/** The candidate answer the judge was given, parsed from the grade prompt's evidence block. */
function candidateOf(spec: AgentSpec): string {
  const match = spec.prompt.match(/"""\n([\s\S]*?)\n"""/)
  return match?.[1] ?? ""
}

function harness() {
  // The fake producer misses the requirement until something in its prompt names it.
  const answerer = behavioralWorker((s) => ({
    text: s.prompt.includes(SENTINEL) ? COMPLIANT_ANSWER : BLIND_ANSWER,
    status: "completed",
    usage,
  }))
  // The fake judge grades the CANDIDATE only (not the rubric text around it).
  const judge = behavioralWorker((s) => {
    const passed = candidateOf(s).includes(SENTINEL)
    const verdict = passed
      ? { passed: true, feedback: "", missing: [] }
      : { passed: false, feedback: `End with the exact sentence "${SENTINEL}"`, missing: [`final sentence is exactly "${SENTINEL}"`] }
    return { text: JSON.stringify(verdict), structured: verdict, status: "completed", usage }
  })
  // The fake distiller always extracts the same reusable rule from a verified answer.
  const distiller = behavioralWorker(() => ({
    text: JSON.stringify({ rule: RULE }),
    structured: { rule: RULE },
    status: "completed",
    usage,
  }))

  const memoryRoot = mkdtempSync(join(tmpdir(), "vernier-pilot3-memory-"))
  const memory = new Memory(rulesPath(memoryRoot))
  const ledgerRoot = mkdtempSync(join(tmpdir(), "vernier-pilot3-ledger-"))
  const loop = { ...compoundingAnswerLoop, ledger: { root: ledgerRoot } }
  const deps = {
    executors: executorRegistry(
      new CodexExecutor({ worker: answerer.worker }),
      new JudgeExecutor({ worker: judge.worker }),
      new JudgeExecutor({ id: "distill", worker: distiller.worker }),
      recallExecutor,
      rememberExecutor,
    ),
    contracts: new ContractRegistry(),
    workdir: mkdtempSync(join(tmpdir(), "vernier-pilot3-work-")),
    memory, // ONE store, shared by every run that uses these deps
  }
  return { loop, deps, memory, ledgerRoot, answerer, judge, distiller }
}

const stepsStarted = (ledgerRoot: string, runId: string): string[] =>
  Ledger.load(join(ledgerRoot, "runs", runId, "journal.jsonl"))
    .filter((e) => e.type === "step_started")
    .map((e) => (e.type === "step_started" ? `${e.stepId}@${e.iteration}` : ""))

describe("pilot 3: compounding across two runs sharing one memory store", () => {
  it("run 1 learns a rule; run 2 recalls it and passes in fewer iterations", async () => {
    const { loop, deps, memory, ledgerRoot, answerer } = harness()

    // ---- run 1: goal A, empty memory — fails blind, corrects, learns.
    const run1 = await runLoop(loop, { goal: GOAL_A, rubric: RUBRIC }, deps)
    expect(run1.state.status).toBe("done")
    expect(run1.state.iteration).toBe(2) // blind miss, then feedback-driven pass
    expect(run1.output?.learnedRule).toBe(RULE)
    expect(stepsStarted(ledgerRoot, run1.state.runId)).toEqual([
      "recall@1", // consult memory first (empty)
      "answer@1",
      "grade@1", // fails -> iterate back to answer (recall is NOT re-run)
      "answer@2",
      "grade@2", // passes -> continue positionally
      "distill@2",
      "remember@2",
    ])
    // The rule landed in the store, filed under goal A's topic, evidence = the verified answer.
    const stored = await memory.recall(topicFrom(GOAL_A))
    expect(stored.map((r) => r.rule)).toEqual([RULE])
    expect(stored[0]).toMatchObject({ evidence: COMPLIANT_ANSWER, sourceRunId: run1.state.runId, loopId: loop.id })

    // ---- run 2: RELATED goal B, same deps, same store.
    const run2 = await runLoop(loop, { goal: GOAL_B, rubric: RUBRIC }, deps)
    expect(run2.state.status).toBe("done")
    expect(run2.state.iteration).toBe(1) // the recalled rule pre-empted the mistake
    expect(run2.state.iteration).toBeLessThan(run1.state.iteration) // THE compounding claim
    expect(stepsStarted(ledgerRoot, run2.state.runId)).toEqual([
      "recall@1",
      "answer@1",
      "grade@1", // passes first try
      "distill@1",
      "remember@1",
    ])

    // Run 2's recall surfaced run 1's rule (ledger shows it entering the data plane)…
    const run2Entries = Ledger.load(join(ledgerRoot, "runs", run2.state.runId, "journal.jsonl"))
    const recall2 = run2Entries.find((e) => e.type === "step_result" && e.stepId === "recall")
    expect(recall2?.type === "step_result" && recall2.output.rules).toEqual([RULE])
    // …and the rule reached run 2's answer-step input: its FIRST prompt carries it.
    const run2FirstAnswerPrompt = answerer.seen[2]!.prompt // seen: run1 blind, run1 retry, run2 first
    expect(run2FirstAnswerPrompt).toContain("Rules recalled from memory")
    expect(run2FirstAnswerPrompt).toContain(RULE)
    // Run 1's first prompt had neither memory nor feedback; its retry had feedback, not memory.
    expect(answerer.seen[0]!.prompt).not.toContain("Rules recalled from memory")
    expect(answerer.seen[0]!.prompt).not.toContain("Verifier feedback")
    expect(answerer.seen[1]!.prompt).toContain("Verifier feedback")
    expect(answerer.seen[1]!.prompt).not.toContain("Rules recalled from memory")
  })

  it("memory holds verified rules only: a never-passing run writes nothing to the store", async () => {
    const { loop, deps, memory } = harness()
    const neverPassJudge = behavioralWorker(() => {
      const verdict = { passed: false, feedback: "not good enough", missing: ["unmeetable"] }
      return { text: JSON.stringify(verdict), structured: verdict, status: "completed" as const, usage }
    })
    const depsNeverPass = {
      ...deps,
      executors: executorRegistry(
        new CodexExecutor({ worker: behavioralWorker(() => ({ text: BLIND_ANSWER, status: "completed", usage })).worker }),
        new JudgeExecutor({ worker: neverPassJudge.worker }),
        new JudgeExecutor({ id: "distill", worker: behavioralWorker(() => ({ text: "unreachable", status: "completed", usage })).worker }),
        recallExecutor,
        rememberExecutor,
      ),
    }
    const outcome = await runLoop(loop, { goal: GOAL_A, rubric: RUBRIC }, depsNeverPass)
    expect(outcome.state.status).toBe("needs_human") // escalated at the iteration ceiling
    expect(existsSync(memory.path)).toBe(false) // nothing was EVER appended
    expect(await memory.recall(topicFrom(GOAL_A))).toEqual([]) // no path to the store without a passing grade
  })

  it("derives distill's outputSchema from its zod signature — same one-source-of-truth as the judge", async () => {
    const { loop, deps, distiller } = harness()
    await runLoop(loop, { goal: GOAL_A, rubric: RUBRIC }, deps)
    const distillStep = compoundingAnswerLoop.steps.find((s) => s.id === "distill")!
    expect(distillStep.structuredOutput).toBe(true)
    expect(distiller.seen[0]!.schema).toEqual(derivedOutputSchema(distillStep.signature))
    expect(distiller.seen[0]!.sandbox).toBe("read-only") // a distiller that can write is not a distiller
  })

  it("declares the loop as data: consult memory first, grade independently, distill, remember", () => {
    expect(compoundingAnswerLoop.id).toBe("compounding-answer")
    expect(compoundingAnswerLoop.steps.map((s) => s.id)).toEqual(["recall", "answer", "grade", "distill", "remember"])
    expect(compoundingAnswerLoop.steps.map((s) => s.executor)).toEqual(["recall", "codex", "judge", "distill", "remember"])
    expect(compoundingAnswerLoop.trust).toBe("active")
    // The loop produces values + memory records, never files.
    for (const step of compoundingAnswerLoop.steps) expect(step.effects.allow).toEqual([])
  })

  it("relates goals by topic keywords (the honest, keyword-only retrieval contract)", () => {
    const a = topicFrom(GOAL_A)
    const b = topicFrom(GOAL_B)
    expect(a).toContain("apollo")
    expect(b).toContain("hubble")
    const shared = [...a.split(" ")].filter((t) => b.split(" ").includes(t))
    expect(shared).toEqual(expect.arrayContaining(["write", "short", "note", "mattered"]))
  })
})

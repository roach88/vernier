// Run Pilot 3 LIVE end-to-end, TWICE, sharing ONE memory store: `npm run pilot3`
//
// THE POINT IS COMPOUNDING, so the demo is two runs, not one:
//   run 1 (goal A): memory is empty; the blind first answer plausibly misses
//          the rubric's non-obvious requirement (the exact closing sentence),
//          iterates on the verifier's feedback, passes, DISTILLS the lesson
//          into one reusable rule, and remembers it.
//   run 2 (goal B, RELATED): recall surfaces run 1's rule; the answer prompt
//          carries it, so the producer should pre-empt the mistake and pass
//          in fewer iterations — ideally the first.
// Iteration counts and recalled rules are printed per run so the compounding
// (or its absence — live models vary) is visible, and the ledgers prove it.
//
// Safety posture (same as Pilot 2, do not loosen):
//   - The loop produces VALUES + memory records, not files. Every step is
//     noEffects(): codex/judge/distill run read-only; any write escalates.
//   - The workdir is a THROWAWAY /tmp scratch dir per run.
//   - The memory store defaults to a fresh /tmp dir per demo invocation so
//     run 1 always starts blank (pass a path to share/persist a store).
//
// Requires a live authed `codex` CLI on PATH. The default `npm test` never
// runs this; the fake-backed compounding proof lives in test/pilot3.test.ts
// and the gated live test in test/pilot3.live.test.ts (LOOPER_LIVE=1).

import { mkdtempSync } from "node:fs"
import { resolve } from "node:path"
import { runLoop } from "../engine/tick.js"
import { CodexExecutor } from "../executors/codex.js"
import { JudgeExecutor } from "../executors/judge.js"
import { recallExecutor, rememberExecutor } from "../executors/memory.js"
import { executorRegistry } from "../executors/script.js"
import { ContractRegistry } from "../kernel/contract.js"
import { Ledger, journalPath, resolveLedgerRoot } from "../ledger/ledger.js"
import { Memory, rulesPath } from "../memory/memory.js"
import { compoundingAnswerLoop, topicFrom } from "./loop.js"

const memoryRoot = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync("/tmp/looper-pilot3-memory-")
const memory = new Memory(rulesPath(memoryRoot))

const rubric = `PASS only if ALL of the following hold:
1. Mentions at least one specific year.
2. Is no more than 120 words long.
3. The final sentence is exactly: "Further study is encouraged."`

const goalA = "Write a short note on why the Apollo 11 mission mattered."
const goalB = "Write a short note on why the Hubble Space Telescope mattered."

const answerer = new CodexExecutor() // producer: its own worker process
const judge = new JudgeExecutor() // verifier: separate process, holds the rubric
const distiller = new JudgeExecutor({ id: "distill" }) // distiller: a third independent instance

interface RunSummary {
  readonly status: string
  readonly iterations: number
  readonly recalled: readonly string[]
  readonly learnedRule: string
  readonly answer: string
  readonly journal: string
}

async function runOnce(label: string, goal: string): Promise<RunSummary> {
  const workdir = mkdtempSync(`/tmp/looper-pilot3-${label}-`)
  const deps = {
    executors: executorRegistry(answerer, judge, distiller, recallExecutor, rememberExecutor),
    contracts: new ContractRegistry(),
    workdir,
    memory, // the ONE store both runs share — this is the compounding seam
  }
  console.log(`--- ${label}: ${goal}`)
  console.log(`    topic: ${topicFrom(goal)}`)
  const outcome = await runLoop(compoundingAnswerLoop, { goal, rubric }, deps)
  const journal = journalPath(resolveLedgerRoot(compoundingAnswerLoop.ledger), outcome.state.runId)
  const entries = Ledger.load(journal)
  const recallResult = entries.find((e) => e.type === "step_result" && e.stepId === "recall")
  const recalled =
    recallResult?.type === "step_result" && Array.isArray(recallResult.output.rules)
      ? recallResult.output.rules.map(String)
      : []
  const summary: RunSummary = {
    status: outcome.state.status,
    iterations: outcome.state.iteration,
    recalled,
    learnedRule: String(outcome.output?.learnedRule ?? ""),
    answer: String(outcome.output?.answer ?? ""),
    journal,
  }
  console.log(`    status=${summary.status} iterations=${summary.iterations} recalled=${recalled.length}`)
  for (const rule of recalled) console.log(`    recalled rule: ${rule}`)
  if (summary.learnedRule) console.log(`    learned rule:  ${summary.learnedRule}`)
  console.log(`    ledger: ${journal}`)
  for (const e of entries) {
    if (e.type === "step_started") console.log(`      step ${e.stepId}@iter${e.iteration} (${e.executorId})`)
    if (e.type === "decision") console.log(`        -> ${e.decision.kind}/${e.decision.classification}`)
  }
  console.log(`    answer:\n${summary.answer.replace(/^/gm, "      ")}`)
  return summary
}

console.log(`loop    ${compoundingAnswerLoop.id}@${compoundingAnswerLoop.version} (trust: ${compoundingAnswerLoop.trust})`)
console.log(`memory  ${rulesPath(memoryRoot)} (shared across both runs)`)
console.log(`rubric  (judge-only)\n${rubric.replace(/^/gm, "        ")}`)

const run1 = await runOnce("run1", goalA)
const run2 = await runOnce("run2", goalB)
await answerer.shutdown()
await judge.shutdown()
await distiller.shutdown()

const recalledRun1Rule = run2.recalled.includes(run1.learnedRule)
const compounded =
  run1.status === "done" && run2.status === "done" && recalledRun1Rule && run2.iterations < run1.iterations

console.log("=== COMPOUNDING ===")
console.log(`run 1: status=${run1.status} iterations=${run1.iterations} recalled=${run1.recalled.length}`)
console.log(`run 2: status=${run2.status} iterations=${run2.iterations} recalled=${run2.recalled.length}`)
console.log(`run 2 recalled run 1's rule: ${recalledRun1Rule}`)
console.log(
  compounded
    ? `COMPOUNDED: run 2 passed in ${run2.iterations} iteration(s) vs run 1's ${run1.iterations} — the recalled rule pre-empted the mistake.`
    : `did not compound this time (live models vary): see iteration counts above and the ledgers.`,
)

process.exit(run1.status === "done" && run2.status === "done" && recalledRun1Rule ? 0 : 1)

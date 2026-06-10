// Run Pilot 2 LIVE end-to-end: `npm run pilot2`
//
// Safety posture (deliberate, do not loosen):
//   - The loop produces a VALUE, not files. Both steps carry noEffects(),
//     so codex runs read-only (derived; never danger-full-access) and any
//     workdir write would escalate to needs_human.
//   - The workdir is a THROWAWAY empty scratch dir under /tmp; the default
//     hash observer watches it.
//   - The producer and the judge are SEPARATE worker processes — the
//     verdict comes from a fresh context, never self-critique.
//
// The rubric is held by the judge only; the producer sees the goal and, on
// later iterations, the verifier's feedback. A blind first answer plausibly
// fails the rubric, so this run is expected to exercise a real loop-back.
//
// Requires a live authed `codex` CLI on PATH. The default `npm test` never
// runs this; the live test is gated by LOOPER_LIVE=1.

import { mkdtempSync } from "node:fs"
import { resolve } from "node:path"
import { runLoop } from "../engine/tick.js"
import { defaultContractRegistry } from "../kernel/contract.js"
import { Ledger, journalPath, resolveLedgerRoot } from "../ledger/ledger.js"
import { CodexExecutor } from "../executors/codex.js"
import { JudgeExecutor } from "../executors/judge.js"
import { executorRegistry } from "../executors/script.js"
import { verifiedAnswerLoop } from "./loop.js"

const workdir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync("/tmp/looper-pilot2-scratch-")

const goal = "Write a short note explaining why the Apollo 11 mission mattered."
const rubric = `PASS only if ALL of the following hold:
1. States the year 1969.
2. Names Neil Armstrong, Buzz Aldrin, AND Michael Collins.
3. Is between 50 and 120 words long.
4. Ends with a single question inviting further study.`

const answerer = new CodexExecutor() // producer: its own worker process
const judge = new JudgeExecutor() // verifier: a separate worker process — independent by construction
const deps = {
  executors: executorRegistry(answerer, judge),
  contracts: defaultContractRegistry(),
  workdir,
}

console.log(`loop      ${verifiedAnswerLoop.id}@${verifiedAnswerLoop.version} (trust: ${verifiedAnswerLoop.trust})`)
console.log(`workdir   ${workdir} (scratch; both steps noEffects -> read-only)`)
console.log(`goal      ${goal}`)
console.log(`rubric    (judge-only)\n${rubric.replace(/^/gm, "          ")}`)
console.log("--- running (codex answer -> independent judge -> until passed) ---")

const outcome = await runLoop(verifiedAnswerLoop, { goal, rubric }, deps)
await answerer.shutdown()
await judge.shutdown()

const { state, decision, output } = outcome
const journal = journalPath(resolveLedgerRoot(verifiedAnswerLoop.ledger), state.runId)
const entries = Ledger.load(journal)

console.log(`status     ${state.status}`)
console.log(`iterations ${state.iteration}`)
console.log(`decision   ${decision.kind} / ${decision.classification} — ${decision.summary}`)
console.log(`verdict    ${output?.verdict ?? "none"}`)
console.log(`ledger     ${journal}`)
console.log("--- answer ---")
console.log(output?.answer ?? "(none)")
console.log("--- ledger entries ---")
for (const entry of entries) {
  const detail =
    entry.type === "meta"
      ? `${entry.loopId}@${entry.loopVersion}`
      : entry.type === "decision"
        ? `${entry.stepId} iter=${entry.iteration} attempt=${entry.attempt} -> ${entry.decision.kind}/${entry.decision.classification}`
        : entry.type === "step_result"
          ? `${entry.stepId} iter=${entry.iteration} attempt=${entry.attempt} status=${entry.status}` +
            (entry.stepId === "grade" && entry.outputValid ? ` passed=${(entry.output as { passed?: unknown }).passed}` : "")
          : `${entry.stepId} iter=${entry.iteration} attempt=${entry.attempt}`
  console.log(`  ${entry.type.padEnd(13)} ${detail}`)
}

process.exit(state.status === "done" ? 0 : 1)

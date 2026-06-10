// LIVE Pilot 2: codex answer + independent codex judge, end-to-end through
// tick(), producing a VALUE (no file effects — both steps run read-only).
// Gated behind LOOPER_LIVE=1 so the default `npm test` stays green without
// auth or network:
//
//   LOOPER_LIVE=1 npm test -- pilot2.live
//
// Requires an authed `codex` CLI on PATH. The judge holds the rubric; the
// producer answers blind, so a first-iteration failure (and a real
// loop-back with threaded feedback) is plausible — but a live model may
// also pass at once, so iteration count is reported, not asserted.

import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runLoop } from "../src/engine/tick.js"
import { CodexExecutor } from "../src/executors/codex.js"
import { JudgeExecutor } from "../src/executors/judge.js"
import { executorRegistry } from "../src/executors/script.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { Ledger, journalPath } from "../src/ledger/ledger.js"
import { verifiedAnswerLoop } from "../src/pilot2/loop.js"

const LIVE = process.env.LOOPER_LIVE === "1"

describe.runIf(LIVE)("pilot 2 LIVE: verified-answer through tick()", () => {
  it(
    "produces an answer, grades it with the independent judge, and iterates until passed",
    async () => {
      const workdir = mkdtempSync("/tmp/looper-pilot2-live-")
      const ledgerRoot = mkdtempSync("/tmp/looper-pilot2-ledger-")
      const loop = { ...verifiedAnswerLoop, ledger: { root: ledgerRoot } }

      const answerer = new CodexExecutor()
      const judge = new JudgeExecutor()
      const deps = {
        executors: executorRegistry(answerer, judge),
        contracts: new ContractRegistry(),
        workdir,
      }
      try {
        const goal = "Write a short note explaining why the Apollo 11 mission mattered."
        const rubric = `PASS only if ALL of the following hold:
1. States the year 1969.
2. Names Neil Armstrong, Buzz Aldrin, AND Michael Collins.
3. Is between 50 and 120 words long.
4. Ends with a single question inviting further study.`

        const outcome = await runLoop(loop, { goal, rubric }, deps)

        expect(outcome.state.status).toBe("done")
        expect(outcome.output?.verdict).toBe("success")
        expect(String(outcome.output?.answer).length).toBeGreaterThan(0)

        const entries = Ledger.load(journalPath(ledgerRoot, outcome.state.runId))
        const grades = entries.filter((e) => e.type === "step_result" && e.stepId === "grade")
        expect(grades.length).toBeGreaterThanOrEqual(1)
        const last = grades.at(-1)
        expect(last?.type === "step_result" && (last.output as { passed?: unknown }).passed).toBe(true)
        // Every pass stayed effect-free (read-only by construction).
        for (const e of entries) {
          if (e.type === "effects") expect(e.observation.changed).toEqual([])
        }
        console.log(`[pilot2.live] iterations=${outcome.state.iteration} journal=${journalPath(ledgerRoot, outcome.state.runId)}`)
        console.log(`[pilot2.live] answer:\n${String(outcome.output?.answer)}`)
      } finally {
        await answerer.shutdown()
        await judge.shutdown()
      }
    },
    1_200_000, // up to 3 iterations x (answer turn + judge working/extraction turns)
  )
})

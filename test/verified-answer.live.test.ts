// LIVE verified-answer template: codex answer + independent codex judge,
// end-to-end through tick(), producing a VALUE (no file effects — both
// steps run read-only), with the answer role resolved through the
// template's SHIPPED config bindings. Gated behind VERNIER_LIVE=1 so the
// default `npm test` stays green without auth or network:
//
//   VERNIER_LIVE=1 npm test -- verified-answer.live
//
// Requires an authed `codex` CLI on PATH. The judge holds the rubric; the
// producer answers blind, so a first-iteration failure (and a real
// loop-back with threaded feedback) is plausible — but a live model may
// also pass at once, so iteration count is reported, not asserted.

import { mkdtempSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { bindExecutors } from "../src/cli/config.js"
import { runLoop } from "../src/engine/tick.js"
import { CodexExecutor } from "../src/executors/codex.js"
import { JudgeExecutor } from "../src/executors/judge.js"
import { executorRegistry } from "../src/executors/script.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { Ledger, journalPath } from "../src/ledger/ledger.js"
import { templateBindings, templateRegistration } from "./templates.js"

const LIVE = process.env.VERNIER_LIVE === "1"

describe.runIf(LIVE)("verified-answer template LIVE: through tick()", () => {
  it(
    "produces an answer, grades it with the independent judge, and iterates until passed",
    async () => {
      const registration = await templateRegistration("verified-answer", "verified-answer-loop.mjs")
      const workdir = mkdtempSync("/tmp/vernier-verified-answer-live-")
      const ledgerRoot = mkdtempSync("/tmp/vernier-verified-answer-ledger-")
      const loop = bindExecutors({ ...registration.loop, ledger: { root: ledgerRoot } }, [templateBindings("verified-answer")])

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
        console.log(`[verified-answer.live] iterations=${outcome.state.iteration} journal=${journalPath(ledgerRoot, outcome.state.runId)}`)
        console.log(`[verified-answer.live] answer:\n${String(outcome.output?.answer)}`)
      } finally {
        await answerer.shutdown()
        await judge.shutdown()
      }
    },
    1_200_000, // up to 3 iterations x (answer turn + judge working/extraction turns)
  )
})

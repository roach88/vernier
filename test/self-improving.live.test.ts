// LIVE self-improving template: the two-run compounding demo through real
// codex workers, with the answer role resolved through the template's
// SHIPPED config bindings (distill rides the built-in `judge` id, as the
// template declares). Gated behind VERNIER_LIVE=1 so the default `npm test`
// stays green without auth or network:
//
//   VERNIER_LIVE=1 npm test -- self-improving.live
//
// Hard assertions: both runs complete, run 1 stores a rule, run 2 RECALLS it
// (the deterministic part of compounding). The iteration delta — run 2
// passing earlier because of the recalled rule — depends on live model
// behavior, so it is REPORTED, not asserted; the deterministic fake-backed
// proof of the delta lives in self-improving-template.test.ts.

import { mkdtempSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { bindExecutors } from "../src/cli/config.js"
import { runLoop } from "../src/engine/tick.js"
import { CodexExecutor } from "../src/executors/codex.js"
import { JudgeExecutor } from "../src/executors/judge.js"
import { recallExecutor, rememberExecutor } from "../src/executors/memory.js"
import { executorRegistry } from "../src/executors/script.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { Ledger, journalPath } from "../src/ledger/ledger.js"
import { Memory, rulesPath } from "../src/memory/memory.js"
import { templateBindings, templateRegistration } from "./templates.js"

const LIVE = process.env.VERNIER_LIVE === "1"

const RUBRIC = `PASS only if ALL of the following hold:
1. Mentions at least one specific year.
2. Is no more than 120 words long.
3. The final sentence is exactly: "Further study is encouraged."`

describe.runIf(LIVE)("self-improving template LIVE: two runs, one memory store", () => {
  it(
    "run 1 learns and remembers a rule; run 2 recalls it (iteration delta reported)",
    async () => {
      const registration = await templateRegistration("self-improving", "self-improving-loop.mjs")
      const memory = new Memory(rulesPath(mkdtempSync("/tmp/vernier-self-improving-live-memory-")))
      const ledgerRoot = mkdtempSync("/tmp/vernier-self-improving-live-ledger-")
      const loop = bindExecutors({ ...registration.loop, ledger: { root: ledgerRoot } }, [templateBindings("self-improving")])

      const answerer = new CodexExecutor()
      const judge = new JudgeExecutor() // serves grade AND distill — each invocation is a fresh conversation
      const deps = {
        executors: executorRegistry(answerer, judge, recallExecutor, rememberExecutor),
        contracts: new ContractRegistry(),
        workdir: mkdtempSync("/tmp/vernier-self-improving-live-work-"),
        memory,
      }
      try {
        const run1 = await runLoop(loop, { goal: "Write a short note on why the Apollo 11 mission mattered.", rubric: RUBRIC }, deps)
        expect(run1.state.status).toBe("done")
        expect(String(run1.output?.learnedRule).length).toBeGreaterThan(0)

        const run2 = await runLoop(loop, { goal: "Write a short note on why the Hubble Space Telescope mattered.", rubric: RUBRIC }, deps)
        expect(run2.state.status).toBe("done")

        // The deterministic compounding claim: run 2's recall surfaced run 1's rule.
        const entries = Ledger.load(journalPath(ledgerRoot, run2.state.runId))
        const recall = entries.find((e) => e.type === "step_result" && e.stepId === "recall")
        const recalled = recall?.type === "step_result" && Array.isArray(recall.output.rules) ? recall.output.rules.map(String) : []
        expect(recalled).toContain(String(run1.output?.learnedRule))

        console.log(`[self-improving.live] run1 iterations=${run1.state.iteration} learned="${run1.output?.learnedRule}"`)
        console.log(`[self-improving.live] run2 iterations=${run2.state.iteration} recalled=${recalled.length}`)
        console.log(
          run2.state.iteration < run1.state.iteration
            ? `[self-improving.live] COMPOUNDED: ${run2.state.iteration} < ${run1.state.iteration}`
            : `[self-improving.live] no iteration delta this time (live variance) — recall still proven above`,
        )
      } finally {
        await answerer.shutdown()
        await judge.shutdown()
      }
    },
    2_400_000, // two runs x up to 3 iterations x (answer + judge) + distill turns
  )
})

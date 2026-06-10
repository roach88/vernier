// LIVE Pilot 1: hermes route + real codex implement, end-to-end through
// tick(), in a throwaway scratch git repo. Gated behind LOOPER_LIVE=1 so
// the default `npm test` stays green without auth or network:
//
//   LOOPER_LIVE=1 npm test -- pilot1.live
//
// Requires authed `hermes` and `codex` CLIs on PATH. Codex runs under
// sandbox "workspace-write" rooted at the scratch dir (derived from the
// step's EffectScope — never danger-full-access).

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runLoop } from "../src/engine/tick.js"
import { defaultContractRegistry } from "../src/kernel/contract.js"
import { gitObserver } from "../src/kernel/git-effects.js"
import { Ledger, journalPath } from "../src/ledger/ledger.js"
import { CodexExecutor } from "../src/executors/codex.js"
import { HermesExecutor } from "../src/executors/hermes.js"
import { executorRegistry } from "../src/executors/script.js"
import { dryRunNoteV1, expectedArtifactPath, routeDecisionV1 } from "../src/pilot1/contracts.js"
import { planWorkReviewLoop } from "../src/pilot1/loop.js"

const LIVE = process.env.LOOPER_LIVE === "1"

describe.runIf(LIVE)("pilot 1 LIVE: hermes + codex through tick()", () => {
  it(
    "routes, implements, validates dry-run-note.v1, and stays inside the effect scope",
    async () => {
      const scratch = mkdtempSync("/tmp/looper-pilot1-live-")
      mkdirSync(join(scratch, "docs", "agent-workflows"), { recursive: true })
      execFileSync("git", ["init", "--quiet"], { cwd: scratch })
      const ledgerRoot = mkdtempSync("/tmp/looper-pilot1-ledger-")
      const loop = { ...planWorkReviewLoop, ledger: { root: ledgerRoot } }

      const codex = new CodexExecutor()
      const deps = {
        executors: executorRegistry(new HermesExecutor(), codex),
        contracts: defaultContractRegistry().register(routeDecisionV1).register(dryRunNoteV1),
        workdir: scratch,
        observer: gitObserver,
      }
      try {
        const task = "Create the expected dry-run note artifact for this loop. Do not edit any other file."
        const outcome = await runLoop(loop, { task }, deps)

        expect(outcome.state.status).toBe("done")
        expect(outcome.output?.verdict).toBe("success")
        const artifact = String(outcome.output?.artifact)
        expect(artifact).toBe(expectedArtifactPath(outcome.state.traceId))
        expect(existsSync(join(scratch, artifact))).toBe(true)
        expect(readFileSync(join(scratch, artifact), "utf8")).toContain(outcome.state.traceId)

        const entries = Ledger.load(journalPath(ledgerRoot, outcome.state.runId))
        const contracts = entries.filter((e) => e.type === "contract")
        expect(contracts.every((c) => c.type === "contract" && c.result.valid)).toBe(true)
        const effects = entries.filter((e) => e.type === "effects" && e.stepId === "implement").at(-1)
        expect(effects?.type === "effects" && effects.observation.allowed).toBe(true)
      } finally {
        await codex.shutdown()
      }
    },
    900_000, // a live route + worker turn + extraction turn; codex does the real work here
  )
})

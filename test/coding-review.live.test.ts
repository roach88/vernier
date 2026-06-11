// LIVE coding-review template: the plan-work-review loop end-to-end through
// tick() with REAL agent CLIs, resolved through the template's SHIPPED
// config bindings (route + implement on codex), in a throwaway scratch git
// repo. Gated behind VERNIER_LIVE=1 so the default `npm test` stays green
// without auth or network:
//
//   VERNIER_LIVE=1 npm test -- coding-review.live
//
// Requires an authed `codex` CLI on PATH. Codex runs under sandbox
// "workspace-write" rooted at the scratch dir (derived from the step's
// EffectScope — never danger-full-access).

import { existsSync, readFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bindExecutors } from "../src/cli/config.js"
import { runLoop } from "../src/engine/tick.js"
import { defaultContractRegistry } from "../src/kernel/contract.js"
import type { Contract } from "../src/kernel/contract.js"
import { gitObserver } from "../src/kernel/git-effects.js"
import { Ledger, journalPath } from "../src/ledger/ledger.js"
import { CodexExecutor } from "../src/executors/codex.js"
import { executorRegistry } from "../src/executors/script.js"
import { templateBindings, templateModule, templateRegistration } from "./templates.js"

const LIVE = process.env.VERNIER_LIVE === "1"

describe.runIf(LIVE)("coding-review template LIVE: codex route + codex implement through tick()", () => {
  it(
    "routes, implements, validates dry-run-note.v1, and stays inside the effect scope",
    async () => {
      const registration = await templateRegistration("coding-review", "coding-review-loop.mjs")
      const mod = await templateModule("coding-review", "coding-review-loop.mjs")
      const expectedArtifactPath = mod.expectedArtifactPath as (traceId: string) => string

      // The template's own workdir prep: a scratch git repo with the allowed root.
      const scratch = registration.defaultWorkdir!()
      const ledgerRoot = mkdtempSync("/tmp/vernier-coding-review-ledger-")
      // The SHIPPED bindings (route -> codex, implement -> codex), applied
      // exactly as the CLI would apply the template's vernier.config.json.
      const loop = bindExecutors({ ...registration.loop, ledger: { root: ledgerRoot } }, [templateBindings("coding-review")])

      const contracts = defaultContractRegistry()
      for (const contract of registration.contracts ?? []) contracts.register(contract as Contract)

      const codex = new CodexExecutor()
      const deps = {
        executors: executorRegistry(codex),
        contracts,
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
        const contractEntries = entries.filter((e) => e.type === "contract")
        expect(contractEntries.every((c) => c.type === "contract" && c.result.valid)).toBe(true)
        const effects = entries.filter((e) => e.type === "effects" && e.stepId === "implement").at(-1)
        expect(effects?.type === "effects" && effects.observation.allowed).toBe(true)
      } finally {
        await codex.shutdown()
      }
    },
    900_000, // a live route + a single codex working turn (the artifact path is derived from effects, not a second extraction turn)
  )
})

// Pilot 1 (plan-work-review) through the generic tick interpreter with
// FAKE executors behind the same ids the live run uses ("hermes",
// "codex") — the loop declaration cannot tell the difference, which is
// the agent-agnosticism claim in test form. Covers: the contract-pass
// path, the route-rejected path (needs_human, no retry — Python parity),
// and the contract-FAIL -> retry -> escalate path.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { runLoop, startRun, tick, type EngineDeps } from "../src/engine/tick.js"
import { defaultContractRegistry } from "../src/kernel/contract.js"
import type { StepSpec } from "../src/kernel/types.js"
import { Ledger, journalPath } from "../src/ledger/ledger.js"
import { executorRegistry, scriptExecutor } from "../src/executors/script.js"
import { dryRunNoteV1, expectedArtifactPath, routeDecisionV1 } from "../src/pilot1/contracts.js"
import { planWorkReviewLoop } from "../src/pilot1/loop.js"

const TASK = "Create the dry-run note. Do not edit any other file."

function setup(ledgerRoot?: string) {
  const root = mkdtempSync(join(tmpdir(), "looper-pilot1-"))
  const workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  return {
    workdir,
    ledgerRoot: ledgerRoot ?? join(root, "ledger"),
    loop: (lr: string) => ({ ...planWorkReviewLoop, ledger: { root: lr } }),
  }
}

/** A fake hermes: returns the gate verbatim, like the real one parses route JSON. */
function fakeHermes(gateDecision: string, routeToWorker = true, worker = "Codex") {
  return scriptExecutor("hermes", () => ({
    output: {
      gateDecision,
      routeToWorker,
      worker,
      reason: "Task is narrow, local, harmless, reviewable.",
      route: { gate_decision: gateDecision, route_to_worker: routeToWorker, worker },
    },
  }))
}

/** Render a note satisfying dry-run-note.v1 for this spec (what live codex is asked to write). */
function conformingNote(spec: Omit<StepSpec, "prompt">): string {
  const expected = expectedArtifactPath(spec.traceId)
  return `# Dry-Run Note: ${spec.traceId}

## Route
- loop_id: \`${spec.loopId}\`
- loop_version: \`${spec.loopVersion}\`
- worker: \`codex\` executed the worker pass after hermes approved the route.

## Bundle
- bundle path: \`${spec.runDir}\`
- artifact path: \`${expected}\`

## Runner Verification
The runner validates this artifact against the contract and writes the trace.

## Improvement Candidate
Drive this loop from the scheduler instead of a manual run.
`
}

/**
 * A fake codex: writes a note (conforming or not) and — like the real one
 * since the structured-output turn was removed — reports only prose. The
 * `artifact` output field must come from the engine's effect attribution.
 */
function fakeCodex(opts: { conforming: boolean }) {
  return scriptExecutor("codex", (spec, ctx) => {
    const expected = expectedArtifactPath(spec.traceId)
    const absolute = join(ctx.workdir, expected)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, opts.conforming ? conformingNote(spec) : `# A note that ignores the contract\n\nNothing required is here.\n`, "utf8")
    return { output: { text: "Wrote the dry-run note." } }
  })
}

function deps(workdir: string, executors: ReturnType<typeof scriptExecutor>[]): EngineDeps {
  return {
    executors: executorRegistry(...executors),
    contracts: defaultContractRegistry().register(routeDecisionV1).register(dryRunNoteV1),
    workdir,
  }
}

describe("pilot 1: plan-work-review through tick()", () => {
  it("contract-pass path: route -> implement -> done, with artifact and verdict", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    const d = deps(workdir, [fakeHermes("approve"), fakeCodex({ conforming: true })])

    const outcome = await runLoop(loop(ledgerRoot), { task: TASK }, d)

    expect(outcome.state.status).toBe("done")
    expect(outcome.decision.kind).toBe("stop")
    expect(outcome.output?.verdict).toBe("success")
    expect(outcome.output?.artifact).toBe(expectedArtifactPath(outcome.state.traceId))

    const entries = Ledger.load(journalPath(ledgerRoot, outcome.state.runId))
    expect(entries.map((e) => e.type)).toEqual([
      "meta",
      "step_started", "step_result", "contract", "effects", "decision", // route
      "step_started", "step_result", "contract", "effects", "decision", // implement
    ])
    const contracts = entries.filter((e) => e.type === "contract")
    expect(contracts.map((c) => (c.type === "contract" ? c.result.valid : null))).toEqual([true, true])
    const effects = entries.filter((e) => e.type === "effects").at(-1)
    expect(effects?.type === "effects" && effects.observation.changed).toEqual([expectedArtifactPath(outcome.state.traceId)])
  })

  it("threads the route decision into the implement step's inputs (the data plane)", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    let seenRoute: unknown
    const spy = scriptExecutor("codex", (spec, ctx) => {
      seenRoute = spec.inputs.route
      const absolute = join(ctx.workdir, expectedArtifactPath(spec.traceId))
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, conformingNote(spec), "utf8")
      return { output: { text: "ok" } }
    })
    await runLoop(loop(ledgerRoot), { task: TASK }, deps(workdir, [fakeHermes("approve"), spy]))
    expect(seenRoute).toMatchObject({ gate_decision: "approve", route_to_worker: true })
  })

  it("route-rejected path: needs_human after ONE tick — route gate failures are not retryable (Python parity)", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    const d = deps(workdir, [fakeHermes("reject", false), fakeCodex({ conforming: true })])
    const run = startRun(loop(ledgerRoot), { task: TASK }, d)

    const outcome = await tick(run, d)
    expect(outcome.decision.kind).toBe("escalate")
    expect(outcome.state.status).toBe("needs_human")
    expect(outcome.decision.notes.join("\n")).toContain("not retryable")
  })

  it("contract-FAIL -> retry (attempt 2, retry- evidence label) -> escalate at the policy cap", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    const d = deps(workdir, [fakeHermes("approve"), fakeCodex({ conforming: false })])
    const run = startRun(loop(ledgerRoot), { task: TASK }, d)

    const route = await tick(run, d)
    expect(route.decision.kind).toBe("continue")

    const first = await tick(run, d)
    expect(first.decision.kind).toBe("retry")
    expect(first.decision.retryHint).toContain("dry-run-note.v1")
    expect(first.state.attempt).toBe(2)

    const second = await tick(run, d)
    expect(second.decision.kind).toBe("escalate")
    expect(second.state.status).toBe("needs_human")
    expect(second.decision.notes.join("\n")).toContain("reached policy max 2")

    const entries = Ledger.load(journalPath(ledgerRoot, run.state.runId))
    const implementAttempts = entries.filter((e) => e.type === "step_started" && e.stepId === "implement")
    expect(implementAttempts.map((a) => (a.type === "step_started" ? a.attempt : 0))).toEqual([1, 2])
    const failedContract = entries.filter((e) => e.type === "contract" && e.stepId === "implement").at(-1)
    expect(failedContract?.type === "contract" && failedContract.result.valid).toBe(false)
  })

  it("derives `artifact` from effect attribution: a worker that writes nothing (or two files) yields no artifact, deterministically", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    // Writes NOTHING: zero changed-and-allowed files -> no artifact field -> signature retry.
    const idle = scriptExecutor("codex", () => ({ output: { text: "did nothing" } }))
    const d = deps(workdir, [fakeHermes("approve"), idle])
    const run = startRun(loop(ledgerRoot), { task: TASK }, d)
    await tick(run, d) // route
    const outcome = await tick(run, d)
    expect(outcome.decision.kind).toBe("retry")
    expect(outcome.decision.summary).toContain("signature")

    // Writes TWO allowed files: no single candidate -> same deterministic failure.
    const { workdir: wd2, ledgerRoot: lr2, loop: loop2 } = setup()
    const sprawling = scriptExecutor("codex", (spec, ctx) => {
      for (const name of [expectedArtifactPath(spec.traceId), "docs/agent-workflows/extra.md"]) {
        const absolute = join(ctx.workdir, name)
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, conformingNote(spec), "utf8")
      }
      return { output: { text: "wrote two files" } }
    })
    const d2 = deps(wd2, [fakeHermes("approve"), sprawling])
    const run2 = startRun(loop2(lr2), { task: TASK }, d2)
    await tick(run2, d2) // route
    const outcome2 = await tick(run2, d2)
    expect(outcome2.decision.kind).toBe("retry")
  })

  it("injects attempt 1's exact failed contract checks into attempt 2's prompt; the fixed attempt succeeds", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    const prompts: string[] = []
    // Attempt 1 violates dry-run-note.v1; attempt 2 conforms.
    const learning = scriptExecutor("codex", (spec, ctx) => {
      prompts.push(spec.prompt ?? "")
      const absolute = join(ctx.workdir, expectedArtifactPath(spec.traceId))
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, spec.attempt === 1 ? "# A note that ignores the contract\n" : conformingNote(spec), "utf8")
      return { output: { text: "wrote the note" } }
    })
    const d = deps(workdir, [fakeHermes("approve"), learning])

    const outcome = await runLoop(loop(ledgerRoot), { task: TASK }, d)
    expect(outcome.state.status).toBe("done")
    expect(outcome.output?.verdict).toBe("success")

    expect(prompts).toHaveLength(2)
    // Attempt 1's prompt carries no failure context; attempt 2's carries the
    // exact failed check labels AND details from attempt 1's contract result.
    expect(prompts[0]).not.toContain("Failed contract checks")
    expect(prompts[1]).toContain("Failed contract checks")
    expect(prompts[1]).toContain(`contract \`dry-run-note.v1\` failed`)
    expect(prompts[1]).toContain("trace id recorded")
    expect(prompts[1]).toContain(`expected \`${outcome.state.traceId}\` in artifact title or metadata`)
    expect(prompts[1]).toContain("one improvement candidate recorded")
  })

  it("renders the route and implement prompts from the loop's own templates", () => {
    const [route, implement] = planWorkReviewLoop.steps
    const base = {
      runId: "plan-work-review-test",
      traceId: "plan-work-review-test",
      loopId: planWorkReviewLoop.id,
      loopVersion: planWorkReviewLoop.version,
      attempt: 1,
      effects: { allow: [] },
      runDir: "/tmp/run",
      timeoutMs: 1000,
    }
    const routePrompt = route!.prompt!({ ...base, stepId: "route", inputs: { task: TASK } })
    expect(routePrompt).toContain("control-plane router")
    expect(routePrompt).toContain(expectedArtifactPath("plan-work-review-test"))
    expect(routePrompt).toContain("gate_decision, route_to_worker, worker")

    const implPrompt = implement!.prompt!({ ...base, stepId: "implement", inputs: { task: TASK, route: { gate_decision: "approve" } } })
    expect(implPrompt).toContain("## Improvement Candidate")
    expect(implPrompt).toContain("/tmp/run") // the bundle path reaches the worker
    const retryPrompt = implement!.prompt!({
      ...base,
      attempt: 2,
      stepId: "implement",
      retryHint: "Failed contract checks:\n- trace id recorded — expected `plan-work-review-test`",
      inputs: { task: TASK, route: {} },
    })
    expect(retryPrompt).toContain("worker retry")
    expect(retryPrompt).toContain("dry-run-note.v1")
    expect(retryPrompt).toContain("trace id recorded — expected `plan-work-review-test`")
  })
})

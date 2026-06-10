// Pilot 0 end-to-end: the deterministic control-plane smoke loop runs green
// under the generic tick interpreter, proving gateway/job/no-op/trace/delivery
// behavior with the ledger written per tick.

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runLoop } from "../src/engine/tick.js"
import { defaultContractRegistry, runTraceV1 } from "../src/kernel/contract.js"
import { executorRegistry } from "../src/executors/script.js"
import { Ledger, replay } from "../src/ledger/ledger.js"
import { controlPlaneSmokeExecutor, controlPlaneSmokeLoop } from "../src/pilot0/loop.js"

function setup() {
  const root = mkdtempSync(join(tmpdir(), "looper-pilot0-"))
  const workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  const ledgerRoot = join(root, "ledger")
  return {
    workdir,
    ledgerRoot,
    loop: { ...controlPlaneSmokeLoop, ledger: { root: ledgerRoot } },
    deps: {
      executors: executorRegistry(controlPlaneSmokeExecutor),
      contracts: defaultContractRegistry(),
      workdir,
    },
  }
}

describe("pilot 0: control-plane smoke loop", () => {
  it("runs end-to-end green: done, ok, no-op, delivery skipped", async () => {
    const { loop, deps } = setup()
    const outcome = await runLoop(loop, { jobName: "watch-every-compound-engineering-upstream" }, deps)

    expect(outcome.state.status).toBe("done")
    expect(outcome.decision.kind).toBe("stop")
    expect(outcome.decision.classification).toBe("success")
    expect(outcome.output?.ok).toBe(true)
    expect(outcome.state.values.watcherOutcome).toBe("no_op")
    expect(outcome.state.values.deliverySkipped).toBe(true)
  })

  it("writes a trace that satisfies run-trace.v1", async () => {
    const { loop, deps, workdir } = setup()
    const outcome = await runLoop(loop, { jobName: "watch-every-compound-engineering-upstream" }, deps)

    const trace = String(outcome.output?.trace)
    const absolute = join(workdir, trace)
    expect(existsSync(absolute)).toBe(true)
    expect(readFileSync(absolute, "utf8")).toContain(`# Trace: ${outcome.state.traceId}`)

    const result = runTraceV1.validate(
      { trace },
      { traceId: outcome.state.traceId, loopId: loop.id, loopVersion: loop.version, workdir },
    )
    expect(result.valid).toBe(true)
  })

  it("journals the full tick: meta, attempt, result, contract, effects, decision — and is replayable", async () => {
    const { loop, deps, ledgerRoot } = setup()
    const outcome = await runLoop(loop, { jobName: "watch-every-compound-engineering-upstream" }, deps)

    const entries = Ledger.load(join(ledgerRoot, "runs", outcome.state.runId, "journal.jsonl"))
    expect(entries.map((e) => e.type)).toEqual(["meta", "step_started", "step_result", "contract", "effects", "decision"])

    const contract = entries.find((e) => e.type === "contract")
    expect(contract?.type === "contract" && contract.result.valid).toBe(true)
    const effects = entries.find((e) => e.type === "effects")
    expect(effects?.type === "effects" && effects.observation.allowed).toBe(true)
    expect(effects?.type === "effects" ? effects.observation.changed.some((p) => p.includes("evidence/traces/")) : false).toBe(true)

    const view = replay(entries)
    expect(view.meta?.loopId).toBe("control-plane-smoke-test")
    expect(view.completed.size).toBe(1)
    expect(view.lastDecision?.decision.kind).toBe("stop")
  })

  it("classifies a changed upstream as delivered (not skipped)", async () => {
    const { loop, deps } = setup()
    const outcome = await runLoop(loop, { jobName: "watch-every-compound-engineering-upstream", upstreamChanged: true }, deps)
    expect(outcome.state.values.watcherOutcome).toBe("changed")
    expect(outcome.state.values.deliverySkipped).toBe(false)
  })
})

// The smoke template (templates/smoke), end-to-end through the generic tick
// interpreter: the deterministic control-plane smoke loop runs green,
// proving gateway/job/no-op/trace/delivery behavior with the ledger written
// per tick. This carries the coverage the in-tree Pilot 0 suite pinned
// before the pilots were cut — the template is now the thing under test.

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runLoop, type EngineDeps } from "../src/engine/tick.js"
import { defaultContractRegistry, runTraceV1 } from "../src/kernel/contract.js"
import { executorRegistry } from "../src/executors/script.js"
import type { Executor } from "../src/kernel/types.js"
import { Ledger, replay } from "../src/ledger/ledger.js"
import { templateRegistration } from "./templates.js"

const registration = await templateRegistration("smoke", "smoke-loop.mjs")

function setup() {
  const root = mkdtempSync(join(tmpdir(), "vernier-smoke-template-"))
  const workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  const ledgerRoot = join(root, "ledger")
  const deps: EngineDeps = {
    executors: executorRegistry(...(registration.executors as Executor[])),
    contracts: defaultContractRegistry(),
    workdir,
  }
  return { workdir, ledgerRoot, loop: { ...registration.loop, ledger: { root: ledgerRoot } }, deps }
}

describe("smoke template: control-plane-smoke-test", () => {
  it("registers the loop with its runtime facts: default inputs, executor, signature", () => {
    expect(registration.loop.id).toBe("control-plane-smoke-test")
    expect(registration.loop.trust).toBe("dry-run")
    expect(registration.defaultInputs).toEqual({ jobName: "watch-upstream" })
    expect(registration.executors?.map((e) => e.id)).toEqual(["script:control-plane-smoke"])
    expect(registration.signature).toContain("->")
  })

  it("runs end-to-end green: done, ok, no-op, delivery skipped", async () => {
    const { loop, deps } = setup()
    const outcome = await runLoop(loop, { jobName: "watch-upstream" }, deps)

    expect(outcome.state.status).toBe("done")
    expect(outcome.decision.kind).toBe("stop")
    expect(outcome.decision.classification).toBe("success")
    expect(outcome.output?.ok).toBe(true)
    expect(outcome.state.values.watcherOutcome).toBe("no_op")
    expect(outcome.state.values.deliverySkipped).toBe(true)
  })

  it("writes a trace that satisfies run-trace.v1", async () => {
    const { loop, deps, workdir } = setup()
    const outcome = await runLoop(loop, { jobName: "watch-upstream" }, deps)

    const trace = String(outcome.output?.trace)
    const absolute = join(workdir, trace)
    expect(existsSync(absolute)).toBe(true)
    expect(readFileSync(absolute, "utf8")).toContain(`# Trace: ${outcome.state.traceId}`)

    const result = runTraceV1.validate(
      { trace },
      {
        traceId: outcome.state.traceId,
        loopId: loop.id,
        loopVersion: loop.version,
        workdir,
        executorId: "script:control-plane-smoke",
        runDir: workdir,
      },
    )
    expect(result.valid).toBe(true)
  })

  it("journals the full tick: meta, attempt, result, contract, effects, decision — and is replayable", async () => {
    const { loop, deps, ledgerRoot } = setup()
    const outcome = await runLoop(loop, { jobName: "watch-upstream" }, deps)

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
    const outcome = await runLoop(loop, { jobName: "watch-upstream", upstreamChanged: true }, deps)
    expect(outcome.state.values.watcherOutcome).toBe("changed")
    expect(outcome.state.values.deliverySkipped).toBe(false)
  })
})

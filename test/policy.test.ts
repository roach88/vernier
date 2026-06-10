// Characterization tests for the Policy, ported from looper's
// tests/test_dynamic_workflow_harness.py (the frozen Python spec).

import { describe, expect, it } from "vitest"
import { decideNextStep, retryPolicy, type Observation } from "../src/kernel/policy.js"

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    loopId: "plan-work-review",
    loopVersion: "0.1.0",
    runId: "trace-001",
    stepId: "implement",
    stepIndex: 1,
    stepCount: 2,
    attempt: 1,
    iteration: 1,
    executorId: "codex",
    executorRan: true,
    stepStatus: "completed",
    outputValid: true,
    contractId: "dry-run-note.v1",
    contractValid: true,
    contractFailedChecks: [],
    effectsAllowed: true,
    unexpectedChanges: [],
    output: {},
    ...overrides,
  }
}

describe("decideNextStep", () => {
  it("stops with success when the final step passes signature, contract, and boundary", () => {
    const decision = decideNextStep(observation())
    expect(decision.kind).toBe("stop")
    expect(decision.classification).toBe("success")
  })

  it("continues when a non-final step passes", () => {
    const decision = decideNextStep(observation({ stepIndex: 0 }))
    expect(decision.kind).toBe("continue")
    expect(decision.classification).toBe("success")
  })

  it("retries with a hint when the contract fails", () => {
    const decision = decideNextStep(
      observation({ contractValid: false, contractFailedChecks: ["artifact path recorded"] }),
    )
    expect(decision.kind).toBe("retry")
    expect(decision.classification).toBe("failure")
    expect(decision.retryHint).toContain("dry-run-note.v1")
    expect(decision.retryHint).toContain("artifact path recorded")
    expect(decision.retryHint).toContain("trace-001")
  })

  it("retries when the executor fails", () => {
    const decision = decideNextStep(observation({ stepStatus: "failed", outputValid: false }))
    expect(decision.kind).toBe("retry")
    expect(decision.classification).toBe("failure")
    expect(decision.retryHint).toBeDefined()
  })

  it("escalates as no_op when the executor never ran", () => {
    const decision = decideNextStep(observation({ executorRan: false, stepStatus: null, outputValid: false }))
    expect(decision.kind).toBe("escalate")
    expect(decision.classification).toBe("no_op")
  })

  it("escalates when changes escape the effect boundary", () => {
    const decision = decideNextStep(
      observation({ effectsAllowed: false, unexpectedChanges: ["scripts/pilot1_runner.py"] }),
    )
    expect(decision.kind).toBe("escalate")
    expect(decision.classification).toBe("failure")
    expect(decision.notes.join("\n")).toContain("scripts/pilot1_runner.py")
  })

  it("is pure: identical observations yield identical decisions", () => {
    const obs = observation({ contractValid: false, contractFailedChecks: ["x"] })
    expect(decideNextStep(obs)).toEqual(decideNextStep(obs))
  })
})

describe("retryPolicy", () => {
  it("passes through retries under the attempt cap", () => {
    const policy = retryPolicy({ maxAttempts: 2 })
    expect(policy(observation({ contractValid: false })).kind).toBe("retry")
  })

  it("escalates when the attempt cap is reached", () => {
    const policy = retryPolicy({ maxAttempts: 1 })
    const decision = policy(observation({ contractValid: false }))
    expect(decision.kind).toBe("escalate")
    expect(decision.notes.join("\n")).toContain("reached policy max 1")
  })

  it("never alters non-retry decisions", () => {
    const policy = retryPolicy({ maxAttempts: 1 })
    expect(policy(observation()).kind).toBe("stop")
    expect(policy(observation({ effectsAllowed: false })).kind).toBe("escalate")
  })
})

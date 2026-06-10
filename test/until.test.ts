// The until combinator: pure decisions over iterations. Loop-back vs stop,
// the maxIterations termination guarantee, feedback threading, and
// composition with retry semantics (retry = same step on transient/contract
// failure; iterate = re-run the sub-sequence because the result wasn't good
// enough yet).

import { describe, expect, it } from "vitest"
import { retryPolicy, until, type Observation } from "../src/kernel/policy.js"

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    loopId: "verified-answer",
    loopVersion: "0.1.0",
    runId: "trace-002",
    stepId: "grade",
    stepIndex: 1, // the final step of a two-step sequence
    stepCount: 2,
    attempt: 1,
    iteration: 1,
    executorId: "judge",
    executorRan: true,
    stepStatus: "completed",
    outputValid: true,
    contractId: null,
    contractValid: true,
    contractFailedChecks: [],
    effectsAllowed: true,
    unexpectedChanges: [],
    output: { passed: true, feedback: "", missing: [] },
    ...overrides,
  }
}

const policy = until((v) => v.passed === true, {
  maxIterations: 3,
  restartAt: "answer",
  feedbackFrom: (v) => String(v.feedback),
})

describe("until", () => {
  it("stops with success when the predicate is met at the end of the sequence", () => {
    const decision = policy(observation())
    expect(decision.kind).toBe("stop")
    expect(decision.classification).toBe("success")
    expect(decision.summary).toContain("until-predicate was met")
  })

  it("iterates with threaded feedback when the predicate is unmet and iterations remain", () => {
    const decision = policy(observation({ output: { passed: false, feedback: "mention the year 1969", missing: ["year"] } }))
    expect(decision.kind).toBe("iterate")
    expect(decision.classification).toBe("failure")
    expect(decision.restartAt).toBe("answer")
    expect(decision.retryHint).toBe("mention the year 1969") // feedbackFrom(output), verbatim
  })

  it("escalates when the predicate is unmet at the iteration ceiling", () => {
    const decision = policy(observation({ iteration: 3, output: { passed: false, feedback: "still wrong", missing: [] } }))
    expect(decision.kind).toBe("escalate")
    expect(decision.classification).toBe("failure")
    expect(decision.notes.join("\n")).toContain("reached policy max 3")
  })

  it("never emits iterate at or beyond maxIterations — the termination guarantee", () => {
    for (let iteration = 1; iteration <= 10; iteration++) {
      const decision = policy(observation({ iteration, output: { passed: false, feedback: "no", missing: [] } }))
      expect(decision.kind).toBe(iteration < 3 ? "iterate" : "escalate")
    }
  })

  it("leaves mid-sequence decisions to the base policy (continue passes through)", () => {
    const decision = policy(observation({ stepId: "answer", stepIndex: 0 }))
    expect(decision.kind).toBe("continue")
  })

  it("composes with retry semantics: a transient step failure stays a same-step retry", () => {
    const composed = until((v) => v.passed === true, {
      maxIterations: 3,
      restartAt: "answer",
      base: retryPolicy({ maxAttempts: 2 }),
    })
    const failed = observation({ stepStatus: "failed", outputValid: false, output: null })
    expect(composed(failed).kind).toBe("retry")
    expect(composed({ ...failed, attempt: 2 }).kind).toBe("escalate") // the retry cap still escalates
  })

  it("defaults restartAt to the loop's first step (engine-resolved)", () => {
    const defaulted = until((v) => v.passed === true, { maxIterations: 2 })
    const decision = defaulted(observation({ output: { passed: false } }))
    expect(decision.kind).toBe("iterate")
    expect(decision.restartAt).toBeUndefined()
  })

  it("is pure: identical observations yield identical decisions", () => {
    const obs = observation({ output: { passed: false, feedback: "f", missing: [] } })
    expect(policy(obs)).toEqual(policy(obs))
  })

  it("rejects a non-positive maxIterations at construction", () => {
    expect(() => until(() => true, { maxIterations: 0 })).toThrow(/positive integer/)
  })
})

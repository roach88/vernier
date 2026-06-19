import { describe, expect, it } from "vitest"
import { decideNextStep, retryPolicy, until, type Decision, type Observation } from "../src/kernel/policy.js"

const DEFAULT_SEED = Number(process.env.VERNIER_PROPERTY_SEED ?? 73_451)
const CASES = Number(process.env.VERNIER_PROPERTY_CASES ?? 128)

interface Rng {
  next(): number
  int(maxExclusive: number): number
  bool(): boolean
}

function rng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
  return {
    next,
    int(maxExclusive) {
      return Math.floor(next() * maxExclusive)
    },
    bool() {
      return next() < 0.5
    },
  }
}

function sample<T>(r: Rng, values: readonly T[]): T {
  return values[r.int(values.length)]!
}

function observation(r: Rng, overrides: Partial<Observation> = {}): Observation {
  const stepCount = 1 + r.int(5)
  const stepIndex = r.int(stepCount)
  const status = sample(r, ["completed", "failed", "interrupted"] as const)
  const contractFailedChecks = Array.from({ length: r.int(3) }, (_, i) => `check-${i}`)
  return {
    loopId: "property-loop",
    loopVersion: "0.1.0",
    runId: `run-${DEFAULT_SEED}`,
    stepId: `step-${stepIndex}`,
    stepIndex,
    stepCount,
    attempt: 1 + r.int(4),
    iteration: 1 + r.int(4),
    executorId: "script",
    executorRan: r.bool(),
    stepStatus: status,
    outputValid: r.bool(),
    contractId: r.bool() ? "contract" : null,
    contractValid: r.bool(),
    contractFailedChecks,
    effectsAllowed: r.bool(),
    effectsObserved: r.bool() ? false : true,
    unexpectedChanges: r.bool() ? [] : ["out/of/scope.txt"],
    output: r.bool() ? { passed: r.bool(), feedback: "try again" } : null,
    ...overrides,
  }
}

function cases(name: string, fn: (r: Rng, index: number) => void): void {
  it(`${name} (seed ${DEFAULT_SEED}, cases ${CASES})`, () => {
    const r = rng(DEFAULT_SEED)
    for (let i = 0; i < CASES; i++) fn(r, i)
  })
}

describe("policy property invariants", () => {
  cases("unsafe observations never produce continue/stop", (r) => {
    const obs = observation(r)
    const decision = decideNextStep(obs)
    const safe =
      obs.executorRan &&
      obs.effectsObserved !== false &&
      obs.stepStatus === "completed" &&
      obs.outputValid &&
      obs.contractValid &&
      obs.effectsAllowed &&
      obs.unexpectedChanges.length === 0

    if (!safe) expect(["continue", "stop"]).not.toContain(decision.kind)
  })

  cases("safe observations are positional: intermediate steps continue, final steps stop", (r) => {
    const obs = observation(r, {
      executorRan: true,
      effectsObserved: true,
      stepStatus: "completed",
      outputValid: true,
      contractValid: true,
      effectsAllowed: true,
      unexpectedChanges: [],
      output: { ok: true },
    })
    const decision = decideNextStep(obs)

    expect(decision.kind).toBe(obs.stepIndex + 1 >= obs.stepCount ? "stop" : "continue")
    expect(decision.classification).toBe("success")
  })

  cases("retryPolicy escalates retries exactly at the configured attempt ceiling", (r) => {
    const maxAttempts = 1 + r.int(4)
    const policy = retryPolicy({ maxAttempts })
    const obs = observation(r, {
      executorRan: true,
      effectsObserved: true,
      stepStatus: "failed",
      outputValid: false,
      contractValid: false,
      effectsAllowed: true,
      unexpectedChanges: [],
      attempt: 1 + r.int(5),
    })
    const decision = policy(obs)

    expect(decision.kind).toBe(obs.attempt >= maxAttempts ? "escalate" : "retry")
    if (obs.attempt >= maxAttempts) expect(decision.notes.join("\n")).toContain(`policy max ${maxAttempts}`)
  })

  cases("until only grades the configured/default graded step", (r) => {
    const maxIterations = 1 + r.int(5)
    const baseDecision: Decision = {
      kind: "continue",
      classification: "success",
      summary: "base",
      notes: [],
      improvement: "base",
    }
    const policy = until((output) => output.passed === true, {
      maxIterations,
      restartAt: "answer",
      feedbackFrom: (output) => String(output.feedback ?? ""),
      base: () => baseDecision,
    })
    const nonGraded = observation(r, {
      stepId: "answer",
      stepIndex: 0,
      stepCount: 2,
      output: { passed: r.bool(), feedback: "revise" },
      iteration: 1 + r.int(6),
    })
    expect(policy(nonGraded)).toBe(baseDecision)

    const obs = observation(r, {
      stepId: "judge",
      stepIndex: 1,
      stepCount: 2,
      output: { passed: r.bool(), feedback: "revise" },
      iteration: 1 + r.int(6),
    })
    const decision = policy(obs)

    if (obs.output?.passed === true) {
      expect(decision).toMatchObject({ kind: baseDecision.kind, classification: baseDecision.classification, improvement: baseDecision.improvement })
      expect(decision.summary).toContain("until-predicate was met")
    } else if (obs.iteration < maxIterations) {
      expect(decision).toMatchObject({ kind: "iterate", restartAt: "answer", retryHint: "revise" })
    } else {
      expect(decision.kind).toBe("escalate")
      expect(decision.notes.join("\n")).toContain(`policy max ${maxIterations}`)
    }
  })
})

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { runLoop, startRun, tick, type EngineDeps } from "../src/engine/tick.js"
import { ContractRegistry, type Contract } from "../src/kernel/contract.js"
import { decideNextStep, retryPolicy, until } from "../src/kernel/policy.js"
import { fsScope, noEffects, sig, type Loop } from "../src/kernel/types.js"
import { executorRegistry, scriptExecutor } from "../src/executors/script.js"
import { Ledger } from "../src/ledger/ledger.js"

function temp(): { workdir: string; ledgerRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "looper-tick-"))
  const workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  return { workdir, ledgerRoot: join(root, "ledger") }
}

const evenCheck: Contract = {
  id: "even.v1",
  validate(output) {
    const passed = typeof output.n === "number" && output.n % 2 === 0
    return { contractId: "even.v1", valid: passed, checks: [{ label: "n is even", passed, detail: "expected an even n" }] }
  },
}

function deps(executors: Parameters<typeof executorRegistry>, workdir: string): EngineDeps {
  return {
    executors: executorRegistry(...executors),
    contracts: new ContractRegistry().register(evenCheck),
    workdir,
  }
}

const twoStepLoop = (ledgerRoot: string): Loop<{ n: number }, { n: number; doubledTwice: boolean }> => ({
  id: "double-twice",
  version: "0.1.0",
  signature: sig(z.object({ n: z.number() }), z.object({ n: z.number(), doubledTwice: z.boolean() })),
  steps: [
    {
      id: "double",
      signature: sig(z.object({ n: z.number() }), z.object({ n: z.number() })),
      executor: "script:double",
      contract: "even.v1",
      effects: noEffects(),
    },
    {
      id: "double-again",
      signature: sig(z.object({ n: z.number() }), z.object({ n: z.number(), doubledTwice: z.boolean() })),
      executor: "script:double-again",
      effects: noEffects(),
    },
  ],
  policy: retryPolicy({ maxAttempts: 2 }),
  trust: "dry-run",
  ledger: { root: ledgerRoot },
})

const double = scriptExecutor("script:double", (spec) => ({ output: { n: Number(spec.inputs.n) * 2 } }))
const doubleAgain = scriptExecutor("script:double-again", (spec) => ({
  output: { n: Number(spec.inputs.n) * 2, doubledTwice: true },
}))

describe("tick", () => {
  it("advances one step per tick, threading values between steps", async () => {
    const { workdir, ledgerRoot } = temp()
    const d = deps([double, doubleAgain], workdir)
    const run = startRun(twoStepLoop(ledgerRoot), { n: 3 }, d)

    const first = await tick(run, d)
    expect(first.decision.kind).toBe("continue")
    expect(first.state.stepIndex).toBe(1)
    expect(first.state.status).toBe("running")
    expect(first.state.values.n).toBe(6)

    const second = await tick(run, d)
    expect(second.decision.kind).toBe("stop")
    expect(second.state.status).toBe("done")
    expect(second.state.values.n).toBe(12)
    expect(second.state.values.doubledTwice).toBe(true)
  })

  it("enforces the contract: failing output retries, then escalates at the cap", async () => {
    const { workdir, ledgerRoot } = temp()
    const odd = scriptExecutor("script:double", () => ({ output: { n: 7 } })) // violates even.v1
    const d = deps([odd, doubleAgain], workdir)
    const run = startRun(twoStepLoop(ledgerRoot), { n: 3 }, d)

    const first = await tick(run, d)
    expect(first.decision.kind).toBe("retry")
    expect(first.state.attempt).toBe(2)

    const second = await tick(run, d)
    expect(second.decision.kind).toBe("escalate")
    expect(second.state.status).toBe("needs_human")
  })

  it("enforces the signature: malformed output is a retry, not a crash", async () => {
    const { workdir, ledgerRoot } = temp()
    const malformed = scriptExecutor("script:double", () => ({ output: { n: "not a number", wat: true } }))
    const d = deps([malformed, doubleAgain], workdir)
    const run = startRun(twoStepLoop(ledgerRoot), { n: 3 }, d)

    const outcome = await tick(run, d)
    expect(outcome.decision.kind).toBe("retry")
    expect(outcome.decision.summary).toContain("signature")
  })

  it("observes effects and escalates on out-of-scope writes", async () => {
    const { workdir, ledgerRoot } = temp()
    const loop: Loop<{ n: number }, { n: number }> = {
      id: "scoped",
      version: "0.1.0",
      signature: sig(z.object({ n: z.number() }), z.object({ n: z.number() })),
      steps: [
        {
          id: "write",
          signature: sig(z.object({ n: z.number() }), z.object({ n: z.number() })),
          executor: "script:writer",
          effects: fsScope("allowed/**"),
        },
      ],
      policy: decideNextStep,
      trust: "dry-run",
      ledger: { root: ledgerRoot },
    }
    const writer = scriptExecutor("script:writer", (spec, ctx) => {
      mkdirSync(join(ctx.workdir, "allowed"), { recursive: true })
      writeFileSync(join(ctx.workdir, "allowed", "fine.txt"), "ok")
      writeFileSync(join(ctx.workdir, "escaped.txt"), "not ok") // outside scope
      return { output: { n: Number(spec.inputs.n) } }
    })
    const d = deps([writer], workdir)
    const run = startRun(loop, { n: 1 }, d)

    const outcome = await tick(run, d)
    expect(outcome.decision.kind).toBe("escalate")
    expect(outcome.decision.notes.join("\n")).toContain("escaped.txt")
    expect(outcome.state.status).toBe("needs_human")
  })

  it("treats a throwing executor as a failed attempt and retries", async () => {
    const { workdir, ledgerRoot } = temp()
    const boom = scriptExecutor("script:double", () => {
      throw new Error("script exploded")
    })
    const d = deps([boom, doubleAgain], workdir)
    const run = startRun(twoStepLoop(ledgerRoot), { n: 3 }, d)

    const outcome = await tick(run, d)
    expect(outcome.decision.kind).toBe("retry")
  })

  it("writes attempts, contract results, effects, and decisions to the ledger per tick", async () => {
    const { workdir, ledgerRoot } = temp()
    const d = deps([double, doubleAgain], workdir)
    const loop = twoStepLoop(ledgerRoot)
    const run = startRun(loop, { n: 3 }, d)
    await tick(run, d)

    const entries = Ledger.load(join(ledgerRoot, "runs", run.state.runId, "journal.jsonl"))
    expect(entries.map((e) => e.type)).toEqual(["meta", "step_started", "step_result", "contract", "effects", "decision"])
  })

  it("refuses to execute draft loops", () => {
    const { workdir, ledgerRoot } = temp()
    const d = deps([double, doubleAgain], workdir)
    const draft = { ...twoStepLoop(ledgerRoot), trust: "draft" as const }
    expect(() => startRun(draft, { n: 3 }, d)).toThrow(/draft loops may not execute/)
  })

  it("runLoop = while tick: returns the loop-signature-validated output", async () => {
    const { workdir, ledgerRoot } = temp()
    const d = deps([double, doubleAgain], workdir)
    const outcome = await runLoop(twoStepLoop(ledgerRoot), { n: 3 }, d)
    expect(outcome.state.status).toBe("done")
    expect(outcome.output).toEqual({ n: 12, doubledTwice: true })
  })
})

// ------------------------------------------------- policy-directed loop-back

/** A produce -> verify loop whose policy iterates the sub-sequence until the verdict passes. */
const untilLoop = (ledgerRoot: string, maxIterations = 3): Loop<{ goal: string }, { answer: string; verdict: string }> => ({
  id: "until-loop",
  version: "0.1.0",
  signature: sig(z.object({ goal: z.string() }), z.object({ answer: z.string(), verdict: z.string() })),
  steps: [
    {
      id: "answer",
      signature: sig(z.object({ goal: z.string() }), z.object({ answer: z.string() })),
      executor: "script:answer",
      effects: noEffects(),
    },
    {
      id: "grade",
      signature: sig(z.object({ answer: z.string() }), z.object({ passed: z.boolean(), feedback: z.string() })),
      executor: "script:judge",
      effects: noEffects(),
    },
  ],
  policy: until((v) => v.passed === true, { maxIterations, restartAt: "answer", feedbackFrom: (v) => String(v.feedback) }),
  trust: "dry-run",
  ledger: { root: ledgerRoot },
})

describe("tick loop-back (iterate decisions)", () => {
  it("re-runs the answer step with the judge's feedback until the verdict passes, journaling every pass", async () => {
    const { workdir, ledgerRoot } = temp()
    const hintsSeen: Array<string | undefined> = []
    const answer = scriptExecutor("script:answer", (spec) => {
      hintsSeen.push(spec.retryHint)
      return { output: { answer: spec.retryHint ? "revised answer" : "first draft" } }
    })
    let grades = 0
    const judge = scriptExecutor("script:judge", () => {
      grades += 1
      return { output: grades === 1 ? { passed: false, feedback: "mention the year 1969" } : { passed: true, feedback: "" } }
    })
    const d = deps([answer, judge], workdir)
    const loop = untilLoop(ledgerRoot)

    const outcome = await runLoop(loop, { goal: "explain apollo 11" }, d)

    expect(outcome.state.status).toBe("done")
    expect(outcome.state.iteration).toBe(2)
    expect(outcome.output).toEqual({ answer: "revised answer", verdict: "success" })
    // The verifier's feedback was threaded into the second pass — verbatim.
    expect(hintsSeen).toEqual([undefined, "mention the year 1969"])

    const entries = Ledger.load(join(ledgerRoot, "runs", outcome.state.runId, "journal.jsonl"))
    const starts = entries.filter((e) => e.type === "step_started")
    expect(starts.map((s) => (s.type === "step_started" ? `${s.stepId}@${s.iteration}` : ""))).toEqual([
      "answer@1",
      "grade@1",
      "answer@2",
      "grade@2",
    ])
    const decisions = entries.filter((e) => e.type === "decision").map((e) => (e.type === "decision" ? e.decision.kind : ""))
    expect(decisions).toEqual(["continue", "iterate", "continue", "stop"])
    const iterate = entries.find((e) => e.type === "decision" && e.decision.kind === "iterate")
    expect(iterate?.type === "decision" && iterate.decision.retryHint).toBe("mention the year 1969")
  })

  it("always terminates: a never-passing verdict escalates at the iteration ceiling", async () => {
    const { workdir, ledgerRoot } = temp()
    const answer = scriptExecutor("script:answer", () => ({ output: { answer: "draft" } }))
    const judge = scriptExecutor("script:judge", () => ({ output: { passed: false, feedback: "never good enough" } }))
    const d = deps([answer, judge], workdir)

    const outcome = await runLoop(untilLoop(ledgerRoot, 3), { goal: "impossible" }, d)

    expect(outcome.state.status).toBe("needs_human")
    expect(outcome.state.iteration).toBe(3)
    expect(outcome.output).toBeNull()
    const entries = Ledger.load(join(ledgerRoot, "runs", outcome.state.runId, "journal.jsonl"))
    expect(entries.filter((e) => e.type === "step_started" && e.stepId === "answer")).toHaveLength(3)
  })

  it("throws on an iterate decision naming an unknown step (loop-data bug, not a step failure)", async () => {
    const { workdir, ledgerRoot } = temp()
    const answer = scriptExecutor("script:answer", () => ({ output: { answer: "draft" } }))
    const judge = scriptExecutor("script:judge", () => ({ output: { passed: false, feedback: "no" } }))
    const d = deps([answer, judge], workdir)
    const loop = {
      ...untilLoop(ledgerRoot),
      policy: until((v) => v.passed === true, { maxIterations: 3, restartAt: "no-such-step" }),
    }
    await expect(runLoop(loop, { goal: "boom" }, d)).rejects.toThrow(/names no step/)
  })
})

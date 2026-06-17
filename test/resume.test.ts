// Resume is replay of the ledger, not re-execution — proven with script
// executors and invocation counters, deterministically (no LLM anywhere).
//
// The two failure modes resume MUST NOT have:
//   (a) re-running a completed LLM step (non-deterministic — the journaled
//       result is the truth), asserted via executor invocation counts;
//   (b) double-applying a side-effecting step (`remember`-style appends),
//       asserted via store contents after crash -> resume.
// Plus the iterating-loop trap: an iterate loop-back re-runs a step with
// byte-identical inputs, so resume must land on the right
// (stepId, iteration, attempt), never collapse passes.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { resumeRun, summarizeJournal } from "../src/engine/resume.js"
import { driveRun, finalOutput, runLoop, startRun, tick, type EngineDeps } from "../src/engine/tick.js"
import { executorRegistry, scriptExecutor } from "../src/executors/script.js"
import { ContractRegistry, type Contract } from "../src/kernel/contract.js"
import { retryPolicy, until } from "../src/kernel/policy.js"
import { noEffects, sig, type Loop } from "../src/kernel/types.js"
import { Ledger, journalPath } from "../src/ledger/ledger.js"

function temp(): { workdir: string; ledgerRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "vernier-resume-"))
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
  return { executors: executorRegistry(...executors), contracts: new ContractRegistry().register(evenCheck), workdir }
}

/** Drop trailing journal entries of the given types — the torn-tick crash window, simulated surgically. */
function stripTrailing(path: string, types: readonly string[]): void {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
  while (lines.length > 0) {
    const last = JSON.parse(lines[lines.length - 1]!) as { type: string }
    if (types.includes(last.type)) lines.pop()
    else break
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8")
}

// ----------------------------------------------------- two-step script loop

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

function countedDoubles(): { double: ReturnType<typeof scriptExecutor>; doubleAgain: ReturnType<typeof scriptExecutor>; counts: Record<string, number> } {
  const counts: Record<string, number> = { double: 0, doubleAgain: 0 }
  const double = scriptExecutor("script:double", (spec) => {
    counts.double! += 1
    return { output: { n: Number(spec.inputs.n) * 2 } }
  })
  const doubleAgain = scriptExecutor("script:double-again", (spec) => {
    counts.doubleAgain! += 1
    return { output: { n: Number(spec.inputs.n) * 2, doubledTwice: true } }
  })
  return { double, doubleAgain, counts }
}

describe("resume from the ledger (linear loop)", () => {
  it("crash after step 1's tick: resume completes WITHOUT re-running step 1; output matches an uninterrupted run", async () => {
    const { workdir, ledgerRoot } = temp()
    const { double, doubleAgain, counts } = countedDoubles()
    const d = deps([double, doubleAgain], workdir)
    const loop = twoStepLoop(ledgerRoot)

    // Drive one tick, then "crash": abandon the in-memory Run. The journal
    // holds step 1's full tick; no terminal state was ever written.
    const crashed = startRun(loop, { n: 3 }, d)
    await tick(crashed, d)
    expect(counts.double).toBe(1)

    // Resume: the fold lands on step 2; step 1 is never re-entered.
    const resumed = resumeRun(loop, crashed.state.runId)
    expect(resumed.state).toMatchObject({ stepIndex: 1, attempt: 1, iteration: 1, status: "running" })
    expect(resumed.state.values.n).toBe(6) // step 1's journaled output, reconstructed

    const outcome = await driveRun(resumed, d)
    expect(outcome.state.status).toBe("done")
    expect(counts).toEqual({ double: 1, doubleAgain: 1 }) // exactly once each, across BOTH drives
    expect(finalOutput(loop, resumed.state, outcome.decision)).toEqual({ n: 12, doubledTwice: true })

    // ...and matches a never-interrupted run bit for bit.
    const fresh = countedDoubles()
    const uninterrupted = await runLoop(twoStepLoop(join(ledgerRoot, "fresh")), { n: 3 }, deps([fresh.double, fresh.doubleAgain], workdir))
    expect(uninterrupted.output).toEqual({ n: 12, doubledTwice: true })
  })

  it("crash INSIDE a tick (step_result journaled, decision missing): the slot is replayed by resume key, not re-executed", async () => {
    const { workdir, ledgerRoot } = temp()
    const { double, doubleAgain, counts } = countedDoubles()
    const d = deps([double, doubleAgain], workdir)
    const loop = twoStepLoop(ledgerRoot)

    const crashed = startRun(loop, { n: 3 }, d)
    await tick(crashed, d)
    const journal = journalPath(ledgerRoot, crashed.state.runId)
    // Simulate the smallest torn tick: the non-side-effecting decision tail is lost,
    // but the effect observation was already journaled.
    stripTrailing(journal, ["decision"])

    // The fold sees no decision, so it lands back ON step 1...
    const resumed = resumeRun(loop, crashed.state.runId)
    expect(resumed.state).toMatchObject({ stepIndex: 0, attempt: 1, iteration: 1 })

    // ...but the tick replays the journaled result instead of executing.
    const replayedTick = await tick(resumed, d)
    expect(counts.double).toBe(1) // NOT re-run
    expect(replayedTick.decision.kind).toBe("continue")
    expect(resumed.state.values.n).toBe(6)

    const outcome = await driveRun(resumed, d)
    expect(outcome.state.status).toBe("done")
    expect(counts).toEqual({ double: 1, doubleAgain: 1 })
    expect(finalOutput(loop, resumed.state, outcome.decision)).toEqual({ n: 12, doubledTwice: true })

    // The replayed tick re-appended the missing decision without re-running.
    const entries = Ledger.load(journal)
    expect(entries.filter((e) => e.type === "step_result" && e.stepId === "double")).toHaveLength(1)
    expect(entries.filter((e) => e.type === "contract" && e.stepId === "double")).toHaveLength(1)
    expect(summarizeJournal(entries).status).toBe("done")
  })



  it("replays a failed step_result without re-running and escalates when effects were never observed", async () => {
    const { workdir, ledgerRoot } = temp()
    let attempts = 0
    const failing = scriptExecutor("script:double", (_spec, ctx) => {
      attempts += 1
      writeFileSync(join(ctx.workdir, "failed-side-effect.txt"), `attempt ${attempts}\n`)
      throw new Error("side-effect then failure")
    })
    const { doubleAgain } = countedDoubles()
    const d = deps([failing, doubleAgain], workdir)
    const loop = twoStepLoop(ledgerRoot)

    const crashed = startRun(loop, { n: 3 }, d)
    await tick(crashed, d)
    const journal = journalPath(ledgerRoot, crashed.state.runId)
    stripTrailing(journal, ["decision", "effects", "contract"])

    const resumed = resumeRun(loop, crashed.state.runId)
    const replayed = await tick(resumed, d)

    expect(attempts).toBe(1)
    expect(replayed.decision.kind).toBe("escalate")
    expect(replayed.state.status).toBe("needs_human")
    expect(readFileSync(join(workdir, "failed-side-effect.txt"), "utf8")).toBe("attempt 1\n")
    const effects = Ledger.load(journal).filter((e) => e.type === "effects")
    expect(effects).toHaveLength(1)
    expect(effects[0]?.type === "effects" ? effects[0].observation.allowed : true).toBe(false)
  })


  it("a terminal run resumes as terminal; ticking it refuses", async () => {
    const { workdir, ledgerRoot } = temp()
    const { double, doubleAgain } = countedDoubles()
    const d = deps([double, doubleAgain], workdir)
    const loop = twoStepLoop(ledgerRoot)
    const outcome = await runLoop(loop, { n: 3 }, d)

    const resumed = resumeRun(loop, outcome.state.runId)
    expect(resumed.state.status).toBe("done")
    await expect(tick(resumed, d)).rejects.toThrow(/is done; nothing to tick/)
  })

  it("refuses to resume across loop versions", async () => {
    const { workdir, ledgerRoot } = temp()
    const { double, doubleAgain } = countedDoubles()
    const d = deps([double, doubleAgain], workdir)
    const loop = twoStepLoop(ledgerRoot)
    const crashed = startRun(loop, { n: 3 }, d)
    await tick(crashed, d)

    expect(() => resumeRun({ ...loop, version: "9.9.9" }, crashed.state.runId)).toThrow(/Refusing to resume across loop versions/)
  })

  it("refuses to START a run whose journal already exists (resume it instead)", async () => {
    const { workdir, ledgerRoot } = temp()
    const { double, doubleAgain } = countedDoubles()
    const d = deps([double, doubleAgain], workdir)
    const loop = twoStepLoop(ledgerRoot)
    const run = startRun(loop, { n: 3 }, d, { runId: "fixed-id" })
    expect(run.state.runId).toBe("fixed-id")
    expect(() => startRun(loop, { n: 3 }, d, { runId: "fixed-id" })).toThrow(/already has a journal/)
  })
})

// ------------------------------------------------------------ iterating loop

const untilLoop = (ledgerRoot: string): Loop<{ goal: string }, { answer: string; verdict: string }> => ({
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
  policy: until((v) => v.passed === true, { maxIterations: 3, restartAt: "answer", feedbackFrom: (v) => String(v.feedback) }),
  trust: "dry-run",
  ledger: { root: ledgerRoot },
})

function iteratingExecutors() {
  const counts = { answer: 0, grade: 0 }
  const hintsSeen: Array<string | undefined> = []
  const answer = scriptExecutor("script:answer", (spec) => {
    counts.answer += 1
    hintsSeen.push(spec.retryHint)
    return { output: { answer: spec.retryHint ? "revised answer" : "first draft" } }
  })
  const judge = scriptExecutor("script:judge", (spec) => {
    counts.grade += 1
    return {
      output:
        spec.inputs.answer === "revised answer" ? { passed: true, feedback: "" } : { passed: false, feedback: "mention the year 1969" },
    }
  })
  return { answer, judge, counts, hintsSeen }
}

describe("resume from the ledger (ITERATING loop)", () => {
  it("crash mid-iteration-2 lands on the right (stepId, iteration, attempt) and does not re-run answer@2", async () => {
    const { workdir, ledgerRoot } = temp()
    const ex = iteratingExecutors()
    const d = deps([ex.answer, ex.judge], workdir)
    const loop = untilLoop(ledgerRoot)

    // answer@1 -> continue; grade@1 -> iterate; answer@2 -> continue; CRASH.
    const crashed = startRun(loop, { goal: "explain apollo 11" }, d)
    await tick(crashed, d)
    await tick(crashed, d)
    await tick(crashed, d)
    expect(ex.counts).toEqual({ answer: 2, grade: 1 })

    // Resume lands on grade@2 — iteration preserved, not collapsed to pass 1.
    const resumed = resumeRun(loop, crashed.state.runId)
    expect(resumed.state).toMatchObject({ stepIndex: 1, iteration: 2, attempt: 1, status: "running" })
    expect(resumed.state.values.answer).toBe("revised answer") // answer@2's journaled output, not answer@1's

    const outcome = await driveRun(resumed, d)
    expect(outcome.state.status).toBe("done")
    expect(ex.counts).toEqual({ answer: 2, grade: 2 }) // answer ran exactly twice ACROSS both drives
    expect(finalOutput(loop, resumed.state, outcome.decision)).toEqual({ answer: "revised answer", verdict: "success" })

    const starts = Ledger.load(journalPath(ledgerRoot, crashed.state.runId))
      .filter((e) => e.type === "step_started")
      .map((e) => (e.type === "step_started" ? `${e.stepId}@${e.iteration}` : ""))
    expect(starts).toEqual(["answer@1", "grade@1", "answer@2", "grade@2"])
  })

  it("crash right after the iterate decision: resume reconstructs the retryHint and the next answer sees the feedback", async () => {
    const { workdir, ledgerRoot } = temp()
    const ex = iteratingExecutors()
    const d = deps([ex.answer, ex.judge], workdir)
    const loop = untilLoop(ledgerRoot)

    // answer@1 -> continue; grade@1 -> iterate; CRASH before answer@2.
    const crashed = startRun(loop, { goal: "explain apollo 11" }, d)
    await tick(crashed, d)
    await tick(crashed, d)
    expect(ex.counts).toEqual({ answer: 1, grade: 1 })

    const resumed = resumeRun(loop, crashed.state.runId)
    expect(resumed.state).toMatchObject({ stepIndex: 0, iteration: 2, attempt: 1 })
    expect(resumed.state.retryHint).toBe("mention the year 1969") // the verifier's feedback survived the crash

    const outcome = await driveRun(resumed, d)
    expect(outcome.state.status).toBe("done")
    expect(ex.counts).toEqual({ answer: 2, grade: 2 })
    // answer@2 genuinely executed on resume (its inputs slot was never journaled) and saw the hint.
    expect(ex.hintsSeen).toEqual([undefined, "mention the year 1969"])
  })

  it("torn tick on an iterating slot: answer@2's journaled result is replayed into iteration 2, never answer@1's", async () => {
    const { workdir, ledgerRoot } = temp()
    const ex = iteratingExecutors()
    const d = deps([ex.answer, ex.judge], workdir)
    const loop = untilLoop(ledgerRoot)

    const crashed = startRun(loop, { goal: "explain apollo 11" }, d)
    await tick(crashed, d) // answer@1
    await tick(crashed, d) // grade@1 -> iterate
    await tick(crashed, d) // answer@2
    const journal = journalPath(ledgerRoot, crashed.state.runId)
    stripTrailing(journal, ["decision"]) // tear answer@2's decision tail, preserving the observed effects

    const resumed = resumeRun(loop, crashed.state.runId)
    expect(resumed.state).toMatchObject({ stepIndex: 0, iteration: 2, attempt: 1 })

    const replayed = await tick(resumed, d)
    expect(ex.counts.answer).toBe(2) // replayed from the ledger, NOT re-executed
    expect(replayed.decision.kind).toBe("continue")
    expect(resumed.state.values.answer).toBe("revised answer") // iteration 2's output — the v2 key did not collapse passes

    const outcome = await driveRun(resumed, d)
    expect(outcome.state.status).toBe("done")
    expect(ex.counts).toEqual({ answer: 2, grade: 2 })
  })
})

// ------------------------------------------------- side-effecting steps

/** A `remember`-style loop: step 1 APPENDS to a durable store; step 2 confirms. */
const rememberLoop = (ledgerRoot: string): Loop<{ rule: string }, { stored: boolean; confirmed: boolean }> => ({
  id: "remember-then-confirm",
  version: "0.1.0",
  signature: sig(z.object({ rule: z.string() }), z.object({ stored: z.boolean(), confirmed: z.boolean() })),
  steps: [
    {
      id: "remember",
      signature: sig(z.object({ rule: z.string() }), z.object({ stored: z.boolean() })),
      executor: "script:remember",
      effects: noEffects(),
    },
    {
      id: "confirm",
      signature: sig(z.object({ stored: z.boolean() }), z.object({ confirmed: z.boolean() })),
      executor: "script:confirm",
      effects: noEffects(),
    },
  ],
  policy: retryPolicy({ maxAttempts: 2 }),
  trust: "dry-run",
  ledger: { root: ledgerRoot },
})

function rememberExecutors(storePath: string) {
  const counts = { remember: 0, confirm: 0 }
  const remember = scriptExecutor("script:remember", (spec) => {
    counts.remember += 1
    appendFileSync(storePath, String(spec.inputs.rule) + "\n", "utf8")
    return { output: { stored: true } }
  })
  const confirm = scriptExecutor("script:confirm", () => {
    counts.confirm += 1
    return { output: { confirmed: true } }
  })
  return { remember, confirm, counts }
}

const storeLines = (path: string): string[] => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [])

describe("resume never double-applies side effects", () => {
  it("crash after the remember step's tick: resume does NOT append twice", async () => {
    const { workdir, ledgerRoot } = temp()
    const store = join(workdir, "..", "rules.txt") // OUTSIDE the observed workdir, like the real Memory store
    const ex = rememberExecutors(store)
    const d = deps([ex.remember, ex.confirm], workdir)
    const loop = rememberLoop(ledgerRoot)

    const crashed = startRun(loop, { rule: "always verify" }, d)
    await tick(crashed, d) // remember completes; store has one line; CRASH.
    expect(storeLines(store)).toEqual(["always verify"])

    const resumed = resumeRun(loop, crashed.state.runId)
    const outcome = await driveRun(resumed, d)
    expect(outcome.state.status).toBe("done")
    expect(storeLines(store)).toEqual(["always verify"]) // exactly one append, ever
    expect(ex.counts).toEqual({ remember: 1, confirm: 1 })
  })

  it("torn tick after the remember step's result: the slot is replayed from the ledger — still exactly one append", async () => {
    const { workdir, ledgerRoot } = temp()
    const store = join(workdir, "..", "rules.txt") // OUTSIDE the observed workdir, like the real Memory store
    const ex = rememberExecutors(store)
    const d = deps([ex.remember, ex.confirm], workdir)
    const loop = rememberLoop(ledgerRoot)

    const crashed = startRun(loop, { rule: "always verify" }, d)
    await tick(crashed, d)
    const journal = journalPath(ledgerRoot, crashed.state.runId)
    stripTrailing(journal, ["decision", "effects", "contract"])

    const resumed = resumeRun(loop, crashed.state.runId)
    expect(resumed.state.stepIndex).toBe(0) // fold lands back on `remember`...
    const outcome = await driveRun(resumed, d)
    expect(outcome.state.status).toBe("needs_human")
    expect(storeLines(store)).toEqual(["always verify"]) // ...but replay, not re-execution: ONE append
    expect(ex.counts).toEqual({ remember: 1, confirm: 0 })
    expect(outcome.decision.kind).toBe("escalate")
  })
})

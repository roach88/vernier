// The CLI surface, asserted as agents will consume it: spawned as a real
// process, --json parsed, exit codes per class (0 done, 1 not-success
// terminal, 2 usage, 3 lease held). Everything here is deterministic — the
// only loop actually RUN is control-plane-smoke-test (Pilot 0, script-only).

import { execFile } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { startRun } from "../src/engine/tick.js"
import { leasePath, type LeaseRecord } from "../src/engine/lease.js"
import { executorRegistry } from "../src/executors/script.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { Ledger, journalPath, resumeKey } from "../src/ledger/ledger.js"
import { controlPlaneSmokeLoop } from "../src/pilot0/loop.js"

const execFileAsync = promisify(execFile)
const BIN = join(import.meta.dirname, "..", "bin", "vernier.js")

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function cli(home: string, ...args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: { ...process.env, VERNIER_HOME: home },
      encoding: "utf8",
      timeout: 60_000,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

const home = (): string => mkdtempSync(join(tmpdir(), "vernier-cli-"))

/**
 * A half-finished smoke run: meta journaled (as `vernier run` would have
 * written first), then the driver "crashed" before its first tick. Built
 * in-process so the crash point is exact and deterministic.
 */
function crashedSmokeRun(root: string): { runId: string; runDir: string } {
  const workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  const loop = { ...controlPlaneSmokeLoop, ledger: { root } }
  const run = startRun(
    loop,
    { jobName: "watch-every-compound-engineering-upstream" },
    { executors: executorRegistry(), contracts: new ContractRegistry(), workdir },
  )
  return { runId: run.state.runId, runDir: dirname(run.ledger.path) }
}

const liveLease = (over: Partial<LeaseRecord> = {}): LeaseRecord => ({
  pid: process.pid, // the test runner: alive for the duration, never the CLI child
  host: hostname(),
  acquiredAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  ttlMs: 60_000,
  ...over,
})

describe("vernier CLI", () => {
  it("`loops --json` lists the four registered loops with id/version/signature/trust", async () => {
    const result = await cli(home(), "loops", "--json")
    expect(result.code).toBe(0)
    const loops = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    expect(loops.map((l) => l.id)).toEqual(["control-plane-smoke-test", "plan-work-review", "verified-answer", "compounding-answer"])
    const smoke = loops[0]!
    expect(smoke.version).toBe("0.2.0")
    expect(smoke.trust).toBe("dry-run")
    expect(smoke.live).toBe(false)
    expect(String(smoke.signature)).toContain("->")
  })

  it("`run control-plane-smoke-test --json` drives to done: exit 0, machine-readable outcome, lease released", async () => {
    const root = home()
    const result = await cli(root, "run", "control-plane-smoke-test", "--json")
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as Record<string, unknown>
    expect(outcome.status).toBe("done")
    expect(outcome.loopId).toBe("control-plane-smoke-test")
    expect((outcome.decision as Record<string, unknown>).kind).toBe("stop")
    expect((outcome.output as Record<string, unknown>).ok).toBe(true)
    const runId = String(outcome.runId)
    expect(existsSync(journalPath(root, runId))).toBe(true)
    expect(existsSync(leasePath(dirname(journalPath(root, runId))))).toBe(false) // released on terminal

    const runs = await cli(root, "runs", "--json")
    expect(runs.code).toBe(0)
    const listed = JSON.parse(runs.stdout) as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ runId, loopId: "control-plane-smoke-test", status: "done" })

    const show = await cli(root, "show", runId, "--json")
    expect(show.code).toBe(0)
    const shown = JSON.parse(show.stdout) as Record<string, unknown>
    expect(shown.status).toBe("done")
    expect((shown.entries as unknown[]).map((e) => (e as { type: string }).type)).toEqual([
      "meta",
      "step_started",
      "step_result",
      "contract",
      "effects",
      "decision",
    ])
  })

  it("`run` accepts --input and honors it", async () => {
    const root = home()
    const result = await cli(root, "run", "control-plane-smoke-test", "--input", '{"jobName":"x","upstreamChanged":true}', "--json")
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as { runId: string }
    const entries = Ledger.load(journalPath(root, outcome.runId))
    const stepResult = entries.find((e) => e.type === "step_result")
    expect(stepResult?.type === "step_result" && stepResult.output.watcherOutcome).toBe("changed")
  })

  it("crash -> `resume` round trip: a half-finished run resumes from its ledger to done", async () => {
    const root = home()
    const { runId } = crashedSmokeRun(root) // meta written, then the driver died

    const result = await cli(root, "resume", runId, "--json")
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as Record<string, unknown>
    expect(outcome).toMatchObject({ runId, status: "done", resumed: true })

    // Exactly one execution of the step across crash + resume.
    const entries = Ledger.load(journalPath(root, runId))
    expect(entries.filter((e) => e.type === "step_started")).toHaveLength(1)

    // Resuming a terminal run is a no-op with the terminal status's exit code.
    const again = await cli(root, "resume", runId, "--json")
    expect(again.code).toBe(0)
    expect(JSON.parse(again.stdout)).toMatchObject({ runId, status: "done", alreadyTerminal: true })
  })

  it("`tick` advances ONE step from the ledger", async () => {
    const root = home()
    const { runId } = crashedSmokeRun(root)
    const result = await cli(root, "tick", runId, "--json")
    expect(result.code).toBe(0) // the single smoke step is also the terminal one
    const outcome = JSON.parse(result.stdout) as Record<string, unknown>
    expect(outcome).toMatchObject({ runId, status: "done" })
    expect((outcome.decision as Record<string, unknown>).kind).toBe("stop")
  })

  it("exit 3: a LIVE lease blocks a second driver, and the run is untouched", async () => {
    const root = home()
    const { runId, runDir } = crashedSmokeRun(root)
    writeFileSync(leasePath(runDir), JSON.stringify(liveLease()) + "\n", "utf8")

    const result = await cli(root, "resume", runId, "--json")
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("lease held")
    expect(result.stderr).toContain(`pid ${process.pid}`)
    expect(Ledger.load(journalPath(root, runId))).toHaveLength(1) // still just meta: nothing advanced
  })

  it("a STALE lease (dead pid, old heartbeat) is taken over; the run completes; the lease is released", async () => {
    const root = home()
    const { runId, runDir } = crashedSmokeRun(root)
    writeFileSync(
      leasePath(runDir),
      JSON.stringify(liveLease({ pid: 4_000_000, heartbeatAt: "2000-01-01T00:00:00.000Z" })) + "\n",
      "utf8",
    )

    const result = await cli(root, "resume", runId, "--json")
    expect(result.code).toBe(0)
    expect(result.stderr).toContain("took over a stale lease")
    expect(JSON.parse(result.stdout)).toMatchObject({ runId, status: "done" })
    expect(existsSync(leasePath(runDir))).toBe(false) // released on terminal state
  })

  it("exit 1: a run that resumed to a not-success terminal state", async () => {
    const root = home()
    const { runId } = crashedSmokeRun(root)
    // Journal an escalate decision (as a crashed driver would have, e.g. on
    // an out-of-scope write) — the run is terminal needs_human.
    const ledger = new Ledger(journalPath(root, runId))
    ledger.append({
      type: "decision",
      key: resumeKey("smoke", {}, 1, 1),
      stepId: "smoke",
      attempt: 1,
      iteration: 1,
      decision: { kind: "escalate", classification: "failure", summary: "boundary needs review", notes: [], improvement: "none" },
      at: new Date().toISOString(),
    })

    const result = await cli(root, "resume", runId, "--json")
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ runId, status: "needs_human", alreadyTerminal: true })
  })

  it("exit 2: usage errors are actionable — unknown loop, unknown run, bad input JSON, unknown command", async () => {
    const root = home()
    const unknownLoop = await cli(root, "run", "nope")
    expect(unknownLoop.code).toBe(2)
    expect(unknownLoop.stderr).toContain("Registered loops:")

    const unknownRun = await cli(root, "tick", "no-such-run")
    expect(unknownRun.code).toBe(2)
    expect(unknownRun.stderr).toContain("vernier runs")

    const badJson = await cli(root, "run", "control-plane-smoke-test", "--input", "{oops")
    expect(badJson.code).toBe(2)
    expect(badJson.stderr).toContain("not valid JSON")

    const badInputs = await cli(root, "run", "control-plane-smoke-test", "--input", '{"jobName":7}')
    expect(badInputs.code).toBe(2)
    expect(badInputs.stderr).toContain("signature")

    const unknownCmd = await cli(root, "frobnicate")
    expect(unknownCmd.code).toBe(2)
    expect(unknownCmd.stderr).toContain("Unknown command")

    const noCmd = await cli(root)
    expect(noCmd.code).toBe(2)

    const help = await cli(root, "--help")
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("EXIT CODES")
  })

  it("`show` renders a run TIMELINE for humans and an additive timeline block under --json", async () => {
    const root = home()
    const ran = await cli(root, "run", "control-plane-smoke-test", "--json")
    const runId = String((JSON.parse(ran.stdout) as { runId: string }).runId)

    const human = await cli(root, "show", runId)
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("--- timeline (6 events) ---")
    expect(human.stdout).toContain("◷ run start — control-plane-smoke-test@0.2.0")
    expect(human.stdout).toContain("▶ smoke#1.1 started (script:control-plane-smoke)")
    expect(human.stdout).toContain("✔ smoke#1.1 completed")
    expect(human.stdout).toContain("contract run-trace.v1 passed")
    expect(human.stdout).toContain("■ smoke#1.1 stop/success")
    expect(human.stdout).toContain("--- per-step usage ---")
    expect(human.stdout).toContain("--- summary ---")
    expect(human.stdout).toContain("status      done (1 iteration, 1 step run)")

    const shown = await cli(root, "show", runId, "--json")
    expect(shown.code).toBe(0)
    const parsed = JSON.parse(shown.stdout) as { entries: unknown[]; timeline: Record<string, unknown> }
    expect(parsed.entries).toHaveLength(6) // the pre-timeline shape is intact (additive change)
    expect(parsed.timeline).toMatchObject({ runId, loopId: "control-plane-smoke-test", status: "done", iterations: 1, stepsRun: 1, skipped: 0 })
    expect(parsed.timeline.events).toHaveLength(6)
    expect(parsed.timeline.steps).toEqual([expect.objectContaining({ stepId: "smoke", executions: 1, hasUsage: true })])
  })

  /** A synthesized verified-answer iterate arc (fail -> iterate -> pass) with usage, journaled as `vernier run` would have. */
  function writeIterateArcJournal(root: string, runId: string): void {
    const T0 = Date.parse("2026-06-09T00:00:00.000Z") // older than any live smoke run in the same root
    const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
    const usage = (inTok: number, outTok: number, ms: number) => ({ inputTokens: inTok, outputTokens: outTok, costUsd: 0, durationMs: ms })
    const entries = [
      { type: "meta", runId, traceId: runId, loopId: "verified-answer", loopVersion: "0.1.0", trust: "active", inputs: { goal: "g", rubric: "r" }, keyVersion: "loop-v2", at: at(0) },
      { type: "step_started", key: "a11", stepId: "answer", attempt: 1, iteration: 1, executorId: "codex", at: at(0) },
      { type: "step_result", key: "a11", stepId: "answer", attempt: 1, iteration: 1, status: "completed", output: {}, outputValid: true, evidence: [], usage: usage(26_432, 109, 8_374), at: at(8.4) },
      { type: "decision", key: "a11", stepId: "answer", attempt: 1, iteration: 1, decision: { kind: "continue", classification: "success", summary: "next", notes: [], improvement: "none" }, at: at(8.4) },
      { type: "step_started", key: "g11", stepId: "grade", attempt: 1, iteration: 1, executorId: "judge", at: at(8.5) },
      { type: "step_result", key: "g11", stepId: "grade", attempt: 1, iteration: 1, status: "completed", output: { passed: false }, outputValid: true, evidence: [], usage: usage(2_000, 50, 3_000), at: at(11.5) },
      { type: "decision", key: "g11", stepId: "grade", attempt: 1, iteration: 1, decision: { kind: "iterate", classification: "failure", summary: "verdict FAIL", notes: [], improvement: "none", restartAt: "answer" }, at: at(11.5) },
      { type: "step_started", key: "a21", stepId: "answer", attempt: 1, iteration: 2, executorId: "codex", at: at(11.6) },
      { type: "step_result", key: "a21", stepId: "answer", attempt: 1, iteration: 2, status: "completed", output: {}, outputValid: true, evidence: [], usage: usage(27_000, 120, 9_000), at: at(20.6) },
      { type: "decision", key: "a21", stepId: "answer", attempt: 1, iteration: 2, decision: { kind: "continue", classification: "success", summary: "next", notes: [], improvement: "none" }, at: at(20.6) },
      { type: "step_started", key: "g21", stepId: "grade", attempt: 1, iteration: 2, executorId: "judge", at: at(20.7) },
      { type: "step_result", key: "g21", stepId: "grade", attempt: 1, iteration: 2, status: "completed", output: { passed: true }, outputValid: true, evidence: [], usage: usage(2_100, 48, 2_800), at: at(24) },
      { type: "decision", key: "g21", stepId: "grade", attempt: 1, iteration: 2, decision: { kind: "stop", classification: "success", summary: "passed", notes: [], improvement: "none" }, at: at(24) },
    ]
    const path = journalPath(root, runId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")
  }

  it("`stats` rolls up runs per loop with per-step usage; --loop and --last filter; tokens only without prices", async () => {
    const root = home()
    await cli(root, "run", "control-plane-smoke-test", "--json")
    writeIterateArcJournal(root, "verified-answer-20260609-fixture")

    const result = await cli(root, "stats", "--json")
    expect(result.code).toBe(0)
    const stats = JSON.parse(result.stdout) as { runs: Array<Record<string, any>>; loops: Array<Record<string, any>>; prices: unknown }
    expect(stats.prices).toBeNull()
    expect(stats.runs).toHaveLength(2)
    expect(stats.runs[0]).toMatchObject({
      runId: "verified-answer-20260609-fixture", // sorted by startedAt: the fixture is older
      loopId: "verified-answer",
      status: "done",
      iterations: 2,
      stepsRun: 4,
      wallMs: 24_000,
      totals: { inputTokens: 57_532, outputTokens: 327 },
    })
    expect(stats.runs[0]!.costUsd).toBeUndefined() // no prices -> no invented dollars
    // Per-STEP attribution in the roll-up: the answer step ate the tokens.
    const va = stats.loops.find((l) => l.loopId === "verified-answer")!
    expect(va).toMatchObject({ runs: 1, succeeded: 1, successRate: 1, meanIterations: 2 })
    expect(va.steps).toEqual([
      expect.objectContaining({ stepId: "answer", executions: 2, inputTokens: 53_432 }),
      expect.objectContaining({ stepId: "grade", executions: 2, inputTokens: 4_100 }),
    ])
    expect(stats.loops.map((l) => l.loopId)).toContain("control-plane-smoke-test")

    const filtered = await cli(root, "stats", "--loop", "verified-answer", "--json")
    expect((JSON.parse(filtered.stdout) as { runs: unknown[] }).runs).toHaveLength(1)

    const lastOne = await cli(root, "stats", "--last", "1", "--json")
    const lastRuns = (JSON.parse(lastOne.stdout) as { runs: Array<{ loopId: string }> }).runs
    expect(lastRuns).toHaveLength(1)
    expect(lastRuns[0]!.loopId).toBe("control-plane-smoke-test") // most recent: the live smoke run

    const human = await cli(root, "stats")
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("runs (2)")
    expect(human.stdout).toContain("TOK-IN")
    expect(human.stdout).toContain("57,532")
    expect(human.stdout).toContain("per loop")
    expect(human.stdout).toContain("verified-answer  runs=1  success=100%  mean-iter=2.0")
    expect(human.stdout).toMatch(/answer\s+2\s+53,432/) // per-step usage under the loop
    expect(human.stdout).not.toContain("$")
    expect(human.stdout).toContain("pass --price-in/--price-out")
  })

  it("`stats` computes a cost column ONLY when both prices are given; one-sided prices and bad --last are usage errors", async () => {
    const root = home()
    writeIterateArcJournal(root, "verified-answer-20260609-fixture")

    const priced = await cli(root, "stats", "--price-in", "3", "--price-out", "15", "--json")
    expect(priced.code).toBe(0)
    const stats = JSON.parse(priced.stdout) as { prices: unknown; runs: Array<{ costUsd?: number }> }
    expect(stats.prices).toEqual({ inUsdPerMTok: 3, outUsdPerMTok: 15 })
    expect(stats.runs[0]!.costUsd).toBeCloseTo((57_532 * 3 + 327 * 15) / 1_000_000) // 0.177501

    const pricedHuman = await cli(root, "stats", "--price-in", "3", "--price-out", "15")
    expect(pricedHuman.stdout).toContain("COST")
    expect(pricedHuman.stdout).toContain("$0.1775")

    const oneSided = await cli(root, "stats", "--price-in", "3")
    expect(oneSided.code).toBe(2)
    expect(oneSided.stderr).toContain("BOTH --price-in and --price-out")

    const badLast = await cli(root, "stats", "--last", "0")
    expect(badLast.code).toBe(2)
    expect(badLast.stderr).toContain("--last expects a positive integer")

    const empty = await cli(home(), "stats", "--json")
    expect(empty.code).toBe(0)
    expect(JSON.parse(empty.stdout)).toMatchObject({ runs: [], loops: [] })
  })

  it("keeps stdout machine-clean under --json: diagnostics go to stderr", async () => {
    const root = home()
    const { runId, runDir } = crashedSmokeRun(root)
    writeFileSync(
      leasePath(runDir),
      JSON.stringify(liveLease({ pid: 4_000_000, heartbeatAt: "2000-01-01T00:00:00.000Z" })) + "\n",
      "utf8",
    )
    const result = await cli(root, "resume", runId, "--json")
    expect(result.code).toBe(0)
    expect(() => JSON.parse(result.stdout)).not.toThrow() // stale-lease note did NOT pollute stdout
    expect(result.stderr).toContain("stale lease")
  })
})

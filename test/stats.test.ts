// The observability layer: pure derivations over journal entries
// (src/ledger/stats.ts), tested on synthesized fixtures — an iterate arc
// with usage (the pilot-2 fail -> iterate -> pass shape), a contract-fail /
// retry arc, and a legacy (pre-loop-v2) journal with a torn line and an
// unknown entry type. No live runs; no engine.

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { LedgerEntry } from "../src/ledger/ledger.js"
import { Ledger } from "../src/ledger/ledger.js"
import {
  buildTimeline,
  computedCostUsd,
  renderStats,
  renderTimeline,
  rollupByLoop,
  runStatsRow,
  type RunStatsRow,
} from "../src/ledger/stats.js"

// ------------------------------------------------------------ entry builders

const T0 = Date.parse("2026-06-10T00:00:00.000Z")
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const meta = (loopId: string, runId: string, over: Record<string, unknown> = {}): LedgerEntry =>
  ({
    type: "meta",
    runId,
    traceId: runId,
    loopId,
    loopVersion: "0.1.0",
    trust: "active",
    inputs: { goal: "g" },
    keyVersion: "loop-v2",
    at: at(0),
    ...over,
  }) as LedgerEntry

const started = (stepId: string, iteration: number, attempt: number, executorId: string, atS: number): LedgerEntry =>
  ({ type: "step_started", key: `${stepId}-${iteration}-${attempt}`, stepId, iteration, attempt, executorId, at: at(atS) }) as LedgerEntry

const result = (stepId: string, iteration: number, attempt: number, usage: { in: number; out: number; ms: number; usd?: number } | null, atS: number): LedgerEntry =>
  ({
    type: "step_result",
    key: `${stepId}-${iteration}-${attempt}`,
    stepId,
    iteration,
    attempt,
    status: "completed",
    output: {},
    outputValid: true,
    evidence: [],
    ...(usage ? { usage: { inputTokens: usage.in, outputTokens: usage.out, costUsd: usage.usd ?? 0, durationMs: usage.ms } } : {}),
    at: at(atS),
  }) as LedgerEntry

const contract = (stepId: string, iteration: number, attempt: number, valid: boolean, failed: readonly string[], atS: number): LedgerEntry =>
  ({
    type: "contract",
    key: `${stepId}-${iteration}-${attempt}`,
    stepId,
    iteration,
    attempt,
    result: {
      contractId: "run-trace.v1",
      valid,
      checks: [...failed.map((label) => ({ label, passed: false, detail: "missing" })), { label: "always-passes", passed: true, detail: "ok" }],
    },
    at: at(atS),
  }) as LedgerEntry

const effects = (stepId: string, iteration: number, attempt: number, changed: readonly string[], unexpected: readonly string[], atS: number): LedgerEntry =>
  ({
    type: "effects",
    key: `${stepId}-${iteration}-${attempt}`,
    stepId,
    iteration,
    attempt,
    observation: { changed, allowed: unexpected.length === 0, unexpected },
    at: at(atS),
  }) as LedgerEntry

const decision = (stepId: string, iteration: number, attempt: number, kind: string, classification: string, atS: number, over: Record<string, unknown> = {}): LedgerEntry =>
  ({
    type: "decision",
    key: `${stepId}-${iteration}-${attempt}`,
    stepId,
    iteration,
    attempt,
    decision: { kind, classification, summary: `${stepId} -> ${kind}`, notes: [], improvement: "none", ...over },
    at: at(atS),
  }) as LedgerEntry

/** The pilot-2 shape: answer -> grade FAILS -> iterate back -> answer -> grade passes. */
const iterateArc = (runId = "va-run-1"): LedgerEntry[] => [
  meta("verified-answer", runId),
  started("answer", 1, 1, "codex", 0),
  result("answer", 1, 1, { in: 26_432, out: 109, ms: 8_374 }, 8.4),
  effects("answer", 1, 1, [], [], 8.4),
  decision("answer", 1, 1, "continue", "success", 8.4),
  started("grade", 1, 1, "judge", 8.5),
  result("grade", 1, 1, { in: 2_000, out: 50, ms: 3_000 }, 11.5),
  decision("grade", 1, 1, "iterate", "failure", 11.5, { restartAt: "answer", summary: "verdict FAIL — missing Michael Collins" }),
  started("answer", 2, 1, "codex", 11.6),
  result("answer", 2, 1, { in: 27_000, out: 120, ms: 9_000 }, 20.6),
  effects("answer", 2, 1, [], [], 20.6),
  decision("answer", 2, 1, "continue", "success", 20.6),
  started("grade", 2, 1, "judge", 20.7),
  result("grade", 2, 1, { in: 2_100, out: 48, ms: 2_800 }, 24),
  decision("grade", 2, 1, "stop", "success", 24),
]

// ------------------------------------------------------------------ timeline

describe("buildTimeline", () => {
  it("derives the iterate arc: offsets, transitions, per-step usage, totals", () => {
    const t = buildTimeline(iterateArc())
    expect(t).toMatchObject({ runId: "va-run-1", loopId: "verified-answer", status: "done", iterations: 2, stepsRun: 4, skipped: 0 })
    expect(t.wallMs).toBe(24_000)
    expect(t.events).toHaveLength(15)

    // Relative offsets, anchored at the meta entry.
    expect(t.events[0]).toMatchObject({ type: "meta", offsetMs: 0, loopId: "verified-answer", keyVersion: "loop-v2" })
    expect(t.events[2]).toMatchObject({ type: "step_result", stepId: "answer", offsetMs: 8_400, usage: { inputTokens: 26_432 } })

    // The iterate transition is first-class: kind + where the loop re-enters.
    const iterate = t.events.find((e) => e.type === "decision" && e.kind === "iterate")
    expect(iterate).toMatchObject({ stepId: "grade", iteration: 1, restartAt: "answer", classification: "failure" })

    // Per-STEP attribution: the answer step ate the tokens, not the grade step.
    expect(t.steps).toEqual([
      expect.objectContaining({ stepId: "answer", executions: 2, inputTokens: 53_432, outputTokens: 229, durationMs: 17_374, hasUsage: true }),
      expect.objectContaining({ stepId: "grade", executions: 2, inputTokens: 4_100, outputTokens: 98, durationMs: 5_800, hasUsage: true }),
    ])
    expect(t.totals).toMatchObject({ inputTokens: 57_532, outputTokens: 327, durationMs: 23_174, reportedCostUsd: 0, hasUsage: true })
  })

  it("renders the fail -> iterate -> pass arc readably, with a closing summary", () => {
    const lines = renderTimeline(buildTimeline(iterateArc())).join("\n")
    expect(lines).toContain("--- timeline (15 events) ---")
    expect(lines).toContain("◷ run start — verified-answer@0.1.0")
    expect(lines).toContain("▶ answer#1.1 started (codex)")
    expect(lines).toContain("✔ answer#1.1 completed — in=26,432 out=109 · 8.4s")
    expect(lines).toContain("⟲ grade#1.1 ITERATE → re-run from answer (iteration 2) — verdict FAIL — missing Michael Collins")
    expect(lines).toContain("▶ answer#2.1 started (codex)") // the arc visibly re-enters
    expect(lines).toContain("■ grade#2.1 stop/success")
    expect(lines).toContain("--- per-step usage ---")
    expect(lines).toMatch(/answer\s+2\s+53,432\s+229/)
    expect(lines).toContain("status      done (2 iterations, 4 steps run)")
    expect(lines).toContain("wall        24.0s (busy 23.2s)")
    expect(lines).toContain("tokens      in=57,532 out=327")
    expect(lines).not.toContain("$") // no prices, no dollars
  })

  it("derives a contract-fail/retry arc with failed-check names", () => {
    const arc: LedgerEntry[] = [
      meta("plan-work-review", "pwr-run-1"),
      started("write", 1, 1, "codex", 0),
      result("write", 1, 1, { in: 100, out: 10, ms: 500 }, 0.5),
      contract("write", 1, 1, false, ["artifact exists"], 0.5),
      decision("write", 1, 1, "retry", "failure", 0.5),
      started("write", 1, 2, "codex", 0.6),
      result("write", 1, 2, { in: 120, out: 12, ms: 400 }, 1),
      contract("write", 1, 2, true, [], 1),
      effects("write", 1, 2, ["notes/a.md"], [], 1),
      decision("write", 1, 2, "stop", "success", 1),
    ]
    const t = buildTimeline(arc)
    const failed = t.events.find((e) => e.type === "contract" && !e.valid)
    expect(failed).toMatchObject({ contractId: "run-trace.v1", failedChecks: ["artifact exists"] })
    expect(t.steps).toEqual([expect.objectContaining({ stepId: "write", executions: 2, inputTokens: 220 })])

    const lines = renderTimeline(t).join("\n")
    expect(lines).toContain("✖ write#1.1 contract run-trace.v1 FAILED: artifact exists")
    expect(lines).toContain("↻ write#1.1 RETRY → attempt 2")
    expect(lines).toContain("± write#1.2 effects: 1 file changed (allowed)")
  })

  it("flags out-of-scope effects", () => {
    const t = buildTimeline([meta("l", "r"), effects("write", 1, 1, ["a", "b"], ["b"], 1)])
    expect(t.events[1]).toMatchObject({ type: "effects", changed: 2, allowed: false, unexpected: ["b"] })
    expect(renderTimeline(t).join("\n")).toContain("⚠ write#1.1 effects: 2 changed — OUT OF SCOPE: b")
  })

  it("degrades gracefully on a legacy journal: torn line dropped, unknown entry counted, missing usage blank, missing iteration defaulted", () => {
    const path = join(mkdtempSync(join(tmpdir(), "looper-stats-")), "journal.jsonl")
    writeFileSync(
      path,
      [
        JSON.stringify(meta("plan-work-review", "legacy-1", { keyVersion: "loop-v1" })),
        // Pre-loop-v2 entries: no `iteration`; this one also carries no usage.
        '{"type":"step_started","key":"k1","stepId":"route","attempt":1,"executorId":"hermes","at":"2026-06-10T00:00:01.000Z"}',
        '{"type":"step_result","key":"k1","stepId":"route","attempt":1,"status":"completed","output":{},"outputValid":true,"evidence":[],"at":"2026-06-10T00:00:02.000Z"}',
        '{"type":"telemetry","payload":"a future entry type"}',
        '{"type":"decision","key":"k1","stepId":"route","attempt":1,"decision":{"kind":"stop","classification":"success","summary":"done","notes":[],"improvement":"none"},"at":"2026-06-10T00:00:03.000Z"}',
        '{"type":"step_result","key":"k2","torn', // torn trailing line: Ledger.load drops it
      ].join("\n"),
      "utf8",
    )
    const t = buildTimeline(Ledger.load(path))
    expect(t).toMatchObject({ status: "done", iterations: 1, stepsRun: 1, skipped: 1, wallMs: 3_000 })
    expect(t.totals.hasUsage).toBe(false)
    expect(t.events.find((e) => e.type === "step_started")).toMatchObject({ stepId: "route", iteration: 1, attempt: 1 })

    const lines = renderTimeline(t).join("\n")
    expect(lines).toContain("tokens      <no usage recorded>")
    expect(lines).toContain("skipped     1 unknown entry")
    expect(lines).toMatch(/route\s+1\s+-\s+-\s+-/) // blanks, not invented zeros
  })

  it("handles an empty journal (no meta, nothing ran)", () => {
    const t = buildTimeline([])
    expect(t).toMatchObject({ runId: null, loopId: null, status: "running", iterations: 0, stepsRun: 0, wallMs: null, skipped: 0 })
    expect(renderTimeline(t).join("\n")).toContain("--- summary ---")
  })
})

// --------------------------------------------------------------------- stats

describe("runStatsRow / rollupByLoop", () => {
  const stoppedRun = (runId: string): LedgerEntry[] => [
    meta("verified-answer", runId),
    started("answer", 1, 1, "codex", 0),
    result("answer", 1, 1, { in: 10_000, out: 40, ms: 5_000 }, 5),
    decision("answer", 1, 1, "stop", "failure", 5),
  ]

  it("derives a per-run row; journals without meta yield null", () => {
    const row = runStatsRow("va-run-1", iterateArc())
    expect(row).toMatchObject({
      runId: "va-run-1",
      loopId: "verified-answer",
      status: "done",
      iterations: 2,
      stepsRun: 4,
      wallMs: 24_000,
      totals: { inputTokens: 57_532, outputTokens: 327 },
    })
    expect(runStatsRow("orphan", [started("x", 1, 1, "script", 0)])).toBeNull()
  })

  it("rolls up per loop id: success rate, mean iterations, merged per-step usage", () => {
    const rows = [runStatsRow("va-run-1", iterateArc()), runStatsRow("va-run-2", stoppedRun("va-run-2"))].filter((r): r is RunStatsRow => r !== null)
    const rollups = rollupByLoop(rows)
    expect(rollups).toHaveLength(1)
    expect(rollups[0]).toMatchObject({
      loopId: "verified-answer",
      runs: 2,
      succeeded: 1,
      successRate: 0.5,
      meanIterations: 1.5,
      wallMs: 29_000,
      totals: { inputTokens: 67_532, outputTokens: 367 },
    })
    // Per-step attribution survives aggregation: answer ate the tokens across BOTH runs.
    expect(rollups[0]?.steps).toEqual([
      expect.objectContaining({ stepId: "answer", executions: 3, inputTokens: 63_432 }),
      expect.objectContaining({ stepId: "grade", executions: 2, inputTokens: 4_100 }),
    ])
  })

  it("computes cost ONLY from explicit prices; renders tokens-only without them", () => {
    expect(computedCostUsd({ inputTokens: 1_000_000, outputTokens: 500_000 }, { inUsdPerMTok: 3, outUsdPerMTok: 15 })).toBeCloseTo(10.5)

    const rows = [runStatsRow("va-run-1", iterateArc())].filter((r): r is RunStatsRow => r !== null)
    const rollups = rollupByLoop(rows)
    const without = renderStats(rows, rollups, null).join("\n")
    expect(without).toContain("TOK-IN")
    expect(without).not.toContain("$")
    expect(without).toContain("pass --price-in/--price-out")

    const withPrices = renderStats(rows, rollups, { inUsdPerMTok: 3, outUsdPerMTok: 15 }).join("\n")
    expect(withPrices).toContain("COST")
    // 57,532 in * $3/M + 327 out * $15/M = $0.177501 -> rendered at 4 decimals
    expect(withPrices).toContain("$0.1775")
    // Per-step cost: answer 53,432*3/M + 229*15/M = $0.163731
    expect(withPrices).toMatch(/answer\s+2\s+53,432\s+229\s+17\.4s\s+\$0\.1637/)
  })

  it("surfaces executor-REPORTED cost separately from computed cost", () => {
    const entries: LedgerEntry[] = [
      meta("claude-loop", "cl-run-1"),
      started("draft", 1, 1, "claude", 0),
      result("draft", 1, 1, { in: 1_000, out: 200, ms: 2_000, usd: 0.42 }, 2),
      decision("draft", 1, 1, "stop", "success", 2),
    ]
    const rows = [runStatsRow("cl-run-1", entries)].filter((r): r is RunStatsRow => r !== null)
    expect(rows[0]?.totals.reportedCostUsd).toBeCloseTo(0.42)
    expect(renderStats(rows, rollupByLoop(rows), null).join("\n")).toContain("reported-cost=$0.4200")
  })
})

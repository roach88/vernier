import { describe, expect, it } from "vitest"
import type { RunEvidenceProjection } from "../src/ledger/evidence.js"
import { RUN_EVIDENCE_SCHEMA_VERSION } from "../src/ledger/evidence.js"
import { evaluateTrustStatus } from "../src/ledger/trust.js"

const baseEvidence = (overrides: Partial<RunEvidenceProjection> = {}): RunEvidenceProjection => ({
  schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
  ledgerPath: `/tmp/${overrides.runId ?? "run"}/journal.jsonl`,
  runId: "run-1",
  traceId: "run-1",
  loopId: "loop-a",
  loopVersion: "1.0.0",
  keyVersion: "loop-v2",
  trust: "dry-run",
  startedAt: "2026-06-19T00:00:00.000Z",
  terminalStatus: "done",
  outcome: { terminalSuccess: true, escalated: false, stoppedFailure: false },
  totals: {
    steps: 1,
    outputInvalid: 0,
    contractsFailed: 0,
    contractsMissing: 0,
    effectsFailed: 0,
    effectsUnknown: 0,
    usageAvailable: true,
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 100,
    reportedCostUsd: 0,
  },
  strict: { validCurrentV2: true, usableForTrust: true },
  steps: [
    {
      key: "judge:1:1",
      stepId: "judge",
      iteration: 1,
      attempt: 1,
      executorId: "judge",
      status: "completed",
      output: "valid",
      contract: "passed",
      effects: "not_applicable",
      unexpectedEffects: [],
      observedEffects: null,
      artifacts: [],
      usage: { available: true, inputTokens: 10, outputTokens: 5, durationMs: 100, reportedCostUsd: 0 },
    },
  ],
  diagnostics: [],
  ...overrides,
})

describe("trust status evaluation", () => {
  it("promotes only when the required clean current-version evidence is present", () => {
    const evidence = [
      baseEvidence({ runId: "run-1", startedAt: "2026-06-19T00:00:01.000Z" }),
      baseEvidence({ runId: "run-2", startedAt: "2026-06-19T00:00:02.000Z" }),
      baseEvidence({ runId: "run-3", startedAt: "2026-06-19T00:00:03.000Z" }),
    ]

    const report = evaluateTrustStatus({ loopId: "loop-a", loopVersion: "1.0.0", evidence })

    expect(report.promotable).toBe(true)
    expect(report.status).toBe("promotable")
    expect(report.totals.cleanRuns).toBe(3)
    expect(report.reasons).toEqual([])
  })

  it("rejects non-current, non-terminal, human-escalated, invalid, and effect-unsafe evidence", () => {
    const evidence = [
      baseEvidence({ runId: "old-key", strict: { validCurrentV2: false, usableForTrust: false } }),
      baseEvidence({ runId: "needs-human", terminalStatus: "needs_human", outcome: { terminalSuccess: false, escalated: true, stoppedFailure: false } }),
      baseEvidence({ runId: "bad-effects", totals: { ...baseEvidence().totals, outputInvalid: 1, contractsFailed: 1, effectsFailed: 1, effectsUnknown: 1 } }),
    ]

    const report = evaluateTrustStatus({ loopId: "loop-a", loopVersion: "1.0.0", evidence })

    expect(report.promotable).toBe(false)
    expect(report.rejected.map((r) => r.runId).sort()).toEqual(["bad-effects", "needs-human", "old-key"])
    expect(report.reasons.join("\n")).toContain("not valid current-v2 evidence")
    expect(report.reasons.join("\n")).toContain("terminal status is needs_human")
    expect(report.reasons.join("\n")).toContain("unknown effect observation")
  })

  it("applies --last-style windows after sorting by startedAt/runId", () => {
    const evidence = [
      baseEvidence({ runId: "run-1", startedAt: "2026-06-19T00:00:01.000Z" }),
      baseEvidence({ runId: "run-2", startedAt: "2026-06-19T00:00:02.000Z", totals: { ...baseEvidence().totals, effectsFailed: 1 } }),
      baseEvidence({ runId: "run-3", startedAt: "2026-06-19T00:00:03.000Z" }),
    ]

    const report = evaluateTrustStatus({ loopId: "loop-a", loopVersion: "1.0.0", evidence, policy: { requiredRuns: 1, last: 1 } })

    expect(report.promotable).toBe(true)
    expect(report.considered.map((e) => e.runId)).toEqual(["run-3"])
  })
})

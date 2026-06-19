import { describe, expect, it } from "vitest"
import { KEY_VERSION, type LedgerEntry } from "../src/ledger/ledger.js"
import { RUN_EVIDENCE_SCHEMA_VERSION, projectRunEvidence, type RunEvidenceProjection } from "../src/ledger/evidence.js"

const at = (s: number): string => `2026-06-10T00:00:${String(s).padStart(2, "0")}.000Z`

const meta = (overrides: Record<string, unknown> = {}): LedgerEntry =>
  ({
    type: "meta",
    runId: "run-1",
    traceId: "trace-1",
    loopId: "plan-work-review",
    loopVersion: "0.5.1",
    trust: "active",
    inputs: { task: "write note" },
    keyVersion: KEY_VERSION,
    at: at(0),
    ...overrides,
  }) as LedgerEntry

const started = (stepId: string, key = `${stepId}-1`, executorId = "codex"): LedgerEntry =>
  ({ type: "step_started", key, stepId, iteration: 1, attempt: 1, executorId, at: at(1) }) as LedgerEntry

const result = (
  stepId: string,
  key = `${stepId}-1`,
  overrides: Record<string, unknown> = {},
): LedgerEntry =>
  ({
    type: "step_result",
    key,
    stepId,
    iteration: 1,
    attempt: 1,
    status: "completed",
    output: { ok: true },
    outputValid: true,
    evidence: [],
    usage: { inputTokens: 10, outputTokens: 3, costUsd: 0.01, durationMs: 120 },
    at: at(2),
    ...overrides,
  }) as LedgerEntry

const contract = (stepId: string, valid: boolean, key = `${stepId}-1`): LedgerEntry =>
  ({
    type: "contract",
    key,
    stepId,
    iteration: 1,
    attempt: 1,
    result: { contractId: "dry-run-note.v1", valid, checks: [{ label: "artifact exists", passed: valid, detail: "fixture" }] },
    at: at(3),
  }) as LedgerEntry

const effects = (stepId: string, allowed: boolean, key = `${stepId}-1`, overrides: Record<string, unknown> = {}): LedgerEntry =>
  ({
    type: "effects",
    key,
    stepId,
    iteration: 1,
    attempt: 1,
    observation: { changed: ["docs/a.md"], allowed, unexpected: allowed ? [] : ["secret.txt"], ...overrides },
    at: at(4),
  }) as LedgerEntry

const decision = (stepId: string, kind: "continue" | "stop" | "escalate", classification: "success" | "failure", key = `${stepId}-1`): LedgerEntry =>
  ({
    type: "decision",
    key,
    stepId,
    iteration: 1,
    attempt: 1,
    decision: { kind, classification, summary: "fixture", notes: [], improvement: "none" },
    at: at(5),
  }) as LedgerEntry

function assertKnownSchema(projection: RunEvidenceProjection): void {
  if (projection.schemaVersion !== RUN_EVIDENCE_SCHEMA_VERSION) throw new Error(`unknown run evidence schema: ${projection.schemaVersion}`)
}

describe("projectRunEvidence", () => {
  it("projects a clean current-v2 journal to success evidence usable by strict consumers", () => {
    const projection = projectRunEvidence({
      ledgerPath: "runs/run-1/journal.jsonl",
      entries: [
        meta(),
        started("write"),
        result("write", "write-1", { evidence: [{ role: "artifact", path: "docs/a.md" }] }),
        contract("write", true),
        effects("write", true),
        decision("write", "stop", "success"),
      ],
    })

    expect(projection).toMatchObject({
      schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
      ledgerPath: "runs/run-1/journal.jsonl",
      runId: "run-1",
      loopId: "plan-work-review",
      loopVersion: "0.5.1",
      keyVersion: KEY_VERSION,
      terminalStatus: "done",
      strict: { validCurrentV2: true, usableForTrust: true },
      outcome: { terminalSuccess: true, escalated: false },
      totals: {
        steps: 1,
        contractsFailed: 0,
        effectsFailed: 0,
        effectsUnknown: 0,
        outputInvalid: 0,
        usageAvailable: true,
        inputTokens: 10,
        outputTokens: 3,
        durationMs: 120,
        reportedCostUsd: 0.01,
      },
    })
    expect(projection.steps[0]).toMatchObject({
      stepId: "write",
      executorId: "codex",
      output: "valid",
      contract: "passed",
      effects: "passed",
      artifacts: [{ role: "artifact", path: "docs/a.md" }],
    })
    expect(projection.diagnostics).toEqual([])
  })

  it("represents load errors and missing meta as strict corrupt evidence", () => {
    const projection = projectRunEvidence({ ledgerPath: "runs/bad/journal.jsonl", loadError: new Error("invalid JSON at line 2") })

    expect(projection.strict).toEqual({ validCurrentV2: false, usableForTrust: false })
    expect(projection.terminalStatus).toBe("running")
    expect(projection.diagnostics).toEqual([
      { severity: "corrupt", code: "LEDGER_LOAD_ERROR", detail: "invalid JSON at line 2" },
      { severity: "corrupt", code: "MISSING_META", detail: "journal has no meta entry" },
    ])
  })

  it("degrades legacy key versions instead of treating display-compatible journals as trust evidence", () => {
    const projection = projectRunEvidence({
      entries: [meta({ keyVersion: "loop-v1" }), started("route"), result("route"), decision("route", "stop", "success")],
    })

    expect(projection.keyVersion).toBe("loop-v1")
    expect(projection.strict).toEqual({ validCurrentV2: false, usableForTrust: false })
    expect(projection.diagnostics).toContainEqual({ severity: "degraded", code: "LEGACY_KEY_VERSION", detail: `expected ${KEY_VERSION}, got loop-v1` })
  })

  it("preserves unsafe flags: failed contracts, unexpected effects, invalid output, and escalation", () => {
    const projection = projectRunEvidence({
      entries: [
        meta(),
        started("write"),
        result("write", "write-1", { outputValid: false }),
        contract("write", false),
        effects("write", false),
        decision("write", "escalate", "failure"),
      ],
    })

    expect(projection.terminalStatus).toBe("needs_human")
    expect(projection.strict.usableForTrust).toBe(false)
    expect(projection.outcome).toMatchObject({ terminalSuccess: false, escalated: true })
    expect(projection.totals).toMatchObject({ contractsFailed: 1, effectsFailed: 1, outputInvalid: 1 })
    expect(projection.steps[0]).toMatchObject({ output: "invalid", contract: "failed", effects: "failed", unexpectedEffects: ["secret.txt"] })
  })

  it("marks unobserved or missing effects as degraded/unknown evidence", () => {
    const unobserved = projectRunEvidence({
      entries: [meta(), started("write"), result("write"), effects("write", true, "write-1", { observed: false, reason: "observer crashed" }), decision("write", "stop", "success")],
    })
    expect(unobserved.strict.usableForTrust).toBe(false)
    expect(unobserved.totals.effectsUnknown).toBe(1)
    expect(unobserved.steps[0]).toMatchObject({ effects: "unknown", observedEffects: false })
    expect(unobserved.diagnostics).toContainEqual({ severity: "degraded", code: "EFFECTS_UNOBSERVED", detail: "step write effects were not observed: observer crashed" })

    const missing = projectRunEvidence({ entries: [meta(), started("write"), result("write"), decision("write", "stop", "success")] })
    expect(missing.strict.usableForTrust).toBe(false)
    expect(missing.totals.effectsUnknown).toBe(1)
    expect(missing.diagnostics).toContainEqual({ severity: "degraded", code: "MISSING_EFFECTS", detail: "completed step write has no effects entry" })
  })

  it("keeps missing usage honest rather than fabricating availability or cost", () => {
    const projection = projectRunEvidence({
      entries: [meta(), started("route"), result("route", "route-1", { usage: undefined }), decision("route", "stop", "success")],
    })

    expect(projection.steps[0]?.usage).toEqual({ available: false, inputTokens: 0, outputTokens: 0, durationMs: 0, reportedCostUsd: 0 })
    expect(projection.totals).toMatchObject({ usageAvailable: false, inputTokens: 0, outputTokens: 0, durationMs: 0, reportedCostUsd: 0 })
  })

  it("gives downstream readers a schema version to reject explicitly", () => {
    const projection = projectRunEvidence({ entries: [meta()] })
    expect(() => assertKnownSchema(projection)).not.toThrow()
    expect(() => assertKnownSchema({ ...projection, schemaVersion: "run-evidence.v999" as typeof RUN_EVIDENCE_SCHEMA_VERSION })).toThrow(
      "unknown run evidence schema: run-evidence.v999",
    )
  })
})

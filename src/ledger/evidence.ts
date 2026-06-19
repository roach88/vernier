import { summarizeJournal } from "../engine/resume.js"
import { KEY_VERSION, replay, type LedgerEntry } from "./ledger.js"

export const RUN_EVIDENCE_SCHEMA_VERSION = "run-evidence.v1" as const

export type RunEvidenceSeverity = "corrupt" | "degraded"
export type EffectEvidenceStatus = "passed" | "failed" | "unknown" | "not_applicable"
export type ContractEvidenceStatus = "passed" | "failed" | "missing" | "not_applicable"
export type OutputEvidenceStatus = "valid" | "invalid" | "missing"

export interface RunEvidenceDiagnostic {
  readonly severity: RunEvidenceSeverity
  readonly code: string
  readonly detail: string
}

export interface StepRunEvidence {
  readonly key: string
  readonly stepId: string
  readonly iteration: number
  readonly attempt: number
  readonly executorId: string | null
  readonly status: string
  readonly output: OutputEvidenceStatus
  readonly contract: ContractEvidenceStatus
  readonly effects: EffectEvidenceStatus
  readonly unexpectedEffects: readonly string[]
  readonly observedEffects: boolean | null
  readonly artifacts: readonly { readonly role: string; readonly path: string }[]
  readonly usage: {
    readonly available: boolean
    readonly inputTokens: number
    readonly outputTokens: number
    readonly durationMs: number
    readonly reportedCostUsd: number
  }
}

export interface RunEvidenceProjection {
  readonly schemaVersion: typeof RUN_EVIDENCE_SCHEMA_VERSION
  readonly ledgerPath: string | null
  readonly runId: string | null
  readonly traceId: string | null
  readonly loopId: string | null
  readonly loopVersion: string | null
  readonly keyVersion: string | null
  readonly trust: string | null
  readonly terminalStatus: string
  readonly startedAt: string | null
  readonly strict: {
    readonly validCurrentV2: boolean
    readonly usableForTrust: boolean
  }
  readonly outcome: {
    readonly terminalSuccess: boolean
    readonly escalated: boolean
    readonly stoppedFailure: boolean
  }
  readonly totals: {
    readonly steps: number
    readonly contractsFailed: number
    readonly contractsMissing: number
    readonly effectsFailed: number
    readonly effectsUnknown: number
    readonly outputInvalid: number
    readonly usageAvailable: boolean
    readonly inputTokens: number
    readonly outputTokens: number
    readonly durationMs: number
    readonly reportedCostUsd: number
  }
  readonly steps: readonly StepRunEvidence[]
  readonly diagnostics: readonly RunEvidenceDiagnostic[]
}

export interface ProjectRunEvidenceInput {
  readonly entries?: readonly LedgerEntry[]
  readonly ledgerPath?: string | null
  /** Pass Ledger.load/read errors here so corrupt evidence is represented, not thrown away by tolerant display callers. */
  readonly loadError?: unknown
}

export function projectRunEvidence(input: ProjectRunEvidenceInput): RunEvidenceProjection {
  const diagnostics: RunEvidenceDiagnostic[] = []
  const entries = input.entries ?? []
  if (input.loadError !== undefined) {
    diagnostics.push({ severity: "corrupt", code: "LEDGER_LOAD_ERROR", detail: errorDetail(input.loadError) })
  }

  const summary = summarizeJournal(entries)
  const view = replay(entries)
  const meta = summary.meta

  if (!meta) diagnostics.push({ severity: "corrupt", code: "MISSING_META", detail: "journal has no meta entry" })
  else if (meta.keyVersion !== KEY_VERSION) {
    diagnostics.push({ severity: "degraded", code: "LEGACY_KEY_VERSION", detail: `expected ${KEY_VERSION}, got ${meta.keyVersion || "<missing>"}` })
  }

  const startedByKey = new Map([...view.started.entries()])
  const steps: StepRunEvidence[] = []
  for (const [key, result] of view.terminal.entries()) {
    const started = startedByKey.get(key)
    if (!started) diagnostics.push({ severity: "corrupt", code: "ORPHAN_STEP_RESULT", detail: `step_result ${key} has no matching step_started entry` })
    const contract = view.contracts.get(key)
    const effects = view.effects.get(key)
    const usage = usageEvidence(result.usage)
    const output = outputEvidence(result)
    const contractStatus = contractEvidence(contract)
    const effectsStatus = effectEvidence(effects)
    const unexpectedEffects = effects?.observation.unexpected.map(String) ?? []
    const observedEffects = effects ? effects.observation.observed !== false : null

    steps.push({
      key,
      stepId: result.stepId,
      iteration: result.iteration ?? 1,
      attempt: result.attempt,
      executorId: started?.executorId ?? null,
      status: result.status,
      output,
      contract: contractStatus,
      effects: effectsStatus,
      unexpectedEffects,
      observedEffects,
      artifacts: result.evidence.map((artifact) => ({ role: artifact.role, path: artifact.path })),
      usage,
    })

    if (result.status === "completed" && !effects) {
      diagnostics.push({ severity: "degraded", code: "MISSING_EFFECTS", detail: `completed step ${result.stepId} has no effects entry` })
    }
    if (effects && effects.observation.observed === false) {
      diagnostics.push({ severity: "degraded", code: "EFFECTS_UNOBSERVED", detail: `step ${result.stepId} effects were not observed: ${effects.observation.reason ?? "unknown reason"}` })
    }
  }

  for (const [key, started] of view.started.entries()) {
    if (!view.terminal.has(key)) {
      diagnostics.push({ severity: "degraded", code: "STARTED_WITHOUT_RESULT", detail: `step ${started.stepId} started without a terminal result` })
    }
  }
  for (const [key, contract] of view.contracts.entries()) {
    if (!view.terminal.has(key)) diagnostics.push({ severity: "corrupt", code: "ORPHAN_CONTRACT", detail: `contract for ${contract.stepId} has no matching step_result` })
  }
  for (const [key, effects] of view.effects.entries()) {
    if (!view.terminal.has(key)) diagnostics.push({ severity: "corrupt", code: "ORPHAN_EFFECTS", detail: `effects for ${effects.stepId} has no matching step_result` })
  }

  const totals = steps.reduce(
    (acc, step) => {
      acc.steps += 1
      if (step.contract === "failed") acc.contractsFailed += 1
      if (step.contract === "missing") acc.contractsMissing += 1
      if (step.effects === "failed") acc.effectsFailed += 1
      if (step.effects === "unknown" || (step.status === "completed" && step.effects === "not_applicable")) acc.effectsUnknown += 1
      if (step.output !== "valid") acc.outputInvalid += 1
      if (step.usage.available) acc.usageAvailable = true
      acc.inputTokens += step.usage.inputTokens
      acc.outputTokens += step.usage.outputTokens
      acc.durationMs += step.usage.durationMs
      acc.reportedCostUsd += step.usage.reportedCostUsd
      return acc
    },
    { steps: 0, contractsFailed: 0, contractsMissing: 0, effectsFailed: 0, effectsUnknown: 0, outputInvalid: 0, usageAvailable: false, inputTokens: 0, outputTokens: 0, durationMs: 0, reportedCostUsd: 0 },
  )

  const hasCorruption = diagnostics.some((d) => d.severity === "corrupt")
  const hasDegraded = diagnostics.some((d) => d.severity === "degraded")
  const unsafe = totals.contractsFailed > 0 || totals.effectsFailed > 0 || totals.effectsUnknown > 0 || totals.outputInvalid > 0
  const terminalSuccess = summary.status === "done"
  const validCurrentV2 = !hasCorruption && meta?.keyVersion === KEY_VERSION

  return {
    schemaVersion: RUN_EVIDENCE_SCHEMA_VERSION,
    ledgerPath: input.ledgerPath ?? null,
    runId: meta?.runId ?? null,
    traceId: meta?.traceId ?? null,
    loopId: meta?.loopId ?? null,
    loopVersion: meta?.loopVersion ?? null,
    keyVersion: meta?.keyVersion ?? null,
    trust: meta?.trust ?? null,
    terminalStatus: summary.status,
    startedAt: summary.startedAt ?? null,
    strict: {
      validCurrentV2,
      usableForTrust: validCurrentV2 && !hasDegraded && !unsafe && terminalSuccess,
    },
    outcome: {
      terminalSuccess,
      escalated: summary.status === "needs_human",
      stoppedFailure: summary.status === "stopped",
    },
    totals,
    steps,
    diagnostics,
  }
}

function usageEvidence(usage: unknown): StepRunEvidence["usage"] {
  if (usage === null || typeof usage !== "object") {
    return { available: false, inputTokens: 0, outputTokens: 0, durationMs: 0, reportedCostUsd: 0 }
  }
  const record = usage as Record<string, unknown>
  return {
    available: true,
    inputTokens: number(record.inputTokens),
    outputTokens: number(record.outputTokens),
    durationMs: number(record.durationMs),
    reportedCostUsd: number(record.costUsd),
  }
}

function outputEvidence(result: { readonly status: string; readonly outputValid?: boolean }): OutputEvidenceStatus {
  if (result.status !== "completed") return "missing"
  return result.outputValid === true ? "valid" : "invalid"
}

function contractEvidence(contract: { readonly result: { readonly valid: boolean } } | undefined): ContractEvidenceStatus {
  if (!contract) return "not_applicable"
  return contract.result.valid ? "passed" : "failed"
}

function effectEvidence(effects: { readonly observation: { readonly allowed: boolean; readonly observed?: boolean } } | undefined): EffectEvidenceStatus {
  if (!effects) return "not_applicable"
  if (effects.observation.observed === false) return "unknown"
  return effects.observation.allowed ? "passed" : "failed"
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

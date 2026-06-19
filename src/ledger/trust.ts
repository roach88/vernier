import type { RunEvidenceProjection } from "./evidence.js"

export type TrustStatus = "promotable" | "not_promotable"

export interface TrustStatusPolicy {
  readonly requiredRuns: number
  /** Optional current evidence window over matching loop id/version runs after sorting by startedAt/runId. */
  readonly last?: number | null
}

export interface TrustStatusReport {
  readonly loopId: string
  readonly loopVersion: string
  readonly status: TrustStatus
  readonly promotable: boolean
  readonly policy: {
    readonly requiredRuns: number
    readonly last: number | null
  }
  readonly totals: {
    readonly matchingLoopRuns: number
    readonly matchingVersionRuns: number
    readonly consideredRuns: number
    readonly cleanRuns: number
    readonly versionMismatchRuns: number
  }
  readonly considered: readonly RunEvidenceProjection[]
  readonly rejected: readonly {
    readonly runId: string | null
    readonly reasons: readonly string[]
  }[]
  readonly reasons: readonly string[]
}

export function evaluateTrustStatus(args: {
  readonly loopId: string
  readonly loopVersion: string
  readonly evidence: readonly RunEvidenceProjection[]
  readonly policy?: Partial<TrustStatusPolicy>
}): TrustStatusReport {
  const requiredRuns = args.policy?.requiredRuns ?? 3
  const last = args.policy?.last ?? null
  if (!Number.isInteger(requiredRuns) || requiredRuns <= 0) throw new Error(`requiredRuns must be a positive integer, got ${requiredRuns}.`)
  if (last !== null && (!Number.isInteger(last) || last <= 0)) throw new Error(`last must be a positive integer when provided, got ${last}.`)

  const matchingLoop = args.evidence.filter((e) => e.loopId === args.loopId)
  const matchingVersion = matchingLoop.filter((e) => e.loopVersion === args.loopVersion).sort(compareEvidence)
  const considered = (last === null ? matchingVersion : matchingVersion.slice(-last)).slice(-Math.max(requiredRuns, last ?? requiredRuns))
  const rejected = considered
    .map((e) => ({ runId: e.runId, reasons: rejectionReasons(e) }))
    .filter((r) => r.reasons.length > 0)
  const cleanRuns = considered.length - rejected.length
  const reasons: string[] = []

  if (matchingVersion.length < requiredRuns) {
    reasons.push(`insufficient evidence: need ${requiredRuns} clean run${requiredRuns === 1 ? "" : "s"}, found ${matchingVersion.length} matching ${args.loopId}@${args.loopVersion} run${matchingVersion.length === 1 ? "" : "s"}`)
  }
  if (considered.length < requiredRuns) {
    reasons.push(`current window has only ${considered.length} run${considered.length === 1 ? "" : "s"}`)
  }
  for (const item of rejected) {
    reasons.push(`run ${item.runId ?? "<unknown>"}: ${item.reasons.join("; ")}`)
  }

  const promotable = reasons.length === 0 && cleanRuns >= requiredRuns
  return {
    loopId: args.loopId,
    loopVersion: args.loopVersion,
    status: promotable ? "promotable" : "not_promotable",
    promotable,
    policy: { requiredRuns, last },
    totals: {
      matchingLoopRuns: matchingLoop.length,
      matchingVersionRuns: matchingVersion.length,
      consideredRuns: considered.length,
      cleanRuns,
      versionMismatchRuns: matchingLoop.length - matchingVersion.length,
    },
    considered,
    rejected,
    reasons,
  }
}

function compareEvidence(a: RunEvidenceProjection, b: RunEvidenceProjection): number {
  return (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || (a.runId ?? "").localeCompare(b.runId ?? "")
}

function rejectionReasons(evidence: RunEvidenceProjection): string[] {
  const reasons: string[] = []
  if (!evidence.strict.validCurrentV2) reasons.push("not valid current-v2 evidence")
  if (evidence.terminalStatus !== "done") reasons.push(`terminal status is ${evidence.terminalStatus}`)
  if (!evidence.outcome.terminalSuccess) reasons.push("terminal decision was not successful")
  if (evidence.outcome.escalated) reasons.push("required human escalation")
  if (evidence.totals.outputInvalid > 0) reasons.push(`${evidence.totals.outputInvalid} invalid output${evidence.totals.outputInvalid === 1 ? "" : "s"}`)
  if (evidence.totals.contractsFailed > 0) reasons.push(`${evidence.totals.contractsFailed} failed contract${evidence.totals.contractsFailed === 1 ? "" : "s"}`)
  if (evidence.totals.effectsFailed > 0) reasons.push(`${evidence.totals.effectsFailed} unexpected effect observation${evidence.totals.effectsFailed === 1 ? "" : "s"}`)
  if (evidence.totals.effectsUnknown > 0) reasons.push(`${evidence.totals.effectsUnknown} unknown effect observation${evidence.totals.effectsUnknown === 1 ? "" : "s"}`)
  for (const diagnostic of evidence.diagnostics) reasons.push(`${diagnostic.severity}: ${diagnostic.code}`)
  return reasons
}

// The Ledger slot: an append-only journal.jsonl per run.
//
// Adapted from omegacode (https://github.com/SawyerHood/omegacode, MIT,
// (c) 2026 Sawyer Hood — see NOTICE): the journal.jsonl append/load shape
// and torn-line tolerance come from src/runtime/journal.ts; canonical()
// (sort-deep stable JSON) comes from src/runtime/keys.ts.
//
// Deliberately left behind from omegacode: the v3 chained call-tree key
// lineage (branch keys, per-branch fan-out counters) and the determinism
// lint. Those exist because omegacode loops are imperative untrusted code
// whose call sites have no stable identity. Under loop-as-data a step HAS
// a stable identity, so the resume key collapses to hash(stepId + inputs).
//
// Added beyond omegacode's journal (the gap looper identified): contract
// results, policy decisions, and effect observations are first-class
// ledger entries, not just agent results.

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ContractResult } from "../kernel/contract.js"
import type { EffectObservation } from "../kernel/effects.js"
import type { Decision } from "../kernel/policy.js"
import type { ArtifactRef, LedgerSpec, StepStatus, Usage } from "../kernel/types.js"

export const KEY_VERSION = "loop-v1"

/** Stable JSON: object keys sorted recursively so equal values hash equally. (omegacode keys.ts) */
export function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(sortDeep)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) {
    if (k === "__proto__") continue
    out[k] = sortDeep(obj[k])
  }
  return out
}

/** The simplified resume key: a step has a stable identity, so this is all lineage needed. */
export function resumeKey(stepId: string, inputs: unknown): string {
  return createHash("sha256")
    .update(KEY_VERSION)
    .update("\0step\0")
    .update(stepId)
    .update("\0")
    .update(canonical(inputs ?? null))
    .digest("hex")
}

// ------------------------------------------------------------ entry types

export interface RunMetaEntry {
  readonly type: "meta"
  readonly runId: string
  readonly traceId: string
  readonly loopId: string
  readonly loopVersion: string
  readonly trust: string
  readonly inputs: unknown
  readonly keyVersion: string
  readonly at: string
}

export interface StepStartedEntry {
  readonly type: "step_started"
  readonly key: string
  readonly stepId: string
  readonly attempt: number
  readonly executorId: string
  readonly at: string
}

export interface StepResultEntry {
  readonly type: "step_result"
  readonly key: string
  readonly stepId: string
  readonly attempt: number
  readonly status: StepStatus
  readonly output: Record<string, unknown>
  readonly outputValid: boolean
  readonly evidence: readonly ArtifactRef[]
  readonly usage: Usage
  readonly at: string
}

export interface ContractEntry {
  readonly type: "contract"
  readonly key: string
  readonly stepId: string
  readonly attempt: number
  readonly result: ContractResult
  readonly at: string
}

export interface EffectsEntry {
  readonly type: "effects"
  readonly key: string
  readonly stepId: string
  readonly attempt: number
  readonly observation: EffectObservation
  readonly at: string
}

export interface DecisionEntry {
  readonly type: "decision"
  readonly key: string
  readonly stepId: string
  readonly attempt: number
  readonly decision: Decision
  readonly at: string
}

export type LedgerEntry =
  | RunMetaEntry
  | StepStartedEntry
  | StepResultEntry
  | ContractEntry
  | EffectsEntry
  | DecisionEntry

// ------------------------------------------------------------------ ledger

export function resolveLedgerRoot(spec: LedgerSpec): string {
  return spec.root ?? process.env.LOOPER_HOME ?? join(process.cwd(), ".looper")
}

export function journalPath(root: string, runId: string): string {
  return join(root, "runs", runId, "journal.jsonl")
}

export class Ledger {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
  }

  append(entry: LedgerEntry): void {
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8")
  }

  static load(path: string): LedgerEntry[] {
    if (!existsSync(path)) return []
    const entries: LedgerEntry[] = []
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as LedgerEntry)
      } catch {
        continue // torn / unparseable line: skip, keep the prefix (omegacode journal.ts)
      }
    }
    return entries
  }
}

/** Replay view: completed step results by resume key (last wins), plus the final decision. */
export interface Replay {
  readonly meta?: RunMetaEntry
  readonly completed: ReadonlyMap<string, StepResultEntry>
  readonly lastDecision?: DecisionEntry
}

export function replay(entries: readonly LedgerEntry[]): Replay {
  let meta: RunMetaEntry | undefined
  let lastDecision: DecisionEntry | undefined
  const completed = new Map<string, StepResultEntry>()
  for (const entry of entries) {
    if (entry.type === "meta") meta = entry
    else if (entry.type === "step_result" && entry.status === "completed") completed.set(entry.key, entry)
    else if (entry.type === "decision") lastDecision = entry
  }
  const out: Replay = { completed, ...(meta && { meta }), ...(lastDecision && { lastDecision }) }
  return out
}

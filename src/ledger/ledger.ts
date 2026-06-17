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
// Added beyond omegacode's journal (the gap vernier identified): contract
// results, policy decisions, and effect observations are first-class
// ledger entries, not just agent results.

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import type { ContractResult } from "../kernel/contract.js"
import type { EffectObservation } from "../kernel/effects.js"
import type { Decision } from "../kernel/policy.js"
import type { ArtifactRef, LedgerSpec, StepStatus, Usage } from "../kernel/types.js"

// loop-v2: iteration + attempt joined the key. hash(stepId + inputs) alone
// cannot disambiguate ITERATING loops — an `iterate` loop-back re-runs the
// same step with byte-identical inputs (the verifier's feedback travels as
// retryHint, not as an input), so v1 keys collided across passes and a
// resume could have replayed iteration 1's output into iteration 2's slot.
// The (stepId, iteration, attempt) tuple is strictly increasing along a
// run, so each execution slot now has exactly one key. Pre-v2 journals
// still resume (the state fold in engine/resume.ts uses decisions, not
// keys) but get no mid-tick replay — see resumeRun.
export const KEY_VERSION = "loop-v2"

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

/**
 * The simplified resume key: a step has a stable identity, so its lineage is
 * (stepId, iteration, attempt) plus the canonical inputs. Replaying a slot
 * additionally requires the inputs to hash equal — omegacode's resume
 * preconditions, collapsed into the key itself.
 */
export function resumeKey(stepId: string, inputs: unknown, iteration: number, attempt: number): string {
  return createHash("sha256")
    .update(KEY_VERSION)
    .update("\0step\0")
    .update(stepId)
    .update("\0")
    .update(`${iteration}.${attempt}`)
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
  /** Absolute workdir the run started under, so a resume lands in the same place. */
  readonly workdir?: string
  readonly at: string
}

export interface StepStartedEntry {
  readonly type: "step_started"
  readonly key: string
  readonly stepId: string
  readonly attempt: number
  readonly iteration: number
  readonly executorId: string
  /**
   * The Agent Skills this execution runs with, post-resolution, and how
   * they reached the provider: "native" (provider-side load, e.g. claude
   * --plugin-dir) or "prompt" (bodies embedded in the step prompt). Absent
   * when the step resolved no skills.
   */
  readonly skills?: {
    readonly resolved: readonly { readonly name: string; readonly dir: string }[]
    readonly delivery: "native" | "prompt"
  }
  readonly at: string
}

export interface StepResultEntry {
  readonly type: "step_result"
  readonly key: string
  readonly stepId: string
  readonly attempt: number
  readonly iteration: number
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
  readonly iteration: number
  readonly result: ContractResult
  readonly at: string
}

export interface EffectsEntry {
  readonly type: "effects"
  readonly key: string
  readonly stepId: string
  readonly attempt: number
  readonly iteration: number
  readonly observation: EffectObservation
  readonly at: string
}

export interface DecisionEntry {
  readonly type: "decision"
  readonly key: string
  readonly stepId: string
  readonly attempt: number
  readonly iteration: number
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
  return spec.root ?? process.env.VERNIER_HOME ?? join(process.cwd(), ".vernier")
}

export function assertSafePathComponent(value: string, label = "path component"): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a safe path component (letters, numbers, dot, underscore, dash; no separators), got \`${value}\`.`)
  }
}

function assertContained(parent: string, child: string): void {
  const rel = relative(parent, child)
  if (rel === "" || rel.startsWith("..") || rel.includes(":") || rel.startsWith("/")) {
    throw new Error(`journal path escaped ledger root: \`${child}\` is outside \`${parent}\`.`)
  }
}

export function journalPath(root: string, runId: string): string {
  assertSafePathComponent(runId, "run id")
  const runsRoot = resolve(root, "runs")
  const path = resolve(runsRoot, runId, "journal.jsonl")
  assertContained(runsRoot, path)
  return path
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

/**
 * Replay view: completed step results — and their contract / effects /
 * decision entries — by resume key (last wins), plus the final decision.
 * This is what the engine consumes on resume: a completed slot is replayed
 * from these entries, never re-executed (engine/tick.ts).
 */
export interface Replay {
  readonly meta?: RunMetaEntry
  /** Terminal step results in this exact execution slot, regardless of status. */
  readonly terminal: ReadonlyMap<string, StepResultEntry>
  /** Completed results only, for summaries that care about successful outputs. */
  readonly completed: ReadonlyMap<string, StepResultEntry>
  readonly contracts: ReadonlyMap<string, ContractEntry>
  readonly effects: ReadonlyMap<string, EffectsEntry>
  readonly decisions: ReadonlyMap<string, DecisionEntry>
  readonly lastDecision?: DecisionEntry
}

export function replay(entries: readonly LedgerEntry[]): Replay {
  let meta: RunMetaEntry | undefined
  let lastDecision: DecisionEntry | undefined
  const terminal = new Map<string, StepResultEntry>()
  const completed = new Map<string, StepResultEntry>()
  const contracts = new Map<string, ContractEntry>()
  const effects = new Map<string, EffectsEntry>()
  const decisions = new Map<string, DecisionEntry>()
  for (const entry of entries) {
    if (entry.type === "meta") meta = entry
    else if (entry.type === "step_result") {
      terminal.set(entry.key, entry)
      if (entry.status === "completed") completed.set(entry.key, entry)
    }
    else if (entry.type === "contract") contracts.set(entry.key, entry)
    else if (entry.type === "effects") effects.set(entry.key, entry)
    else if (entry.type === "decision") {
      decisions.set(entry.key, entry)
      lastDecision = entry
    }
  }
  const out: Replay = { terminal, completed, contracts, effects, decisions, ...(meta && { meta }), ...(lastDecision && { lastDecision }) }
  return out
}

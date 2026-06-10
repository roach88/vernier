// The five-slot kernel. Everything else in this repo serves these types.
//
//   Loop = Signature + Steps + Policy + Trust + Ledger
//   Step = Signature + Executor + Contract + Effects
//
// Dogma: the loop is data; the step is typed; the executor is fungible;
// the policy is pure; the ledger is append-only.
//
// The Executor protocol is a rename of omegacode's Worker seam
// (src/worker/index.ts: Worker.runAgent(spec, ctx) -> AgentResult, MIT,
// (c) 2026 Sawyer Hood — see NOTICE), generalized so a script, an LLM
// agent, a judge, or a human are all the same kind of thing. Deliberately
// NOT taken from omegacode: the node:vm sandbox trunk that runs workflows
// as untrusted code — loop-as-data makes it unnecessary.

import type { z } from "zod"
import type { EffectObservation } from "./effects.js"
import type { Policy } from "./policy.js"

// ---------------------------------------------------------------- Signature

/** The Ax-style typed `in -> out` boundary. Both sides are validated at runtime. */
export interface Signature<I = unknown, O = unknown> {
  readonly input: z.ZodType<I>
  readonly output: z.ZodType<O>
}

export function sig<I, O>(input: z.ZodType<I>, output: z.ZodType<O>): Signature<I, O> {
  return { input, output }
}

// ------------------------------------------------------------------ Effects

/**
 * What a step is allowed to touch, as workdir-relative paths. Patterns are
 * either exact paths or `dir/**` prefixes. Observed (not just trusted) via
 * snapshot diff — see kernel/effects.ts, ported from looper's GitSnapshotter
 * + assess_worker_state ("what changed, and was it allowed").
 */
export interface EffectScope {
  readonly allow: readonly string[]
}

export const noEffects = (): EffectScope => ({ allow: [] })
export const fsScope = (...allow: string[]): EffectScope => ({ allow })

// --------------------------------------------------------------------- Step

/** What the engine hands an Executor for one attempt. Inputs are already signature-validated. */
export interface StepSpec {
  readonly runId: string
  readonly traceId: string
  readonly loopId: string
  readonly loopVersion: string
  readonly stepId: string
  readonly attempt: number
  readonly inputs: Record<string, unknown>
  /** Rendered from the step's prompt template for LLM executors; undefined for scripts. */
  readonly prompt?: string | undefined
  /**
   * On attempt > 1: the previous attempt's retry hint, carrying the exact
   * failed contract check labels/messages. Prompt templates render it so
   * the executor is told precisely what to fix.
   */
  readonly retryHint?: string | undefined
  /**
   * Executor-seam escape hatch (omegacode's AgentSpec.schema): plain JSON
   * Schema for provider-native structured output. No v1 step sets it — the
   * engine derives deterministic output fields from effect attribution
   * instead (Step.outputFrom). If a future step (e.g. an LLM judge) truly
   * needs a model-emitted value, derive this from the step's zod output
   * signature at runtime; never hand-write a second schema.
   */
  readonly outputSchema?: Record<string, unknown> | undefined
  readonly effects: EffectScope
  /**
   * Absolute path of this run's ledger directory. Executors write
   * runner-managed evidence here (prompts, transcripts, route JSON) —
   * looper's "task bundle". It is OUTSIDE the workdir, so effect
   * observation never has to exclude runner-managed files by name
   * (the Python looper's runner_managed_codex_files dance).
   */
  readonly runDir: string
  readonly timeoutMs: number
}

/** The step's prompt template: pure data-to-text, rendered by the engine each attempt. */
export type PromptTemplate = (spec: Omit<StepSpec, "prompt">) => string

/**
 * Deterministic output projection, merged over the executor's reported
 * output before validation. Fields the engine can OBSERVE (e.g. an artifact
 * path from effect attribution) are derived here instead of asked of the
 * model — no second model turn, no trusting self-report.
 */
export type OutputProjection = (result: StepResult, effects: EffectObservation) => Record<string, unknown>

/** The unit of orchestration: typed boundary, accountable actor, deterministic check, bounded blast radius. */
export interface Step<I = any, O = any> {
  readonly id: string
  readonly signature: Signature<I, O>
  /** Executor id, resolved against a registry at run time. The executor is fungible. */
  readonly executor: string
  /** Optional contract id: deterministic semantic validation of the output value. */
  readonly contract?: string
  readonly effects: EffectScope
  /** Prompt template for LLM executors; omitted for scripts. */
  readonly prompt?: PromptTemplate
  /** Derive output fields from engine observations (see OutputProjection). */
  readonly outputFrom?: OutputProjection
  readonly timeoutMs?: number
}

export type StepStatus = "completed" | "failed" | "interrupted"

export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly durationMs: number
}

export const zeroUsage = (durationMs = 0): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs })

export interface ArtifactRef {
  readonly role: string
  /** Workdir-relative for worker artifacts; absolute for runner-managed evidence under the run dir. */
  readonly path: string
}

export interface StepResult {
  readonly status: StepStatus
  /** Validated against the step signature's output by the engine, not the executor. */
  readonly output: Record<string, unknown>
  readonly evidence: readonly ArtifactRef[]
  readonly usage: Usage
}

// ----------------------------------------------------------------- Executor

export interface RunContext {
  /** Absolute path the step may operate in; effect observation is rooted here. */
  readonly workdir: string
  readonly signal?: AbortSignal
}

/** Anything that can run one Step: a script, a CLI agent, an API agent, a judge, a human. */
export interface Executor {
  readonly id: string
  run(spec: StepSpec, ctx: RunContext): Promise<StepResult>
}

// -------------------------------------------------------------------- Trust

/** Promotion level. Draft loops may not execute; promotion enforcement from ledger evidence is a later step. */
export type Trust = "draft" | "dry-run" | "active"

// ------------------------------------------------------------------- Ledger

/** Where the append-only journal lives. Resolved at run time; see ledger/ledger.ts. */
export interface LedgerSpec {
  /** Root directory for run journals. Default: $LOOPER_HOME, else ./.looper */
  readonly root?: string
}

// --------------------------------------------------------------------- Loop

/** The five slots. A coding loop, a research loop, and a script loop are all this shape. */
export interface Loop<I = any, O = any> {
  readonly id: string
  readonly version: string
  readonly signature: Signature<I, O> // 1. what goes in, what must come out
  readonly steps: readonly Step[] // 2. ordered typed units of work
  readonly policy: Policy // 3. pure fn: Observation -> Decision
  readonly trust: Trust // 4. promotion level; gates execution
  readonly ledger: LedgerSpec // 5. append-only journal of attempts, evidence, decisions
}

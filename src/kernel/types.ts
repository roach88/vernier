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
import { zodToJsonSchema } from "zod-to-json-schema"
import type { EffectObservation } from "./effects.js"
import type { Policy } from "./policy.js"

// ---------------------------------------------------------------- Signature

/**
 * The Ax-style typed `in -> out` boundary. Both sides are validated at
 * runtime. I and O are the PARSED types; the raw shape a schema accepts is
 * the schema's business — so a zod transform can derive a step's inputs
 * from the data plane (e.g. topic from goal, in the self-improving
 * template's recall step) and the
 * signature IS the derivation.
 */
export interface Signature<I = unknown, O = unknown> {
  readonly input: z.ZodType<I, z.ZodTypeDef, any>
  readonly output: z.ZodType<O, z.ZodTypeDef, any>
}

export function sig<I, O>(input: z.ZodType<I, z.ZodTypeDef, any>, output: z.ZodType<O, z.ZodTypeDef, any>): Signature<I, O> {
  return { input, output }
}

/**
 * Derive the provider-facing JSON Schema from a signature's zod output —
 * the ONE source of truth for structured-output steps. The engine calls
 * this when a step sets `structuredOutput: true`; nothing in this repo may
 * hand-write a second copy of a step's output schema.
 */
export function derivedOutputSchema(signature: Signature<any, any>): Record<string, unknown> {
  const { $schema: _, ...schema } = zodToJsonSchema(signature.output, { $refStrategy: "none" }) as Record<string, unknown>
  return schema
}

// ------------------------------------------------------------------ Effects

/**
 * What a step is allowed to touch, as workdir-relative paths. Patterns are
 * either exact paths or `dir/**` prefixes. Observed (not just trusted) via
 * snapshot diff — see kernel/effects.ts, ported from the Python predecessor's GitSnapshotter
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
  /** 1-based pass over the step sequence; > 1 after an `iterate` loop-back. */
  readonly iteration: number
  readonly inputs: Record<string, unknown>
  /** Rendered from the step's prompt template for LLM executors; undefined for scripts. */
  readonly prompt?: string | undefined
  /**
   * What the next execution should fix: on attempt > 1 the previous
   * attempt's failed contract checks; after an `iterate` loop-back the
   * verifier's feedback. Prompt templates render it so the executor is
   * told precisely what to fix.
   */
  readonly retryHint?: string | undefined
  /**
   * Executor-seam escape hatch (omegacode's AgentSpec.schema): plain JSON
   * Schema for provider-native structured output. Engine-set, never
   * hand-written: when a step opts in via `Step.structuredOutput`, this is
   * derived from the step's zod output signature (derivedOutputSchema) —
   * one source of truth. First real use: the LLM judge's verdict, the one
   * output that genuinely must be model-emitted (deterministic fields come
   * from effect attribution via Step.outputFrom instead).
   */
  readonly outputSchema?: Record<string, unknown> | undefined
  readonly effects: EffectScope
  /**
   * Absolute path of this run's ledger directory. Executors write
   * runner-managed evidence here (prompts, transcripts, route JSON) —
   * the Python predecessor's "task bundle". It is OUTSIDE the workdir, so effect
   * observation never has to exclude runner-managed files by name
   * (the Python predecessor's runner_managed_codex_files dance).
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
  /**
   * Opt in to model-emitted structured output: the engine derives
   * StepSpec.outputSchema from this step's zod output signature. Reserve it
   * for outputs that only the model can produce (a judge's verdict);
   * engine-observable facts belong in outputFrom.
   */
  readonly structuredOutput?: boolean
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

// ------------------------------------------------------------------- Memory

/**
 * One distilled, VERIFIED rule. Memory is the ledger's sibling: append-only,
 * durable, but queryable by topic and shared ACROSS runs — that sharing is
 * what makes a self-improving loop genuinely compound (a later run recalls
 * what an earlier run learned). The store holds reusable rules that passed
 * verification, never raw failure notes; loops enforce that by shape
 * (`remember` sits after a passing grade — see the self-improving template).
 */
export interface RuleRecord {
  /** Content-derived: hash(topic + rule), so re-remembering the same rule re-yields the same id. */
  readonly id: string
  /** The reusable rule — one general, imperative sentence, applicable beyond the run that learned it. */
  readonly rule: string
  /** Why the rule is believed: the verified answer/artifact that passed the grade. */
  readonly evidence: string
  /** Recall key. Retrieval ranks against this (and the rule/evidence text); see memory/retriever.ts. */
  readonly topic: string
  readonly sourceRunId: string
  readonly loopId: string
  readonly at: string
  /**
   * Attached at REMEMBER time by an embedding retriever (memory/embedding.ts);
   * absent on lexical stores and on every pre-embedding store — such records
   * stay readable and retrievable through the lexical tier.
   */
  readonly embedding?: RuleEmbedding
}

/**
 * A rule's stored embedding, versioned twice over: `v` guards this record
 * shape; `model` names the embedder (package:model) that produced the
 * vector — vectors from different models live in different spaces and are
 * NEVER compared (a mismatched record falls back to lexical retrieval).
 */
export interface RuleEmbedding {
  readonly v: 1
  readonly model: string
  readonly vector: readonly number[]
}

/**
 * The memory seam (Ax's primitives): deterministic store ops, no LLM.
 * `recall(topic) -> rules[]` is a read; `remember(rule, evidence)` is an
 * append. Either may be async — an embedding retriever embeds the query
 * topic at recall time and the rule at remember time — but both stay
 * DETERMINISTIC given the store contents and the embedding model version.
 * The JSONL implementation lives in memory/memory.ts; executors reach it
 * through RunContext.memory, injected via EngineDeps exactly as contracts
 * and executors are.
 */
export interface MemoryStore {
  recall(topic: string): readonly RuleRecord[] | Promise<readonly RuleRecord[]>
  remember(record: Omit<RuleRecord, "id" | "at" | "embedding">): RuleRecord | Promise<RuleRecord>
}

// ----------------------------------------------------------------- Executor

export interface RunContext {
  /** Absolute path the step may operate in; effect observation is rooted here. */
  readonly workdir: string
  /** The shared rule store; the recall/remember executors require it (executors/memory.ts). */
  readonly memory?: MemoryStore
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
  /** Root directory for run journals. Default: $VERNIER_HOME, else ./.vernier */
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

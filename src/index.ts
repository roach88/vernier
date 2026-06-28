// The library surface of vernier: what a LOOP AUTHOR needs, nothing
// else. One deliberate root export — the five-slot kernel API plus the
// config helpers an out-of-tree vernier.config (and the loop/executor modules
// it names) genuinely uses. The engine, ledger, registry, and provider
// executors stay internal: they are reachable through the CLI, and exposing
// them would freeze internals v1 has no reason to freeze.
//
//   Loop = Signature + Steps + Policy + Trust + Ledger
//   Step = Signature + Executor + Contract + Effects

// The five-slot model: the types a Loop literally is, and the helpers that
// build its slots.
export {
  sig,
  fsScope,
  noEffects,
  zeroUsage,
  type Loop,
  type Step,
  type StepSpec,
  type StepResult,
  type StepStatus,
  type Signature,
  type EffectScope,
  type Executor,
  type RunContext,
  type Trust,
  type LedgerSpec,
  type Usage,
  type ArtifactRef,
  type PromptTemplate,
  type OutputProjection,
  type MemoryStore,
  type RuleRecord,
  type StepSkill,
  type SkillDelivery,
} from "./kernel/types.js"

// The Policy slot: the default decision procedure and its combinators.
export {
  decideNextStep,
  retryPolicy,
  until,
  type Policy,
  type Observation,
  type Decision,
  type DecisionKind,
  type Classification,
  type UntilOpts,
} from "./kernel/policy.js"

// Deterministic output projection from observed effects (the diff is the report).
export {
  artifactFromEffects,
  type EffectObservation,
} from "./kernel/effects.js"

// The Contract seam: deterministic semantic validation of a step's output.
export { type Contract, type ContractCheck, type ContractContext, type ContractResult } from "./kernel/contract.js"

// Out-of-tree registration: what a vernier.config.{ts,js,mjs} and the loop
// modules it names export.
export { defineConfig, defineLoop, type VernierConfig, type LoopRegistration } from "./cli/config.js"

// The smallest custom executor: a plain function behind the Executor seam.
export { scriptExecutor, type ScriptFn, type ScriptOutcome } from "./executors/script.js"

// The Memory seam: the durable rule store and its pluggable Retriever.
// Lexical BM25 is the built-in default; construct Memory with your own
// Retriever only after measured recall quality needs a different ranker.
export { Memory, resolveMemoryRoot, rulesPath, type MemorySpec } from "./memory/memory.js"
export { LexicalRetriever, lexicalRetriever, topicTokens, type Retriever } from "./memory/retriever.js"

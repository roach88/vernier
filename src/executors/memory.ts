// recall / remember: Ax's memory primitives as DETERMINISTIC executors.
// Store reads/writes behind the same seam as everything else — Ax's
// `fn().handler()`, not an LLM. Built on scriptExecutor because that is
// exactly what they are: plain functions over the injected store.
//
//   recall:   {topic}                 -> {rules: string[]}     (store read)
//   remember: {rule, evidence, topic} -> {stored: boolean, id} (store write)
//
// The store arrives via RunContext.memory, injected through
// EngineDeps.memory exactly as contracts and executors are injected.
// `remember` stores VERIFIED rules only — enforced not here but by loop
// shape: it is only reachable after a passing grade (see the
// self-improving template's loop).
// Both ops are awaited: a custom retriever may do async work at the seam,
// but retrieval quality remains a Memory concern, never a loop concern.

import type { Executor, MemoryStore, RunContext, StepSpec } from "../kernel/types.js"
import { scriptExecutor } from "./script.js"

function requireMemory(ctx: RunContext, spec: StepSpec, executorId: string): MemoryStore {
  if (!ctx.memory) {
    throw new Error(
      `Step \`${spec.stepId}\` reached executor \`${executorId}\` without a memory store. Pass \`memory\` in EngineDeps (e.g. new Memory(rulesPath(root))).`,
    )
  }
  return ctx.memory
}

/** Deterministic store read: recall(topic) -> rules[], ranked best-first by the store's retriever. */
export const recallExecutor: Executor = scriptExecutor("recall", async (spec, ctx) => {
  const memory = requireMemory(ctx, spec, "recall")
  const topic = String(spec.inputs.topic ?? "")
  const records = await memory.recall(topic)
  return { output: { rules: records.map((r) => r.rule) } }
})

/** Deterministic store write: remember(rule, evidence) -> {stored, id}. */
export const rememberExecutor: Executor = scriptExecutor("remember", async (spec, ctx) => {
  const memory = requireMemory(ctx, spec, "remember")
  const record = await memory.remember({
    rule: String(spec.inputs.rule ?? ""),
    evidence: String(spec.inputs.evidence ?? ""),
    topic: String(spec.inputs.topic ?? ""),
    sourceRunId: spec.runId,
    loopId: spec.loopId,
  })
  return { output: { stored: true, id: record.id } }
})

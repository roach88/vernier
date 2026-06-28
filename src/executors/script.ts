// The script executor: the Python predecessor's `no-agent-script` capability as an Executor.
// A plain function behind the same seam an LLM agent will sit behind —
// that fungibility is the point. Real agent/provider executors (codex,
// claude, judges — omegacode's src/worker/ adapters) come in a later step;
// the Executor interface in kernel/types.ts is their stubbed seam.

import type { ArtifactRef, Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import { zeroUsage } from "../kernel/types.js"

export interface ScriptOutcome {
  readonly output: Record<string, unknown>
  readonly evidence?: readonly ArtifactRef[]
}

export type ScriptFn = (spec: StepSpec, ctx: RunContext) => ScriptOutcome | Promise<ScriptOutcome>

function isTimeoutAbortReason(reason: unknown): boolean {
  if (reason instanceof DOMException && reason.name === "TimeoutError") return true
  if (reason instanceof Error && reason.message.includes("timeout")) return true
  return false
}

function stepTimedOutMessage(timeoutMs: number): string {
  return `step timed out after ${timeoutMs}ms`
}

export function scriptExecutor(id: string, fn: ScriptFn): Executor {
  return {
    id,
    async run(spec, ctx): Promise<StepResult> {
      const startedAt = Date.now()
      const complete = async (): Promise<StepResult> => {
        try {
          const { output, evidence = [] } = await fn(spec, ctx)
          if (ctx.signal.aborted && isTimeoutAbortReason(ctx.signal.reason)) {
            throw new Error(stepTimedOutMessage(spec.timeoutMs))
          }
          return { status: "completed", output, evidence, usage: zeroUsage(Date.now() - startedAt) }
        } catch (error) {
          if (ctx.signal.aborted && isTimeoutAbortReason(ctx.signal.reason)) {
            throw new Error(stepTimedOutMessage(spec.timeoutMs))
          }
          throw error
        }
      }
      const onAbort = (): Promise<StepResult> => {
        const reason = ctx.signal.reason
        if (isTimeoutAbortReason(reason)) {
          return Promise.reject(new Error(stepTimedOutMessage(spec.timeoutMs)))
        }
        return Promise.reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")))
      }
      if (ctx.signal.aborted) return onAbort()
      return Promise.race([
        complete(),
        new Promise<StepResult>((_, reject) => {
          ctx.signal.addEventListener("abort", () => void onAbort().catch(reject), { once: true })
        }),
      ])
    },
  }
}

export function executorRegistry(...executors: Executor[]): ReadonlyMap<string, Executor> {
  const map = new Map<string, Executor>()
  for (const executor of executors) {
    if (map.has(executor.id)) throw new Error(`Duplicate executor id \`${executor.id}\`.`)
    map.set(executor.id, executor)
  }
  return map
}

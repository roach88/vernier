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

export function scriptExecutor(id: string, fn: ScriptFn): Executor {
  return {
    id,
    async run(spec, ctx): Promise<StepResult> {
      const startedAt = Date.now()
      const complete = async (): Promise<StepResult> => {
        const { output, evidence = [] } = await fn(spec, ctx)
        return { status: "completed", output, evidence, usage: zeroUsage(Date.now() - startedAt) }
      }
      const onAbort = (): Promise<StepResult> => {
        const reason = ctx.signal.reason
        const timedOut =
          reason instanceof DOMException
            ? reason.name === "TimeoutError"
            : reason instanceof Error
              ? reason.message.includes("timeout")
              : false
        if (timedOut) {
          return Promise.reject(new Error(`step timed out after ${spec.timeoutMs}ms`))
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

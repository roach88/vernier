// Shared wrapper for CLI agents that cannot enforce vernier's read-only or
// scoped-write intent at the OS/process boundary.

import type { RunContext, StepResult, StepSpec } from "../kernel/types.js"
import type { Worker } from "./vendor/omegacode/index.js"
import type { AgentSpec, ProviderId } from "./vendor/omegacode/types.js"
import { beginWorkerStep, requirePrompt, runWorkerStep, unsupportedSandboxResult } from "./worker-step.js"

export type UnsafeReadonlyCliProvider = Extract<ProviderId, "opencode" | "pi">

export interface UnsafeReadonlyCliExecutorConfig {
  readonly id: UnsafeReadonlyCliProvider
  readonly worker: Worker
  readonly model?: string | undefined
  readonly unsupportedWriteMessage: (effects: readonly string[]) => string
}

export async function runUnsafeReadonlyCliStep(
  config: UnsafeReadonlyCliExecutorConfig,
  spec: StepSpec,
  ctx: RunContext,
): Promise<StepResult> {
  const prompt = requirePrompt(config.id, spec)
  const evidence = beginWorkerStep(spec, config.id, prompt)

  if (spec.effects.allow.length > 0) {
    return unsupportedSandboxResult({
      spec,
      evidence,
      provider: config.id,
      role: `${config.id}-preflight`,
      message: config.unsupportedWriteMessage(spec.effects.allow),
    })
  }

  const agentSpec: AgentSpec = {
    prompt,
    provider: config.id,
    cwd: ctx.workdir,
    sandbox: "danger-full-access",
    approval: "never",
    ...(config.model ? { model: config.model } : {}),
    ...(spec.outputSchema ? { schema: spec.outputSchema } : {}),
  }

  return runWorkerStep({
    executorId: config.id,
    spec,
    ctx,
    worker: config.worker,
    agentSpec,
    evidence,
    final: { kind: "text", stem: config.id },
  })
}

// CodexExecutor: the real coding agent behind the Executor seam.
//
// Wraps omegacode's vendored CodexWorker (codex app-server over JSON-RPC
// stdio) and maps its AgentResult onto the kernel's StepResult honestly:
//
//   AgentResult.text        -> output.text (or evidence-only when structured)
//   AgentResult.structured  -> output (when a spec sets the outputSchema
//                              escape hatch — e.g. the coding-review
//                              template's route step;
//                              deterministic fields still come from effect
//                              attribution instead)
//   AgentResult.status      -> StepResult.status        (same closed set)
//   AgentResult.usage       -> StepResult.usage (+ wall-clock durationMs)
//   AgentError / AgentInterrupted -> status "failed" / "interrupted",
//                                    with code + retryability in the output
//
// Sandbox derivation (fail-closed): a step with a non-empty EffectScope gets
// codex sandbox "workspace-write" rooted at the workdir; an effect-free step
// gets "read-only". danger-full-access is never produced here — by
// construction, not convention.
//
// Evidence: the streamed progress feed (reasoning, tool use, text deltas)
// and the final message are written under StepSpec.runDir — the run's
// ledger directory — mirroring the Python predecessor's runner-managed bundle
// files (codex-events.jsonl / codex-final.md), kept OUTSIDE the workdir so
// effect attribution never has to exclude them by name.

import type { Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import type { Worker } from "./vendor/omegacode/index.js"
import { CodexWorker } from "./vendor/omegacode/codex.js"
import type { AgentSpec, Sandbox } from "./vendor/omegacode/types.js"
import { beginWorkerStep, requirePrompt, runWorkerStep } from "./worker-step.js"

export interface CodexExecutorOpts {
  /** Injectable worker (tests pass scripted workers). Default: a real CodexWorker. */
  readonly worker?: Worker
  /** Codex binary when constructing the default worker. */
  readonly bin?: string
  readonly model?: string
}

export class CodexExecutor implements Executor {
  readonly id = "codex"
  private readonly worker: Worker
  private readonly model: string | undefined

  constructor(opts: CodexExecutorOpts = {}) {
    this.worker = opts.worker ?? new CodexWorker({ bin: opts.bin })
    this.model = opts.model
  }

  async run(spec: StepSpec, ctx: RunContext): Promise<StepResult> {
    const prompt = requirePrompt(this.id, spec)
    // EffectScope -> sandbox ceiling. Never danger-full-access.
    const sandbox: Sandbox = spec.effects.allow.length > 0 ? "workspace-write" : "read-only"
    const agentSpec: AgentSpec = {
      prompt,
      provider: "codex",
      cwd: ctx.workdir,
      sandbox,
      approval: "never",
      ...(this.model ? { model: this.model } : {}),
      ...(spec.outputSchema ? { schema: spec.outputSchema } : {}),
    }
    return runWorkerStep({
      executorId: this.id,
      spec,
      ctx,
      worker: this.worker,
      agentSpec,
      evidence: beginWorkerStep(spec, "codex", prompt),
      final: { kind: "text", stem: "codex" },
    })
  }

  /** Tear down the underlying app-server child process. */
  shutdown(): Promise<void> {
    return this.worker.shutdown()
  }
}

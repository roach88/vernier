// OpencodeExecutor: the OpenCode CLI behind the Executor seam.
//
// Wraps omegacode's vendored OpencodeWorker (`opencode run --format json`,
// spawn-per-call, JSONL off stdout) and maps its AgentResult onto the
// kernel's StepResult exactly as CodexExecutor does:
//
//   AgentResult.text        -> output.text (or evidence-only when structured)
//   AgentResult.structured  -> output (when the step opted into structured
//                              output via the StepSpec.outputSchema hatch)
//   AgentResult.status      -> StepResult.status        (same closed set)
//   AgentResult.usage       -> StepResult.usage (+ wall-clock durationMs)
//   AgentError / AgentInterrupted -> status "failed" / "interrupted",
//                                    with code + retryability in the output
//
// Sandbox posture (fail-closed on writes — the cursor precedent, one notch
// weaker on reads): opencode exposes NO enforceable sandbox at any level —
// no OS confinement, and its app-level permission rules leave bash
// unconfined — so the vendored worker refuses to pretend and accepts only
// "danger-full-access". Vernier therefore:
//   (a) FAILS CLOSED on write scopes: a step with a non-empty EffectScope
//       refuses pre-spawn with an actionable error (worker never invoked);
//   (b) runs effect-free steps with the worker's only accepted mode. Such a
//       step is UNCONFINED at the OS level: its read-only intent travels in
//       the prompt and is observed post-hoc by effect attribution
//       (kernel/effects.ts flags out-of-scope changes), never enforced
//       up front. That is strictly weaker than codex (OS sandbox), claude
//       (CLI permission-mode + toolset gate), and cursor (provider
//       read-only mode) — bind those providers to steps where read
//       enforcement matters.
//
// The worker also rejects maxTurns and effort pre-spawn; vernier never sets
// either, so those refusals are unreachable from here.

import type { Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import type { Worker } from "./vendor/omegacode/index.js"
import { OpencodeWorker } from "./vendor/omegacode/opencode.js"
import type { AgentSpec } from "./vendor/omegacode/types.js"
import { beginWorkerStep, requirePrompt, runWorkerStep, unsupportedSandboxResult } from "./worker-step.js"

export interface OpencodeExecutorOpts {
  /** Injectable worker (tests pass scripted workers). Default: a real OpencodeWorker. */
  readonly worker?: Worker
  /** OpenCode binary when constructing the default worker. Defaults to "opencode". */
  readonly bin?: string
  readonly model?: string
}

export class OpencodeExecutor implements Executor {
  readonly id = "opencode"
  private readonly worker: Worker
  private readonly model: string | undefined

  constructor(opts: OpencodeExecutorOpts = {}) {
    // One worker per executor: spawn-per-call, but the --version preflight
    // caches across steps. Construction never spawns.
    this.worker = opts.worker ?? new OpencodeWorker(opts.bin !== undefined ? { bin: opts.bin } : {})
    this.model = opts.model
  }

  async run(spec: StepSpec, ctx: RunContext): Promise<StepResult> {
    const prompt = requirePrompt(this.id, spec)
    const evidence = beginWorkerStep(spec, "opencode", prompt)

    if (spec.effects.allow.length > 0) {
      const message =
        `opencode has no enforceable sandbox (bash is unconfined), so vernier refuses to hand it ` +
        `write scope(s): ${spec.effects.allow.join(", ")} — use noEffects() steps with opencode, ` +
        `or bind this step to codex/claude, which enforce scoped writes`
      return unsupportedSandboxResult({ spec, evidence, provider: this.id, role: "opencode-preflight", message })
    }

    // Effect-free steps only reach here. The worker accepts exactly one
    // sandbox value (see header); the gate above is what keeps this honest.
    const agentSpec: AgentSpec = {
      prompt,
      provider: "opencode",
      cwd: ctx.workdir,
      sandbox: "danger-full-access",
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
      evidence,
      final: { kind: "text", stem: "opencode" },
    })
  }

  shutdown(): Promise<void> {
    return this.worker.shutdown()
  }
}

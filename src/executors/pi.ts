// Pi CLI behind the Executor seam. Pi's tool allowlists are not OS
// confinement (write/edit accept absolute paths; bash is unrestricted), so
// writes fail preflight; noEffects steps run through the shared
// unsafe-readonly CLI helper with post-hoc effect attribution.

import type { Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import type { Worker } from "./vendor/omegacode/index.js"
import { PiWorker } from "./vendor/omegacode/pi.js"
import { runUnsafeReadonlyCliStep } from "./unsafe-readonly-cli.js"

export interface PiExecutorOpts {
  /** Injectable worker (tests pass scripted workers). Default: a real PiWorker. */
  readonly worker?: Worker
  /** pi binary when constructing the default worker. Defaults to "pi". */
  readonly bin?: string
  readonly model?: string | undefined
}

export class PiExecutor implements Executor {
  readonly id = "pi"
  private readonly worker: Worker
  private readonly model: string | undefined

  constructor(opts: PiExecutorOpts = {}) {
    // One worker per executor: spawn-per-call, but the --version preflight
    // caches across steps. Construction never spawns.
    this.worker = opts.worker ?? new PiWorker(opts.bin !== undefined ? { bin: opts.bin } : {})
    this.model = opts.model
  }

  async run(spec: StepSpec, ctx: RunContext): Promise<StepResult> {
    return runUnsafeReadonlyCliStep(
      {
        id: this.id,
        worker: this.worker,
        model: this.model,
        unsupportedWriteMessage: (effects) =>
          `pi has no enforceable sandbox (tool allowlists are not OS confinement; bash is unrestricted), ` +
          `so vernier refuses to hand it write scope(s): ${effects.join(", ")} — use noEffects() ` +
          `steps with pi, or bind this step to codex/claude, which enforce scoped writes`,
      },
      spec,
      ctx,
    )
  }

  shutdown(): Promise<void> {
    return this.worker.shutdown()
  }
}

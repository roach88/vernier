// OpenCode CLI behind the Executor seam. OpenCode has no enforceable sandbox
// (bash is unconfined), so writes fail preflight; noEffects steps run through
// the shared unsafe-readonly CLI helper with their read-only intent carried in
// the prompt and checked post-hoc by effect attribution.

import type { Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import type { Worker } from "./vendor/omegacode/index.js"
import { OpencodeWorker } from "./vendor/omegacode/opencode.js"
import { runUnsafeReadonlyCliStep } from "./unsafe-readonly-cli.js"

export interface OpencodeExecutorOpts {
  /** Injectable worker (tests pass scripted workers). Default: a real OpencodeWorker. */
  readonly worker?: Worker
  /** OpenCode binary when constructing the default worker. Defaults to "opencode". */
  readonly bin?: string
  readonly model?: string | undefined
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
    return runUnsafeReadonlyCliStep(
      {
        id: this.id,
        worker: this.worker,
        model: this.model,
        unsupportedWriteMessage: (effects) =>
          `opencode has no enforceable sandbox (bash is unconfined), so vernier refuses to hand it ` +
          `write scope(s): ${effects.join(", ")} — use noEffects() steps with opencode, ` +
          `or bind this step to codex/claude, which enforce scoped writes`,
      },
      spec,
      ctx,
    )
  }

  shutdown(): Promise<void> {
    return this.worker.shutdown()
  }
}

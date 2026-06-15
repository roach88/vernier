// CursorExecutor: Cursor Agent behind the Executor seam.
//
// Cursor's CLI provides read-only Ask mode and write-capable Agent mode behind
// its own sandbox switch. Vernier maps EffectScope -> read-only/workspace-write
// the same way Codex/Claude do; exact path scope remains the engine's post-run
// effect observation contract.

import { join } from "node:path"
import { CursorWorker } from "./vendor/omegacode/cursor.js"
import type { AgentError, AgentInterrupted, Worker } from "./vendor/omegacode/index.js"
import type { AgentSpec, Sandbox } from "./vendor/omegacode/types.js"
import type { Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import { beginWorkerStep, requirePrompt, runWorkerStep } from "./worker-step.js"

export interface CursorExecutorOpts {
  /** Injectable worker (tests pass scripted workers). Default: a per-run CursorWorker. */
  readonly worker?: Worker
  /** Cursor CLI binary. Defaults through the shared resolver; explicit values bypass fallback. */
  readonly bin?: string
  readonly model?: string
}

export class CursorExecutor implements Executor {
  readonly id = "cursor-agent"
  private readonly worker: Worker | undefined
  private readonly bin: string | undefined
  private readonly model: string | undefined

  constructor(opts: CursorExecutorOpts = {}) {
    this.worker = opts.worker
    this.bin = opts.bin
    this.model = opts.model
  }

  async run(spec: StepSpec, ctx: RunContext): Promise<StepResult> {
    const prompt = requirePrompt(this.id, spec)
    const evidence = beginWorkerStep(spec, "cursor", prompt)
    const sandbox: Sandbox = spec.effects.allow.length > 0 ? "workspace-write" : "read-only"

    const configDir = join(spec.runDir, `${evidence.prefix}cursor-config`)
    const agentSpec: AgentSpec = {
      prompt,
      provider: "cursor-agent",
      cwd: ctx.workdir,
      sandbox,
      approval: "never",
      ...(this.model ? { model: this.model } : {}),
      ...(spec.outputSchema ? { schema: spec.outputSchema } : {}),
    }
    const worker = this.worker ?? new CursorWorker({ ...(this.bin !== undefined ? { bin: this.bin } : {}), configDir })
    try {
      return await runWorkerStep({
        executorId: this.id,
        spec,
        ctx,
        worker,
        agentSpec,
        evidence,
        eventText: (line) => redactText(line, configDir),
        final: {
          kind: "text",
          stem: "cursor",
          transformText: (text) => redactText(text, configDir),
          interruptedOutput: (_error: AgentInterrupted, finalText: string) => finalText,
          agentErrorOutput: (error: AgentError) => redactText(error.message, configDir),
        },
      })
    } finally {
      if (!this.worker) await worker.shutdown()
    }
  }

  shutdown(): Promise<void> {
    return this.worker?.shutdown() ?? Promise.resolve()
  }
}

function redactText(text: string, configDir: string): string {
  let out = text.replace(/(CURSOR_API_KEY=)[^\s)]+/g, "$1<redacted>").replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
  const key = process.env.CURSOR_API_KEY
  if (key) out = out.split(key).join("<redacted>")
  return out.split(configDir).join("<cursor-config-dir>")
}

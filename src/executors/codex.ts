// CodexExecutor: the real coding agent behind the Executor seam.
//
// Wraps omegacode's vendored CodexWorker (codex app-server over JSON-RPC
// stdio) and maps its AgentResult onto the kernel's StepResult honestly:
//
//   AgentResult.text        -> output.text (or evidence-only when structured)
//   AgentResult.structured  -> output (when a spec sets the outputSchema
//                              escape hatch — e.g. pilot-1's route step;
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

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ArtifactRef, Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import { evidencePrefix } from "./evidence.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerProgress } from "./vendor/omegacode/index.js"
import { CodexWorker } from "./vendor/omegacode/codex.js"
import type { AgentResult, AgentSpec, Sandbox } from "./vendor/omegacode/types.js"

export interface CodexExecutorOpts {
  /** Injectable worker (tests pass omegacode's FakeWorker). Default: a real CodexWorker. */
  readonly worker?: Worker
  /** Codex binary when constructing the default worker. */
  readonly bin?: string
  readonly model?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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
    if (!spec.prompt) {
      throw new Error(`Step \`${spec.stepId}\` reached executor \`${this.id}\` without a rendered prompt.`)
    }
    // EffectScope -> sandbox ceiling. Never danger-full-access.
    const sandbox: Sandbox = spec.effects.allow.length > 0 ? "workspace-write" : "read-only"
    const agentSpec: AgentSpec = {
      prompt: spec.prompt,
      provider: "codex",
      cwd: ctx.workdir,
      sandbox,
      approval: "never",
      ...(this.model ? { model: this.model } : {}),
      ...(spec.outputSchema ? { schema: spec.outputSchema } : {}),
    }

    const prefix = evidencePrefix(spec)
    mkdirSync(spec.runDir, { recursive: true })
    const promptPath = join(spec.runDir, `${prefix}codex-prompt.md`)
    writeFileSync(promptPath, spec.prompt, "utf8")

    const events: string[] = []
    const onProgress = (e: WorkerProgress): void => {
      events.push(JSON.stringify({ at: new Date().toISOString(), ...e }))
    }
    // Per-step timeout COMPOSED with any caller signal: either may abort the
    // turn — a caller-supplied ctx.signal must not bypass the executor timeout.
    const timeout = AbortSignal.timeout(spec.timeoutMs)
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout

    const startedAt = Date.now()
    let result: AgentResult
    try {
      result = await this.worker.runAgent(agentSpec, { signal, onProgress })
    } catch (error) {
      const evidence = this.writeEvidence(spec, prefix, promptPath, events, errorText(error))
      const durationMs = Date.now() - startedAt
      if (error instanceof AgentInterrupted) {
        return { status: "interrupted", output: { error: error.message }, evidence, usage: zero(durationMs) }
      }
      if (error instanceof AgentError) {
        return {
          status: "failed",
          output: { error: error.message, code: error.code, retryable: error.retryable },
          evidence,
          // Failed turns still bill (omegacode's error taxonomy carries the usage).
          usage: error.usage ? { ...error.usage, durationMs } : zero(durationMs),
        }
      }
      throw error
    }

    const durationMs = Date.now() - startedAt
    const evidence = this.writeEvidence(spec, prefix, promptPath, events, result.text)
    const output = isRecord(result.structured) ? result.structured : { text: result.text }
    return {
      status: result.status,
      output,
      evidence,
      usage: { ...result.usage, durationMs },
    }
  }

  /** Tear down the underlying app-server child process. */
  shutdown(): Promise<void> {
    return this.worker.shutdown()
  }

  private writeEvidence(
    spec: StepSpec,
    prefix: string,
    promptPath: string,
    events: readonly string[],
    finalText: string,
  ): ArtifactRef[] {
    const eventsPath = join(spec.runDir, `${prefix}codex-events.jsonl`)
    const finalPath = join(spec.runDir, `${prefix}codex-final.md`)
    writeFileSync(eventsPath, events.join("\n") + (events.length ? "\n" : ""), "utf8")
    writeFileSync(finalPath, finalText, "utf8")
    return [
      { role: "worker-prompt", path: promptPath },
      { role: "worker-events", path: eventsPath },
      { role: "worker-final", path: finalPath },
    ]
  }
}

const zero = (durationMs: number) => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs })

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

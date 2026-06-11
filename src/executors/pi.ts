// PiExecutor: the pi coding agent behind the Executor seam.
//
// Wraps omegacode's vendored PiWorker (`pi --mode json --no-session`,
// spawn-per-call, JSONL AgentEvents off stdout) and maps its AgentResult
// onto the kernel's StepResult exactly as CodexExecutor does:
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
// weaker on reads): pi's tool allowlists are model/tool-layer controls, not
// OS confinement (write/edit accept absolute paths; bash is unrestricted),
// so the vendored worker refuses to pretend and accepts only
// "danger-full-access". Vernier therefore:
//   (a) FAILS CLOSED on write scopes: a step with a non-empty EffectScope
//       refuses pre-spawn with an actionable error (worker never invoked);
//   (b) runs effect-free steps with the worker's only accepted mode. Such a
//       step is UNCONFINED at the OS level: its read-only intent travels in
//       the prompt and is observed post-hoc by effect attribution
//       (kernel/effects.ts flags out-of-scope changes), never enforced
//       up front. That is strictly weaker than codex (OS sandbox), claude
//       (SDK canUseTool gate), and cursor (provider read-only mode) — bind
//       those providers to steps where read enforcement matters.
//
// The worker also rejects maxTurns pre-spawn; vernier never sets it, so that
// refusal is unreachable from here. (pi supports effort/instructions; vernier
// does not set those either.)

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ArtifactRef, Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import { zeroUsage } from "../kernel/types.js"
import { evidencePrefix } from "./evidence.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerProgress } from "./vendor/omegacode/index.js"
import { PiWorker } from "./vendor/omegacode/pi.js"
import type { AgentResult, AgentSpec } from "./vendor/omegacode/types.js"

export interface PiExecutorOpts {
  /** Injectable worker (tests pass scripted workers). Default: a real PiWorker. */
  readonly worker?: Worker
  /** pi binary when constructing the default worker. Defaults to "pi". */
  readonly bin?: string
  readonly model?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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
    if (!spec.prompt) {
      throw new Error(`Step \`${spec.stepId}\` reached executor \`${this.id}\` without a rendered prompt.`)
    }

    const startedAt = Date.now()
    const prefix = evidencePrefix(spec)
    mkdirSync(spec.runDir, { recursive: true })
    const promptPath = join(spec.runDir, `${prefix}pi-prompt.md`)
    writeFileSync(promptPath, spec.prompt, "utf8")

    if (spec.effects.allow.length > 0) {
      const message =
        `pi has no enforceable sandbox (tool allowlists are not OS confinement; bash is unrestricted), ` +
        `so vernier refuses to hand it write scope(s): ${spec.effects.allow.join(", ")} — use noEffects() ` +
        `steps with pi, or bind this step to codex/claude, which enforce scoped writes`
      const preflightPath = join(spec.runDir, `${prefix}pi-preflight.json`)
      writeFileSync(
        preflightPath,
        JSON.stringify(
          {
            provider: this.id,
            code: "unsupported_sandbox",
            retryable: false,
            stepId: spec.stepId,
            effects: spec.effects.allow,
            message,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      )
      return {
        status: "failed",
        output: { error: message, code: "unsupported_sandbox", retryable: false },
        evidence: [
          { role: "worker-prompt", path: promptPath },
          { role: "pi-preflight", path: preflightPath },
        ],
        usage: zeroUsage(Date.now() - startedAt),
      }
    }

    // Effect-free steps only reach here. The worker accepts exactly one
    // sandbox value (see header); the gate above is what keeps this honest.
    const agentSpec: AgentSpec = {
      prompt: spec.prompt,
      provider: "pi",
      cwd: ctx.workdir,
      sandbox: "danger-full-access",
      approval: "never",
      ...(this.model ? { model: this.model } : {}),
      ...(spec.outputSchema ? { schema: spec.outputSchema } : {}),
    }

    const events: string[] = []
    const onProgress = (e: WorkerProgress): void => {
      events.push(JSON.stringify({ at: new Date().toISOString(), ...e }))
    }
    // Per-step timeout COMPOSED with any caller signal: either may abort the turn.
    const timeout = AbortSignal.timeout(spec.timeoutMs)
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout

    let result: AgentResult
    try {
      result = await this.worker.runAgent(agentSpec, { signal, onProgress })
    } catch (error) {
      const evidence = this.writeEvidence(spec, prefix, promptPath, events, errorText(error))
      const durationMs = Date.now() - startedAt
      if (error instanceof AgentInterrupted) {
        return { status: "interrupted", output: { error: error.message }, evidence, usage: zeroUsage(durationMs) }
      }
      if (error instanceof AgentError) {
        return {
          status: "failed",
          output: { error: error.message, code: error.code, retryable: error.retryable },
          evidence,
          // Failed turns still bill (the error taxonomy carries the usage).
          usage: error.usage ? { ...error.usage, durationMs } : zeroUsage(durationMs),
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
    const eventsPath = join(spec.runDir, `${prefix}pi-events.jsonl`)
    const finalPath = join(spec.runDir, `${prefix}pi-final.md`)
    writeFileSync(eventsPath, events.join("\n") + (events.length ? "\n" : ""), "utf8")
    writeFileSync(finalPath, finalText, "utf8")
    return [
      { role: "worker-prompt", path: promptPath },
      { role: "worker-events", path: eventsPath },
      { role: "worker-final", path: finalPath },
    ]
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

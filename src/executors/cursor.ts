// CursorExecutor: Cursor Agent behind the Executor seam.
//
// Cursor Agent Step 6A is deliberately read-only only. Unlike Codex, Cursor does not expose the
// hard sandbox vernier needs for scoped writes, so write scopes become evidence-bearing failures
// before the provider process starts.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { evidencePrefix } from "./evidence.js"
import { CursorWorker } from "./vendor/omegacode/cursor.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerProgress } from "./vendor/omegacode/index.js"
import type { AgentResult, AgentSpec } from "./vendor/omegacode/types.js"
import type { ArtifactRef, Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import { zeroUsage } from "../kernel/types.js"

export interface CursorExecutorOpts {
  /** Injectable worker (tests pass scripted workers). Default: a per-run CursorWorker. */
  readonly worker?: Worker
  /** Cursor Agent binary. Defaults to "cursor-agent"; pass "agent" or an absolute path explicitly. */
  readonly bin?: string
  readonly model?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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
    if (!spec.prompt) {
      throw new Error(`Step \`${spec.stepId}\` reached executor \`${this.id}\` without a rendered prompt.`)
    }

    const startedAt = Date.now()
    const prefix = evidencePrefix(spec)
    mkdirSync(spec.runDir, { recursive: true })
    const promptPath = join(spec.runDir, `${prefix}cursor-prompt.md`)
    writeFileSync(promptPath, spec.prompt, "utf8")

    if (spec.effects.allow.length > 0) {
      const message =
        `cursor-agent Step 6A supports read-only/noEffects() steps only; ` +
        `refusing to run write scope(s): ${spec.effects.allow.join(", ")}`
      const preflightPath = join(spec.runDir, `${prefix}cursor-preflight.json`)
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
          { role: "cursor-preflight", path: preflightPath },
        ],
        usage: zeroUsage(Date.now() - startedAt),
      }
    }

    const configDir = join(spec.runDir, `${prefix}cursor-config`)
    const agentSpec: AgentSpec = {
      prompt: spec.prompt,
      provider: "cursor-agent",
      cwd: ctx.workdir,
      sandbox: "read-only",
      approval: "never",
      ...(this.model ? { model: this.model } : {}),
      ...(spec.outputSchema ? { schema: spec.outputSchema } : {}),
    }

    const events: string[] = []
    const onProgress = (e: WorkerProgress): void => {
      events.push(redactText(JSON.stringify({ at: new Date().toISOString(), ...e }), configDir))
    }
    const timeout = AbortSignal.timeout(spec.timeoutMs)
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
    const worker = this.worker ?? new CursorWorker({ ...(this.bin !== undefined ? { bin: this.bin } : {}), configDir })

    let result: AgentResult
    try {
      result = await worker.runAgent(agentSpec, { signal, onProgress })
    } catch (error) {
      const safeError = redactText(errorText(error), configDir)
      const evidence = this.writeEvidence(spec, prefix, promptPath, events, safeError, configDir)
      const durationMs = Date.now() - startedAt
      if (error instanceof AgentInterrupted) {
        return { status: "interrupted", output: { error: safeError }, evidence, usage: zeroUsage(durationMs) }
      }
      if (error instanceof AgentError) {
        return {
          status: "failed",
          output: { error: redactText(error.message, configDir), code: error.code, retryable: error.retryable },
          evidence,
          usage: error.usage ? { ...error.usage, durationMs } : zeroUsage(durationMs),
        }
      }
      throw error
    } finally {
      if (!this.worker) await worker.shutdown()
    }

    const durationMs = Date.now() - startedAt
    const evidence = this.writeEvidence(spec, prefix, promptPath, events, result.text, configDir)
    const output = isRecord(result.structured) ? result.structured : { text: result.text }
    return {
      status: result.status,
      output,
      evidence,
      usage: { ...result.usage, durationMs },
    }
  }

  shutdown(): Promise<void> {
    return this.worker?.shutdown() ?? Promise.resolve()
  }

  private writeEvidence(
    spec: StepSpec,
    prefix: string,
    promptPath: string,
    events: readonly string[],
    finalText: string,
    configDir: string,
  ): ArtifactRef[] {
    const eventsPath = join(spec.runDir, `${prefix}cursor-events.jsonl`)
    const finalPath = join(spec.runDir, `${prefix}cursor-final.md`)
    writeFileSync(eventsPath, events.join("\n") + (events.length ? "\n" : ""), "utf8")
    writeFileSync(finalPath, redactText(finalText, configDir), "utf8")
    return [
      { role: "worker-prompt", path: promptPath },
      { role: "worker-events", path: eventsPath },
      { role: "worker-final", path: finalPath },
    ]
  }
}

function redactText(text: string, configDir: string): string {
  let out = text.replace(/(CURSOR_API_KEY=)[^\s)]+/g, "$1<redacted>").replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
  const key = process.env.CURSOR_API_KEY
  if (key) out = out.split(key).join("<redacted>")
  return out.split(configDir).join("<cursor-config-dir>")
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

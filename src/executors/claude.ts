// ClaudeExecutor: Claude Code behind the Executor seam.
//
// Wraps omegacode's vendored ClaudeWorker (@anthropic-ai/claude-agent-sdk
// query()) and maps its AgentResult onto the kernel's StepResult exactly as
// CodexExecutor does:
//
//   AgentResult.text        -> output.text (or evidence-only when structured)
//   AgentResult.structured  -> output (when the step opted into structured
//                              output via the StepSpec.outputSchema hatch)
//   AgentResult.status      -> StepResult.status        (same closed set)
//   AgentResult.usage       -> StepResult.usage (+ wall-clock durationMs)
//   AgentError / AgentInterrupted -> status "failed" / "interrupted",
//                                    with code + retryability in the output
//
// Sandbox derivation (fail-closed): a step with a non-empty EffectScope gets
// "workspace-write", an effect-free step gets "read-only" — identical to
// codex. Claude has no OS sandbox; ClaudeWorker enforces these through its
// canUseTool gate. danger-full-access is never produced here.
//
// LAZY SDK LOADING — the load-bearing difference from codex/cursor: the SDK
// is an OPTIONAL peer dependency, so this module must import cleanly without
// it. The vendored worker (vendor/omegacode/claude.ts) statically imports
// the SDK, so it is imported DYNAMICALLY on first run(): constructing the
// executor (registry listing, doctor) never touches the SDK; a run without
// it fails as an actionable StepResult (code "sdk_missing"), and
// `vernier doctor` reports the same probe.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ArtifactRef, Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import { zeroUsage } from "../kernel/types.js"
import { evidencePrefix } from "./evidence.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerProgress } from "./vendor/omegacode/index.js"
import type { AgentResult, AgentSpec, Sandbox } from "./vendor/omegacode/types.js"

export const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk"

export interface ClaudeExecutorOpts {
  /** Injectable worker (tests pass scripted workers). Default: a lazily-imported ClaudeWorker. */
  readonly worker?: Worker
  /** Test seam for the lazy SDK import; production never sets this. */
  readonly loadWorker?: () => Promise<Worker>
  readonly model?: string
  /** Forwarded to ClaudeWorker (the SDK's pathToClaudeCodeExecutable). */
  readonly claudeCodeExecutable?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export class ClaudeExecutor implements Executor {
  readonly id = "claude"
  private worker: Worker | undefined
  private readonly loadWorker: () => Promise<Worker>
  private readonly model: string | undefined

  constructor(opts: ClaudeExecutorOpts = {}) {
    this.worker = opts.worker
    this.model = opts.model
    this.loadWorker =
      opts.loadWorker ??
      (async () => {
        // Dynamic on purpose: this is the only line that needs the SDK.
        const { ClaudeWorker } = await import("./vendor/omegacode/claude.js")
        return new ClaudeWorker(
          opts.claudeCodeExecutable !== undefined ? { pathToClaudeCodeExecutable: opts.claudeCodeExecutable } : {},
        )
      })
  }

  async run(spec: StepSpec, ctx: RunContext): Promise<StepResult> {
    if (!spec.prompt) {
      throw new Error(`Step \`${spec.stepId}\` reached executor \`${this.id}\` without a rendered prompt.`)
    }

    const startedAt = Date.now()
    const prefix = evidencePrefix(spec)
    mkdirSync(spec.runDir, { recursive: true })
    const promptPath = join(spec.runDir, `${prefix}claude-prompt.md`)
    writeFileSync(promptPath, spec.prompt, "utf8")

    if (this.worker === undefined) {
      try {
        this.worker = await this.loadWorker()
      } catch (error) {
        // The one failure this executor owns: the optional peer is absent.
        // Anything else (a broken vendored file, a bad install) is a bug and
        // propagates as the crash it is.
        const code = (error as { code?: string }).code
        const message = error instanceof Error ? error.message : String(error)
        if (code !== "ERR_MODULE_NOT_FOUND" || !message.includes(CLAUDE_SDK)) throw error
        const actionable =
          `executor \`claude\` needs ${CLAUDE_SDK}, an optional peer dependency this install does not carry. ` +
          `Install it next to vernier (\`npm install ${CLAUDE_SDK}\`) and re-run. \`vernier doctor\` shows the same probe.`
        const evidence = this.writeEvidence(spec, prefix, promptPath, [], actionable)
        return {
          status: "failed",
          output: { error: actionable, code: "sdk_missing", retryable: false },
          evidence,
          usage: zeroUsage(Date.now() - startedAt),
        }
      }
    }

    // EffectScope -> sandbox ceiling, exactly like codex. Never danger-full-access.
    const sandbox: Sandbox = spec.effects.allow.length > 0 ? "workspace-write" : "read-only"
    const agentSpec: AgentSpec = {
      prompt: spec.prompt,
      provider: "claude-code",
      cwd: ctx.workdir,
      sandbox,
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
    return this.worker?.shutdown() ?? Promise.resolve()
  }

  private writeEvidence(
    spec: StepSpec,
    prefix: string,
    promptPath: string,
    events: readonly string[],
    finalText: string,
  ): ArtifactRef[] {
    const eventsPath = join(spec.runDir, `${prefix}claude-events.jsonl`)
    const finalPath = join(spec.runDir, `${prefix}claude-final.md`)
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

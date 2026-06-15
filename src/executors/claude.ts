// ClaudeExecutor: Claude Code (the `claude` CLI) behind the Executor seam.
//
// Drives the CLI exactly like its siblings drive theirs — a binary looked up
// on PATH, spawn-per-call, non-interactive print mode — and maps the run
// onto the kernel's StepResult exactly as CodexExecutor does:
//
//   result.result            -> output.text (or evidence-only when structured)
//   result.structured_output -> output (when the step opted into structured
//                               output via the StepSpec.outputSchema hatch —
//                               the CLI's --json-schema flag is REAL
//                               schema-constrained output, verified against
//                               claude 2.1.x; nothing is parsed out of prose)
//   result.usage/total_cost_usd -> StepResult.usage (+ wall-clock durationMs)
//   AgentError / AgentInterrupted -> status "failed" / "interrupted",
//                                    with code + retryability in the output
//
// The turn: `claude -p --output-format stream-json --verbose`, prompt on
// stdin, JSONL events off stdout (the shared subprocess-jsonl mechanics).
// `--setting-sources ""` keeps the run hermetic — the user's own permission
// allowlists (e.g. an allowed `Bash(*)`) must never silently widen the
// posture below — and `--no-session-persistence` keeps orchestration turns
// out of the user's resume history.
//
// Sandbox posture (house rule: permission-bypass flags are never passed —
// no --dangerously-skip-permissions, no --permission-mode bypassPermissions):
//   read-only        → `--tools Read,Glob,Grep --permission-mode dontAsk`:
//                      write tools and Bash are not even loaded, and any
//                      residual permission ask is auto-denied. Enforced at
//                      the provider, like cursor's read-only mode.
//   workspace-write  → `--permission-mode acceptEdits`: Claude Code
//                      auto-accepts file edits INSIDE the workspace (the
//                      spawn cwd = ctx.workdir); everything else that would
//                      prompt — Bash, out-of-workspace writes, web tools —
//                      is denied, because print mode cannot raise a prompt.
//                      Writes land file-tool-only, confined to the workdir;
//                      finer EffectScope globs are attributed post-hoc by
//                      the kernel, same as codex.
//   danger-full-access → refused pre-spawn (unconstructible from a loop
//                      declaration anyway; the refusal keeps the no-bypass
//                      rule structural rather than conventional).
//
// Evidence: claude-prompt.md / claude-events.jsonl / claude-final.md under
// StepSpec.runDir, prefix-aware — identical to the sibling conventions.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ArtifactRef, Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import { zeroUsage } from "../kernel/types.js"
import { SKILLS_PLUGIN_NAME, snapshotSkills } from "../skills/skills.js"
import { evidencePrefix } from "./evidence.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext, type WorkerProgress } from "./vendor/omegacode/index.js"
import type { AgentResult, AgentSpec, AgentUsage, Effort } from "./vendor/omegacode/types.js"
import { emptyUsage } from "./vendor/omegacode/types.js"
import { assertValidSchema } from "./vendor/omegacode/schema.js"
import {
  captureStdout,
  exitError,
  runJsonlSubprocess,
  versionAtLeast,
  DEFAULT_STALL_TIMEOUT_MS,
  type SpawnProcess,
} from "./vendor/omegacode/subprocess-jsonl.js"
import { errorText, isRecord } from "./worker-step.js"

const PROVIDER = "claude-code" as const

/** The minimum CLI version whose flag surface this worker is verified against
 *  (--json-schema, --setting-sources, --tools, --permission-mode dontAsk,
 *  stream-json result shape — all checked live on 2.1.173). */
export const CLAUDE_MIN_VERSION = "2.0.0"

/** The toolset a read-only step runs with: inspection only — no Bash (it can
 *  execute arbitrary writers), no write/edit tools, no web tools. */
export const CLAUDE_READONLY_TOOLS = "Read,Glob,Grep"

// ---------------------------------------------------------------------------
// ClaudeCliWorker — vernier's own CLI driver behind the vendored Worker seam.
// (The SDK-based vendored ClaudeWorker is gone, and with it the optional
// @anthropic-ai/claude-agent-sdk peer and its zod override; see NOTICE.)
// ---------------------------------------------------------------------------

export interface ClaudeWorkerOpts {
  /** Claude Code binary. Defaults to "claude" (resolved on PATH by spawn). */
  bin?: string
  /** Test seam: replaces child_process.spawn for every subprocess (runs AND --version). */
  spawnProcess?: SpawnProcess
  /** No-output stall watchdog (ms). 0 disables. */
  stallTimeoutMs?: number
}

// The CLI supports low/medium/high/xhigh/max; the codex-only tiers map to the lowest.
function toClaudeEffort(effort: Effort): "low" | "medium" | "high" | "xhigh" | "max" {
  return effort === "none" || effort === "minimal" ? "low" : effort
}

export class ClaudeCliWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly spawnProcess: SpawnProcess | undefined
  private readonly stallTimeoutMs: number
  /** Once-per-worker version preflight (construction never spawns). */
  private versionCheck: Promise<void> | null = null

  constructor(opts: ClaudeWorkerOpts = {}) {
    this.bin = opts.bin ?? "claude"
    this.spawnProcess = opts.spawnProcess
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (spec.schema) {
      // Surface author schema errors (bad $ref, typo'd type) BEFORE the paid turn.
      try {
        assertValidSchema(spec.schema)
      } catch (err) {
        throw new AgentError({ provider: PROVIDER, code: "invalid_schema", message: `output schema does not compile: ${(err as Error).message}` })
      }
    }
    // Fail closed on everything this surface cannot honestly honor.
    if (spec.maxTurns !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "claude 2.x print mode exposes no turn cap (no --max-turns flag); omit maxTurns for provider \"claude-code\"",
      })
    }
    if (spec.approval !== "never") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `claude runs as a one-shot print-mode subprocess and cannot surface approval requests — use approval: "never" with provider "claude-code"`,
      })
    }
    if (spec.sandbox === "danger-full-access") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "vernier never passes claude permission-bypass flags; use sandbox \"read-only\" or \"workspace-write\" with provider \"claude-code\"",
      })
    }
    await this.ensureVersion()

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      // --print + stream-json requires verbose; it is also what puts the
      // assistant/tool messages (the evidence feed) on the stream.
      "--verbose",
      // Hermetic: no user/project/local settings — their permission
      // allowlists must not widen the posture derived below.
      "--setting-sources",
      "",
      "--no-session-persistence",
      ...(spec.sandbox === "read-only"
        ? ["--tools", CLAUDE_READONLY_TOOLS, "--permission-mode", "dontAsk"]
        : ["--permission-mode", "acceptEdits"]),
      // Session-scoped plugins (per-step Agent Skills): the one context
      // channel Claude Code documents as surviving hermetic runs — skills
      // load with progressive disclosure intact, namespaced
      // `vernier-skills:<name>`, with the user's settings still untouched.
      ...(spec.pluginDirs ?? []).flatMap((dir) => ["--plugin-dir", dir]),
      ...(spec.model ? ["--model", spec.model] : []),
      ...(spec.effort ? ["--effort", toClaudeEffort(spec.effort)] : []),
      ...(spec.instructions ? ["--append-system-prompt", spec.instructions] : []),
      ...(spec.schema ? ["--json-schema", JSON.stringify(spec.schema)] : []),
    ]

    let resultEvent: Record<string, unknown> | undefined
    const exit = await runJsonlSubprocess({
      provider: PROVIDER,
      bin: this.bin,
      args,
      cwd: spec.cwd,
      env: this.env(),
      stdin: spec.prompt,
      signal: ctx.signal,
      stallTimeoutMs: this.stallTimeoutMs,
      spawnProcess: this.spawnProcess,
      onValue: (value) => {
        if (!isObject(value)) return
        switch (value.type) {
          case "assistant": {
            const message = isObject(value.message) ? value.message : undefined
            for (const block of asBlocks(message?.content)) {
              if (block.type === "text" && typeof block.text === "string") {
                ctx.onProgress({ kind: "text", text: block.text })
              } else if (block.type === "thinking" && typeof block.thinking === "string") {
                ctx.onProgress({ kind: "reasoning", text: block.thinking })
              } else if (block.type === "tool_use" && typeof block.name === "string") {
                ctx.onProgress({ kind: "tool", id: typeof block.id === "string" ? block.id : undefined, name: block.name, input: block.input })
              }
            }
            return
          }
          case "user": {
            const message = isObject(value.message) ? value.message : undefined
            for (const block of asBlocks(message?.content)) {
              if (block.type === "tool_result") {
                const out = typeof block.content === "string" ? block.content : JSON.stringify(block.content)
                ctx.onProgress({ kind: "tool-result", id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined, output: out, isError: block.is_error === true })
              }
            }
            return
          }
          case "result": {
            resultEvent = value
            return
          }
          default:
            // system init and other event types are forward-compatible noise.
            return
        }
      },
    })

    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (resultEvent !== undefined) {
      const subtype = typeof resultEvent.subtype === "string" ? resultEvent.subtype : "unknown"
      const usage = usageFromResult(resultEvent)
      if (subtype !== "success" || resultEvent.is_error === true) {
        // error_max_turns is a terminal cap, not a transient fault — never retry it. Carry the
        // usage on the error: failed turns still bill, so budget ceilings must see them.
        const retryable = subtype !== "error_max_turns" && /rate|overload|529|429/i.test(subtype)
        throw new AgentError({ provider: PROVIDER, code: subtype, message: `claude result: ${subtype}`, retryable, usage })
      }
      if (exit.code !== 0) throw exitError(PROVIDER, this.bin, exit)
      return {
        text: typeof resultEvent.result === "string" ? resultEvent.result : "",
        structured: spec.schema ? resultEvent.structured_output : undefined,
        status: "completed",
        usage,
      }
    }
    if (exit.code !== 0) throw exitError(PROVIDER, this.bin, exit)
    throw new AgentError({ provider: PROVIDER, code: "no_result", message: "claude exited 0 without a result event" })
  }

  async shutdown(): Promise<void> {
    // Spawn-per-call: nothing persistent to tear down.
  }

  // -------------------------------------------------------------------------

  private ensureVersion(): Promise<void> {
    if (!this.versionCheck) {
      this.versionCheck = this.checkVersion().catch((err: unknown) => {
        // Do not cache failures — a transient --version hiccup must not poison the worker.
        this.versionCheck = null
        throw err
      })
    }
    return this.versionCheck
  }

  private async checkVersion(): Promise<void> {
    const out = await captureStdout({
      provider: PROVIDER,
      bin: this.bin,
      args: ["--version"],
      env: this.env(),
      spawnProcess: this.spawnProcess,
    })
    if (!versionAtLeast(out, CLAUDE_MIN_VERSION)) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_outdated",
        message: `claude ${out || "(unknown version)"} is below the minimum supported ${CLAUDE_MIN_VERSION} — upgrade Claude Code`,
        retryable: false,
      })
    }
  }

  private env(): NodeJS.ProcessEnv {
    // Never let a run trigger a self-update mid-flight.
    return { ...process.env, DISABLE_AUTOUPDATER: "1" }
  }
}

/**
 * Sum a result event's usage into AgentUsage. Cache reads/creation are billed
 * input tokens — dropping them undercounts budget ceilings. costUsd is passed
 * through AS REPORTED by the CLI (total_cost_usd). Exported for tests.
 */
export function usageFromResult(result: { usage?: unknown; total_cost_usd?: unknown }): AgentUsage {
  const u = (isObject(result.usage) ? result.usage : {}) as Record<string, unknown>
  return {
    ...emptyUsage(),
    inputTokens: numOr(u.input_tokens) + numOr(u.cache_read_input_tokens) + numOr(u.cache_creation_input_tokens),
    outputTokens: numOr(u.output_tokens),
    costUsd: numOr(result.total_cost_usd),
  }
}

/** Coerce a message's content into an array of block-like records. */
function asBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return []
  return content.filter((b): b is Record<string, unknown> => b !== null && typeof b === "object")
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function numOr(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// ---------------------------------------------------------------------------
// The executor.
// ---------------------------------------------------------------------------

export interface ClaudeExecutorOpts {
  /** Injectable worker (tests pass scripted workers). Default: a real ClaudeCliWorker. */
  readonly worker?: Worker
  /** Claude Code binary when constructing the default worker. Defaults to "claude". */
  readonly bin?: string
  readonly model?: string
}

export class ClaudeExecutor implements Executor {
  readonly id = "claude"
  /** Native Agent Skill delivery: the engine passes StepSpec.skills instead of embedding bodies in the prompt. */
  readonly skillDelivery = "native" as const
  private readonly worker: Worker
  private readonly model: string | undefined

  constructor(opts: ClaudeExecutorOpts = {}) {
    // One worker per executor: spawn-per-call, but the --version preflight
    // caches across steps. Construction never spawns.
    this.worker = opts.worker ?? new ClaudeCliWorker(opts.bin !== undefined ? { bin: opts.bin } : {})
    this.model = opts.model
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

    // EffectScope -> sandbox ceiling, exactly like codex. Never danger-full-access.
    const sandbox = spec.effects.allow.length > 0 ? "workspace-write" : "read-only"

    // Native skill delivery: synthesize a session plugin under the run's
    // ledger dir (runner-managed evidence, never the workdir — effect
    // observation must not see it) and hand it to the CLI via --plugin-dir.
    // snapshotSkills (the shared guard+copy both delivery modes use)
    // realpath-resolves each skill dir (the marketplace install shape links
    // it to a cache), verifies the tree symlink-free, and copies it
    // byte-for-byte — a true snapshot of exactly what this step ran with.
    // Every skill is checked before ANY is copied, and `pluginDir` is
    // assigned only after full success, so a containment violation or
    // filesystem failure returns a clean failed StepResult (with evidence)
    // and never passes a partial plugin to the CLI or emits one as evidence.
    let pluginDir: string | undefined
    if (spec.skills !== undefined && spec.skills.length > 0) {
      const dir = join(spec.runDir, `${prefix}skills-plugin`)
      try {
        snapshotSkills(spec.skills, join(dir, "skills"))
        mkdirSync(join(dir, ".claude-plugin"), { recursive: true })
        writeFileSync(
          join(dir, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: SKILLS_PLUGIN_NAME, description: "Per-step Agent Skills delivered by vernier" }, null, 2) + "\n",
          "utf8",
        )
        pluginDir = dir
      } catch (error) {
        return {
          status: "failed",
          output: { error: `skills plugin synthesis failed: ${errorText(error)}`, code: "skills_delivery_failed", retryable: false },
          evidence: this.writeEvidence(spec, prefix, promptPath, [], errorText(error)),
          usage: zeroUsage(Date.now() - startedAt),
        }
      }
    }

    const agentSpec: AgentSpec = {
      prompt: spec.prompt,
      provider: PROVIDER,
      cwd: ctx.workdir,
      sandbox,
      approval: "never",
      ...(pluginDir !== undefined ? { pluginDirs: [pluginDir] } : {}),
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
      const evidence = this.writeEvidence(spec, prefix, promptPath, events, errorText(error), pluginDir)
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
    const evidence = this.writeEvidence(spec, prefix, promptPath, events, result.text, pluginDir)
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
    pluginDir?: string,
  ): ArtifactRef[] {
    const eventsPath = join(spec.runDir, `${prefix}claude-events.jsonl`)
    const finalPath = join(spec.runDir, `${prefix}claude-final.md`)
    writeFileSync(eventsPath, events.join("\n") + (events.length ? "\n" : ""), "utf8")
    writeFileSync(finalPath, finalText, "utf8")
    return [
      { role: "worker-prompt", path: promptPath },
      { role: "worker-events", path: eventsPath },
      { role: "worker-final", path: finalPath },
      // The synthesized plugin IS evidence: exactly the skills this step ran with.
      ...(pluginDir !== undefined ? [{ role: "skills-plugin", path: pluginDir }] : []),
    ]
  }
}

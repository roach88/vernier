// CursorWorker - drives Cursor Agent CLI print mode one shot at a time.
//
// Safety surface: Cursor Agent does not provide Codex-style OS confinement, so this worker only
// accepts read-only specs. The looper-facing CursorExecutor fails write scopes before a subprocess
// is spawned; this worker repeats the check for direct factory use.

import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addUsage, emptyUsage, type AgentResult, type AgentSpec, type AgentUsage } from "./types.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext, type WorkerProgress } from "./index.js"
import { assertValidSchema, parseJsonLoose, stripNullOptionals, validate } from "./schema.js"
import {
  DEFAULT_STALL_TIMEOUT_MS,
  exitError,
  runJsonlSubprocess,
  type SpawnProcess,
} from "./subprocess-jsonl.js"

const PROVIDER = "cursor-agent" as const

export interface CursorWorkerOpts {
  /** Defaults to the user-requested command name. Pass "agent" or an absolute path explicitly. */
  bin?: string
  /** Test seam: replaces child_process.spawn for every subprocess. */
  spawnProcess?: SpawnProcess
  /** No-output stall watchdog (ms). 0 disables. */
  stallTimeoutMs?: number
  /** Isolated Cursor CLI config directory. Defaults to a scratch temp dir. */
  configDir?: string
  /** Env base for tests; production uses a small allowlist from process.env. */
  env?: NodeJS.ProcessEnv
}

interface TurnOutcome {
  text: string
  usage: AgentUsage
}

const ALLOW_ENV_KEYS = ["PATH", "HOME", "SHELL", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "CURSOR_API_KEY"]

export function cursorEnv(base: NodeJS.ProcessEnv = process.env, configDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOW_ENV_KEYS) {
    const value = base[key]
    if (value !== undefined) env[key] = value
  }
  if (configDir) env.CURSOR_CONFIG_DIR = configDir
  return env
}

export class CursorWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly spawnProcess: SpawnProcess | undefined
  private readonly stallTimeoutMs: number
  private readonly configDir: string | undefined
  private readonly envBase: NodeJS.ProcessEnv | undefined

  constructor(opts: CursorWorkerOpts = {}) {
    this.bin = opts.bin ?? "cursor-agent"
    this.spawnProcess = opts.spawnProcess
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
    this.configDir = opts.configDir ?? mkdtempSync(join(tmpdir(), "omegacode-cursor-config-"))
    this.envBase = opts.env
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (spec.schema) {
      try {
        assertValidSchema(spec.schema)
      } catch (err) {
        throw new AgentError({ provider: PROVIDER, code: "invalid_schema", message: `output schema does not compile: ${(err as Error).message}` })
      }
    }
    if (spec.maxTurns !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "cursor-agent has no enforceable maxTurns support in print mode; omit maxTurns",
      })
    }
    if (spec.effort !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "cursor-agent effort mapping is not wired yet; omit effort for provider \"cursor-agent\"",
      })
    }
    if (spec.sandbox !== "read-only") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `cursor-agent cannot enforce a "${spec.sandbox}" sandbox in Step 6A; use read-only/noEffects() or a provider with a hard sandbox`,
      })
    }
    if (spec.approval !== "never") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "cursor-agent print mode cannot surface approval prompts through looper; use approval: \"never\"",
      })
    }

    const working = await this.runTurn(spec, withInstructions(spec, spec.prompt), ctx, true)
    if (!spec.schema) return { text: working.text, status: "completed", usage: working.usage }

    const extraction = await this.runTurn(spec, withInstructions(spec, extractionPrompt(spec, working.text)), ctx, false)
    let parsed: unknown
    try {
      parsed = parseJsonLoose(extraction.text)
    } catch (err) {
      throw new AgentError({
        provider: PROVIDER,
        code: "invalid_structured_output",
        message: `cursor-agent structured extraction did not return JSON: ${(err as Error).message}`,
        retryable: false,
      })
    }
    const structured = stripNullOptionals(parsed, spec.schema)
    const check = validate(spec.schema, structured)
    if (!check.ok) {
      throw new AgentError({
        provider: PROVIDER,
        code: "invalid_structured_output",
        message: `cursor-agent structured extraction did not satisfy the output schema: ${check.errors}`,
        retryable: false,
      })
    }
    return {
      text: extraction.text,
      structured,
      status: "completed",
      usage: addUsage(working.usage, extraction.usage),
    }
  }

  async shutdown(): Promise<void> {
    // Spawn-per-call: nothing persistent to tear down.
  }

  private args(spec: AgentSpec, prompt: string): string[] {
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      ...(spec.model ? ["--model", spec.model] : []),
      prompt,
    ]
  }

  private env(): NodeJS.ProcessEnv {
    if (this.configDir) mkdirSync(this.configDir, { recursive: true })
    return cursorEnv(this.envBase ?? process.env, this.configDir)
  }

  private async runTurn(spec: AgentSpec, prompt: string, ctx: WorkerContext, forwardProgress: boolean): Promise<TurnOutcome> {
    let fallbackText = ""
    let resultText: string | undefined
    let usage = emptyUsage()
    let streamError: AgentError | undefined
    const forward = (e: WorkerProgress): void => {
      if (forwardProgress) ctx.onProgress(e)
    }

    const exit = await runJsonlSubprocess({
      provider: PROVIDER,
      bin: this.bin,
      args: this.args(spec, prompt),
      cwd: spec.cwd,
      env: this.env(),
      signal: ctx.signal,
      stallTimeoutMs: this.stallTimeoutMs,
      spawnProcess: this.spawnProcess,
      onValue: (value) => {
        if (!isObject(value)) return
        switch (strOf(value.type)) {
          case "assistant":
          case "text": {
            const text = assistantText(value) ?? strOf(value.text) ?? strOf(value.content)
            if (text !== undefined && text.length > 0) {
              fallbackText += text
              forward({ kind: "text", text })
            }
            return
          }
          case "thinking":
          case "reasoning": {
            const text = strOf(value.text) ?? strOf(value.content) ?? assistantText(value)
            if (text !== undefined && text.length > 0) forward({ kind: "reasoning", text })
            return
          }
          case "tool_call":
          case "tool_use":
          case "tool": {
            forward(toolProgress(value))
            return
          }
          case "tool_result":
          case "tool_call_result": {
            forward(toolResultProgress(value))
            return
          }
          case "result": {
            const text = strOf(value.result) ?? strOf(value.content) ?? strOf(value.text) ?? assistantText(value)
            const u = usageOf(value)
            if (u) usage = addUsage(usage, u)
            if (value.is_error === true || strOf(value.subtype) === "error") {
              streamError = new AgentError({
                provider: PROVIDER,
                code: "provider_error",
                message: text ?? "cursor-agent result event reported an error",
                retryable: false,
              })
              return
            }
            if (text !== undefined && text.length > 0) resultText = text
            return
          }
          case "usage": {
            const u = usageOf(value)
            if (u) {
              usage = addUsage(usage, u)
              forward({ kind: "usage", usage })
            }
            return
          }
          default:
            // Unknown Cursor event shapes are forward-compatible noise.
            return
        }
      },
    })

    if (streamError) throw streamError
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (exit.code !== 0) throw exitError(PROVIDER, this.bin, exit)
    const text = resultText ?? fallbackText
    if (text.length === 0) {
      throw new AgentError({ provider: PROVIDER, code: "no_result", message: "cursor-agent exited 0 without producing assistant text" })
    }
    return { text, usage }
  }
}

function withInstructions(spec: AgentSpec, prompt: string): string {
  if (!spec.instructions) return prompt
  return `<instructions>\n${spec.instructions}\n</instructions>\n\n${prompt}`
}

function extractionPrompt(spec: AgentSpec, workingText: string): string {
  return (
    `Earlier you produced this answer:\n\n${workingText}\n\n` +
    "Return that answer as a single JSON value that conforms to the following JSON Schema. " +
    "Output ONLY the JSON - no prose, no explanation, no code fences.\n\nSchema:\n" +
    JSON.stringify(spec.schema)
  )
}

function assistantText(value: Record<string, unknown>): string | undefined {
  const message = isObject(value.message) ? value.message : value
  const content = message.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  let out = ""
  for (const block of content) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") out += block.text
  }
  return out.length > 0 ? out : undefined
}

function toolProgress(value: Record<string, unknown>): WorkerProgress {
  const payload = payloadOf(value)
  return {
    kind: "tool",
    id: strOf(payload.id) ?? strOf(value.tool_call_id) ?? strOf(value.callID),
    name: strOf(payload.name) ?? strOf(payload.tool_name) ?? strOf(payload.tool) ?? strOf(value.name) ?? strOf(value.toolName) ?? "tool",
    input: payload.input ?? payload.args ?? payload.arguments ?? value.input ?? value.args,
  }
}

function toolResultProgress(value: Record<string, unknown>): WorkerProgress {
  const payload = payloadOf(value)
  const name = strOf(payload.name) ?? strOf(payload.tool_name) ?? strOf(payload.tool) ?? strOf(value.name) ?? strOf(value.toolName)
  return {
    kind: "tool-result",
    id: strOf(payload.id) ?? strOf(value.tool_call_id) ?? strOf(value.callID),
    ...(name ? { name } : {}),
    output: stringifyResult(payload.output ?? payload.result ?? value.output ?? value.result ?? value.content),
    isError: value.is_error === true || strOf(value.status) === "error" || strOf(payload.status) === "error",
  }
}

function payloadOf(value: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["tool_call", "toolCall", "tool", "part"] as const) {
    const payload = value[key]
    if (isObject(payload)) return payload
  }
  return value
}

function usageOf(value: Record<string, unknown>): AgentUsage | undefined {
  const source = isObject(value.usage) ? value.usage : value
  const inputTokens = numOf(source.inputTokens) ?? numOf(source.input_tokens) ?? numOf(source.prompt_tokens)
  const outputTokens = numOf(source.outputTokens) ?? numOf(source.output_tokens) ?? numOf(source.completion_tokens)
  const costUsd = numOf(source.costUsd) ?? numOf(source.cost_usd) ?? numOf(source.cost)
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return undefined
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, costUsd: costUsd ?? 0 }
}

function stringifyResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined
  if (typeof result === "string") return result
  if (isObject(result) && Array.isArray(result.content)) {
    const text = result.content.map((b: unknown) => (isObject(b) && typeof b.text === "string" ? b.text : "")).join("")
    if (text.length > 0) return text
  }
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function numOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

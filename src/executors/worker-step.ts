import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { zeroUsage, type ArtifactRef, type RunContext, type StepResult, type StepSpec } from "../kernel/types.js"
import { evidencePrefix } from "./evidence.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerProgress } from "./vendor/omegacode/index.js"
import type { AgentResult, AgentSpec } from "./vendor/omegacode/types.js"

export interface WorkerStepEvidence {
  readonly startedAt: number
  readonly prefix: string
  readonly promptPath: string
}

interface EvidenceRoles {
  readonly prompt: string
  readonly events: string
  readonly final: string
}

interface TextFinal {
  readonly kind: "text"
  readonly stem: string
  readonly roles?: EvidenceRoles
  readonly transformText?: (text: string) => string
  readonly interruptedOutput?: (error: AgentInterrupted, finalText: string) => string
  readonly agentErrorOutput?: (error: AgentError) => string
}

interface JsonFinal {
  readonly kind: "json"
  readonly stem: string
  readonly roles: EvidenceRoles
  readonly value: (result: AgentResult) => Record<string, unknown> | null
  readonly missingOutput: (result: AgentResult) => Record<string, unknown>
}

export interface RunWorkerStepOpts {
  readonly executorId: string
  readonly spec: StepSpec
  readonly ctx: RunContext
  readonly worker: Worker
  readonly agentSpec: AgentSpec
  readonly evidence: WorkerStepEvidence
  readonly eventText?: (line: string) => string
  readonly final: TextFinal | JsonFinal
}

export function requirePrompt(executorId: string, spec: StepSpec): string {
  if (!spec.prompt) throw new Error(`Step \`${spec.stepId}\` reached executor \`${executorId}\` without a rendered prompt.`)
  return spec.prompt
}

export function beginWorkerStep(spec: StepSpec, promptStem: string, prompt: string): WorkerStepEvidence {
  const prefix = evidencePrefix(spec)
  mkdirSync(spec.runDir, { recursive: true })
  const promptPath = join(spec.runDir, `${prefix}${promptStem}-prompt.md`)
  writeFileSync(promptPath, prompt, "utf8")
  return { startedAt: Date.now(), prefix, promptPath }
}

export function unsupportedSandboxResult(args: {
  readonly spec: StepSpec
  readonly evidence: WorkerStepEvidence
  readonly provider: string
  readonly fileStem?: string
  readonly role: string
  readonly message: string
}): StepResult {
  const preflightPath = join(args.spec.runDir, `${args.evidence.prefix}${args.fileStem ?? args.provider}-preflight.json`)
  writeFileSync(
    preflightPath,
    JSON.stringify(
      {
        provider: args.provider,
        code: "unsupported_sandbox",
        retryable: false,
        stepId: args.spec.stepId,
        effects: args.spec.effects.allow,
        message: args.message,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )
  return {
    status: "failed",
    output: { error: args.message, code: "unsupported_sandbox", retryable: false },
    evidence: [
      { role: "worker-prompt", path: args.evidence.promptPath },
      { role: args.role, path: preflightPath },
    ],
    usage: zeroUsage(Date.now() - args.evidence.startedAt),
  }
}

export async function runWorkerStep(opts: RunWorkerStepOpts): Promise<StepResult> {
  const events: string[] = []
  const onProgress = (e: WorkerProgress): void => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...e })
    events.push(opts.eventText ? opts.eventText(line) : line)
  }
  const timeout = AbortSignal.timeout(opts.spec.timeoutMs)
  const signal = opts.ctx.signal ? AbortSignal.any([opts.ctx.signal, timeout]) : timeout

  let result: AgentResult
  try {
    result = await opts.worker.runAgent(opts.agentSpec, { signal, onProgress })
  } catch (error) {
    const evidence = writeEvidence(opts.spec, opts.evidence, opts.final, events, { kind: "error", error })
    const durationMs = Date.now() - opts.evidence.startedAt
    if (error instanceof AgentInterrupted) {
      const finalText = opts.final.kind === "text" ? finalTextForError(opts.final, error) : error.message
      return {
        status: "interrupted",
        output: { error: opts.final.kind === "text" && opts.final.interruptedOutput ? opts.final.interruptedOutput(error, finalText) : error.message },
        evidence,
        usage: zeroUsage(durationMs),
      }
    }
    if (error instanceof AgentError) {
      return {
        status: "failed",
        output: {
          error: opts.final.kind === "text" && opts.final.agentErrorOutput ? opts.final.agentErrorOutput(error) : error.message,
          code: error.code,
          retryable: error.retryable,
        },
        evidence,
        usage: error.usage ? { ...error.usage, durationMs } : zeroUsage(durationMs),
      }
    }
    throw error
  }

  const durationMs = Date.now() - opts.evidence.startedAt
  const usage = { ...result.usage, durationMs }
  if (opts.final.kind === "json") {
    const value = opts.final.value(result)
    const evidence = writeEvidence(opts.spec, opts.evidence, opts.final, events, { kind: "result", result, jsonValue: value })
    if (value === null) return { status: "failed", output: opts.final.missingOutput(result), evidence, usage }
    return { status: result.status, output: value, evidence, usage }
  }

  const evidence = writeEvidence(opts.spec, opts.evidence, opts.final, events, { kind: "result", result })
  const output = isRecord(result.structured) ? result.structured : { text: result.text }
  return { status: result.status, output, evidence, usage }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

type EvidencePayload =
  | { readonly kind: "result"; readonly result: AgentResult; readonly jsonValue?: Record<string, unknown> | null }
  | { readonly kind: "error"; readonly error: unknown }

function writeEvidence(
  spec: StepSpec,
  evidence: WorkerStepEvidence,
  final: TextFinal | JsonFinal,
  events: readonly string[],
  payload: EvidencePayload,
): ArtifactRef[] {
  const eventsPath = join(spec.runDir, `${evidence.prefix}${final.stem}-events.jsonl`)
  writeFileSync(eventsPath, events.join("\n") + (events.length ? "\n" : ""), "utf8")

  const roles = final.roles ?? { prompt: "worker-prompt", events: "worker-events", final: "worker-final" }
  if (final.kind === "json") {
    const finalPath = join(spec.runDir, `${evidence.prefix}${final.stem}-verdict.json`)
    const value = payload.kind === "result" ? payload.jsonValue ?? null : null
    writeFileSync(finalPath, JSON.stringify(value, null, 2) + "\n", "utf8")
    return [
      { role: roles.prompt, path: evidence.promptPath },
      { role: roles.events, path: eventsPath },
      { role: roles.final, path: finalPath },
    ]
  }

  const finalPath = join(spec.runDir, `${evidence.prefix}${final.stem}-final.md`)
  const raw = payload.kind === "result" ? payload.result.text : errorText(payload.error)
  const text = final.transformText ? final.transformText(raw) : raw
  writeFileSync(finalPath, text, "utf8")
  return [
    { role: roles.prompt, path: evidence.promptPath },
    { role: roles.events, path: eventsPath },
    { role: roles.final, path: finalPath },
  ]
}

function finalTextForError(final: TextFinal, error: unknown): string {
  const text = errorText(error)
  return final.transformText ? final.transformText(text) : text
}

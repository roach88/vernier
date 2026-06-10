// HermesExecutor: an LLM gate is just a Step.
//
// Ported from the Python looper's HermesCli adapter
// (agent_workflows/adapters/hermes_cli.py) and the route handling in
// RunLoop.run (application/run_loop.py): run `hermes -t clarify -z
// <prompt>`, capture stdout/stderr, loose-parse the route JSON (tolerating
// surrounding prose), and return the gate fields as the step's output
// value. Whether the route is APPROVED is not decided here — that is the
// route-decision contract's job (the gate semantics are loop data, not
// executor behavior). In the five-slot model the router is not special;
// it is the first Step.
//
// Evidence mirrors the Python task bundle: route-prompt.md, route-raw.txt,
// route-decision.json under StepSpec.runDir.

import { execFile } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import { zeroUsage } from "../kernel/types.js"
import { evidencePrefix } from "./evidence.js"

export interface HermesRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Subprocess seam, injectable for tests (the Python adapter's CommandRunner). */
export type HermesRunner = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<HermesRunResult>

const defaultRunner: HermesRunner = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code?: unknown }).code) : 1) : 0
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" })
      },
    )
  })

/** Port of RunLoop.parse_route_json: strict parse, then best-effort `{...}` extraction. */
export function parseRouteJson(raw: string): Record<string, unknown> {
  const stripped = raw.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    const start = stripped.indexOf("{")
    const end = stripped.lastIndexOf("}")
    if (start === -1 || end === -1 || end <= start) throw new Error("Hermes route output contained no JSON object")
    parsed = JSON.parse(stripped.slice(start, end + 1))
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hermes route output was not a JSON object")
  }
  return parsed as Record<string, unknown>
}

/** Python wrote route-decision.json with json.dumps(sort_keys=True); match it. */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) out[key] = sortKeysDeep(obj[key])
  return out
}

export interface HermesExecutorOpts {
  readonly command?: string
  readonly runner?: HermesRunner
}

export class HermesExecutor implements Executor {
  readonly id = "hermes"
  private readonly command: string
  private readonly runner: HermesRunner

  constructor(opts: HermesExecutorOpts = {}) {
    this.command = opts.command ?? "hermes"
    this.runner = opts.runner ?? defaultRunner
  }

  async run(spec: StepSpec, ctx: RunContext): Promise<StepResult> {
    if (!spec.prompt) {
      throw new Error(`Step \`${spec.stepId}\` reached executor \`${this.id}\` without a rendered prompt.`)
    }
    mkdirSync(spec.runDir, { recursive: true })
    const prefix = evidencePrefix(spec)
    const promptPath = join(spec.runDir, `${prefix}route-prompt.md`)
    const rawPath = join(spec.runDir, `${prefix}route-raw.txt`)
    const decisionPath = join(spec.runDir, `${prefix}route-decision.json`)
    writeFileSync(promptPath, spec.prompt, "utf8")

    const startedAt = Date.now()
    const result = await this.runner(this.command, ["-t", "clarify", "-z", spec.prompt], {
      cwd: ctx.workdir,
      timeoutMs: spec.timeoutMs,
    })
    const durationMs = Date.now() - startedAt
    // Python HermesRouteResult.raw_text: stdout + optional STDERR section.
    writeFileSync(rawPath, result.stdout + (result.stderr ? "\nSTDERR:\n" + result.stderr : ""), "utf8")
    const evidence = [
      { role: "route-prompt", path: promptPath },
      { role: "route-raw", path: rawPath },
      { role: "route-decision", path: decisionPath },
    ]

    if (result.code !== 0) {
      writeFileSync(decisionPath, "{}\n", "utf8")
      return {
        status: "failed",
        output: { error: `Hermes exited with status ${result.code}.` },
        evidence,
        usage: zeroUsage(durationMs),
      }
    }

    let route: Record<string, unknown>
    try {
      route = parseRouteJson(result.stdout)
    } catch (error) {
      writeFileSync(decisionPath, "{}\n", "utf8")
      return {
        status: "failed",
        output: { error: `Could not parse Hermes route JSON: ${error instanceof Error ? error.message : String(error)}` },
        evidence,
        usage: zeroUsage(durationMs),
      }
    }
    writeFileSync(decisionPath, JSON.stringify(sortKeysDeep(route), null, 2) + "\n", "utf8")

    return {
      status: "completed",
      output: {
        gateDecision: String(route.gate_decision ?? ""),
        routeToWorker: route.route_to_worker === true,
        worker: String(route.worker ?? ""),
        reason: String(route.reason ?? ""),
        route,
      },
      evidence,
      usage: zeroUsage(durationMs), // hermes CLI reports no token usage (Python trace: "Unknown")
    }
  }
}

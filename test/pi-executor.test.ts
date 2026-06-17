import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { PiExecutor } from "../src/executors/pi.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext } from "../src/executors/vendor/omegacode/index.js"
import type { AgentResult, AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import { fsScope, noEffects, type StepSpec } from "../src/kernel/types.js"

function spec(overrides: Partial<StepSpec> = {}): StepSpec {
  const runDir = mkdtempSync(join(tmpdir(), "vernier-pi-run-"))
  return {
    runId: "run-1",
    traceId: "run-1",
    loopId: "verified-answer",
    loopVersion: "0.2.0",
    stepId: "answer",
    attempt: 1,
    iteration: 1,
    inputs: { task: "answer" },
    prompt: "Answer the question.",
    effects: noEffects(),
    runDir,
    timeoutMs: 60_000,
    ...overrides,
  }
}

const workdir = (): string => mkdtempSync(join(tmpdir(), "vernier-pi-work-"))

function recordingWorker(result: AgentResult): { worker: Worker; seen: AgentSpec[] } {
  const seen: AgentSpec[] = []
  const worker: Worker = {
    id: "pi",
    async runAgent(s: AgentSpec, _ctx: WorkerContext) {
      seen.push(s)
      return result
    },
    async shutdown() {},
  }
  return { worker, seen }
}

describe("PiExecutor", () => {
  it("maps a worker text turn onto StepResult and writes evidence under runDir", async () => {
    const { worker } = recordingWorker({ text: "pi ok", status: "completed", usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 } })
    const s = spec()
    const result = await new PiExecutor({ worker }).run(s, { workdir: workdir() })

    expect(result.status).toBe("completed")
    expect(result.output).toEqual({ text: "pi ok" })
    expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 })
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.evidence.map((e) => e.role)).toEqual(["worker-prompt", "worker-events", "worker-final"])
    for (const ref of result.evidence) {
      expect(ref.path.startsWith(s.runDir)).toBe(true)
      expect(existsSync(ref.path)).toBe(true)
    }
    expect(readFileSync(join(s.runDir, "answer-pi-prompt.md"), "utf8")).toBe(s.prompt)
  })

  it("maps structured AgentResult output onto StepResult output", async () => {
    const { worker } = recordingWorker({
      text: "{\"passed\":true}",
      structured: { passed: true },
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    })
    const result = await new PiExecutor({ worker }).run(
      spec({
        outputSchema: {
          type: "object",
          properties: { passed: { type: "boolean" } },
          required: ["passed"],
        },
      }),
      { workdir: workdir() },
    )

    expect(result.status).toBe("completed")
    expect(result.output).toEqual({ passed: true })
  })

  it("hands the worker its only accepted sandbox (danger-full-access) for noEffects steps", async () => {
    const { worker, seen } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const wd = workdir()
    await new PiExecutor({ worker, model: "pi-test-model" }).run(spec(), { workdir: wd })

    expect(seen[0]).toMatchObject({
      provider: "pi",
      cwd: wd,
      sandbox: "danger-full-access",
      approval: "never",
      model: "pi-test-model",
    })
  })

  it("fails closed for write scopes with preflight evidence and never invokes the worker", async () => {
    let invoked = false
    const worker: Worker = {
      id: "pi",
      async runAgent() {
        invoked = true
        return { text: "unexpected", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
      },
      async shutdown() {},
    }
    const s = spec({ effects: fsScope("docs/**") })
    const result = await new PiExecutor({ worker }).run(s, { workdir: workdir() })

    expect(invoked).toBe(false)
    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "unsupported_sandbox", retryable: false })
    expect(String(result.output.error)).toContain("no enforceable sandbox")
    expect(result.evidence.map((e) => e.role)).toEqual(["worker-prompt", "pi-preflight"])
    expect(readFileSync(join(s.runDir, "answer-pi-preflight.json"), "utf8")).toContain("docs/**")
  })

  it("labels retry-attempt evidence with the same retry prefix as other executors", async () => {
    const { worker } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const s = spec({ attempt: 2 })
    await new PiExecutor({ worker }).run(s, { workdir: workdir() })
    expect(existsSync(join(s.runDir, "retry-2-answer-pi-final.md"))).toBe(true)
  })

  it("maps AgentError onto a failed StepResult with code, retryability, and billed usage", async () => {
    const failing: Worker = {
      id: "pi",
      async runAgent() {
        throw new AgentError({
          provider: "pi",
          code: "provider_outdated",
          message: "pi 0.73.1 is below the minimum supported 0.79.1",
          retryable: false,
          usage: { inputTokens: 10, outputTokens: 0, costUsd: 0 },
        })
      },
      async shutdown() {},
    }
    const s = spec()
    const result = await new PiExecutor({ worker: failing }).run(s, { workdir: workdir() })

    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "provider_outdated", retryable: false })
    expect(readFileSync(join(s.runDir, "answer-pi-final.md"), "utf8")).toContain("below the minimum supported")
    expect(result.usage.inputTokens).toBe(10)
  })

  it("composes timeout and caller abort into interrupted StepResult", async () => {
    const hanging: Worker = {
      id: "pi",
      runAgent(_s: AgentSpec, ctx: WorkerContext) {
        return new Promise<AgentResult>((_resolve, reject) => {
          if (ctx.signal.aborted) return reject(new AgentInterrupted())
          ctx.signal.addEventListener("abort", () => reject(new AgentInterrupted()), { once: true })
        })
      },
      async shutdown() {},
    }

    const timedOut = await new PiExecutor({ worker: hanging }).run(spec({ timeoutMs: 50 }), { workdir: workdir() })
    expect(timedOut.status).toBe("interrupted")

    const caller = new AbortController()
    const pending = new PiExecutor({ worker: hanging }).run(spec({ timeoutMs: 600_000 }), { workdir: workdir(), signal: caller.signal })
    setTimeout(() => caller.abort(), 20)
    const aborted = await pending
    expect(aborted.status).toBe("interrupted")
  })

  it("refuses to run without a rendered prompt", async () => {
    const { worker } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const promptless = { ...spec() } as Record<string, unknown>
    delete promptless.prompt
    await expect(new PiExecutor({ worker }).run(promptless as unknown as StepSpec, { workdir: workdir() })).rejects.toThrow(
      /without a rendered prompt/,
    )
  })
})

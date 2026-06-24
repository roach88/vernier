import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Executor } from "../src/kernel/types.js"
import { OpencodeExecutor } from "../src/executors/opencode.js"
import { PiExecutor } from "../src/executors/pi.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext } from "../src/executors/vendor/omegacode/index.js"
import type { AgentResult, AgentSpec, ProviderId } from "../src/executors/vendor/omegacode/types.js"
import { fsScope, noEffects, type StepSpec } from "../src/kernel/types.js"

type Provider = Extract<ProviderId, "opencode" | "pi">

interface ExecutorCase {
  readonly label: string
  readonly provider: Provider
  readonly model: string
  readonly make: (worker: Worker, model?: string) => Executor
  readonly failure: { readonly code: string; readonly message: string; readonly retryable: boolean }
}

const cases: readonly ExecutorCase[] = [
  {
    label: "OpencodeExecutor",
    provider: "opencode",
    model: "opencode-test-model",
    make: (worker, model) => new OpencodeExecutor({ worker, model }),
    failure: { code: "provider_busy", message: "opencode exited with transient database contention", retryable: true },
  },
  {
    label: "PiExecutor",
    provider: "pi",
    model: "pi-test-model",
    make: (worker, model) => new PiExecutor({ worker, model }),
    failure: { code: "provider_outdated", message: "pi 0.73.1 is below the minimum supported 0.79.1", retryable: false },
  },
]

function spec(provider: Provider, overrides: Partial<StepSpec> = {}): StepSpec {
  const runDir = mkdtempSync(join(tmpdir(), `vernier-${provider}-run-`))
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

const workdir = (provider: Provider): string => mkdtempSync(join(tmpdir(), `vernier-${provider}-work-`))

function recordingWorker(provider: Provider, result: AgentResult): { worker: Worker; seen: AgentSpec[] } {
  const seen: AgentSpec[] = []
  const worker: Worker = {
    id: provider,
    async runAgent(s: AgentSpec, ctx: WorkerContext) {
      seen.push(s)
      ctx.onProgress({ kind: "text", text: result.text })
      return result
    },
    async shutdown() {},
  }
  return { worker, seen }
}

describe.each(cases)("$label", (c) => {
  it("maps a worker text turn onto StepResult and writes evidence under runDir", async () => {
    const { worker } = recordingWorker(c.provider, { text: `${c.provider} ok`, status: "completed", usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 } })
    const s = spec(c.provider)
    const result = await c.make(worker).run(s, { workdir: workdir(c.provider) })

    expect(result.status).toBe("completed")
    expect(result.output).toEqual({ text: `${c.provider} ok` })
    expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 })
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.evidence.map((e) => e.role)).toEqual(["worker-prompt", "worker-events", "worker-final"])
    for (const ref of result.evidence) {
      expect(ref.path.startsWith(s.runDir)).toBe(true)
      expect(existsSync(ref.path)).toBe(true)
    }
    expect(readFileSync(join(s.runDir, `${c.provider}-prompt.md`), "utf8")).toBe(s.prompt)
  })

  it("maps structured AgentResult output onto StepResult output", async () => {
    const { worker } = recordingWorker(c.provider, {
      text: "{\"passed\":true}",
      structured: { passed: true },
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    })
    const result = await c.make(worker).run(
      spec(c.provider, {
        outputSchema: {
          type: "object",
          properties: { passed: { type: "boolean" } },
          required: ["passed"],
        },
      }),
      { workdir: workdir(c.provider) },
    )

    expect(result.status).toBe("completed")
    expect(result.output).toEqual({ passed: true })
  })

  it("hands the worker its only accepted sandbox (danger-full-access) for noEffects steps", async () => {
    const { worker, seen } = recordingWorker(c.provider, { text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const wd = workdir(c.provider)
    await c.make(worker, c.model).run(spec(c.provider), { workdir: wd })

    expect(seen[0]).toMatchObject({
      provider: c.provider,
      cwd: wd,
      sandbox: "danger-full-access",
      approval: "never",
      model: c.model,
    })
  })

  it("fails closed for write scopes with preflight evidence and never invokes the worker", async () => {
    let invoked = false
    const worker: Worker = {
      id: c.provider,
      async runAgent() {
        invoked = true
        return { text: "unexpected", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
      },
      async shutdown() {},
    }
    const s = spec(c.provider, { effects: fsScope("docs/**") })
    const result = await c.make(worker).run(s, { workdir: workdir(c.provider) })

    expect(invoked).toBe(false)
    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "unsupported_sandbox", retryable: false })
    expect(String(result.output.error)).toContain("no enforceable sandbox")
    expect(result.evidence.map((e) => e.role)).toEqual(["worker-prompt", `${c.provider}-preflight`])
    expect(readFileSync(join(s.runDir, `${c.provider}-preflight.json`), "utf8")).toContain("docs/**")
  })

  it("labels retry-attempt evidence with the same retry prefix as other executors", async () => {
    const { worker } = recordingWorker(c.provider, { text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const s = spec(c.provider, { attempt: 2 })
    await c.make(worker).run(s, { workdir: workdir(c.provider) })
    expect(existsSync(join(s.runDir, `retry-2-${c.provider}-final.md`))).toBe(true)
  })

  it("maps AgentError onto a failed StepResult with code, retryability, and billed usage", async () => {
    const failing: Worker = {
      id: c.provider,
      async runAgent() {
        throw new AgentError({
          provider: c.provider,
          code: c.failure.code,
          message: c.failure.message,
          retryable: c.failure.retryable,
          usage: { inputTokens: 10, outputTokens: 0, costUsd: 0 },
        })
      },
      async shutdown() {},
    }
    const s = spec(c.provider)
    const result = await c.make(failing).run(s, { workdir: workdir(c.provider) })

    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: c.failure.code, retryable: c.failure.retryable })
    expect(readFileSync(join(s.runDir, `${c.provider}-final.md`), "utf8")).toContain(c.failure.message)
    expect(result.usage.inputTokens).toBe(10)
  })

  it("composes timeout and caller abort into interrupted StepResult", async () => {
    const hanging: Worker = {
      id: c.provider,
      runAgent(_s: AgentSpec, ctx: WorkerContext) {
        return new Promise<AgentResult>((_resolve, reject) => {
          if (ctx.signal.aborted) return reject(new AgentInterrupted())
          ctx.signal.addEventListener("abort", () => reject(new AgentInterrupted()), { once: true })
        })
      },
      async shutdown() {},
    }

    const timedOut = await c.make(hanging).run(spec(c.provider, { timeoutMs: 50 }), { workdir: workdir(c.provider) })
    expect(timedOut.status).toBe("interrupted")

    const caller = new AbortController()
    const pending = c.make(hanging).run(spec(c.provider, { timeoutMs: 600_000 }), { workdir: workdir(c.provider), signal: caller.signal })
    setTimeout(() => caller.abort(), 20)
    const aborted = await pending
    expect(aborted.status).toBe("interrupted")
  })

  it("refuses to run without a rendered prompt", async () => {
    const { worker } = recordingWorker(c.provider, { text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const promptless = { ...spec(c.provider) } as Record<string, unknown>
    delete promptless.prompt
    await expect(c.make(worker).run(promptless as unknown as StepSpec, { workdir: workdir(c.provider) })).rejects.toThrow(
      /without a rendered prompt/,
    )
  })
})

import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CursorExecutor } from "../src/executors/cursor.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext } from "../src/executors/vendor/omegacode/index.js"
import type { AgentResult, AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import { fsScope, noEffects, type StepSpec } from "../src/kernel/types.js"

function spec(overrides: Partial<StepSpec> = {}): StepSpec {
  const runDir = mkdtempSync(join(tmpdir(), "vernier-cursor-run-"))
  return {
    runId: "run-1",
    traceId: "run-1",
    loopId: "plan-work-review",
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

const workdir = (): string => mkdtempSync(join(tmpdir(), "vernier-cursor-work-"))

function recordingWorker(result: AgentResult): { worker: Worker; seen: AgentSpec[] } {
  const seen: AgentSpec[] = []
  const worker: Worker = {
    id: "cursor-agent",
    async runAgent(s: AgentSpec, _ctx: WorkerContext) {
      seen.push(s)
      return result
    },
    async shutdown() {},
  }
  return { worker, seen }
}

describe("CursorExecutor", () => {
  it("maps a read-only worker text turn onto StepResult and writes evidence under runDir", async () => {
    const { worker } = recordingWorker({ text: "cursor ok", status: "completed", usage: { inputTokens: 1, outputTokens: 2, costUsd: 0 } })
    const s = spec()
    const result = await new CursorExecutor({ worker }).run(s, { workdir: workdir() })

    expect(result.status).toBe("completed")
    expect(result.output).toEqual({ text: "cursor ok" })
    expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 })
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.evidence.map((e) => e.role)).toEqual(["worker-prompt", "worker-events", "worker-final"])
    for (const ref of result.evidence) {
      expect(ref.path.startsWith(s.runDir)).toBe(true)
      expect(existsSync(ref.path)).toBe(true)
    }
    expect(readFileSync(join(s.runDir, "answer-cursor-prompt.md"), "utf8")).toBe(s.prompt)
  })

  it("maps structured AgentResult output onto StepResult output", async () => {
    const { worker } = recordingWorker({
      text: "{\"passed\":true}",
      structured: { passed: true },
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    })
    const result = await new CursorExecutor({ worker }).run(
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

  it("hands read-only Cursor AgentSpec to the worker for noEffects steps", async () => {
    const { worker, seen } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const wd = workdir()
    await new CursorExecutor({ worker, model: "cursor-test-model" }).run(spec(), { workdir: wd })

    expect(seen[0]).toMatchObject({
      provider: "cursor-agent",
      cwd: wd,
      sandbox: "read-only",
      approval: "never",
      model: "cursor-test-model",
    })
  })

  it("hands workspace-write Cursor AgentSpec to the worker for write scopes", async () => {
    const { worker, seen } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const wd = workdir()
    const s = spec({ effects: fsScope("docs/**") })
    const result = await new CursorExecutor({ worker }).run(s, { workdir: wd })

    expect(result.status).toBe("completed")
    expect(seen[0]).toMatchObject({
      provider: "cursor-agent",
      cwd: wd,
      sandbox: "workspace-write",
      approval: "never",
    })
  })

  it("labels retry-attempt evidence with the same retry prefix as other executors", async () => {
    const { worker } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const s = spec({ attempt: 2 })
    await new CursorExecutor({ worker }).run(s, { workdir: workdir() })
    expect(existsSync(join(s.runDir, "retry-2-answer-cursor-final.md"))).toBe(true)
  })

  it("maps AgentError onto a failed StepResult and redacts auth-looking evidence", async () => {
    const failing: Worker = {
      id: "cursor-agent",
      async runAgent() {
        throw new AgentError({
          provider: "cursor-agent",
          code: "provider_auth",
          message: "CURSOR_API_KEY=secret-token failed",
          retryable: false,
          usage: { inputTokens: 10, outputTokens: 0, costUsd: 0 },
        })
      },
      async shutdown() {},
    }
    const s = spec()
    const result = await new CursorExecutor({ worker: failing }).run(s, { workdir: workdir() })

    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "provider_auth", retryable: false })
    expect(String(result.output.error)).not.toContain("secret-token")
    expect(readFileSync(join(s.runDir, "answer-cursor-final.md"), "utf8")).not.toContain("secret-token")
    expect(result.usage.inputTokens).toBe(10)
  })

  it("composes timeout and caller abort into interrupted StepResult", async () => {
    const hanging: Worker = {
      id: "cursor-agent",
      runAgent(_s: AgentSpec, ctx: WorkerContext) {
        return new Promise<AgentResult>((_resolve, reject) => {
          if (ctx.signal.aborted) return reject(new AgentInterrupted())
          ctx.signal.addEventListener("abort", () => reject(new AgentInterrupted()), { once: true })
        })
      },
      async shutdown() {},
    }

    const timedOut = await new CursorExecutor({ worker: hanging }).run(spec({ timeoutMs: 50 }), { workdir: workdir() })
    expect(timedOut.status).toBe("interrupted")

    const caller = new AbortController()
    const pending = new CursorExecutor({ worker: hanging }).run(spec({ timeoutMs: 600_000 }), { workdir: workdir(), signal: caller.signal })
    setTimeout(() => caller.abort(), 20)
    const aborted = await pending
    expect(aborted.status).toBe("interrupted")
  })

  it("refuses to run without a rendered prompt", async () => {
    const { worker } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const promptless = { ...spec() } as Record<string, unknown>
    delete promptless.prompt
    await expect(new CursorExecutor({ worker }).run(promptless as unknown as StepSpec, { workdir: workdir() })).rejects.toThrow(
      /without a rendered prompt/,
    )
  })
})

// ClaudeExecutor against scripted workers only — the SDK is never imported
// here (the lazy-load seam is exercised with injected loaders), so this
// suite is deterministic and runs on installs that do not carry the
// optional peer. The live path is gated in claude.live.test.ts.

import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ClaudeExecutor, CLAUDE_SDK } from "../src/executors/claude.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext } from "../src/executors/vendor/omegacode/index.js"
import type { AgentResult, AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import { fsScope, noEffects, type StepSpec } from "../src/kernel/types.js"

function spec(overrides: Partial<StepSpec> = {}): StepSpec {
  const runDir = mkdtempSync(join(tmpdir(), "vernier-claude-run-"))
  return {
    runId: "run-1",
    traceId: "run-1",
    loopId: "plan-work-review",
    loopVersion: "0.3.0",
    stepId: "implement",
    attempt: 1,
    iteration: 1,
    inputs: { task: "implement" },
    prompt: "Implement the note.",
    effects: noEffects(),
    runDir,
    timeoutMs: 60_000,
    ...overrides,
  }
}

const workdir = (): string => mkdtempSync(join(tmpdir(), "vernier-claude-work-"))

function recordingWorker(result: AgentResult): { worker: Worker; seen: AgentSpec[] } {
  const seen: AgentSpec[] = []
  const worker: Worker = {
    id: "claude-code",
    async runAgent(s: AgentSpec, _ctx: WorkerContext) {
      seen.push(s)
      return result
    },
    async shutdown() {},
  }
  return { worker, seen }
}

describe("ClaudeExecutor", () => {
  it("maps a worker text turn onto StepResult and writes evidence under runDir", async () => {
    const { worker } = recordingWorker({ text: "claude ok", status: "completed", usage: { inputTokens: 3, outputTokens: 5, costUsd: 0.01 } })
    const s = spec()
    const result = await new ClaudeExecutor({ worker }).run(s, { workdir: workdir() })

    expect(result.status).toBe("completed")
    expect(result.output).toEqual({ text: "claude ok" })
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 5, costUsd: 0.01 })
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.evidence.map((e) => e.role)).toEqual(["worker-prompt", "worker-events", "worker-final"])
    for (const ref of result.evidence) {
      expect(ref.path.startsWith(s.runDir)).toBe(true)
      expect(existsSync(ref.path)).toBe(true)
    }
    expect(readFileSync(join(s.runDir, "claude-prompt.md"), "utf8")).toBe(s.prompt)
    expect(readFileSync(join(s.runDir, "claude-final.md"), "utf8")).toBe("claude ok")
  })

  it("maps structured AgentResult output onto StepResult output", async () => {
    const { worker } = recordingWorker({
      text: '{"passed":true}',
      structured: { passed: true },
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    })
    const result = await new ClaudeExecutor({ worker }).run(
      spec({ outputSchema: { type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] } }),
      { workdir: workdir() },
    )
    expect(result.status).toBe("completed")
    expect(result.output).toEqual({ passed: true })
  })

  it("derives the sandbox from the EffectScope: noEffects -> read-only, a write scope -> workspace-write", async () => {
    const { worker, seen } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const wd = workdir()
    const executor = new ClaudeExecutor({ worker, model: "claude-test-model" })

    await executor.run(spec(), { workdir: wd })
    expect(seen[0]).toMatchObject({ provider: "claude-code", cwd: wd, sandbox: "read-only", approval: "never", model: "claude-test-model" })

    await executor.run(spec({ effects: fsScope("docs/**") }), { workdir: wd })
    expect(seen[1]!.sandbox).toBe("workspace-write")
  })

  it("fails actionably (not crashes) when the optional SDK is missing, without retry-burning", async () => {
    const missing = Object.assign(new Error(`Cannot find package '${CLAUDE_SDK}' imported from vernier`), {
      code: "ERR_MODULE_NOT_FOUND",
    })
    const s = spec()
    const result = await new ClaudeExecutor({ loadWorker: () => Promise.reject(missing) }).run(s, { workdir: workdir() })

    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "sdk_missing", retryable: false })
    expect(String(result.output.error)).toContain(`npm install ${CLAUDE_SDK}`)
    expect(String(result.output.error)).toContain("vernier doctor")
    expect(readFileSync(join(s.runDir, "claude-final.md"), "utf8")).toContain(CLAUDE_SDK)
  })

  it("propagates loader failures that are NOT the missing optional peer (a broken install is a crash, not a step failure)", async () => {
    const broken = Object.assign(new Error("Cannot find module './vendor/omegacode/claude.js'"), { code: "ERR_MODULE_NOT_FOUND" })
    await expect(new ClaudeExecutor({ loadWorker: () => Promise.reject(broken) }).run(spec(), { workdir: workdir() })).rejects.toThrow(
      /vendor\/omegacode/,
    )
  })

  it("loads the worker once and reuses it across runs", async () => {
    let loads = 0
    const { worker } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const executor = new ClaudeExecutor({
      loadWorker: async () => {
        loads += 1
        return worker
      },
    })
    await executor.run(spec(), { workdir: workdir() })
    await executor.run(spec(), { workdir: workdir() })
    expect(loads).toBe(1)
  })

  it("maps AgentError onto a failed StepResult, carrying the failed turn's usage", async () => {
    const failing: Worker = {
      id: "claude-code",
      async runAgent() {
        throw new AgentError({
          provider: "claude-code",
          code: "error_max_turns",
          message: "claude result: error_max_turns",
          retryable: false,
          usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.02 },
        })
      },
      async shutdown() {},
    }
    const result = await new ClaudeExecutor({ worker: failing }).run(spec(), { workdir: workdir() })
    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "error_max_turns", retryable: false })
    expect(result.usage.inputTokens).toBe(12)
  })

  it("composes timeout and caller abort into interrupted StepResult", async () => {
    const hanging: Worker = {
      id: "claude-code",
      runAgent(_s: AgentSpec, ctx: WorkerContext) {
        return new Promise<AgentResult>((_resolve, reject) => {
          if (ctx.signal.aborted) return reject(new AgentInterrupted())
          ctx.signal.addEventListener("abort", () => reject(new AgentInterrupted()), { once: true })
        })
      },
      async shutdown() {},
    }

    const timedOut = await new ClaudeExecutor({ worker: hanging }).run(spec({ timeoutMs: 50 }), { workdir: workdir() })
    expect(timedOut.status).toBe("interrupted")

    const caller = new AbortController()
    const pending = new ClaudeExecutor({ worker: hanging }).run(spec({ timeoutMs: 600_000 }), { workdir: workdir(), signal: caller.signal })
    setTimeout(() => caller.abort(), 20)
    const aborted = await pending
    expect(aborted.status).toBe("interrupted")
  })

  it("labels retry-attempt evidence with the same retry prefix as other executors", async () => {
    const { worker } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const s = spec({ attempt: 2 })
    await new ClaudeExecutor({ worker }).run(s, { workdir: workdir() })
    expect(existsSync(join(s.runDir, "retry-2-claude-final.md"))).toBe(true)
  })

  it("refuses to run without a rendered prompt", async () => {
    const { worker } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const promptless = { ...spec() } as Record<string, unknown>
    delete promptless.prompt
    await expect(new ClaudeExecutor({ worker }).run(promptless as unknown as StepSpec, { workdir: workdir() })).rejects.toThrow(
      /without a rendered prompt/,
    )
  })
})

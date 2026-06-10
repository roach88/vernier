// CodexExecutor conformance to the Executor seam, proven against
// omegacode's vendored deterministic FakeWorker (no network, no auth)
// plus stub workers for the error taxonomy. What is under test is the
// honest AgentResult -> StepResult mapping and the fail-closed sandbox
// derivation — not the model.

import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CodexExecutor } from "../src/executors/codex.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext } from "../src/executors/vendor/omegacode/index.js"
import { FakeWorker } from "../src/executors/vendor/omegacode/fake.js"
import type { AgentResult, AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import { fsScope, noEffects, type StepSpec } from "../src/kernel/types.js"

function spec(overrides: Partial<StepSpec> = {}): StepSpec {
  const runDir = mkdtempSync(join(tmpdir(), "looper-codex-run-"))
  return {
    runId: "run-1",
    traceId: "run-1",
    loopId: "plan-work-review",
    loopVersion: "0.2.0",
    stepId: "implement",
    attempt: 1,
    iteration: 1,
    inputs: { task: "write the note" },
    prompt: "Write the dry-run note.",
    effects: fsScope("docs/agent-workflows/**"),
    runDir,
    timeoutMs: 60_000,
    ...overrides,
  }
}

const workdir = (): string => mkdtempSync(join(tmpdir(), "looper-codex-work-"))

/** A stub worker that records the AgentSpec it received and returns a canned result. */
function recordingWorker(result: AgentResult): { worker: Worker; seen: AgentSpec[] } {
  const seen: AgentSpec[] = []
  const worker: Worker = {
    id: "codex",
    async runAgent(s: AgentSpec, _ctx: WorkerContext) {
      seen.push(s)
      return result
    },
    async shutdown() {},
  }
  return { worker, seen }
}

describe("CodexExecutor", () => {
  it("maps a FakeWorker text turn onto StepResult: completed, {text}, usage + duration", async () => {
    const executor = new CodexExecutor({ worker: new FakeWorker() })
    const s = spec()
    const result = await executor.run(s, { workdir: workdir() })

    expect(result.status).toBe("completed")
    expect(String(result.output.text)).toContain("[fake:codex]")
    expect(result.usage.inputTokens).toBe(s.prompt!.length) // FakeWorker bills prompt length
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("maps structured output (outputSchema -> AgentResult.structured) onto output", async () => {
    const executor = new CodexExecutor({ worker: new FakeWorker() })
    const s = spec({
      outputSchema: {
        type: "object",
        properties: { artifact: { type: "string" }, summary: { type: "string" } },
        required: ["artifact", "summary"],
      },
    })
    const result = await executor.run(s, { workdir: workdir() })

    expect(result.status).toBe("completed")
    // FakeWorker synthesizes a schema-satisfying value; the executor returns it AS the output.
    expect(result.output).toEqual({ artifact: "fake", summary: "fake" })
  })

  it("writes runner-managed evidence (prompt, events, final) under runDir, never the workdir", async () => {
    const executor = new CodexExecutor({ worker: new FakeWorker() })
    const s = spec()
    const wd = workdir()
    const result = await executor.run(s, { workdir: wd })

    const roles = result.evidence.map((e) => e.role)
    expect(roles).toEqual(["worker-prompt", "worker-events", "worker-final"])
    for (const ref of result.evidence) {
      expect(ref.path.startsWith(s.runDir)).toBe(true) // absolute, under runDir
      expect(existsSync(ref.path)).toBe(true)
    }
    expect(readFileSync(join(s.runDir, "codex-prompt.md"), "utf8")).toBe(s.prompt)
    // The progress feed was journaled as JSONL.
    const events = readFileSync(join(s.runDir, "codex-events.jsonl"), "utf8").trim().split("\n")
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.parse(events[0]!)).toHaveProperty("kind")
  })

  it("labels retry-attempt evidence like the Python runner (retry- prefix)", async () => {
    const executor = new CodexExecutor({ worker: new FakeWorker() })
    const s = spec({ attempt: 2 })
    await executor.run(s, { workdir: workdir() })
    expect(existsSync(join(s.runDir, "retry-2-codex-final.md"))).toBe(true)
  })

  it("derives the sandbox from the EffectScope, fail-closed: scope -> workspace-write, none -> read-only", async () => {
    const canned: AgentResult = { text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }

    const scoped = recordingWorker(canned)
    await new CodexExecutor({ worker: scoped.worker }).run(spec(), { workdir: workdir() })
    expect(scoped.seen[0]!.sandbox).toBe("workspace-write")
    expect(scoped.seen[0]!.approval).toBe("never")

    const unscoped = recordingWorker(canned)
    await new CodexExecutor({ worker: unscoped.worker }).run(spec({ effects: noEffects() }), { workdir: workdir() })
    expect(unscoped.seen[0]!.sandbox).toBe("read-only")
  })

  it("runs the agent in the step's workdir (cwd = ctx.workdir)", async () => {
    const canned: AgentResult = { text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
    const { worker, seen } = recordingWorker(canned)
    const wd = workdir()
    await new CodexExecutor({ worker }).run(spec(), { workdir: wd })
    expect(seen[0]!.cwd).toBe(wd)
  })

  it("maps AgentError onto a failed StepResult carrying code, retryability, and billed usage", async () => {
    const failing: Worker = {
      id: "codex",
      async runAgent() {
        throw new AgentError({
          provider: "codex",
          code: "turn_failed",
          message: "codex turn failed",
          retryable: true,
          usage: { inputTokens: 100, outputTokens: 5, costUsd: 0 },
        })
      },
      async shutdown() {},
    }
    const result = await new CodexExecutor({ worker: failing }).run(spec(), { workdir: workdir() })
    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "turn_failed", retryable: true })
    expect(result.usage.inputTokens).toBe(100) // failed turns still bill
  })

  it("composes the executor timeout with an incoming ctx.signal — either may abort", async () => {
    /** A worker that hangs until its signal aborts (then surfaces the interrupt). */
    const hanging: Worker = {
      id: "codex",
      runAgent(_s: AgentSpec, ctx: WorkerContext) {
        return new Promise<AgentResult>((_resolve, reject) => {
          if (ctx.signal.aborted) return reject(new AgentInterrupted())
          ctx.signal.addEventListener("abort", () => reject(new AgentInterrupted()), { once: true })
        })
      },
      async shutdown() {},
    }

    // A caller-supplied signal must NOT bypass the executor timeout.
    const idleCaller = new AbortController()
    const timedOut = await new CodexExecutor({ worker: hanging }).run(spec({ timeoutMs: 50 }), {
      workdir: workdir(),
      signal: idleCaller.signal,
    })
    expect(timedOut.status).toBe("interrupted")

    // And the caller signal still aborts well inside a generous timeout.
    const caller = new AbortController()
    const pending = new CodexExecutor({ worker: hanging }).run(spec({ timeoutMs: 600_000 }), {
      workdir: workdir(),
      signal: caller.signal,
    })
    setTimeout(() => caller.abort(), 20)
    const aborted = await pending
    expect(aborted.status).toBe("interrupted")
  })

  it("maps AgentInterrupted onto an interrupted StepResult", async () => {
    const interrupted: Worker = {
      id: "codex",
      async runAgent() {
        throw new AgentInterrupted()
      },
      async shutdown() {},
    }
    const result = await new CodexExecutor({ worker: interrupted }).run(spec(), { workdir: workdir() })
    expect(result.status).toBe("interrupted")
  })

  it("refuses to run without a rendered prompt (executor misconfiguration, not a step failure)", async () => {
    const executor = new CodexExecutor({ worker: new FakeWorker() })
    const promptless = { ...spec() } as Record<string, unknown>
    delete promptless.prompt
    await expect(executor.run(promptless as unknown as StepSpec, { workdir: workdir() })).rejects.toThrow(/without a rendered prompt/)
  })
})

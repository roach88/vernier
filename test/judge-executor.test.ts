// JudgeExecutor conformance to the Executor seam: the structured verdict
// mapping (provider structured output -> StepResult.output), the pinned
// read-only sandbox, the refusal to run without a derived outputSchema, and
// the evidence trail. Proven against scripted workers — no network, no auth.

import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { JudgeExecutor } from "../src/executors/judge.js"
import { AgentError, type Worker, type WorkerContext } from "../src/executors/vendor/omegacode/index.js"
import type { AgentResult, AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import { derivedOutputSchema, fsScope, noEffects, sig, type StepSpec } from "../src/kernel/types.js"

const verdictOutput = z.object({ passed: z.boolean(), feedback: z.string(), missing: z.array(z.string()) })
// Derived, not hand-written — the same one-source-of-truth path the engine uses.
const verdictSchema = derivedOutputSchema(sig(z.object({}), verdictOutput))

function spec(overrides: Partial<StepSpec> = {}): StepSpec {
  return {
    runId: "run-2",
    traceId: "run-2",
    loopId: "verified-answer",
    loopVersion: "0.1.0",
    stepId: "grade",
    attempt: 1,
    iteration: 1,
    inputs: { rubric: "be right", answer: "an answer" },
    prompt: "Grade the answer against the rubric.",
    outputSchema: verdictSchema,
    effects: noEffects(),
    runDir: mkdtempSync(join(tmpdir(), "vernier-judge-run-")),
    timeoutMs: 60_000,
    ...overrides,
  }
}

const workdir = (): string => mkdtempSync(join(tmpdir(), "vernier-judge-work-"))

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

const verdict = { passed: false, feedback: "mention the year", missing: ["states the year 1969"] }
const canned: AgentResult = {
  text: "verdict rendered",
  structured: verdict,
  status: "completed",
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
}

describe("JudgeExecutor", () => {
  it("maps the provider's structured verdict onto StepResult.output", async () => {
    const { worker } = recordingWorker(canned)
    const result = await new JudgeExecutor({ worker }).run(spec(), { workdir: workdir() })
    expect(result.status).toBe("completed")
    expect(result.output).toEqual(verdict)
    expect(result.usage.inputTokens).toBe(10)
  })

  it("defaults the backing provider to codex — a default, not a privilege", async () => {
    const { worker, seen } = recordingWorker(canned)
    const judge = new JudgeExecutor({ worker })
    expect(judge.provider).toBe("codex")
    await judge.run(spec(), { workdir: workdir() })
    expect(seen[0]!.provider).toBe("codex")
  })

  it("the backing provider is a constructor binding: any worker fills the judge role", async () => {
    // A fake claude-backed worker — the seam the fungibility rule rides on.
    const seen: AgentSpec[] = []
    const claudeBacked: Worker = {
      id: "claude-code",
      async runAgent(s: AgentSpec, _ctx: WorkerContext) {
        seen.push(s)
        return canned
      },
      async shutdown() {},
    }
    const judge = new JudgeExecutor({ worker: claudeBacked })
    // The injected worker's identity wins; doctor probes THIS provider's binary.
    expect(judge.provider).toBe("claude-code")
    const result = await judge.run(spec(), { workdir: workdir() })
    expect(result.output).toEqual(verdict)
    expect(seen[0]).toMatchObject({ provider: "claude-code", sandbox: "read-only", approval: "never" })
  })

  it("constructs a claude-backed default worker from the provider id alone (construction never spawns)", () => {
    const judge = new JudgeExecutor({ id: "distill", provider: "claude-code" })
    expect(judge.id).toBe("distill")
    expect(judge.provider).toBe("claude-code")
  })

  it("pins the sandbox to read-only regardless of the step's effect scope — a judge never writes", async () => {
    const { worker, seen } = recordingWorker(canned)
    await new JudgeExecutor({ worker }).run(spec({ effects: fsScope("anything/**") }), { workdir: workdir() })
    expect(seen[0]!.sandbox).toBe("read-only")
    expect(seen[0]!.approval).toBe("never")
  })

  it("hands the engine-derived outputSchema to the provider unchanged", async () => {
    const { worker, seen } = recordingWorker(canned)
    await new JudgeExecutor({ worker }).run(spec(), { workdir: workdir() })
    expect(seen[0]!.schema).toEqual(verdictSchema)
  })

  it("refuses to run without an outputSchema (the verdict must be structured)", async () => {
    const { worker } = recordingWorker(canned)
    const promptless = { ...spec() } as Record<string, unknown>
    delete promptless.outputSchema
    await expect(new JudgeExecutor({ worker }).run(promptless as unknown as StepSpec, { workdir: workdir() })).rejects.toThrow(
      /structuredOutput: true/,
    )
  })

  it("refuses to run without a rendered prompt", async () => {
    const { worker } = recordingWorker(canned)
    const promptless = { ...spec() } as Record<string, unknown>
    delete promptless.prompt
    await expect(new JudgeExecutor({ worker }).run(promptless as unknown as StepSpec, { workdir: workdir() })).rejects.toThrow(
      /without a rendered prompt/,
    )
  })

  it("writes judge evidence (prompt, events, verdict) under runDir, never the workdir", async () => {
    const { worker } = recordingWorker(canned)
    const s = spec()
    const result = await new JudgeExecutor({ worker }).run(s, { workdir: workdir() })
    expect(result.evidence.map((e) => e.role)).toEqual(["judge-prompt", "judge-events", "judge-verdict"])
    for (const ref of result.evidence) {
      expect(ref.path.startsWith(s.runDir)).toBe(true)
      expect(existsSync(ref.path)).toBe(true)
    }
    expect(JSON.parse(readFileSync(join(s.runDir, "grade-judge-verdict.json"), "utf8"))).toEqual(verdict)
  })

  it("prefixes evidence by iteration so loop-back passes never overwrite earlier verdicts", async () => {
    const { worker } = recordingWorker(canned)
    const s = spec({ iteration: 2 })
    await new JudgeExecutor({ worker }).run(s, { workdir: workdir() })
    expect(existsSync(join(s.runDir, "iter-2-grade-judge-verdict.json"))).toBe(true)
  })

  it("fails the step when the provider returns no structured verdict despite the schema", async () => {
    const { worker } = recordingWorker({ text: "just prose", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const result = await new JudgeExecutor({ worker }).run(spec(), { workdir: workdir() })
    expect(result.status).toBe("failed")
    expect(String(result.output.error)).toContain("no structured verdict")
  })

  it("maps AgentError onto a failed StepResult carrying code, retryability, and billed usage", async () => {
    const failing: Worker = {
      id: "codex",
      async runAgent() {
        throw new AgentError({ provider: "codex", code: "turn_failed", message: "judge turn failed", retryable: true, usage: { inputTokens: 7, outputTokens: 0, costUsd: 0 } })
      },
      async shutdown() {},
    }
    const result = await new JudgeExecutor({ worker: failing }).run(spec(), { workdir: workdir() })
    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "turn_failed", retryable: true })
    expect(result.usage.inputTokens).toBe(7)
  })
})

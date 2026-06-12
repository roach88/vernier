// ClaudeExecutor + ClaudeCliWorker against scripted workers and scripted
// spawns only — the `claude` CLI is never executed here, so this suite is
// deterministic and auth-free. The live path is gated in claude.live.test.ts.

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { ClaudeCliWorker, ClaudeExecutor, CLAUDE_READONLY_TOOLS, usageFromResult } from "../src/executors/claude.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext, type WorkerProgress } from "../src/executors/vendor/omegacode/index.js"
import type { AgentResult, AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import type { SpawnProcess } from "../src/executors/vendor/omegacode/subprocess-jsonl.js"
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

// ---------------------------------------------------------------- executor

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

  it("fails actionably (not crashes) when the claude binary is missing from PATH", async () => {
    const worker = new ClaudeCliWorker({
      spawnProcess: () => {
        throw new Error("spawn claude ENOENT")
      },
    })
    const s = spec()
    const result = await new ClaudeExecutor({ worker }).run(s, { workdir: workdir() })

    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "binary_not_found", retryable: false })
    expect(String(result.output.error)).toContain("on PATH")
    expect(readFileSync(join(s.runDir, "claude-final.md"), "utf8")).toContain("claude")
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

  it("declares native skill delivery and synthesizes the session plugin under runDir: manifest, byte-equal copy, worker pluginDirs, evidence", async () => {
    const { worker, seen } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const executor = new ClaudeExecutor({ worker })
    expect(executor.skillDelivery).toBe("native")

    const skillDir = join(import.meta.dirname, "fixtures", "skills-cli", "skills", "greeting-style")
    const s = spec({
      skills: [
        {
          name: "greeting-style",
          description: "House greeting style.",
          dir: skillDir,
          file: join(skillDir, "SKILL.md"),
        },
      ],
    })
    const result = await executor.run(s, { workdir: workdir() })

    const pluginDir = join(s.runDir, "skills-plugin")
    expect(seen[0]!.pluginDirs).toEqual([pluginDir])
    const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as { name: string }
    expect(manifest.name).toBe("vernier-skills")
    expect(readFileSync(join(pluginDir, "skills", "greeting-style", "SKILL.md"), "utf8")).toBe(
      readFileSync(join(skillDir, "SKILL.md"), "utf8"),
    )
    expect(result.evidence.map((e) => e.role)).toContain("skills-plugin")
  })

  it("a spec without skills synthesizes no plugin and hands the worker no pluginDirs", async () => {
    const { worker, seen } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const s = spec()
    const result = await new ClaudeExecutor({ worker }).run(s, { workdir: workdir() })
    expect(seen[0]!.pluginDirs).toBeUndefined()
    expect(existsSync(join(s.runDir, "skills-plugin"))).toBe(false)
    expect(result.evidence.map((e) => e.role)).not.toContain("skills-plugin")
  })

  it("a SYMLINKED skill dir (the .claude/skills marketplace install shape) is resolved and copied as a real tree, not a bare link", async () => {
    const { worker, seen } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    // The real skill lives in a "cache"; ~/.claude/skills/<name> would be a link to it.
    const cache = mkdtempSync(join(tmpdir(), "vernier-skill-cache-"))
    const real = join(cache, "aliased-skill")
    mkdirSync(join(real, "scripts"), { recursive: true })
    writeFileSync(join(real, "SKILL.md"), "---\nname: aliased-skill\ndescription: Installed via symlink. Use when testing.\n---\n\nbody\n", "utf8")
    writeFileSync(join(real, "scripts", "run.sh"), "echo hi\n", "utf8")
    const linkParent = mkdtempSync(join(tmpdir(), "vernier-skill-links-"))
    const alias = join(linkParent, "aliased-skill")
    symlinkSync(real, alias)

    const s = spec({ skills: [{ name: "aliased-skill", description: "x", dir: alias, file: join(alias, "SKILL.md") }] })
    const result = await new ClaudeExecutor({ worker }).run(s, { workdir: workdir() })

    expect(result.status).toBe("completed")
    expect(seen).toHaveLength(1)
    const copied = join(s.runDir, "skills-plugin", "skills", "aliased-skill")
    // The copy is a REAL directory tree — a snapshot — not a symlink back to mutable source.
    expect(lstatSync(copied).isSymbolicLink()).toBe(false)
    expect(lstatSync(copied).isDirectory()).toBe(true)
    expect(lstatSync(join(copied, "SKILL.md")).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(copied, "scripts", "run.sh"), "utf8")).toBe("echo hi\n")
  })

  it("refuses a skill whose dir escapes via symlink: failed result, no plugin, and the out-of-tree secret never lands under runDir", async () => {
    const { worker, seen } = recordingWorker({ text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    const root = mkdtempSync(join(tmpdir(), "vernier-evil-skill-"))
    const secretDir = mkdtempSync(join(tmpdir(), "vernier-secret-"))
    writeFileSync(join(secretDir, "id_rsa"), "TOPSECRET-KEY-MATERIAL", "utf8")
    const evil = join(root, "evil")
    mkdirSync(evil, { recursive: true })
    writeFileSync(join(evil, "SKILL.md"), "---\nname: evil\ndescription: A hostile skill. Use never.\n---\n\nbody\n", "utf8")
    symlinkSync(join(secretDir, "id_rsa"), join(evil, "leak")) // escapes the skill dir

    const s = spec({ skills: [{ name: "evil", description: "x", dir: evil, file: join(evil, "SKILL.md") }] })
    const result = await new ClaudeExecutor({ worker }).run(s, { workdir: workdir() })

    expect(result.status).toBe("failed")
    expect(result.output).toMatchObject({ code: "skills_delivery_failed" })
    expect(String(result.output.error)).toContain("contains a symlink")
    expect(seen).toHaveLength(0) // the worker was never invoked — no paid turn on a hostile skill
    // Containment is checked before any copy, so no plugin dir exists and the
    // secret's bytes were never materialized under the run dir.
    expect(existsSync(join(s.runDir, "skills-plugin"))).toBe(false)
  })
})

// ------------------------------------------------------------- CLI worker

interface SpawnCall {
  bin: string
  args: string[]
  opts: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined }
  stdin: string
}

interface Script {
  stdout?: readonly unknown[]
  stderr?: string
  code?: number | null
  error?: Error
  keepOpen?: boolean
}

function scriptedSpawn(...scripts: Script[]): { spawnProcess: SpawnProcess; calls: SpawnCall[] } {
  const pending = [...scripts]
  const calls: SpawnCall[] = []
  const spawnProcess: SpawnProcess = (bin, args, opts) => {
    const script = pending.shift() ?? {}
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    const call: SpawnCall = { bin, args, opts, stdin: "" }
    calls.push(call)
    stdin.on("data", (chunk: Buffer | string) => {
      call.stdin += chunk.toString()
    })
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      kill() {
        return true
      },
    })
    queueMicrotask(() => {
      if (script.error) {
        child.emit("error", script.error)
        return
      }
      if (script.keepOpen) return
      if (script.stderr) stderr.write(script.stderr)
      for (const line of script.stdout ?? []) stdout.write((typeof line === "string" ? line : JSON.stringify(line)) + "\n")
      stdout.end()
      stderr.end()
      const code = script.code ?? 0
      child.emit("exit", code, null)
      child.emit("close", code, null)
    })
    return child
  }
  return { spawnProcess, calls }
}

const VERSION_OK = "2.1.173 (Claude Code)"

function agentSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "Tell me about this repo.",
    provider: "claude-code",
    cwd: mkdtempSync(join(tmpdir(), "vernier-claude-worker-")),
    sandbox: "read-only",
    approval: "never",
    ...overrides,
  }
}

function context() {
  const progress: WorkerProgress[] = []
  return {
    progress,
    ctx: { signal: new AbortController().signal, onProgress: (e: WorkerProgress) => progress.push(e) },
  }
}

const success = (over: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Done.",
  total_cost_usd: 0.05,
  usage: { input_tokens: 10, cache_creation_input_tokens: 4, cache_read_input_tokens: 2, output_tokens: 7 },
  ...over,
})

describe("ClaudeCliWorker", () => {
  it("preflights --version, then runs print-mode stream-json with the prompt on stdin", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ stdout: [VERSION_OK] }, { stdout: [success()] })
    const { ctx } = context()
    const result = await new ClaudeCliWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(agentSpec(), ctx)

    expect(result).toMatchObject({ status: "completed", text: "Done." })
    // Cache reads/creation fold into input tokens; cost is AS REPORTED.
    expect(result.usage).toEqual({ inputTokens: 16, outputTokens: 7, costUsd: 0.05 })
    expect(calls.map((c) => c.bin)).toEqual(["claude", "claude"])
    expect(calls[0]!.args).toEqual(["--version"])
    const args = calls[1]!.args
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"])
    expect(args).toContain("--no-session-persistence")
    // Hermetic: user/project permission allowlists never widen the posture.
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("")
    expect(calls[1]!.stdin).toBe("Tell me about this repo.")
    expect(calls[1]!.opts.env?.DISABLE_AUTOUPDATER).toBe("1")
  })

  it("read-only sandbox: inspection toolset only, permission asks auto-denied, never a bypass flag", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ stdout: [VERSION_OK] }, { stdout: [success()] })
    await new ClaudeCliWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(agentSpec(), context().ctx)

    const args = calls[1]!.args
    expect(args[args.indexOf("--tools") + 1]).toBe(CLAUDE_READONLY_TOOLS)
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk")
    expect(args).not.toContain("--dangerously-skip-permissions")
    expect(args).not.toContain("bypassPermissions")
  })

  it("workspace-write sandbox: acceptEdits (workspace-confined edits), full toolset, still no bypass", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ stdout: [VERSION_OK] }, { stdout: [success()] })
    await new ClaudeCliWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(agentSpec({ sandbox: "workspace-write" }), context().ctx)

    const args = calls[1]!.args
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits")
    expect(args).not.toContain("--tools")
    expect(args).not.toContain("--dangerously-skip-permissions")
    expect(args).not.toContain("bypassPermissions")
  })

  it("maps AgentSpec.pluginDirs onto repeatable --plugin-dir flags, with the hermetic posture intact", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ stdout: [VERSION_OK] }, { stdout: [success()] })
    await new ClaudeCliWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(
      agentSpec({ pluginDirs: ["/run/dir/skills-plugin", "/run/dir/other-plugin"] }),
      context().ctx,
    )
    const args = calls[1]!.args
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe("/run/dir/skills-plugin")
    expect(args[args.lastIndexOf("--plugin-dir") + 1]).toBe("/run/dir/other-plugin")
    // The skills channel must not loosen anything: still hermetic, still no bypass.
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("")
    expect(args).toContain("--no-session-persistence")
    expect(args).not.toContain("--dangerously-skip-permissions")
  })

  it("passes no --plugin-dir when the spec carries no pluginDirs", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ stdout: [VERSION_OK] }, { stdout: [success()] })
    await new ClaudeCliWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(agentSpec(), context().ctx)
    expect(calls[1]!.args).not.toContain("--plugin-dir")
  })

  it("refuses danger-full-access pre-spawn — permission-bypass flags are never passed", async () => {
    const { spawnProcess, calls } = scriptedSpawn()
    await expect(
      new ClaudeCliWorker({ spawnProcess }).runAgent(agentSpec({ sandbox: "danger-full-access" }), context().ctx),
    ).rejects.toMatchObject({ code: "unsupported_option" })
    expect(calls).toHaveLength(0) // nothing spawned, not even the preflight
  })

  it("refuses maxTurns pre-spawn (claude 2.x print mode has no turn cap to honor)", async () => {
    const { spawnProcess } = scriptedSpawn()
    await expect(new ClaudeCliWorker({ spawnProcess }).runAgent(agentSpec({ maxTurns: 3 }), context().ctx)).rejects.toMatchObject({
      code: "unsupported_option",
    })
  })

  it("forwards assistant text/thinking/tool blocks and tool results as normalized progress", async () => {
    const { spawnProcess, calls } = scriptedSpawn(
      { stdout: [VERSION_OK] },
      {
        stdout: [
          { type: "system", subtype: "init", session_id: "s1" },
          {
            type: "assistant",
            message: {
              content: [
                { type: "thinking", thinking: "plan it" },
                { type: "text", text: "Working..." },
                { type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } },
              ],
            },
          },
          { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] } },
          success(),
        ],
      },
    )
    const { ctx, progress } = context()
    const result = await new ClaudeCliWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(agentSpec({ model: "claude-test" }), ctx)

    expect(result.text).toBe("Done.")
    expect(progress).toEqual([
      { kind: "reasoning", text: "plan it" },
      { kind: "text", text: "Working..." },
      { kind: "tool", id: "t1", name: "Read", input: { file_path: "README.md" } },
      { kind: "tool-result", id: "t1", output: "ok", isError: false },
    ])
    const args = calls[1]!.args
    expect(args[args.indexOf("--model") + 1]).toBe("claude-test")
  })

  it("passes the schema through --json-schema and returns the CLI's structured_output verbatim", async () => {
    const schema = { type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"] }
    const { spawnProcess, calls } = scriptedSpawn(
      { stdout: [VERSION_OK] },
      { stdout: [success({ result: "verdict rendered", structured_output: { passed: true } })] },
    )
    const result = await new ClaudeCliWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(agentSpec({ schema }), context().ctx)

    expect(result.structured).toEqual({ passed: true })
    const args = calls[1]!.args
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual(schema)
  })

  it("rejects an uncompilable schema before the paid turn", async () => {
    const { spawnProcess, calls } = scriptedSpawn()
    await expect(
      new ClaudeCliWorker({ spawnProcess }).runAgent(agentSpec({ schema: { type: "not-a-type" } }), context().ctx),
    ).rejects.toMatchObject({ code: "invalid_schema" })
    expect(calls).toHaveLength(0)
  })

  it("maps a non-success result subtype onto AgentError, carrying code + billed usage", async () => {
    const { spawnProcess } = scriptedSpawn(
      { stdout: [VERSION_OK] },
      {
        stdout: [success({ subtype: "error_max_turns", is_error: true, result: "" })],
        code: 1,
      },
    )
    await expect(new ClaudeCliWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(agentSpec(), context().ctx)).rejects.toMatchObject({
      code: "error_max_turns",
      retryable: false,
      usage: { inputTokens: 16, outputTokens: 7, costUsd: 0.05 },
    })
  })

  it("normalizes spawn failures, outdated versions, provider exits, and missing results", async () => {
    await expect(
      new ClaudeCliWorker({
        spawnProcess: () => {
          throw new Error("spawn claude ENOENT")
        },
      }).runAgent(agentSpec(), context().ctx),
    ).rejects.toMatchObject({ code: "binary_not_found", retryable: false })

    const outdated = scriptedSpawn({ stdout: ["1.0.130 (Claude Code)"] })
    await expect(new ClaudeCliWorker({ spawnProcess: outdated.spawnProcess }).runAgent(agentSpec(), context().ctx)).rejects.toMatchObject({
      code: "provider_outdated",
      retryable: false,
    })

    const exited = scriptedSpawn({ stdout: [VERSION_OK] }, { stderr: "bad flag", code: 2 })
    await expect(new ClaudeCliWorker({ spawnProcess: exited.spawnProcess, stallTimeoutMs: 0 }).runAgent(agentSpec(), context().ctx)).rejects.toMatchObject({
      code: "provider_exit",
    })

    const silent = scriptedSpawn({ stdout: [VERSION_OK] }, { stdout: [] })
    await expect(new ClaudeCliWorker({ spawnProcess: silent.spawnProcess, stallTimeoutMs: 0 }).runAgent(agentSpec(), context().ctx)).rejects.toMatchObject({
      code: "no_result",
    })
  })

  it("throws AgentInterrupted when the signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(new ClaudeCliWorker().runAgent(agentSpec(), { signal: ac.signal, onProgress() {} })).rejects.toBeInstanceOf(AgentInterrupted)
  })

  it("usageFromResult bills cache reads/creation as input tokens and passes cost through as reported", () => {
    expect(
      usageFromResult({
        usage: { input_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 20, output_tokens: 9 },
        total_cost_usd: 1.25,
      }),
    ).toEqual({ inputTokens: 150, outputTokens: 9, costUsd: 1.25 })
    expect(usageFromResult({})).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
  })
})

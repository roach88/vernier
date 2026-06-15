import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/executors/vendor/omegacode/index.js"
import { resolveCursorBin } from "../src/executors/cursor-bin.js"
import { CursorWorker, cursorEnv } from "../src/executors/vendor/omegacode/cursor.js"
import type { AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import type { SpawnProcess } from "../src/executors/vendor/omegacode/subprocess-jsonl.js"

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
  signal?: NodeJS.Signals | null
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
      const signal = script.signal ?? null
      child.emit("exit", code, signal)
      child.emit("close", code, signal)
    })
    return child
  }
  return { spawnProcess, calls }
}

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "Tell me about this repo.",
    provider: "cursor-agent",
    cwd: mkdtempSync(join(tmpdir(), "vernier-cursor-worker-")),
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

describe("CursorWorker", () => {
  it("runs cursor-agent in stream-json print mode and returns terminal result text", async () => {
    const { spawnProcess, calls } = scriptedSpawn({
      stdout: [
        { type: "assistant", message: { content: [{ type: "text", text: "Working..." }] } },
        { type: "result", result: "Done.", is_error: false },
      ],
    })
    const { ctx, progress } = context()
    const result = await new CursorWorker({ spawnProcess, stallTimeoutMs: 0, env: { PATH: "" } }).runAgent(spec(), ctx)

    expect(result).toMatchObject({ status: "completed", text: "Done." })
    expect(progress).toEqual([{ kind: "text", text: "Working..." }])
    expect(calls[0]!.bin).toBe("agent")
    expect(calls[0]!.args.slice(0, 7)).toEqual(["-p", "--output-format", "stream-json", "--stream-partial-output", "--mode=ask", "--sandbox", "enabled"])
    expect(calls[0]!.args).not.toContain("--force")
    expect(calls[0]!.args.at(-1)).toBe("Tell me about this repo.")
    expect(calls[0]!.opts.env?.CURSOR_CONFIG_DIR).toContain("omegacode-cursor-config-")
  })

  it("runs workspace-write turns in Cursor agent mode with sandbox enabled", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ stdout: [{ type: "result", result: "Done.", is_error: false }] })
    const { ctx } = context()
    const result = await new CursorWorker({ spawnProcess, stallTimeoutMs: 0, env: { PATH: "" } }).runAgent(spec({ sandbox: "workspace-write" }), ctx)

    expect(result).toMatchObject({ status: "completed", text: "Done." })
    expect(calls[0]!.args).toContain("--mode=agent")
    expect(calls[0]!.args).toContain("--sandbox")
    expect(calls[0]!.args).toContain("enabled")
    expect(calls[0]!.args).toContain("--force")
  })

  it("forwards tool call and result events as normalized progress", async () => {
    const { spawnProcess } = scriptedSpawn({
      stdout: [
        { type: "tool_call", tool_call: { id: "t1", name: "read_file", input: { path: "README.md" } } },
        { type: "tool_result", tool_call_id: "t1", name: "read_file", output: "ok" },
        { type: "result", result: "Done.", is_error: false },
      ],
    })
    const { ctx, progress } = context()
    await new CursorWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(spec(), ctx)

    expect(progress).toEqual([
      { kind: "tool", id: "t1", name: "read_file", input: { path: "README.md" } },
      { kind: "tool-result", id: "t1", name: "read_file", output: "ok", isError: false },
    ])
  })

  it("uses a read-only extraction turn, validates structured output, and returns structured", async () => {
    const { spawnProcess, calls } = scriptedSpawn(
      { stdout: [{ type: "result", result: "The answer is yes.", is_error: false }] },
      { stdout: [{ type: "result", result: JSON.stringify({ passed: true }), is_error: false }] },
    )
    const { ctx } = context()
    const result = await new CursorWorker({ spawnProcess, stallTimeoutMs: 0, env: { PATH: "" } }).runAgent(
      spec({
        sandbox: "workspace-write",
        schema: {
          type: "object",
          properties: { passed: { type: "boolean" } },
          required: ["passed"],
          additionalProperties: false,
        },
      }),
      ctx,
    )

    expect(result.structured).toEqual({ passed: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.args).toContain("--force")
    expect(calls[0]!.args).toContain("--mode=agent")
    expect(calls[1]!.args).not.toContain("--force")
    expect(calls[1]!.args).toContain("--mode=ask")
    expect(calls[1]!.args).toContain("--sandbox")
    expect(calls[1]!.args).toContain("enabled")
    expect(calls[1]!.args.at(-1)).toContain("Output ONLY the JSON")
  })

  it("keeps read-only structured output in Ask mode for both turns", async () => {
    const { spawnProcess, calls } = scriptedSpawn(
      { stdout: [{ type: "result", result: "The answer is yes.", is_error: false }] },
      { stdout: [{ type: "result", result: JSON.stringify({ passed: true }), is_error: false }] },
    )
    const { ctx } = context()
    const result = await new CursorWorker({ spawnProcess, stallTimeoutMs: 0, env: { PATH: "" } }).runAgent(
      spec({
        sandbox: "read-only",
        schema: {
          type: "object",
          properties: { passed: { type: "boolean" } },
          required: ["passed"],
          additionalProperties: false,
        },
      }),
      ctx,
    )

    expect(result.structured).toEqual({ passed: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.args).toContain("--mode=ask")
    expect(calls[0]!.args).not.toContain("--force")
    expect(calls[1]!.args).toContain("--mode=ask")
    expect(calls[1]!.args).not.toContain("--force")
  })

  it("rejects invalid structured extraction before returning AgentResult.structured", async () => {
    const { spawnProcess } = scriptedSpawn(
      { stdout: [{ type: "result", result: "The answer is yes.", is_error: false }] },
      { stdout: [{ type: "result", result: JSON.stringify({ passed: "yes" }), is_error: false }] },
    )
    const { ctx } = context()
    await expect(
      new CursorWorker({ spawnProcess, stallTimeoutMs: 0 }).runAgent(
        spec({
          schema: {
            type: "object",
            properties: { passed: { type: "boolean" } },
            required: ["passed"],
          },
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid_structured_output" })
  })

  it("keeps binary selection explicit and builds a small env allowlist", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ stdout: [{ type: "result", result: "ok", is_error: false }] })
    const configDir = mkdtempSync(join(tmpdir(), "vernier-cursor-config-"))
    const { ctx } = context()
    await new CursorWorker({
      bin: "cursor-agent",
      spawnProcess,
      stallTimeoutMs: 0,
      configDir,
      env: {
        PATH: "/safe/bin",
        CURSOR_API_KEY: "secret",
        CURSOR_AGENT_BIN: "evil",
        LD_PRELOAD: "evil",
      },
    }).runAgent(spec(), ctx)

    expect(calls[0]!.bin).toBe("cursor-agent")
    expect(calls[0]!.opts.env).toMatchObject({ PATH: "/safe/bin", CURSOR_API_KEY: "secret", CURSOR_CONFIG_DIR: configDir })
    expect(calls[0]!.opts.env).not.toHaveProperty("CURSOR_AGENT_BIN")
    expect(calls[0]!.opts.env).not.toHaveProperty("LD_PRELOAD")
    expect(cursorEnv({ CURSOR_AGENT_BIN: "evil" })).not.toHaveProperty("CURSOR_AGENT_BIN")
  })

  it("normalizes spawn failures, provider exits, aborted signals, and stalls", async () => {
    const enoent = new Error("spawn cursor-agent ENOENT")
    await expect(
      new CursorWorker({ spawnProcess: () => {
        throw enoent
      } }).runAgent(spec(), context().ctx),
    ).rejects.toMatchObject({ code: "binary_not_found", retryable: false })

    const exited = scriptedSpawn({ stderr: "bad flag", code: 2 })
    await expect(new CursorWorker({ spawnProcess: exited.spawnProcess, stallTimeoutMs: 0 }).runAgent(spec(), context().ctx)).rejects.toMatchObject({
      code: "provider_exit",
    })

    const ac = new AbortController()
    ac.abort()
    await expect(new CursorWorker().runAgent(spec(), { signal: ac.signal, onProgress() {} })).rejects.toBeInstanceOf(AgentInterrupted)

    const stalled = scriptedSpawn({ keepOpen: true })
    await expect(new CursorWorker({ spawnProcess: stalled.spawnProcess, stallTimeoutMs: 5 }).runAgent(spec(), context().ctx)).rejects.toMatchObject({
      code: "turn_stalled",
      retryable: true,
    })
  })

  it("resolves Cursor binaries through env and PATH fallback", () => {
    expect(resolveCursorBin({ env: {}, which: (bin) => (bin === "agent" ? "/bin/agent" : undefined) })).toMatchObject({
      ok: true,
      bin: "/bin/agent",
      requires: "agent",
    })
    expect(resolveCursorBin({ env: {}, which: (bin) => (bin === "cursor-agent" ? "/bin/cursor-agent" : undefined) })).toMatchObject({
      ok: true,
      bin: "/bin/cursor-agent",
      requires: "cursor-agent",
    })
    expect(
      resolveCursorBin({
        explicitBin: "cursor-agent",
        env: { VERNIER_CURSOR_BIN: "agent" },
        which: (bin) => (bin === "cursor-agent" ? "/bin/cursor-agent" : bin === "agent" ? "/bin/agent" : undefined),
      }),
    ).toMatchObject({
      ok: true,
      bin: "cursor-agent",
      requires: "cursor-agent",
      source: "explicit",
      found: "/bin/cursor-agent",
    })
    expect(resolveCursorBin({ env: { VERNIER_CURSOR_BIN: "custom-cursor" }, which: () => undefined })).toMatchObject({
      ok: false,
      bin: "custom-cursor",
      requires: "custom-cursor",
    })
  })

  it("does not resolve Cursor defaults from relative PATH entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "vernier-cursor-relative-path-"))
    writeFileSync(join(dir, "agent"), "#!/bin/sh\nexit 0\n", "utf8")
    chmodSync(join(dir, "agent"), 0o755)

    expect(resolveCursorBin({ env: { PATH: dir } })).toMatchObject({ ok: true, bin: join(dir, "agent") })
    expect(resolveCursorBin({ env: { PATH: "." } })).toMatchObject({ ok: false, requires: "agent" })
  })

  it("rejects danger-full-access inside the worker as a second safety check", async () => {
    const { spawnProcess } = scriptedSpawn({ stdout: [{ type: "result", result: "ok", is_error: false }] })
    await expect(new CursorWorker({ spawnProcess }).runAgent(spec({ sandbox: "danger-full-access" }), context().ctx)).rejects.toBeInstanceOf(AgentError)
  })
})

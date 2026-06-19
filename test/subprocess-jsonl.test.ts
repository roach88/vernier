import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { AgentError, AgentInterrupted } from "../src/executors/vendor/omegacode/index.js"
import { runJsonlSubprocess, type SpawnProcess } from "../src/executors/vendor/omegacode/subprocess-jsonl.js"

interface SpawnedCall {
  readonly bin: string
  readonly args: string[]
  readonly opts: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined }
  stdin: string
  kills: NodeJS.Signals[]
}

interface Script {
  readonly stdout?: readonly string[]
  readonly stderr?: readonly string[]
  readonly code?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly error?: Error
  readonly keepOpen?: boolean
}

function scriptedSpawn(...scripts: Script[]): { spawnProcess: SpawnProcess; calls: SpawnedCall[] } {
  const pending = [...scripts]
  const calls: SpawnedCall[] = []
  const spawnProcess: SpawnProcess = (bin, args, opts) => {
    const script = pending.shift() ?? {}
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    const call: SpawnedCall = { bin, args, opts, stdin: "", kills: [] }
    calls.push(call)

    stdin.on("data", (chunk: Buffer | string) => {
      call.stdin += chunk.toString()
    })

    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      kill(signal: NodeJS.Signals = "SIGTERM") {
        call.kills.push(signal)
        if (script.keepOpen) {
          queueMicrotask(() => {
            stdout.end()
            stderr.end()
            child.emit("exit", null, signal)
            child.emit("close", null, signal)
          })
        }
        return true
      },
    })

    queueMicrotask(() => {
      if (script.error) {
        child.emit("error", script.error)
        return
      }
      if (script.keepOpen) return
      for (const chunk of script.stderr ?? []) stderr.write(chunk)
      for (const chunk of script.stdout ?? []) stdout.write(chunk)
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

function run(overrides: Partial<Parameters<typeof runJsonlSubprocess>[0]> = {}) {
  const values: unknown[] = []
  const textLines: string[] = []
  const ac = new AbortController()
  const promise = runJsonlSubprocess({
    provider: "opencode",
    bin: "fake-agent",
    args: ["run"],
    signal: ac.signal,
    onValue: (value) => values.push(value),
    onTextLine: (line) => textLines.push(line),
    stallTimeoutMs: 0,
    killGraceMs: 1,
    ...overrides,
  })
  return { promise, values, textLines, ac }
}

describe("runJsonlSubprocess", () => {
  it("parses strict LF-framed JSON values and routes non-JSON stdout to diagnostics", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ stdout: ['{"type":"progress"}\nplain diagnostic\n', '{"type":"done"}\n'] })
    const { promise, values, textLines } = run({ spawnProcess, stdin: "prompt" })

    await expect(promise).resolves.toMatchObject({ code: 0, signal: null })
    expect(values).toEqual([{ type: "progress" }, { type: "done" }])
    expect(textLines).toEqual(["plain diagnostic"])
    expect(calls[0]).toMatchObject({ bin: "fake-agent", args: ["run"], stdin: "prompt" })
  })

  it("fails loudly when the worker's JSON value handler rejects a malformed provider event", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ stdout: ['{"type":"progress"}\n', '{"type":"bad"}\n', '{"type":"late"}\n'] })
    const seen: string[] = []
    const ac = new AbortController()
    const promise = runJsonlSubprocess({
      provider: "opencode",
      bin: "fake-agent",
      args: [],
      signal: ac.signal,
      onValue(value) {
        const type = (value as { type?: string }).type ?? "unknown"
        seen.push(type)
        if (type === "bad") throw new Error("bad provider event")
      },
      stallTimeoutMs: 0,
      killGraceMs: 1,
      spawnProcess,
    })

    await expect(promise).rejects.toThrow(/bad provider event/)
    expect(seen).toEqual(["progress", "bad"])
    expect(calls[0]?.kills).toEqual(["SIGTERM"])
  })

  it("bounds stderr to the configured diagnostic tail", async () => {
    const { spawnProcess } = scriptedSpawn({ stderr: ["0123456789abcdef"], code: 7 })
    const { promise } = run({ spawnProcess, stderrLimit: 6 })

    await expect(promise).resolves.toMatchObject({ code: 7, stderrTail: "abcdef" })
  })

  it("rejects on stdout stall with a retryable AgentError and aborts the child", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ keepOpen: true })
    const { promise } = run({ spawnProcess, stallTimeoutMs: 5, killGraceMs: 1 })

    await expect(promise).rejects.toMatchObject({ code: "turn_stalled", retryable: true })
    expect(calls[0]?.kills).toContain("SIGTERM")
  })

  it("maps caller abort to AgentInterrupted and settles once even if close follows", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ keepOpen: true })
    const { promise, ac } = run({ spawnProcess, stallTimeoutMs: 0, killGraceMs: 1 })

    ac.abort()

    await expect(promise).rejects.toBeInstanceOf(AgentInterrupted)
    expect(calls[0]?.kills).toEqual(["SIGTERM"])
  })

  it("normalizes spawn failures into AgentError codes", async () => {
    const { spawnProcess } = scriptedSpawn({ error: new Error("ENOENT: fake-agent not found") })
    const { promise } = run({ spawnProcess })

    await expect(promise).rejects.toMatchObject({ code: "binary_not_found", retryable: false })
    await expect(promise).rejects.toBeInstanceOf(AgentError)
  })
})

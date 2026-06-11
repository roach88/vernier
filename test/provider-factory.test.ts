import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { DefaultWorkerFactory } from "../src/executors/vendor/omegacode/factory.js"
import { PROVIDER_IDS, type AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import type { SpawnProcess } from "../src/executors/vendor/omegacode/subprocess-jsonl.js"

interface SpawnCall {
  bin: string
  args: string[]
  opts: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined }
}

/** Each spawned subprocess emits the NEXT script in order: raw text lines as-is, others as JSONL. */
function scriptedSpawn(...scripts: ReadonlyArray<{ raw?: string; lines?: readonly unknown[] }>): {
  spawnProcess: SpawnProcess
  calls: SpawnCall[]
} {
  const calls: SpawnCall[] = []
  const spawnProcess: SpawnProcess = (bin, args, opts) => {
    const script = scripts[calls.length] ?? {}
    calls.push({ bin, args, opts })
    const stdin = new PassThrough()
    const out = new PassThrough()
    const err = new PassThrough()
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    Object.assign(child, {
      stdin,
      stdout: out,
      stderr: err,
      kill() {
        return true
      },
    })
    queueMicrotask(() => {
      if (script.raw !== undefined) out.write(script.raw)
      for (const line of script.lines ?? []) out.write(JSON.stringify(line) + "\n")
      out.end()
      err.end()
      child.emit("exit", 0, null)
      child.emit("close", 0, null)
    })
    return child
  }
  return { spawnProcess, calls }
}

function agentSpec(provider: AgentSpec["provider"], sandbox: AgentSpec["sandbox"] = "read-only"): AgentSpec {
  return {
    prompt: "hello",
    provider,
    cwd: mkdtempSync(join(tmpdir(), "vernier-provider-factory-")),
    sandbox,
    approval: "never",
  }
}

describe("DefaultWorkerFactory", () => {
  it("includes cursor-agent in the provider id set", () => {
    expect(PROVIDER_IDS).toContain("cursor-agent")
  })

  it("constructs cursor-agent with its explicit provider options", async () => {
    const { spawnProcess, calls } = scriptedSpawn({ lines: [{ type: "result", result: "factory ok", is_error: false }] })
    const configDir = mkdtempSync(join(tmpdir(), "vernier-factory-cursor-config-"))
    const factory = new DefaultWorkerFactory({
      cursorBin: "trusted-cursor",
      cursorConfigDir: configDir,
      cursorSpawnProcess: spawnProcess,
      cursorStallTimeoutMs: 0,
    })

    const result = await factory.get("cursor-agent").runAgent(agentSpec("cursor-agent"), {
      signal: new AbortController().signal,
      onProgress() {},
    })

    expect(result.text).toBe("factory ok")
    expect(calls[0]!.bin).toBe("trusted-cursor")
    expect(calls[0]!.opts.env?.CURSOR_CONFIG_DIR).toBe(configDir)
  })

  it("keeps fake mode working for every provider id", async () => {
    const factory = new DefaultWorkerFactory({ fake: true })
    for (const provider of PROVIDER_IDS) {
      const result = await factory.get(provider).runAgent(agentSpec(provider), {
        signal: new AbortController().signal,
        onProgress() {},
      })
      expect(result.text).toContain(`[fake:${provider}]`)
    }
  })

  it("constructs the real opencode worker: version preflight, then a run turn, on its explicit bin", async () => {
    const { spawnProcess, calls } = scriptedSpawn(
      { raw: "1.16.2\n" }, // --version preflight
      { lines: [{ type: "text", part: { text: "factory ok" } }] },
    )
    const factory = new DefaultWorkerFactory({
      opencodeBin: "trusted-opencode",
      opencodeSpawnProcess: spawnProcess,
      opencodeStallTimeoutMs: 0,
    })

    const result = await factory.get("opencode").runAgent(agentSpec("opencode", "danger-full-access"), {
      signal: new AbortController().signal,
      onProgress() {},
    })

    expect(result.text).toBe("factory ok")
    expect(calls.map((c) => c.bin)).toEqual(["trusted-opencode", "trusted-opencode"])
    expect(calls[0]!.args).toEqual(["--version"])
    expect(calls[1]!.args).toContain("run")
    expect(calls[1]!.args).toContain("--dangerously-skip-permissions")
    expect(calls[1]!.opts.env?.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
  })

  it("constructs the real pi worker: isolated version preflight, then a run turn, on its explicit bin", async () => {
    const { spawnProcess, calls } = scriptedSpawn(
      { raw: "0.79.1\n" }, // --version preflight (scratch agent dir, neutral cwd)
      {
        lines: [
          {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "factory ok" }], usage: { input: 1, output: 2 } },
          },
        ],
      },
    )
    const factory = new DefaultWorkerFactory({
      piBin: "trusted-pi",
      piSpawnProcess: spawnProcess,
      piStallTimeoutMs: 0,
    })

    const spec = agentSpec("pi", "danger-full-access")
    const result = await factory.get("pi").runAgent(spec, {
      signal: new AbortController().signal,
      onProgress() {},
    })

    expect(result.text).toBe("factory ok")
    expect(calls.map((c) => c.bin)).toEqual(["trusted-pi", "trusted-pi"])
    expect(calls[0]!.args).toEqual(["--version"])
    expect(calls[0]!.opts.env?.PI_CODING_AGENT_DIR).toBeDefined() // scratch agent dir isolates the probe
    expect(calls[0]!.opts.cwd).toBe(tmpdir()) // neutral cwd, never the run's
    expect(calls[1]!.args).toContain("--no-session")
    expect(calls[1]!.opts.cwd).toBe(spec.cwd)
  })

  it("keeps claude-code behind the executor layer (factory stays not-implemented; the SDK must not load here)", async () => {
    const factory = new DefaultWorkerFactory()
    await expect(
      factory.get("claude-code").runAgent(agentSpec("claude-code"), {
        signal: new AbortController().signal,
        onProgress() {},
      }),
    ).rejects.toMatchObject({ code: "not_implemented" })
  })
})

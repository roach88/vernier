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

function scriptedSpawn(stdout: readonly unknown[]): { spawnProcess: SpawnProcess; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawnProcess: SpawnProcess = (bin, args, opts) => {
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
      for (const line of stdout) out.write(JSON.stringify(line) + "\n")
      out.end()
      err.end()
      child.emit("exit", 0, null)
      child.emit("close", 0, null)
    })
    return child
  }
  return { spawnProcess, calls }
}

function agentSpec(provider: AgentSpec["provider"]): AgentSpec {
  return {
    prompt: "hello",
    provider,
    cwd: mkdtempSync(join(tmpdir(), "looper-provider-factory-")),
    sandbox: "read-only",
    approval: "never",
  }
}

describe("DefaultWorkerFactory", () => {
  it("includes cursor-agent in the provider id set", () => {
    expect(PROVIDER_IDS).toContain("cursor-agent")
  })

  it("constructs cursor-agent with its explicit provider options", async () => {
    const { spawnProcess, calls } = scriptedSpawn([{ type: "result", result: "factory ok", is_error: false }])
    const configDir = mkdtempSync(join(tmpdir(), "looper-factory-cursor-config-"))
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

  it("leaves opencode intentionally unwired in this step", async () => {
    const factory = new DefaultWorkerFactory()
    await expect(
      factory.get("opencode").runAgent(agentSpec("opencode"), {
        signal: new AbortController().signal,
        onProgress() {},
      }),
    ).rejects.toMatchObject({ code: "not_implemented" })
  })
})

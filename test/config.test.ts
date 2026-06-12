// Out-of-tree loop registration + executor binding, asserted through the
// REAL CLI surface (spawned process, --json, exit codes), driven by the
// fixture config in test/fixtures/user-config: a user loop module, a user
// executor module, and a vernier.config.json — no vernier source edited.
// Everything here is deterministic; no LLM runs.

import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineConfig, type LoadedConfig } from "../src/cli/config.js"
import { loopRegistry } from "../src/cli/registry.js"
import { JudgeExecutor } from "../src/executors/judge.js"
import type { Loop } from "../src/kernel/types.js"
import { journalPath } from "../src/ledger/ledger.js"

// In-process registry construction below builds runtimes whose Memory mkdirs
// under the vernier root; point it at scratch so the repo is never touched.
// (Spawned CLI calls are unaffected: cli() sets VERNIER_HOME explicitly.)
process.env.VERNIER_HOME = mkdtempSync(join(tmpdir(), "vernier-config-home-"))

const execFileAsync = promisify(execFile)
const BIN = join(import.meta.dirname, "..", "bin", "vernier.js")
const FIXTURE = join(import.meta.dirname, "fixtures", "user-config")
const CONFIG = join(FIXTURE, "vernier.config.json")

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface CliOpts {
  readonly home: string
  /** cwd for config discovery. Default: the fixture dir. */
  readonly cwd?: string
  /** $VERNIER_CONFIG override; unset (and scrubbed from the env) when omitted. */
  readonly config?: string
}

async function cli(opts: CliOpts, ...args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, VERNIER_HOME: opts.home }
  delete env.VERNIER_CONFIG
  if (opts.config !== undefined) env.VERNIER_CONFIG = opts.config
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? FIXTURE,
      env,
      encoding: "utf8",
      timeout: 60_000,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

const home = (): string => mkdtempSync(join(tmpdir(), "vernier-config-"))
const scratch = (): string => mkdtempSync(join(tmpdir(), "vernier-config-scratch-"))

describe("vernier.config: out-of-tree loops and executors", () => {
  it("discovers vernier.config.json from cwd and lists the user loop with its source (the registry IS the config)", async () => {
    const result = await cli({ home: home() }, "loops", "--json")
    expect(result.code).toBe(0)
    const loops = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    expect(loops.map((l) => l.id)).toEqual(["echo-shout"]) // zero builtins: only what the config registers
    const echo = loops.at(-1)!
    expect(echo.version).toBe("0.1.0")
    expect(echo.trust).toBe("dry-run")
    expect(echo.live).toBe(false)
    expect(String(echo.source)).toMatch(/echo-loop\.mjs$/)
  })

  it("runs the user loop end-to-end on its own executor: `vernier run echo-shout`", async () => {
    const root = home()
    const result = await cli({ home: root }, "run", "echo-shout", "--json")
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as Record<string, unknown>
    expect(outcome.status).toBe("done")
    expect(outcome.loopId).toBe("echo-shout")
    expect(outcome.output).toMatchObject({ echoed: "HELLO VERNIER", verdict: "success" })
    expect(existsSync(journalPath(root, String(outcome.runId)))).toBe(true)
  })

  it("$VERNIER_CONFIG overrides discovery (run from an unrelated cwd)", async () => {
    const result = await cli({ home: home(), cwd: scratch(), config: CONFIG }, "run", "echo-shout", "--json")
    expect(result.code).toBe(0)
    expect((JSON.parse(result.stdout) as { output: { echoed: string } }).output.echoed).toBe("HELLO VERNIER")
  })

  it("--executor rebinds a step onto a config-registered executor (CLI layer of the chain)", async () => {
    const result = await cli({ home: home() }, "run", "echo-shout", "--executor", "echo=reverse", "--json")
    expect(result.code).toBe(0)
    expect((JSON.parse(result.stdout) as { output: { echoed: string } }).output.echoed).toBe("reinrev olleh")
  })

  it("config `bindings` rebind too, and --executor beats them (full chain: CLI > config > loop default)", async () => {
    // A second config, written at test time, binding the echo step to the
    // config-level reverse executor; module paths are absolute on purpose.
    const dir = scratch()
    const configPath = join(dir, "vernier.config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        loops: [join(FIXTURE, "echo-loop.mjs")],
        executors: [join(FIXTURE, "reverse-executor.mjs")],
        bindings: { echo: "reverse" },
      }),
      "utf8",
    )

    const viaConfig = await cli({ home: home(), cwd: dir }, "run", "echo-shout", "--json")
    expect(viaConfig.code).toBe(0)
    expect((JSON.parse(viaConfig.stdout) as { output: { echoed: string } }).output.echoed).toBe("reinrev olleh")

    const viaCli = await cli({ home: home(), cwd: dir }, "run", "echo-shout", "--executor", "echo=upper", "--json")
    expect(viaCli.code).toBe(0)
    expect((JSON.parse(viaCli.stdout) as { output: { echoed: string } }).output.echoed).toBe("HELLO VERNIER")
  })

  it("exit 2 with the registered-executor list when a binding targets an unknown executor", async () => {
    const result = await cli({ home: home() }, "run", "echo-shout", "--executor", "echo=nope")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("Unresolved executor binding")
    expect(result.stderr).toContain("Registered executors:")
    expect(result.stderr).toContain("reverse") // the config executor is in the list
  })

  it("exit 2 when an --executor key names no step or executor in the loop (typo guard)", async () => {
    const result = await cli({ home: home() }, "run", "echo-shout", "--executor", "bogus=reverse")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("names no step or executor")
  })

  it("resume finds a config-registered loop again (terminal no-op round trip)", async () => {
    const root = home()
    const ran = await cli({ home: root }, "run", "echo-shout", "--json")
    expect(ran.code).toBe(0)
    const runId = String((JSON.parse(ran.stdout) as { runId: string }).runId)
    const resumed = await cli({ home: root }, "resume", runId, "--json")
    expect(resumed.code).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ runId, status: "done", alreadyTerminal: true })
  })

  it("malformed configs are exit-2 usage errors with the trust reminder, not stack traces", async () => {
    const dir = scratch()
    const bad = join(dir, "vernier.config.json")
    writeFileSync(bad, "{ not json", "utf8")
    const result = await cli({ home: home(), cwd: scratch(), config: bad }, "loops")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("config error")
    expect(result.stderr).toContain("not valid JSON")
    expect(result.stderr).toContain("full privileges")

    const missing = await cli({ home: home(), cwd: scratch(), config: join(dir, "nope.json") }, "loops")
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain("$VERNIER_CONFIG")
  })

  it("without a config, the registry is EMPTY (no accidental discovery, no builtins)", async () => {
    const result = await cli({ home: home(), cwd: scratch() }, "loops", "--json")
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([])
    expect(result.stderr).toContain("vernier init") // the friendly empty-state pointer
  })
})

// ---------------------------------------------------- the judge config block

describe("vernier.config: the judge block", () => {
  const echoLoop = join(FIXTURE, "echo-loop.mjs")

  /** A scratch config dir registering the echo loop plus the given judge block. */
  function judgeConfigDir(judge: unknown): string {
    const dir = scratch()
    writeFileSync(join(dir, "vernier.config.json"), JSON.stringify({ loops: [echoLoop], judge }), "utf8")
    return dir
  }

  it("accepts codex and claude — the executor vocabulary, not internal worker ids", async () => {
    for (const provider of ["codex", "claude"]) {
      const result = await cli({ home: home(), cwd: judgeConfigDir({ provider }) }, "loops", "--json")
      expect(result.code).toBe(0)
      expect((JSON.parse(result.stdout) as Array<{ id: string }>).map((l) => l.id)).toEqual(["echo-shout"])
    }
  })

  it("rejects unsupported providers with the WHY for each (the error text is the documentation)", async () => {
    const result = await cli({ home: home(), cwd: judgeConfigDir({ provider: "opencode" }) }, "loops")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('judge.provider must be "codex" or "claude"')
    expect(result.stderr).toContain("pinned read-only sandbox")
    expect(result.stderr).toContain("opencode and pi refuse it")
    expect(result.stderr).toContain("cursor-agent has no per-run config plumbing")
    expect(result.stderr).toContain("inject a custom worker")
  })

  it("points the internal worker id back at the executor vocabulary", async () => {
    const result = await cli({ home: home(), cwd: judgeConfigDir({ provider: "claude-code" }) }, "loops")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("internal worker id")
    expect(result.stderr).toContain("executor vocabulary")
  })

  it("rejects unknown keys inside the block (exit 2, schema named)", async () => {
    const result = await cli({ home: home(), cwd: judgeConfigDir({ provider: "codex", model: "o3" }) }, "loops")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("config error")
  })

  it("validates the block in TS/JS configs too (the form zod never sees)", async () => {
    const dir = scratch()
    writeFileSync(
      join(dir, "vernier.config.mjs"),
      `export default { loops: [${JSON.stringify(echoLoop)}], judge: { provider: "pi" } }\n`,
      "utf8",
    )
    const result = await cli({ home: home(), cwd: dir }, "loops")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('judge.provider must be "codex" or "claude"')
  })

  it("config-loop runtimes construct the judge on the configured provider (construction never spawns)", async () => {
    const loop = {
      id: "judge-wiring",
      version: "0.0.1",
      signature: { input: z.object({}), output: z.object({}) },
      steps: [{ id: "grade", signature: { input: z.object({}), output: z.object({}) }, executor: "judge", effects: { allow: [] } }],
      policy: () => ({ kind: "stop", classification: "success", summary: "", notes: [], improvement: "" }),
      trust: "dry-run",
      ledger: {},
    }
    const loaded = (judge?: { readonly provider: "codex" | "claude" }): LoadedConfig => ({
      path: "/scratch/vernier.config.json",
      loops: [{ registration: { loop: loop as unknown as Loop }, source: "test" }],
      executors: [],
      bindings: new Map(),
      skills: [],
      skillBindings: new Map(),
      ...(judge !== undefined ? { judge } : {}),
    })
    // claude maps to the claude-code worker; codex and the absent block stay codex.
    for (const [judge, expected] of [
      [{ provider: "claude" }, "claude-code"],
      [{ provider: "codex" }, "codex"],
      [undefined, "codex"],
    ] as const) {
      const runtime = loopRegistry(loaded(judge)).get("judge-wiring")!.runtime(scratch())
      try {
        const judgeExecutor = runtime.deps.executors.get("judge")
        expect(judgeExecutor).toBeInstanceOf(JudgeExecutor)
        expect((judgeExecutor as JudgeExecutor).provider).toBe(expected)
      } finally {
        await runtime.shutdown()
      }
    }
  })

  it("defineConfig carries the judge block (type-level support, held by tsc over this file)", () => {
    const cfg = defineConfig({ judge: { provider: "claude" } })
    expect(cfg.judge?.provider).toBe("claude")
  })
})

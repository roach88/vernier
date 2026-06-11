// Out-of-tree loop registration + executor binding, asserted through the
// REAL CLI surface (spawned process, --json, exit codes), driven by the
// fixture config in test/fixtures/user-config: a user loop module, a user
// executor module, and a looper.config.json — no looper source edited.
// Everything here is deterministic; no LLM runs.

import { execFile } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { journalPath } from "../src/ledger/ledger.js"

const execFileAsync = promisify(execFile)
const BIN = join(import.meta.dirname, "..", "bin", "looper.js")
const FIXTURE = join(import.meta.dirname, "fixtures", "user-config")
const CONFIG = join(FIXTURE, "looper.config.json")

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface CliOpts {
  readonly home: string
  /** cwd for config discovery. Default: the fixture dir. */
  readonly cwd?: string
  /** $LOOPER_CONFIG override; unset (and scrubbed from the env) when omitted. */
  readonly config?: string
}

async function cli(opts: CliOpts, ...args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, LOOPER_HOME: opts.home }
  delete env.LOOPER_CONFIG
  if (opts.config !== undefined) env.LOOPER_CONFIG = opts.config
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

const home = (): string => mkdtempSync(join(tmpdir(), "looper-config-"))
const scratch = (): string => mkdtempSync(join(tmpdir(), "looper-config-scratch-"))

describe("looper.config: out-of-tree loops and executors", () => {
  it("discovers looper.config.json from cwd and lists the user loop with its source (builtins keep theirs)", async () => {
    const result = await cli({ home: home() }, "loops", "--json")
    expect(result.code).toBe(0)
    const loops = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    expect(loops.map((l) => l.id)).toEqual([
      "control-plane-smoke-test",
      "plan-work-review",
      "verified-answer",
      "compounding-answer",
      "echo-shout",
    ])
    const echo = loops.at(-1)!
    expect(echo.version).toBe("0.1.0")
    expect(echo.trust).toBe("dry-run")
    expect(echo.live).toBe(false)
    expect(String(echo.source)).toMatch(/echo-loop\.mjs$/)
    expect(loops.filter((l) => l.source === "builtin")).toHaveLength(4)
  })

  it("runs the user loop end-to-end on its own executor: `looper run echo-shout`", async () => {
    const root = home()
    const result = await cli({ home: root }, "run", "echo-shout", "--json")
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as Record<string, unknown>
    expect(outcome.status).toBe("done")
    expect(outcome.loopId).toBe("echo-shout")
    expect(outcome.output).toMatchObject({ echoed: "HELLO LOOPER", verdict: "success" })
    expect(existsSync(journalPath(root, String(outcome.runId)))).toBe(true)
  })

  it("$LOOPER_CONFIG overrides discovery (run from an unrelated cwd)", async () => {
    const result = await cli({ home: home(), cwd: scratch(), config: CONFIG }, "run", "echo-shout", "--json")
    expect(result.code).toBe(0)
    expect((JSON.parse(result.stdout) as { output: { echoed: string } }).output.echoed).toBe("HELLO LOOPER")
  })

  it("--executor rebinds a step onto a config-registered executor (CLI layer of the chain)", async () => {
    const result = await cli({ home: home() }, "run", "echo-shout", "--executor", "echo=reverse", "--json")
    expect(result.code).toBe(0)
    expect((JSON.parse(result.stdout) as { output: { echoed: string } }).output.echoed).toBe("repool olleh")
  })

  it("config `bindings` rebind too, and --executor beats them (full chain: CLI > config > loop default)", async () => {
    // A second config, written at test time, binding the echo step to the
    // config-level reverse executor; module paths are absolute on purpose.
    const dir = scratch()
    const configPath = join(dir, "looper.config.json")
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
    expect((JSON.parse(viaConfig.stdout) as { output: { echoed: string } }).output.echoed).toBe("repool olleh")

    const viaCli = await cli({ home: home(), cwd: dir }, "run", "echo-shout", "--executor", "echo=upper", "--json")
    expect(viaCli.code).toBe(0)
    expect((JSON.parse(viaCli.stdout) as { output: { echoed: string } }).output.echoed).toBe("HELLO LOOPER")
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
    const bad = join(dir, "looper.config.json")
    writeFileSync(bad, "{ not json", "utf8")
    const result = await cli({ home: home(), cwd: scratch(), config: bad }, "loops")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("config error")
    expect(result.stderr).toContain("not valid JSON")
    expect(result.stderr).toContain("full privileges")

    const missing = await cli({ home: home(), cwd: scratch(), config: join(dir, "nope.json") }, "loops")
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain("$LOOPER_CONFIG")
  })

  it("without a config, the registry is exactly the four builtins (no accidental discovery)", async () => {
    const result = await cli({ home: home(), cwd: scratch() }, "loops", "--json")
    expect(result.code).toBe(0)
    const loops = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    expect(loops).toHaveLength(4)
    expect(loops.every((l) => l.source === "builtin")).toBe(true)
  })
})

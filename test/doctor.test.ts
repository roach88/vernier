// `looper doctor`, deterministic at two layers:
//   - in-process diagnose() with INJECTED probes (never the machine's PATH,
//     never a real SDK probe) — semantics: probe classification, binding
//     resolution, "unused unusable executor does not fail the doctor",
//     runtime-factory failure containment;
//   - the spawned CLI with a MANIPULATED PATH (a shim dir + /usr/bin:/bin
//     for git) — surface: --json shape, human sections, exit codes.
// No real agent CLI is ever found, let alone executed: probes only look
// binaries up; the shim is an inert script that nothing runs.

import { execFile } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { CLAUDE_SDK } from "../src/executors/claude.js"
import { diagnose, type DoctorProbes, type DoctorReport } from "../src/cli/doctor.js"
import type { LoadedConfig } from "../src/cli/config.js"
import { loopRegistry, type RegisteredLoop } from "../src/cli/registry.js"

const execFileAsync = promisify(execFile)
const BIN = join(import.meta.dirname, "..", "bin", "looper.js")
const FIXTURE = join(import.meta.dirname, "fixtures", "user-config")

// pilot3's default runtime opens the durable memory store under the looper
// root; point it at scratch so in-process diagnose() never touches the repo.
process.env.LOOPER_HOME = mkdtempSync(join(tmpdir(), "looper-doctor-home-"))

const probes = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  which: () => undefined,
  resolvable: () => false,
  ...over,
})

const allFound = (over: Partial<DoctorProbes> = {}): DoctorProbes =>
  probes({ which: (bin) => `/fake/bin/${bin}`, resolvable: () => true, ...over })

const config = (over: Partial<LoadedConfig>): LoadedConfig => ({
  path: "/scratch/looper.config.json",
  loops: [],
  executors: [],
  bindings: new Map<string, string>(),
  ...over,
})

const executorById = (report: DoctorReport, id: string) => report.executors.find((e) => e.id === id)
const loopById = (report: DoctorReport, id: string) => report.loops.find((l) => l.loopId === id)

describe("diagnose()", () => {
  it("probes every executor the builtin runtimes register, and a bare machine blocks exactly the agent-driven loops", async () => {
    const report = await diagnose(loopRegistry(), undefined, probes())

    expect(executorById(report, "codex")).toMatchObject({ ok: false, requires: "codex" })
    expect(executorById(report, "cursor-agent")).toMatchObject({ ok: false, requires: "cursor-agent" })
    expect(executorById(report, "claude")).toMatchObject({ ok: false, requires: CLAUDE_SDK })
    expect(executorById(report, "claude")?.detail).toContain(`npm install ${CLAUDE_SDK}`)
    expect(executorById(report, "judge")).toMatchObject({ ok: false, requires: "codex" })
    expect(executorById(report, "recall")).toMatchObject({ ok: true, requires: null })
    expect(executorById(report, "script:control-plane-smoke")).toMatchObject({ ok: true })

    expect(loopById(report, "control-plane-smoke-test")?.runnable).toBe(true)
    for (const id of ["plan-work-review", "verified-answer", "compounding-answer"]) {
      const loop = loopById(report, id)!
      expect(loop.runnable).toBe(false)
      expect(loop.steps.some((s) => !s.ok && s.why.includes("not found on PATH"))).toBe(true)
    }
    expect(report.ok).toBe(false)
  })

  it("an unusable executor that no step resolves to is reported but does not fail the doctor", async () => {
    const report = await diagnose(loopRegistry(), undefined, allFound({ resolvable: () => false }))
    expect(executorById(report, "claude")?.ok).toBe(false)
    expect(report.loops.every((l) => l.runnable)).toBe(true)
    expect(report.ok).toBe(true) // nothing binds onto claude by default
  })

  it("config bindings are resolved exactly as a run would resolve them, and the missing piece is named", async () => {
    const report = await diagnose(
      loopRegistry(),
      config({ bindings: new Map([["implement", "claude"]]) }),
      allFound({ resolvable: () => false }),
    )
    const loop = loopById(report, "plan-work-review")!
    const step = loop.steps.find((s) => s.stepId === "implement")!
    expect(step).toMatchObject({ declared: "codex", resolved: "claude", ok: false })
    expect(step.why).toContain(CLAUDE_SDK)
    expect(loop.runnable).toBe(false)
    expect(report.ok).toBe(false)
  })

  it("a binding onto an executor nobody registered names the registered set", async () => {
    const report = await diagnose(loopRegistry(), config({ bindings: new Map([["smoke", "nope"]]) }), allFound())
    const step = loopById(report, "control-plane-smoke-test")!.steps[0]!
    expect(step).toMatchObject({ resolved: "nope", ok: false })
    expect(step.why).toContain("not registered")
    expect(step.why).toContain("script:control-plane-smoke")
  })

  it("a runtime factory that throws is contained as a non-runnable loop, not a doctor crash", async () => {
    const loop = {
      id: "broken-runtime",
      version: "0.0.1",
      signature: { input: z.object({}), output: z.object({}) },
      steps: [{ id: "only", signature: { input: z.object({}), output: z.object({}) }, executor: "codex", effects: { allow: [] } }],
      policy: () => ({ kind: "stop", classification: "success", summary: "", notes: [], improvement: "" }),
      trust: "dry-run",
      ledger: {},
    }
    const entry: RegisteredLoop = {
      loop: loop as RegisteredLoop["loop"],
      signature: "{} -> {}",
      summary: "fixture",
      source: "test",
      live: false,
      defaultWorkdir: () => mkdtempSync(join(tmpdir(), "looper-doctor-broken-")),
      runtime: () => {
        throw new Error("tool `frobnicator` is not installed")
      },
    }
    const report = await diagnose(new Map([["broken-runtime", entry]]), undefined, allFound())
    expect(report.loops[0]).toMatchObject({ loopId: "broken-runtime", runnable: false })
    expect(report.loops[0]!.error).toContain("frobnicator")
    expect(report.ok).toBe(false)
  })
})

// ----------------------------------------------------------- the CLI surface

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** A PATH with git (loop runtimes shell out to it) but NO real agent CLIs; optionally a shim dir first. */
const basePath = (shimDir?: string): string => [shimDir, "/usr/bin", "/bin"].filter(Boolean).join(":")

async function cli(env: { home: string; path: string; cwd?: string }, ...args: string[]): Promise<CliResult> {
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, LOOPER_HOME: env.home, PATH: env.path }
  delete spawnEnv.LOOPER_CONFIG
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd: env.cwd ?? mkdtempSync(join(tmpdir(), "looper-doctor-cwd-")),
      env: spawnEnv,
      encoding: "utf8",
      timeout: 60_000,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

const home = (): string => mkdtempSync(join(tmpdir(), "looper-doctor-cli-"))

/** An inert executable named `codex` that doctor may FIND but never runs. */
function codexShimDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "looper-doctor-shim-"))
  const shim = join(dir, "codex")
  writeFileSync(shim, "#!/bin/sh\nexit 0\n", "utf8")
  chmodSync(shim, 0o755)
  return dir
}

describe("looper doctor (CLI)", () => {
  it("exit 0 + full --json report when every registered loop is runnable (codex shim on PATH)", async () => {
    const shims = codexShimDir()
    const result = await cli({ home: home(), path: basePath(shims) }, "doctor", "--json")
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as DoctorReport
    expect(report.ok).toBe(true)
    expect(report.loops).toHaveLength(4)
    expect(report.loops.every((l) => l.runnable)).toBe(true)
    expect(executorById(report, "codex")).toMatchObject({ ok: true, detail: expect.stringContaining(shims) })
    expect(executorById(report, "claude")?.ok).toBe(true) // the devDependency SDK is resolvable in this repo
    expect(executorById(report, "cursor-agent")?.ok).toBe(false) // reported, but no step resolves to it
  })

  it("exit 1 when agent-driven loops are blocked (bare PATH), with the missing binary named per step", async () => {
    const result = await cli({ home: home(), path: basePath() }, "doctor", "--json")
    expect(result.code).toBe(1)
    const report = JSON.parse(result.stdout) as DoctorReport
    expect(report.ok).toBe(false)
    expect(loopById(report, "control-plane-smoke-test")?.runnable).toBe(true)
    const pilot1 = loopById(report, "plan-work-review")!
    expect(pilot1.runnable).toBe(false)
    expect(pilot1.steps.find((s) => s.stepId === "implement")?.why).toContain("`codex` not found on PATH")
  })

  it("covers config-registered loops and executors: the user loop stays runnable on a bare machine", async () => {
    const result = await cli({ home: home(), path: basePath(), cwd: FIXTURE }, "doctor", "--json")
    expect(result.code).toBe(1) // the codex pilots are still blocked...
    const report = JSON.parse(result.stdout) as DoctorReport
    expect(executorById(report, "upper")).toMatchObject({ ok: true, detail: expect.stringContaining("in-process") })
    expect(executorById(report, "reverse")).toMatchObject({ ok: true, detail: expect.stringContaining("config-registered") })
    expect(loopById(report, "echo-shout")?.runnable).toBe(true) // ...but the user loop needs nothing external
  })

  it("human output: EXECUTORS and LOOPS sections, blockers marked", async () => {
    const result = await cli({ home: home(), path: basePath() }, "doctor")
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("EXECUTORS")
    expect(result.stdout).toContain("LOOPS")
    expect(result.stdout).toContain("!!")
    expect(result.stdout).toContain("some loops are not runnable")
  })
})

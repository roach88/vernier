// `vernier doctor`, deterministic at two layers:
//   - in-process diagnose() with INJECTED probes (never the machine's PATH,
//     never a real package probe) — semantics: probe classification, binding
//     resolution, "unused unusable executor does not fail the doctor",
//     runtime-factory failure containment, the zero-loop baseline. The
//     agent templates are diagnosed here, registered exactly as their
//     scaffolded configs would register them (templatesAsConfig);
//   - the spawned CLI with a MANIPULATED PATH (a shim dir + /usr/bin:/bin
//     for git) — surface: --json shape, human sections, exit codes, the
//     empty state. The spawned runs use the smoke template and scratch
//     configs (the agent templates import "vernier", which resolves in a
//     consumer install; in-tree they are covered by the in-process layer).
// No real agent CLI is ever found, let alone executed: probes only look
// binaries up; the shim is an inert script that nothing runs.

import { execFile } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { JudgeExecutor } from "../src/executors/judge.js"
import { defaultContractRegistry } from "../src/kernel/contract.js"
import { diagnose, renderDoctor, type DoctorProbes, type DoctorReport } from "../src/cli/doctor.js"
import { discoverSkills } from "../src/skills/skills.js"
import type { LoadedConfig } from "../src/cli/config.js"
import { loopRegistry, type RegisteredLoop } from "../src/cli/registry.js"
import { TEMPLATES, templatesAsConfig } from "./templates.js"

const execFileAsync = promisify(execFile)
const BIN = join(import.meta.dirname, "..", "bin", "vernier.js")
const FIXTURE = join(import.meta.dirname, "fixtures", "user-config")

// Config-registered runtimes open the durable memory store under the vernier
// root; point it at scratch so in-process diagnose() never touches the repo.
process.env.VERNIER_HOME = mkdtempSync(join(tmpdir(), "vernier-doctor-home-"))

// All four templates, registered as their scaffolded configs would register
// them (loop modules + shipped bindings) — the at-rest state doctor reports.
const ALL_TEMPLATES = await templatesAsConfig("smoke", "coding-review", "verified-answer", "self-improving")
// The templates' shipped skill registrations, discovered the way cmdDoctor would.
const ALL_TEMPLATE_SKILLS = discoverSkills({ explicit: ALL_TEMPLATES.skills })
const allTemplatesRegistry = () => loopRegistry(ALL_TEMPLATES)

const probes = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  which: () => undefined,
  env: () => ({}),
  zodInstalls: () => [],
  ...over,
})

const allFound = (over: Partial<DoctorProbes> = {}): DoctorProbes =>
  probes({ which: (bin) => `/fake/bin/${bin}`, ...over })

const config = (over: Partial<LoadedConfig>): LoadedConfig => ({
  path: "/scratch/vernier.config.json",
  loops: [],
  executors: [],
  bindings: new Map<string, string>(),
  skills: [],
  skillBindings: new Map<string, readonly string[]>(),
  ...over,
})

const executorById = (report: DoctorReport, id: string) => report.executors.find((e) => e.id === id)
const loopById = (report: DoctorReport, id: string) => report.loops.find((l) => l.loopId === id)

describe("diagnose()", () => {
  it("probes every executor the template runtimes register, and a bare machine blocks exactly the agent-driven loops", async () => {
    const report = await diagnose(allTemplatesRegistry(), ALL_TEMPLATES, probes(), ALL_TEMPLATE_SKILLS)

    expect(executorById(report, "codex")).toMatchObject({ ok: false, requires: "codex" })
    expect(executorById(report, "cursor-agent")).toMatchObject({ ok: false, requires: "agent" })
    expect(executorById(report, "opencode")).toMatchObject({ ok: false, requires: "opencode" })
    expect(executorById(report, "pi")).toMatchObject({ ok: false, requires: "pi" })
    // claude is a CLI provider like every other: probed as a binary on PATH, never an SDK.
    expect(executorById(report, "claude")).toMatchObject({ ok: false, requires: "claude" })
    expect(executorById(report, "claude")?.detail).toContain("not found on PATH")
    expect(executorById(report, "judge")).toMatchObject({ ok: false, requires: "codex" })
    expect(executorById(report, "recall")).toMatchObject({ ok: true, requires: null })
    expect(executorById(report, "script:control-plane-smoke")).toMatchObject({ ok: true })

    expect(loopById(report, "control-plane-smoke-test")?.runnable).toBe(true)
    for (const id of ["plan-work-review", "verified-answer", "compounding-answer"]) {
      const loop = loopById(report, id)!
      expect(loop.runnable).toBe(false)
      expect(loop.steps.some((s) => !s.ok && s.why.includes("not found on PATH"))).toBe(true)
    }
    // The shipped bindings are what doctor resolved: agent -> codex.
    const route = loopById(report, "plan-work-review")!.steps.find((s) => s.stepId === "route")!
    expect(route).toMatchObject({ declared: "agent", resolved: "codex" })
    expect(report.ok).toBe(false)
  })

  it("an unusable executor that no step resolves to is reported but does not fail the doctor", async () => {
    const report = await diagnose(
      allTemplatesRegistry(),
      ALL_TEMPLATES,
      allFound({ which: (bin) => (bin === "claude" ? undefined : `/fake/bin/${bin}`) }),
      ALL_TEMPLATE_SKILLS,
    )
    expect(executorById(report, "claude")?.ok).toBe(false)
    expect(report.loops.every((l) => l.runnable)).toBe(true)
    expect(report.ok).toBe(true) // the shipped bindings point at codex, not claude
  })

  it("probes Cursor through the shared agent then cursor-agent fallback", async () => {
    const onlyAgent = await diagnose(
      loopRegistry(),
      undefined,
      probes({ which: (bin) => (bin === "agent" ? "/fake/bin/agent" : undefined) }),
      ALL_TEMPLATE_SKILLS,
    )
    expect(executorById(onlyAgent, "cursor-agent")).toMatchObject({ ok: true, requires: "agent", detail: expect.stringContaining("/fake/bin/agent") })

    const onlyCursorAgent = await diagnose(
      loopRegistry(),
      undefined,
      probes({ which: (bin) => (bin === "cursor-agent" ? "/fake/bin/cursor-agent" : undefined) }),
      ALL_TEMPLATE_SKILLS,
    )
    expect(executorById(onlyCursorAgent, "cursor-agent")).toMatchObject({
      ok: true,
      requires: "cursor-agent",
      detail: expect.stringContaining("/fake/bin/cursor-agent"),
    })
  })

  it("honors VERNIER_CURSOR_BIN in Cursor doctor probing", async () => {
    const report = await diagnose(
      loopRegistry(),
      undefined,
      probes({
        env: () => ({ VERNIER_CURSOR_BIN: "custom-cursor" }),
        which: (bin) => (bin === "custom-cursor" ? "/fake/bin/custom-cursor" : undefined),
      }),
      ALL_TEMPLATE_SKILLS,
    )
    expect(executorById(report, "cursor-agent")).toMatchObject({
      ok: true,
      requires: "custom-cursor",
      detail: expect.stringContaining("VERNIER_CURSOR_BIN=`custom-cursor`"),
    })
  })

  it("reports each step's resolved skills against the discovered registry; a config skillBindings layer rebinds at rest and a missing name blocks", async () => {
    const report = await diagnose(allTemplatesRegistry(), ALL_TEMPLATES, allFound(), ALL_TEMPLATE_SKILLS)
    const loop = loopById(report, "plan-work-review")!
    expect(loop.steps.find((s) => s.stepId === "implement")!.skills).toEqual([
      expect.objectContaining({ name: "dry-run-note-style", ok: true }),
    ])
    expect(loop.steps.find((s) => s.stepId === "route")!.skills).toBeUndefined()
    expect(report.skills).toContainEqual(expect.objectContaining({ name: "dry-run-note-style", ok: true, origin: "config" }))

    // The same chain a run resolves: config skillBindings > the step's declared default.
    const bound = { ...ALL_TEMPLATES, skillBindings: new Map<string, readonly string[]>([["implement", ["missing-skill"]]]) }
    const rebound = await diagnose(loopRegistry(bound), bound, allFound(), ALL_TEMPLATE_SKILLS)
    const step = loopById(rebound, "plan-work-review")!.steps.find((s) => s.stepId === "implement")!
    expect(step.skills).toEqual([expect.objectContaining({ name: "missing-skill", ok: false })])
    expect(step.ok).toBe(false)
    expect(rebound.ok).toBe(false)
  })

  it("ZERO loops registered: the baseline executor set is still probed, loops say none, exit-0 semantics", async () => {
    const report = await diagnose(loopRegistry(), undefined, probes())
    expect(report.loops).toEqual([])
    expect(report.ok).toBe(true) // nothing registered = nothing broken
    // The environment question is still answered: what could this machine run?
    for (const id of ["codex", "cursor-agent", "claude", "opencode", "pi"]) {
      expect(executorById(report, id)).toMatchObject({ ok: false, requires: id === "cursor-agent" ? "agent" : id })
    }
    expect(executorById(report, "judge")).toMatchObject({ ok: false, requires: "codex" })
    expect(executorById(report, "recall")).toMatchObject({ ok: true, requires: null })
    expect(executorById(report, "memory:lexical")).toBeUndefined()
  })

  it("config bindings are resolved exactly as a run would resolve them, and the missing piece is named", async () => {
    const bindings = new Map(ALL_TEMPLATES.bindings)
    bindings.set("implement", "claude") // the user re-points one role at claude
    const report = await diagnose(
      loopRegistry({ ...ALL_TEMPLATES, bindings }),
      { ...ALL_TEMPLATES, bindings },
      allFound({ which: (bin) => (bin === "claude" ? undefined : `/fake/bin/${bin}`) }),
    )
    const loop = loopById(report, "plan-work-review")!
    const step = loop.steps.find((s) => s.stepId === "implement")!
    expect(step).toMatchObject({ declared: "agent", resolved: "claude", ok: false })
    expect(step.why).toContain("`claude` not found on PATH")
    expect(loop.runnable).toBe(false)
    expect(report.ok).toBe(false)
  })

  it("probes judge/distill against the binary of whichever provider actually backs them", async () => {
    const onlyClaude = probes({ which: (bin) => (bin === "claude" ? "/fake/bin/claude" : undefined) })
    const loop = {
      id: "judged",
      version: "0.0.1",
      signature: { input: z.object({}), output: z.object({}) },
      steps: [{ id: "grade", signature: { input: z.object({}), output: z.object({}) }, executor: "judge", effects: { allow: [] } }],
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
      defaultWorkdir: () => mkdtempSync(join(tmpdir(), "vernier-doctor-judged-")),
      runtime: () => ({
        deps: {
          executors: new Map([["judge", new JudgeExecutor({ provider: "claude-code" })]]),
          contracts: defaultContractRegistry(),
          workdir: mkdtempSync(join(tmpdir(), "vernier-doctor-judged-wd-")),
        },
        shutdown: async () => {},
      }),
    }
    const report = await diagnose(new Map([["judged", entry]]), undefined, onlyClaude)
    // The judge is claude-backed here, so doctor wants `claude`, not `codex`.
    expect(executorById(report, "judge")).toMatchObject({ ok: true, requires: "claude" })
    expect(report.ok).toBe(true)
  })

  it("the config's `judge` block rebinds the wrapper: doctor probes the CONFIGURED provider's binary", async () => {
    const cfg = { ...ALL_TEMPLATES, judge: { provider: "claude" } as const }
    const onlyClaude = probes({ which: (bin) => (bin === "claude" ? "/fake/bin/claude" : undefined) })
    const report = await diagnose(loopRegistry(cfg), cfg, onlyClaude)
    expect(executorById(report, "judge")).toMatchObject({ ok: true, requires: "claude" })
    // grade and distill both ride the ONE wrapper instance — one key backs both.
    expect(loopById(report, "verified-answer")!.steps.find((s) => s.stepId === "grade")).toMatchObject({ ok: true })
    expect(loopById(report, "compounding-answer")!.steps.find((s) => s.stepId === "distill")).toMatchObject({ ok: true })

    // ZERO loops registered: the baseline probe honors the block too.
    const baseline = await diagnose(loopRegistry(), config({ judge: { provider: "claude" } }), onlyClaude)
    expect(executorById(baseline, "judge")).toMatchObject({ ok: true, requires: "claude" })
  })

  it("a binding onto an executor nobody registered names the registered set", async () => {
    const smokeOnly = await templatesAsConfig("smoke")
    const bindings = new Map([["smoke", "nope"]])
    const report = await diagnose(loopRegistry({ ...smokeOnly, bindings }), config({ bindings }), allFound())
    const step = loopById(report, "control-plane-smoke-test")!.steps[0]!
    expect(step).toMatchObject({ resolved: "nope", ok: false })
    expect(step.why).toContain("not registered")
    expect(step.why).toContain("script:control-plane-smoke")
  })

  describe("memory retriever", () => {
    it("lexical memory is just the store-op executors; no separate optional-package probe exists", async () => {
      const report = await diagnose(allTemplatesRegistry(), ALL_TEMPLATES, allFound(), ALL_TEMPLATE_SKILLS)
      expect(executorById(report, "recall")).toMatchObject({ ok: true, requires: null })
      expect(executorById(report, "remember")).toMatchObject({ ok: true, requires: null })
      expect(executorById(report, "memory:lexical")).toBeUndefined()
      expect(loopById(report, "compounding-answer")?.runnable).toBe(true)
    })
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
      defaultWorkdir: () => mkdtempSync(join(tmpdir(), "vernier-doctor-broken-")),
      runtime: () => {
        throw new Error("tool `frobnicator` is not installed")
      },
    }
    const report = await diagnose(new Map([["broken-runtime", entry]]), undefined, allFound())
    expect(report.loops[0]).toMatchObject({ loopId: "broken-runtime", runnable: false })
    expect(report.loops[0]!.error).toContain("frobnicator")
    expect(report.ok).toBe(false)
  })

  it("a broken-runtime loop STILL reports its declared skills, so a user-tier skill it needs is not elided from the inventory", async () => {
    // A user-tier skill referenced ONLY by a loop whose runtime throws.
    const home = mkdtempSync(join(tmpdir(), "vernier-doctor-skill-home-"))
    const skillDir = join(home, ".claude", "skills", "broken-only-skill")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: broken-only-skill\ndescription: Needed only by a broken loop. Use when testing elision.\n---\n\nbody\n",
      "utf8",
    )
    const skills = discoverSkills({ home })

    const loop = {
      id: "broken-with-skill",
      version: "0.0.1",
      signature: { input: z.object({}), output: z.object({}) },
      steps: [
        {
          id: "only",
          signature: { input: z.object({}), output: z.object({}) },
          executor: "codex",
          skills: ["broken-only-skill"],
          effects: { allow: [] },
          prompt: () => "x",
        },
      ],
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
      defaultWorkdir: () => mkdtempSync(join(tmpdir(), "vernier-doctor-broken2-")),
      runtime: () => {
        throw new Error("tool missing")
      },
    }

    const report = await diagnose(new Map([["broken-with-skill", entry]]), undefined, allFound(), skills)
    // The declared skill survives the broken runtime in the report...
    const step = loopById(report, "broken-with-skill")!.steps.find((s) => s.stepId === "only")!
    expect(step.skills).toEqual([expect.objectContaining({ name: "broken-only-skill", ok: true })])
    // ...so renderDoctor counts it as referenced and does NOT elide it.
    const lines = renderDoctor(report).join("\n")
    expect(lines).toContain("broken-only-skill")
    expect(lines).not.toMatch(/\+ 1 more spec-valid skill/)
  })

  describe("zod-skew derive-probe + shadow warning", () => {
    // A registered loop with ONE structuredOutput step carrying `output`, on an
    // in-process executor that always probes ok — so schema derivation is the
    // only thing that can block the step.
    function structuredRegistry(output: z.ZodType): Map<string, RegisteredLoop> {
      const exec = {
        id: "inproc",
        async run() {
          return { status: "completed" as const, output: {}, evidence: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 } }
        },
      }
      const loop = {
        id: "structured",
        version: "0.0.1",
        signature: { input: z.object({}), output },
        steps: [
          { id: "emit", signature: { input: z.object({}), output }, executor: "inproc", effects: { allow: [] }, prompt: () => "x", structuredOutput: true },
        ],
        policy: () => ({ kind: "stop", classification: "success", summary: "", notes: [], improvement: "" }),
        trust: "dry-run",
        ledger: {},
      }
      const entry: RegisteredLoop = {
        loop: loop as RegisteredLoop["loop"],
        signature: "{} -> ?",
        summary: "fixture",
        source: "test",
        live: false,
        defaultWorkdir: () => mkdtempSync(join(tmpdir(), "vernier-doctor-skew-")),
        runtime: () => ({
          deps: {
            executors: new Map([["inproc", exec]]),
            contracts: defaultContractRegistry(),
            workdir: mkdtempSync(join(tmpdir(), "vernier-doctor-skew-wd-")),
          },
          shutdown: async () => {},
        }),
      }
      return new Map([["structured", entry]])
    }

    it("blocks a structuredOutput step whose output is typeless (z.any -> {}), naming the derivation error", async () => {
      const report = await diagnose(structuredRegistry(z.any()), undefined, allFound())
      const step = loopById(report, "structured")!.steps.find((s) => s.stepId === "emit")!
      expect(step.ok).toBe(false)
      expect(step.why).toContain("constrains nothing")
      expect(report.ok).toBe(false)
    })

    it("passes a structuredOutput step whose output derives cleanly", async () => {
      const report = await diagnose(structuredRegistry(z.object({ verdict: z.string() })), undefined, allFound())
      expect(loopById(report, "structured")!.steps.find((s) => s.stepId === "emit")!.ok).toBe(true)
      expect(loopById(report, "structured")!.runnable).toBe(true)
    })

    it("warns (without failing the doctor) when a second zod resolves above the project", async () => {
      const shadowed = probes({
        zodInstalls: () => [
          { path: "/proj/node_modules/zod", version: "4.0.0" },
          { path: "/shadow/node_modules/zod", version: "3.23.0" },
        ],
      })
      const report = await diagnose(loopRegistry(), undefined, shadowed)
      expect(report.warnings).toHaveLength(1)
      expect(report.warnings[0]).toContain("/shadow/node_modules/zod")
      expect(report.ok).toBe(true) // a shadow is a warning, not a failure
      expect(renderDoctor(report).join("\n")).toContain("WARNINGS")
    })

    it("surfaces a shadow warning on the normal (non-empty registry) return path too, without blocking the loop", async () => {
      const report = await diagnose(
        structuredRegistry(z.object({ verdict: z.string() })),
        undefined,
        allFound({
          zodInstalls: () => [
            { path: "/proj/node_modules/zod", version: "4.0.0" },
            { path: "/shadow/node_modules/zod", version: "3.23.0" },
          ],
        }),
      )
      expect(report.warnings).toHaveLength(1)
      expect(loopById(report, "structured")!.runnable).toBe(true) // a shadow warning never blocks a loop
    })

    it("no warning when only the project's own zod is on the resolution path", async () => {
      const report = await diagnose(
        loopRegistry(),
        undefined,
        probes({ zodInstalls: () => [{ path: "/proj/node_modules/zod", version: "4.0.0" }] }),
      )
      expect(report.warnings).toEqual([])
      expect(renderDoctor(report).join("\n")).not.toContain("WARNINGS")
    })

    it("does not warn when the zod install(s) above are the SAME version (not a skew)", async () => {
      const report = await diagnose(
        loopRegistry(),
        undefined,
        probes({
          zodInstalls: () => [
            { path: "/proj/node_modules/zod", version: "4.0.0" },
            { path: "/workspace/node_modules/zod", version: "4.0.0" },
          ],
        }),
      )
      expect(report.warnings).toEqual([])
      expect(renderDoctor(report).join("\n")).not.toContain("WARNINGS")
    })
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

async function cli(env: { home: string; path: string; cwd?: string; config?: string }, ...args: string[]): Promise<CliResult> {
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, VERNIER_HOME: env.home, PATH: env.path }
  if (env.config !== undefined) spawnEnv.VERNIER_CONFIG = env.config
  else delete spawnEnv.VERNIER_CONFIG
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd: env.cwd ?? mkdtempSync(join(tmpdir(), "vernier-doctor-cwd-")),
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

const home = (): string => mkdtempSync(join(tmpdir(), "vernier-doctor-cli-"))
const SMOKE_CONFIG = join(TEMPLATES, "smoke", "vernier.config.json")

/** Inert executables (codex, opencode, …) that doctor may FIND but never runs. */
function shimDir(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vernier-doctor-shim-"))
  for (const name of names) {
    const shim = join(dir, name)
    writeFileSync(shim, "#!/bin/sh\nexit 0\n", "utf8")
    chmodSync(shim, 0o755)
  }
  return dir
}

/**
 * A scratch out-of-tree config whose one loop binds a step to `codex` —
 * the smallest spawned-CLI case of "an agent-driven loop on this machine".
 * zod is symlinked from this repo's node_modules (a consumer project would
 * have its own).
 */
function codexBoundConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vernier-doctor-agent-config-"))
  mkdirSync(join(dir, "node_modules"))
  symlinkSync(join(import.meta.dirname, "..", "node_modules", "zod"), join(dir, "node_modules", "zod"))
  writeFileSync(
    join(dir, "agent-loop.mjs"),
    `import { z } from "zod"
export default {
  loop: {
    id: "needs-codex",
    version: "0.0.1",
    signature: { input: z.object({ q: z.string() }), output: z.object({ a: z.string(), verdict: z.string() }) },
    steps: [
      {
        id: "ask",
        signature: { input: z.object({ q: z.string() }), output: z.object({ a: z.string() }) },
        executor: "codex",
        effects: { allow: [] },
        prompt: (spec) => String(spec.inputs.q),
      },
    ],
    policy: () => ({ kind: "stop", classification: "success", summary: "done", notes: [], improvement: "none" }),
    trust: "dry-run",
    ledger: {},
  },
  summary: "Fixture loop bound to codex.",
  signature: "q:string -> a:string, verdict:string",
}
`,
    "utf8",
  )
  writeFileSync(join(dir, "vernier.config.json"), JSON.stringify({ loops: ["./agent-loop.mjs"] }) + "\n", "utf8")
  return dir
}

describe("vernier doctor (CLI)", () => {
  it("exit 0 + full --json report when every registered loop is runnable (the smoke template needs nothing)", async () => {
    const result = await cli({ home: home(), path: basePath(), config: SMOKE_CONFIG }, "doctor", "--json")
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as DoctorReport
    expect(report.ok).toBe(true)
    expect(report.loops).toHaveLength(1)
    expect(report.loops[0]).toMatchObject({ loopId: "control-plane-smoke-test", runnable: true })
    expect(executorById(report, "script:control-plane-smoke")?.ok).toBe(true)
    // The wired providers are reported (the runtime registers them for
    // rebinding) but none is needed: unusable-but-unused does not fail doctor.
    expect(executorById(report, "codex")?.ok).toBe(false)
    expect(executorById(report, "claude")?.ok).toBe(false)
    expect(executorById(report, "cursor-agent")?.ok).toBe(false)
  })

  it("ZERO loops, no config: exit 0, executors section still probed, loops say none registered", async () => {
    const shims = shimDir("codex")
    const result = await cli({ home: home(), path: basePath(shims) }, "doctor", "--json")
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as DoctorReport
    expect(report.ok).toBe(true)
    expect(report.loops).toEqual([])
    expect(executorById(report, "codex")).toMatchObject({ ok: true, detail: expect.stringContaining(shims) })
    expect(executorById(report, "claude")?.ok).toBe(false)
    expect(executorById(report, "memory:lexical")).toBeUndefined()

    const human = await cli({ home: home(), path: basePath(shims) }, "doctor")
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("EXECUTORS")
    expect(human.stdout).toContain("LOOPS")
    expect(human.stdout).toContain("none registered")
    expect(human.stdout).toContain("vernier init")
  })

  it("probes the claude, opencode, and pi binaries by PATH lookup only (shims found, never executed)", async () => {
    const shims = shimDir("codex", "claude", "opencode", "pi")
    const result = await cli({ home: home(), path: basePath(shims), config: SMOKE_CONFIG }, "doctor", "--json")
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as DoctorReport
    expect(executorById(report, "claude")).toMatchObject({ ok: true, requires: "claude", detail: expect.stringContaining(shims) })
    expect(executorById(report, "opencode")).toMatchObject({ ok: true, requires: "opencode", detail: expect.stringContaining(shims) })
    expect(executorById(report, "pi")).toMatchObject({ ok: true, requires: "pi", detail: expect.stringContaining(shims) })
  })

  it("exit 1 when an agent-bound loop is blocked (bare PATH), with the missing binary named per step", async () => {
    const dir = codexBoundConfigDir()
    const result = await cli({ home: home(), path: basePath(), cwd: dir }, "doctor", "--json")
    expect(result.code).toBe(1)
    const report = JSON.parse(result.stdout) as DoctorReport
    expect(report.ok).toBe(false)
    const blocked = loopById(report, "needs-codex")!
    expect(blocked.runnable).toBe(false)
    expect(blocked.steps.find((s) => s.stepId === "ask")?.why).toContain("`codex` not found on PATH")

    const human = await cli({ home: home(), path: basePath(), cwd: dir }, "doctor")
    expect(human.code).toBe(1)
    expect(human.stdout).toContain("EXECUTORS")
    expect(human.stdout).toContain("LOOPS")
    expect(human.stdout).toContain("!!")
    expect(human.stdout).toContain("some loops are not runnable")
  })

  it("covers config-registered loops and executors: the user loop is runnable on a bare machine (exit 0)", async () => {
    const result = await cli({ home: home(), path: basePath(), cwd: FIXTURE }, "doctor", "--json")
    expect(result.code).toBe(0) // zero builtins: nothing else is registered to block
    const report = JSON.parse(result.stdout) as DoctorReport
    expect(executorById(report, "upper")).toMatchObject({ ok: true, detail: expect.stringContaining("in-process") })
    expect(executorById(report, "reverse")).toMatchObject({ ok: true, detail: expect.stringContaining("config-registered") })
    expect(loopById(report, "echo-shout")?.runnable).toBe(true)
  })
})

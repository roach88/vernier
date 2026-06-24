// The --skill surface through the REAL CLI (spawned bin, --json, exit
// codes), driven by the skills-cli fixture: a prompt-echo loop whose step
// declares `skills: ["greeting-style"]`, the skill registered by the
// fixture's vernier.config.json. The executor echoes the rendered prompt,
// so whatever the engine delivered comes back as the loop output — skill
// embedding is observable from outside the process. HOME points at scratch
// so the user tier (~/.agents/skills) is hermetic per test.

import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { journalPath, Ledger, type StepStartedEntry } from "../src/ledger/ledger.js"

const execFileAsync = promisify(execFile)
const BIN = join(import.meta.dirname, "..", "bin", "vernier.js")
const FIXTURE = join(import.meta.dirname, "fixtures", "skills-cli")
const SKILL_BODY_MARKER = "Always open with the word SALUTATIONS"

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface CliOpts {
  readonly home: string
  /** $HOME for the spawned process — the user skill tier. Default: an empty scratch dir. */
  readonly userHome?: string
  readonly cwd?: string
}

async function cli(opts: CliOpts, ...args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, VERNIER_HOME: opts.home, HOME: opts.userHome ?? scratch("user-home") }
  delete env.VERNIER_CONFIG
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

const scratch = (label: string): string => mkdtempSync(join(tmpdir(), `vernier-skills-cli-${label}-`))

function writeLegacyUserSkill(home: string, name: string, body: string): string {
  const dir = join(home, ".claude", "skills", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: A legacy user-tier skill. Use when testing migration.\n---\n\n${body}\n`, "utf8")
  return dir
}

describe("vernier run --skill (spawned CLI)", () => {
  it("delivers the step's declared skill: the SKILL.md body arrives embedded in the prompt, and the journal records it", async () => {
    const home = scratch("home")
    const result = await cli({ home }, "run", "skill-echo", "--json")
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as { runId: string; output: { text: string } }
    expect(outcome.output.text.startsWith("Say hello to the reviewer.")).toBe(true)
    expect(outcome.output.text).toContain('<skill name="greeting-style"')
    expect(outcome.output.text).toContain(SKILL_BODY_MARKER)

    const started = Ledger.load(journalPath(home, outcome.runId)).find((e): e is StepStartedEntry => e.type === "step_started")
    expect(started?.skills).toMatchObject({ delivery: "prompt", resolved: [{ name: "greeting-style" }] })
  })

  it("`--skill <step>=` clears the step's skills: the prompt arrives bare and the journal records none", async () => {
    const home = scratch("home")
    const result = await cli({ home }, "run", "skill-echo", "--skill", "speak=", "--json")
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as { runId: string; output: { text: string } }
    expect(outcome.output.text).toBe("Say hello to the reviewer.")

    const started = Ledger.load(journalPath(home, outcome.runId)).find((e): e is StepStartedEntry => e.type === "step_started")
    expect(started?.skills).toBeUndefined()
  })

  it("resolves a --skill override from the user tier (~/.agents/skills of $HOME)", async () => {
    const userHome = scratch("user-tier")
    const dir = join(userHome, ".agents", "skills", "home-greeting")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: home-greeting\ndescription: A user-tier greeting style. Use when greeting.\n---\n\nOpen with AHOY instead.\n",
      "utf8",
    )
    const result = await cli({ home: scratch("home"), userHome }, "run", "skill-echo", "--skill", "speak=home-greeting", "--json")
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as { output: { text: string } }
    expect(outcome.output.text).toContain("Open with AHOY instead.")
    expect(outcome.output.text).not.toContain(SKILL_BODY_MARKER) // the override REPLACED the declared skill
  })

  it("resolves a legacy ~/.claude/skills user skill for migration and warns on stderr", async () => {
    const userHome = scratch("legacy-user-tier")
    writeLegacyUserSkill(userHome, "legacy-greeting", "Open with HOWDY instead.")
    const result = await cli({ home: scratch("home"), userHome }, "run", "skill-echo", "--skill", "speak=legacy-greeting", "--json")
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as { output: { text: string } }
    expect(outcome.output.text).toContain("Open with HOWDY instead.")
    expect(result.stderr).toContain("warning:")
    expect(result.stderr).toContain(".claude/skills")
    expect(result.stderr).toContain("legacy-greeting")
  })

  it("exit 2 with the discovered inventory named when a bound skill cannot be resolved", async () => {
    const result = await cli({ home: scratch("home") }, "run", "skill-echo", "--skill", "speak=no-such-skill", "--json")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("Unresolved skill binding(s)")
    expect(result.stderr).toContain("`no-such-skill`")
    expect(result.stderr).toContain("greeting-style") // the inventory tells the user what IS available
  })

  it("exit 2 when a --skill key names no step or executor in the loop, and on malformed pairs", async () => {
    const badKey = await cli({ home: scratch("home") }, "run", "skill-echo", "--skill", "nope=greeting-style", "--json")
    expect(badKey.code).toBe(2)
    expect(badKey.stderr).toContain("names no step or executor")
    expect(badKey.stderr).toContain("speak") // the valid vocabulary is listed

    const malformed = await cli({ home: scratch("home") }, "run", "skill-echo", "--skill", "speak", "--json")
    expect(malformed.code).toBe(2)
    expect(malformed.stderr).toContain("--skill expects")
  })

  it("exit 2 on a comma-only or grammar-invalid --skill value (a typo must not silently clear skills)", async () => {
    const commaOnly = await cli({ home: scratch("home") }, "run", "skill-echo", "--skill", "speak=,,", "--json")
    expect(commaOnly.code).toBe(2)
    expect(commaOnly.stderr).toContain("not a valid skill name")
    expect(commaOnly.stderr).toContain("to clear") // points at the explicit clear form

    const badGrammar = await cli({ home: scratch("home") }, "run", "skill-echo", "--skill", "speak=Bad_Name", "--json")
    expect(badGrammar.code).toBe(2)
    expect(badGrammar.stderr).toContain("not a valid skill name")
  })

  it("repeated --skill flags for one key accumulate and de-dupe; a later empty value clears, winning over accumulation", async () => {
    // A second resolvable skill in the user tier so accumulation is observable.
    const userHome = scratch("accum-user")
    const dir = join(userHome, ".agents", "skills", "home-greeting")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: home-greeting\ndescription: A user-tier greeting. Use when greeting.\n---\n\nAHOY there.\n",
      "utf8",
    )

    // Accumulate across two flags + de-dupe a repeat within one.
    const accum = await cli(
      { home: scratch("home"), userHome },
      "run", "skill-echo", "--skill", "speak=greeting-style,greeting-style", "--skill", "speak=home-greeting", "--json",
    )
    expect(accum.code).toBe(0)
    const accumText = (JSON.parse(accum.stdout) as { output: { text: string } }).output.text
    expect(accumText).toContain('<skill name="greeting-style"')
    expect(accumText).toContain('<skill name="home-greeting"')
    expect(accumText.match(/<skill name="greeting-style"/g)?.length).toBe(1) // de-duped, not embedded twice

    // A trailing empty value clears, beating the earlier accumulation.
    const cleared = await cli(
      { home: scratch("home"), userHome },
      "run", "skill-echo", "--skill", "speak=greeting-style", "--skill", "speak=", "--json",
    )
    expect(cleared.code).toBe(0)
    expect((JSON.parse(cleared.stdout) as { output: { text: string } }).output.text).toBe("Say hello to the reviewer.")
  })

  it("doctor reports the skill inventory and the per-step resolution (exit 0: the fixture loop is runnable)", async () => {
    const result = await cli({ home: scratch("home") }, "doctor", "--json")
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as {
      ok: boolean
      skills: Array<{ name: string; ok: boolean; origin: string }>
      loops: Array<{ loopId: string; runnable: boolean; steps: Array<{ stepId: string; skills?: Array<{ name: string; ok: boolean }> }> }>
    }
    expect(report.ok).toBe(true)
    expect(report.skills).toContainEqual(expect.objectContaining({ name: "greeting-style", ok: true, origin: "config" }))
    const speak = report.loops.find((l) => l.loopId === "skill-echo")!.steps.find((s) => s.stepId === "speak")!
    expect(speak.skills).toEqual([expect.objectContaining({ name: "greeting-style", ok: true })])
  })

  it("doctor blocks the loop (exit 1) when the registered skill path is gone, naming the step and the missing skill", async () => {
    // A copy of the fixture whose config registers the skill but whose
    // skills/ dir was never scaffolded — the at-rest misconfiguration.
    const broken = scratch("broken")
    writeFileSync(join(broken, "vernier.config.json"), JSON.stringify({ loops: ["./skill-loop.mjs"] }), "utf8")
    writeFileSync(join(broken, "skill-loop.mjs"), readFileSync(join(FIXTURE, "skill-loop.mjs"), "utf8"), "utf8")

    const result = await cli({ home: scratch("home"), cwd: broken }, "doctor", "--json")
    expect(result.code).toBe(1)
    const report = JSON.parse(result.stdout) as {
      ok: boolean
      loops: Array<{ runnable: boolean; steps: Array<{ skills?: Array<{ name: string; ok: boolean; detail: string }> }> }>
    }
    expect(report.ok).toBe(false)
    const skill = report.loops[0]!.steps[0]!.skills![0]!
    expect(skill).toMatchObject({ name: "greeting-style", ok: false })
    expect(skill.detail).toContain("not discovered")
  })

  it("a run against the same misconfiguration fails BEFORE any journal write (exit 2)", async () => {
    const broken = scratch("broken-run")
    writeFileSync(join(broken, "vernier.config.json"), JSON.stringify({ loops: ["./skill-loop.mjs"] }), "utf8")
    writeFileSync(join(broken, "skill-loop.mjs"), readFileSync(join(FIXTURE, "skill-loop.mjs"), "utf8"), "utf8")
    const home = scratch("home")

    const result = await cli({ home, cwd: broken }, "run", "skill-echo", "--json")
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("Unresolved skill binding(s)")

    const runs = await cli({ home, cwd: broken }, "runs", "--json")
    expect(JSON.parse(runs.stdout)).toEqual([]) // nothing journaled
  })

  it("`vernier skills` enumerates the inventory (the cheap parity with `vernier loops`), in --json and human form", async () => {
    const json = await cli({ home: scratch("home") }, "skills", "--json")
    expect(json.code).toBe(0)
    const rows = JSON.parse(json.stdout) as Array<{ name: string | null; origin: string; ok: boolean; description?: string }>
    expect(rows).toContainEqual(expect.objectContaining({ name: "greeting-style", origin: "config", ok: true }))

    const human = await cli({ home: scratch("home") }, "skills")
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("greeting-style")
    expect(human.stdout).toContain("[config]")
  })

  it("`vernier skills --json` keeps JSON on stdout and warns on stderr for legacy ~/.claude/skills", async () => {
    const userHome = scratch("legacy-skills-list")
    writeLegacyUserSkill(userHome, "legacy-listing", "List me during migration.")
    const result = await cli({ home: scratch("home"), userHome, cwd: scratch("no-config") }, "skills", "--json")
    expect(result.code).toBe(0)
    const rows = JSON.parse(result.stdout) as Array<{ name: string | null; origin: string; ok: boolean; dir: string }>
    expect(rows).toContainEqual(expect.objectContaining({ name: "legacy-listing", origin: "user", ok: true }))
    expect(result.stderr).toContain("warning:")
    expect(result.stderr).toContain(".claude/skills")
    expect(result.stderr).toContain("legacy-listing")
  })

  it("doctor reports legacy ~/.claude/skills warnings in both JSON and human output", async () => {
    const broken = scratch("legacy-doctor")
    writeFileSync(join(broken, "vernier.config.json"), JSON.stringify({ loops: ["./skill-loop.mjs"] }), "utf8")
    writeFileSync(join(broken, "skill-loop.mjs"), readFileSync(join(FIXTURE, "skill-loop.mjs"), "utf8"), "utf8")
    const userHome = scratch("legacy-doctor-home")
    writeLegacyUserSkill(userHome, "greeting-style", "Always open with HOWDY during migration.")

    const json = await cli({ home: scratch("home"), userHome, cwd: broken }, "doctor", "--json")
    expect(json.code).toBe(0)
    const report = JSON.parse(json.stdout) as { warnings: string[]; skills: Array<{ name: string; origin: string; ok: boolean }> }
    expect(report.skills).toContainEqual(expect.objectContaining({ name: "greeting-style", origin: "user", ok: true }))
    expect(report.warnings).toEqual([expect.stringContaining("greeting-style")])
    expect(report.warnings[0]).toContain(".claude/skills")
    expect(json.stderr).toContain("warning:")
    expect(json.stderr).toContain(".claude/skills")

    const human = await cli({ home: scratch("home"), userHome, cwd: broken }, "doctor")
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("WARNINGS")
    expect(human.stdout).toContain(".claude/skills")
    expect(human.stdout).toContain("greeting-style")
  })

  it("warns when vernier.config explicitly registers a legacy .claude/skills parent", async () => {
    const project = scratch("legacy-config")
    writeFileSync(join(project, "vernier.config.json"), JSON.stringify({ skills: ["./.claude/skills"] }), "utf8")
    const dir = join(project, ".claude", "skills", "legacy-configured")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: legacy-configured\ndescription: A config-registered legacy skill. Use when testing migration.\n---\n\nConfigured legacy body.\n",
      "utf8",
    )

    const result = await cli({ home: scratch("home"), cwd: project }, "skills", "--json")
    expect(result.code).toBe(0)
    const rows = JSON.parse(result.stdout) as Array<{ name: string | null; origin: string; ok: boolean }>
    expect(rows).toContainEqual(expect.objectContaining({ name: "legacy-configured", origin: "config", ok: true }))
    expect(result.stderr).toContain("warning:")
    expect(result.stderr).toContain(".claude/skills")
    expect(result.stderr).toContain("legacy-configured")
  })

  it("a --json output larger than the 64KB pipe buffer arrives COMPLETE (exit discipline: drain, never process.exit)", async () => {
    // A user tier big enough that `skills --json` exceeds the pipe buffer:
    // process.exit() after writing would truncate mid-document (the bug this
    // pins was found live against a ~190-skill machine).
    const userHome = scratch("big-tier")
    const filler = "x".repeat(900)
    for (let i = 0; i < 90; i++) {
      const name = `bulk-skill-${String(i).padStart(2, "0")}`
      const dir = join(userHome, ".agents", "skills", name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Bulk fixture ${i}. ${filler}\n---\n\nbody\n`, "utf8")
    }
    const result = await cli({ home: scratch("home"), userHome }, "skills", "--json")
    expect(result.code).toBe(0)
    expect(result.stdout.length).toBeGreaterThan(65536) // past the pipe buffer
    const rows = JSON.parse(result.stdout) as Array<{ name: string | null }> // parses ⇔ it arrived whole
    expect(rows.filter((r) => r.name?.startsWith("bulk-skill-"))).toHaveLength(90)
  })

  it("`vernier skills --json` is [] with a friendly stderr when nothing is discovered (exit 0; not a health check)", async () => {
    // A cwd with no config above it and an empty user tier: zero skills.
    const empty = await cli({ home: scratch("home"), userHome: scratch("empty-user"), cwd: scratch("no-config") }, "skills", "--json")
    expect(empty.code).toBe(0)
    expect(JSON.parse(empty.stdout)).toEqual([])
    expect(empty.stderr).toContain("no skills discovered")
  })

  it("errors emit a structured JSON document on stdout under --json (not just stderr prose), with exit code preserved", async () => {
    const result = await cli({ home: scratch("home") }, "run", "skill-echo", "--skill", "speak=no-such-skill", "--json")
    expect(result.code).toBe(2)
    const doc = JSON.parse(result.stdout) as { error: string; type: string; exitCode: number }
    expect(doc.type).toBe("usage_error")
    expect(doc.exitCode).toBe(2)
    expect(doc.error).toContain("Unresolved skill binding")
    // Human diagnostics still go to stderr.
    expect(result.stderr).toContain("usage error")
  })
})

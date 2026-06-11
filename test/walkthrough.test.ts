// Rot guard for docs/walkthrough.md §8–9: drives examples/getting-started/
// through the CLI surface exactly as the walkthrough does — config loaded,
// loop listed, run green, rebinding honored (both the passing and the
// contract-failing alternate), crash -> resume. If this file goes red, the
// walkthrough's centerpiece is lying; fix the example or the doc, not the
// test.

import { execFile } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { Ledger, journalPath } from "../src/ledger/ledger.js"

const execFileAsync = promisify(execFile)
const BIN = join(import.meta.dirname, "..", "bin", "vernier.js")
const CONFIG = join(import.meta.dirname, "..", "examples", "getting-started", "vernier.config.json")

const HAIKU = "a vernier scale\nthe engine ticks on, dusk\nthe ledger recalls"

interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Run the real bin against the getting-started config, as the walkthrough's reader does. */
async function cli(home: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  const env = { ...process.env, VERNIER_HOME: home, VERNIER_CONFIG: CONFIG, ...extraEnv }
  delete (env as Record<string, unknown>).GETTING_STARTED_CRASH // never inherit the crash hook
  Object.assign(env, extraEnv)
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], { env, encoding: "utf8", timeout: 60_000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number | null; signal?: string | null; stdout?: string; stderr?: string }
    // A SIGKILLed child reports a signal, not a code; fold it to non-zero.
    return { code: e.code ?? (e.signal ? 137 : 1), stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}

const tmp = (label: string): string => mkdtempSync(join(tmpdir(), `vernier-walkthrough-${label}-`))

describe("walkthrough §8: examples/getting-started through the CLI", () => {
  it("the config registers haiku-review alongside the builtins", async () => {
    const result = await cli(tmp("home"), ["loops", "--json"])
    expect(result.code).toBe(0)
    const loops = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    const haiku = loops.find((l) => l.id === "haiku-review")
    expect(haiku).toMatchObject({
      version: "0.1.0",
      trust: "dry-run",
      live: false,
      steps: ["compose", "review"],
    })
    expect(String(haiku!.source)).toContain("haiku-loop.mjs")
  })

  it("`run haiku-review` is green with the default topic: 5-7-5, contracts pass, exit 0", async () => {
    const result = await cli(tmp("home"), ["run", "haiku-review", "--workdir", tmp("work"), "--json"])
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as Record<string, unknown>
    expect(outcome.status).toBe("done")
    expect(outcome.output).toEqual({ haiku: HAIKU, syllables: [5, 7, 5], verdict: "success" })
  })

  it("rebinding compose onto haiku-bot-loud (a config-level executor) still verifies", async () => {
    const result = await cli(tmp("home"), [
      "run", "haiku-review", "--workdir", tmp("work"), "--executor", "compose=haiku-bot-loud", "--json",
    ])
    expect(result.code).toBe(0)
    const outcome = JSON.parse(result.stdout) as { status: string; output: { haiku: string; syllables: number[] } }
    expect(outcome.status).toBe("done")
    expect(outcome.output.haiku).toBe(HAIKU.toUpperCase())
    expect(outcome.output.syllables).toEqual([5, 7, 5])
  })

  it("rebinding compose onto free-verse-bot fails the step's contract: escalate, exit 1", async () => {
    const result = await cli(tmp("home"), [
      "run", "haiku-review", "--workdir", tmp("work"), "--executor", "compose=free-verse-bot", "--json",
    ])
    expect(result.code).toBe(1)
    const outcome = JSON.parse(result.stdout) as Record<string, unknown>
    expect(outcome.status).toBe("needs_human")
    expect((outcome.decision as { summary: string }).summary).toContain("three lines")
  })

  it("§9: a crashed run resumes from its ledger — compose replays, review re-executes, done", async () => {
    const home = tmp("home")
    const work = tmp("work")

    const crashed = await cli(home, ["run", "haiku-review", "--workdir", work, "--json"], { GETTING_STARTED_CRASH: "1" })
    expect(crashed.code).not.toBe(0) // SIGKILLed mid-run by the example's crash hook

    const runs = await cli(home, ["runs", "--json"])
    const listed = JSON.parse(runs.stdout) as Array<{ runId: string; status: string }>
    expect(listed).toHaveLength(1)
    expect(listed[0]!.status).toBe("running") // non-terminal: the journal stops at review started
    const runId = listed[0]!.runId

    const resumed = await cli(home, ["resume", runId, "--json"])
    expect(resumed.code).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ runId, status: "done", resumed: true })
    expect(resumed.stderr).toContain("took over a stale lease")

    // Resume replayed compose from the ledger (one execution) and re-ran
    // only the torn review step (started pre-crash, started again on resume).
    const entries = Ledger.load(journalPath(home, runId))
    expect(entries.filter((e) => e.type === "step_started" && e.stepId === "compose")).toHaveLength(1)
    expect(entries.filter((e) => e.type === "step_started" && e.stepId === "review")).toHaveLength(2)
    expect(entries.filter((e) => e.type === "step_result" && e.stepId === "review")).toHaveLength(1)
  })
})

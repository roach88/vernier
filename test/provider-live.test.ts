import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { runLoop } from "../src/engine/tick.js"
import { resolveCursorBin } from "../src/executors/cursor-bin.js"
import { CursorExecutor } from "../src/executors/cursor.js"
import { executorRegistry } from "../src/executors/script.js"
import { artifactFromEffects, type EffectObservation } from "../src/kernel/effects.js"
import { gitObserver } from "../src/kernel/git-effects.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { decideNextStep } from "../src/kernel/policy.js"
import { fsScope, noEffects, sig, type Loop, type StepSpec } from "../src/kernel/types.js"
import { journalPath, Ledger, type LedgerEntry } from "../src/ledger/ledger.js"

const LIVE_CURSOR_REQUESTED = process.env.VERNIER_LIVE === "1" && process.env.VERNIER_LIVE_CURSOR === "1"
const LIVE_CURSOR_WRITE_REQUESTED = LIVE_CURSOR_REQUESTED && process.env.VERNIER_LIVE_CURSOR_WRITE === "1"
const LIVE_CURSOR_WRITE_OUT_OF_SCOPE_REQUESTED = LIVE_CURSOR_WRITE_REQUESTED && process.env.VERNIER_LIVE_CURSOR_WRITE_OUT_OF_SCOPE === "1"
const CURSOR_MODEL = process.env.VERNIER_CURSOR_MODEL

function spec(): StepSpec {
  return {
    runId: "cursor-live",
    traceId: "cursor-live",
    loopId: "provider-live",
    loopVersion: "0.1.0",
    stepId: "cursor",
    attempt: 1,
    iteration: 1,
    inputs: {},
    prompt: "Reply with exactly this text: vernier cursor live proof",
    effects: noEffects(),
    runDir: mkdtempSync(join(tmpdir(), "vernier-cursor-live-run-")),
    timeoutMs: 180_000,
  }
}

function cursorExecutor(): CursorExecutor {
  const cursor = resolveCursorBin({ env: process.env })
  return new CursorExecutor({ bin: cursor.bin, ...(CURSOR_MODEL ? { model: CURSOR_MODEL } : {}) })
}

function cursorAvailable(): boolean {
  return LIVE_CURSOR_REQUESTED && resolveCursorBin({ env: process.env }).ok
}

function scratchGitWorkdir(): string {
  const workdir = mkdtempSync(join(tmpdir(), "vernier-cursor-live-work-"))
  execFileSync("git", ["init"], { cwd: workdir, stdio: "ignore", timeout: 30_000 })
  return workdir
}

function liveWriteLoop(ledgerRoot: string, prompt: string): Loop<Record<string, never>, { path: string }> {
  return {
    id: "cursor-live-write",
    version: "0.1.0",
    signature: sig(z.object({}), z.object({ path: z.string() })),
    steps: [
      {
        id: "cursor",
        signature: sig(z.object({}), z.object({ path: z.string() })),
        executor: "cursor-agent",
        effects: fsScope("docs/**"),
        outputFrom: artifactFromEffects("path", "docs/**"),
        prompt: () => prompt,
      },
    ],
    policy: decideNextStep,
    trust: "dry-run",
    ledger: { root: ledgerRoot },
  }
}

function effectObservation(entries: readonly LedgerEntry[]): EffectObservation {
  const entry = entries.find((e) => e.type === "effects")
  if (entry?.type !== "effects") throw new Error("missing effects entry")
  return entry.observation
}

describe("cursor-agent live proof", () => {
  it.skipIf(!cursorAvailable())(
    "runs a no-effects Cursor step through the Executor seam",
    async () => {
      const executor = cursorExecutor()
      const result = await executor.run(spec(), { workdir: mkdtempSync(join(tmpdir(), "vernier-cursor-live-work-")) })
      expect(result.status).toBe("completed")
      expect(String(result.output.text).length).toBeGreaterThan(0)
    },
    240_000,
  )

  it.skipIf(!(cursorAvailable() && LIVE_CURSOR_WRITE_REQUESTED))(
    "runs a workspace-write Cursor step and records allowed effects in the ledger",
    async () => {
      const workdir = scratchGitWorkdir()
      const ledgerRoot = mkdtempSync(join(tmpdir(), "vernier-cursor-live-ledger-"))
      const prompt =
        "Create exactly one file at docs/cursor-live-proof.md with this exact text: vernier cursor live write proof\n" +
        "Do not edit any other files. Reply with a short confirmation."

      const outcome = await runLoop(liveWriteLoop(ledgerRoot, prompt), {}, {
        executors: executorRegistry(cursorExecutor()),
        contracts: new ContractRegistry(),
        workdir,
        observer: gitObserver,
      })

      expect(outcome.state.status).toBe("done")
      const effects = effectObservation(Ledger.load(journalPath(ledgerRoot, outcome.state.runId)))
      expect(effects.changed).toEqual(["docs/cursor-live-proof.md"])
      expect(effects.allowed).toBe(true)
      expect(effects.unexpected).toEqual([])
    },
    300_000,
  )

  it.skipIf(!(cursorAvailable() && LIVE_CURSOR_WRITE_OUT_OF_SCOPE_REQUESTED))(
    "escalates a live Cursor write that changes files outside scope",
    async () => {
      const workdir = scratchGitWorkdir()
      const ledgerRoot = mkdtempSync(join(tmpdir(), "vernier-cursor-live-ledger-"))
      const prompt =
        "Create docs/cursor-live-proof.md with text: allowed\n" +
        "Also create escaped.txt with text: outside scope\n" +
        "Reply with a short confirmation."

      const outcome = await runLoop(liveWriteLoop(ledgerRoot, prompt), {}, {
        executors: executorRegistry(cursorExecutor()),
        contracts: new ContractRegistry(),
        workdir,
        observer: gitObserver,
      })

      expect(outcome.state.status).toBe("needs_human")
      const effects = effectObservation(Ledger.load(journalPath(ledgerRoot, outcome.state.runId)))
      expect(effects.unexpected).toContain("escaped.txt")
      expect(effects.allowed).toBe(false)
    },
    300_000,
  )
})

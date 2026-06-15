import { dirname, join } from "node:path"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { runLoop, type EngineDeps } from "../src/engine/tick.js"
import { CursorExecutor } from "../src/executors/cursor.js"
import { type Worker } from "../src/executors/vendor/omegacode/index.js"
import { type AgentSpec } from "../src/executors/vendor/omegacode/types.js"
import { executorRegistry } from "../src/executors/script.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { decideNextStep } from "../src/kernel/policy.js"
import { fsScope, sig, type Loop } from "../src/kernel/types.js"
import { journalPath, Ledger, type LedgerEntry } from "../src/ledger/ledger.js"
import type { EffectObservation } from "../src/kernel/effects.js"

function temp(): { workdir: string; ledgerRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "vernier-cursor-effects-"))
  const workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  return { workdir, ledgerRoot: join(root, "ledger") }
}

function deps(workdir: string, cursor: CursorExecutor): EngineDeps {
  return {
    executors: executorRegistry(cursor),
    contracts: new ContractRegistry(),
    workdir,
  }
}

function loop(ledgerRoot: string): Loop<Record<string, never>, { text: string }> {
  return {
    id: "cursor-effects",
    version: "0.1.0",
    signature: sig(z.object({}), z.object({ text: z.string() })),
    steps: [
      {
        id: "write",
        signature: sig(z.object({}), z.object({ text: z.string() })),
        executor: "cursor-agent",
        effects: fsScope("docs/**"),
        prompt: () => "Write the requested file.",
      },
    ],
    policy: decideNextStep,
    trust: "dry-run",
    ledger: { root: ledgerRoot },
  }
}

function writingCursor(paths: readonly string[]): CursorExecutor {
  const worker: Worker = {
    id: "cursor-agent",
    async runAgent(spec: AgentSpec) {
      for (const path of paths) {
        const absolute = join(spec.cwd, path)
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, `wrote ${path}`, "utf8")
      }
      return { text: "ok", status: "completed", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
    },
    async shutdown() {},
  }
  return new CursorExecutor({ worker })
}

function effectObservation(entries: readonly LedgerEntry[]): EffectObservation {
  const entry = entries.find((e) => e.type === "effects")
  if (entry?.type !== "effects") throw new Error("missing effects entry")
  return entry.observation
}

describe("CursorExecutor effects integration", () => {
  it("journals allowed Cursor writes as allowed effects", async () => {
    const { workdir, ledgerRoot } = temp()
    const outcome = await runLoop(loop(ledgerRoot), {}, deps(workdir, writingCursor(["docs/cursor-proof.md"])))

    expect(outcome.state.status).toBe("done")
    const effects = effectObservation(Ledger.load(journalPath(ledgerRoot, outcome.state.runId)))
    expect(effects).toEqual({
      changed: ["docs/cursor-proof.md"],
      allowed: true,
      unexpected: [],
    })
  })

  it("escalates out-of-scope Cursor writes through effects observation", async () => {
    const { workdir, ledgerRoot } = temp()
    const outcome = await runLoop(loop(ledgerRoot), {}, deps(workdir, writingCursor(["docs/cursor-proof.md", "escaped.txt"])))

    expect(outcome.state.status).toBe("needs_human")
    const effects = effectObservation(Ledger.load(journalPath(ledgerRoot, outcome.state.runId)))
    expect(effects.changed).toEqual(["docs/cursor-proof.md", "escaped.txt"])
    expect(effects.allowed).toBe(false)
    expect(effects.unexpected).toEqual(["escaped.txt"])
  })
})

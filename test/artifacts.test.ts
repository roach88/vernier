// Effect artifacts: artifactFromEffects projects one path-valued output
// field from effect attribution. It supports only exact paths and `dir/**`
// prefixes; zero or several matches intentionally project no field so the
// signature fails deterministically and the policy decides.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { runLoop, type EngineDeps } from "../src/engine/tick.js"
import { executorRegistry, scriptExecutor, type ScriptFn } from "../src/executors/script.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { artifactFromEffects } from "../src/kernel/effects.js"
import { retryPolicy } from "../src/kernel/policy.js"
import { fsScope, sig, type Loop, type OutputProjection } from "../src/kernel/types.js"

function setup() {
  const root = mkdtempSync(join(tmpdir(), "vernier-artifacts-"))
  const workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  return { workdir, ledgerRoot: join(root, "ledger") }
}

function writer(files: readonly string[]): ScriptFn {
  return (_spec, ctx) => {
    for (const file of files) {
      const absolute = join(ctx.workdir, file)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, `content of ${file}\n`, "utf8")
    }
    return { output: { text: `wrote ${files.length} file(s)` } }
  }
}

function artifactLoop(ledgerRoot: string, projection: OutputProjection): Loop {
  return {
    id: "single-artifact",
    version: "0.1.0",
    signature: sig(z.object({}), z.object({ verdict: z.string() }).passthrough()),
    steps: [
      {
        id: "write",
        signature: sig(z.object({}), z.object({ artifact: z.string() })),
        executor: "writer",
        effects: fsScope("notes/**"),
        outputFrom: projection,
      },
    ],
    policy: retryPolicy({ maxAttempts: 1 }),
    trust: "dry-run",
    ledger: { root: ledgerRoot },
  }
}

function deps(workdir: string, fn: ScriptFn): EngineDeps {
  return { executors: executorRegistry(scriptExecutor("writer", fn)), contracts: new ContractRegistry(), workdir }
}

describe("artifactFromEffects", () => {
  it("projects one changed-and-allowed file when exactly one candidate exists", async () => {
    const { workdir, ledgerRoot } = setup()
    const loop = artifactLoop(ledgerRoot, artifactFromEffects("artifact"))
    const outcome = await runLoop(loop, {}, deps(workdir, writer(["notes/a.md"])))
    expect(outcome.state.status).toBe("done")
    expect((outcome.output as { artifact: string }).artifact).toBe("notes/a.md")
  })

  it("exact path filtering disambiguates multiple changed files", async () => {
    const { workdir, ledgerRoot } = setup()
    const loop = artifactLoop(ledgerRoot, artifactFromEffects("artifact", "notes/a.md"))
    const outcome = await runLoop(loop, {}, deps(workdir, writer(["notes/a.md", "notes/data.json"])))
    expect(outcome.state.status).toBe("done")
    expect((outcome.output as { artifact: string }).artifact).toBe("notes/a.md")
  })

  it("dir/** prefix filtering narrows to a subtree", async () => {
    const { workdir, ledgerRoot } = setup()
    const loop = artifactLoop(ledgerRoot, artifactFromEffects("artifact", "notes/sub/**"))
    const outcome = await runLoop(loop, {}, deps(workdir, writer(["notes/a.md", "notes/sub/b.md"])))
    expect(outcome.state.status).toBe("done")
    expect((outcome.output as { artifact: string }).artifact).toBe("notes/sub/b.md")
  })

  it("no matching files -> no field -> the signature fails deterministically and the policy decides", async () => {
    const { workdir, ledgerRoot } = setup()
    const loop = artifactLoop(ledgerRoot, artifactFromEffects("artifact", "notes/sub/**"))
    const outcome = await runLoop(loop, {}, deps(workdir, writer(["notes/data.json"])))
    expect(outcome.state.status).toBe("needs_human")
    expect(outcome.decision.kind).toBe("escalate")
    expect(outcome.decision.summary).toContain("signature")
  })

  it("several matching files still refuse: artifact projection is exactly-one", async () => {
    const { workdir, ledgerRoot } = setup()
    const loop = artifactLoop(ledgerRoot, artifactFromEffects("artifact"))
    const outcome = await runLoop(loop, {}, deps(workdir, writer(["notes/a.md", "notes/b.md"])))
    expect(outcome.state.status).toBe("needs_human")
    expect(outcome.decision.summary).toContain("signature")
  })

  it("rejects unsupported mini-glob patterns up front", () => {
    expect(() => artifactFromEffects("artifact", "notes/**/*.md")).toThrow(/exact paths or dir\/\*\*/)
    expect(() => artifactFromEffects("artifact", "notes/*.md")).toThrow(/exact paths or dir\/\*\*/)
  })
})

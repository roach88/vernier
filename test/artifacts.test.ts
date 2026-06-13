// Multi-file effect artifacts: artifactsFromEffects projects path-valued
// output fields from effect attribution — one path (Pilot 1's pinned-note
// shape) or many (real coding tasks change several files). All proven with
// fake executors through the real tick engine; the failure case is the
// deterministic no-field -> signature-fails -> policy-decides path.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { runLoop, type EngineDeps } from "../src/engine/tick.js"
import { executorRegistry, scriptExecutor, type ScriptFn } from "../src/executors/script.js"
import { ContractRegistry } from "../src/kernel/contract.js"
import { artifactFromEffects, artifactsFromEffects, globMatch } from "../src/kernel/effects.js"
import { retryPolicy } from "../src/kernel/policy.js"
import { fsScope, sig, type Loop, type OutputProjection } from "../src/kernel/types.js"

describe("globMatch", () => {
  it("`*` stays within a segment; `**` crosses segments; `**/` matches zero or more whole segments", () => {
    expect(globMatch("notes/*.md", "notes/a.md")).toBe(true)
    expect(globMatch("notes/*.md", "notes/sub/a.md")).toBe(false)
    expect(globMatch("notes/**/*.md", "notes/a.md")).toBe(true)
    expect(globMatch("notes/**/*.md", "notes/sub/deep/a.md")).toBe(true)
    expect(globMatch("notes/**/*.md", "notes/a.json")).toBe(false)
    expect(globMatch("notes/**", "notes/sub/a.json")).toBe(true)
    expect(globMatch("notes/**", "other/a.md")).toBe(false)
    expect(globMatch("**/*.md", "a.md")).toBe(true)
    expect(globMatch("**/*.md", "x/y/a.md")).toBe(true)
    expect(globMatch("notes/a.md", "notes/a.md")).toBe(true) // exact, no wildcards
    expect(globMatch("notes/a.md", "notes/aXmd")).toBe(false) // `.` is literal
  })
})

// ------------------------------------------------------------ loop fixture

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

/** A one-step loop whose `artifacts` output is projected from effects. */
function artifactLoop(ledgerRoot: string, projection: OutputProjection, output: z.ZodType<any, any>): Loop {
  return {
    id: "multi-artifact",
    version: "0.1.0",
    signature: sig(z.object({}), z.object({ verdict: z.string() }).passthrough()),
    steps: [
      {
        id: "write",
        signature: sig(z.object({}), output),
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

const manyOutput = z.object({ artifacts: z.array(z.string()).min(1) })

describe("artifactsFromEffects", () => {
  it('arity "many": the loop output carries ALL changed-and-allowed files', async () => {
    const { workdir, ledgerRoot } = setup()
    const loop = artifactLoop(ledgerRoot, artifactsFromEffects("artifacts", { arity: "many" }), manyOutput)
    const files = ["notes/a.md", "notes/sub/b.md", "notes/data.json"]
    const outcome = await runLoop(loop, {}, deps(workdir, writer(files)))
    expect(outcome.state.status).toBe("done")
    expect(outcome.output).toMatchObject({ artifacts: files.slice().sort(), verdict: "success" })
  })

  it('arity "many" + pattern: only matching changed files count as the artifact', async () => {
    const { workdir, ledgerRoot } = setup()
    const loop = artifactLoop(ledgerRoot, artifactsFromEffects("artifacts", { arity: "many", pattern: "notes/**/*.md" }), manyOutput)
    const outcome = await runLoop(loop, {}, deps(workdir, writer(["notes/a.md", "notes/sub/b.md", "notes/data.json"])))
    expect(outcome.state.status).toBe("done")
    expect((outcome.output as { artifacts: string[] }).artifacts).toEqual(["notes/a.md", "notes/sub/b.md"])
  })

  it("no matching files -> no field -> the signature fails deterministically and the policy decides", async () => {
    const { workdir, ledgerRoot } = setup()
    const loop = artifactLoop(ledgerRoot, artifactsFromEffects("artifacts", { arity: "many", pattern: "notes/**/*.md" }), manyOutput)
    // The step completes but writes only a non-matching file: zero candidates.
    const outcome = await runLoop(loop, {}, deps(workdir, writer(["notes/data.json"])))
    expect(outcome.state.status).toBe("needs_human") // retryPolicy(max 1): retry -> escalate
    expect(outcome.decision.kind).toBe("escalate")
    expect(outcome.decision.summary).toContain("signature")
  })

  it('arity "one" + pattern disambiguates: two changed files, one matching -> that path (Pilot 1 semantics kept)', async () => {
    const { workdir, ledgerRoot } = setup()
    const oneOutput = z.object({ artifacts: z.string() })
    const loop = artifactLoop(ledgerRoot, artifactFromEffects("artifacts", "notes/**/*.md"), oneOutput)
    const outcome = await runLoop(loop, {}, deps(workdir, writer(["notes/a.md", "notes/data.json"])))
    expect(outcome.state.status).toBe("done")
    expect((outcome.output as { artifacts: string }).artifacts).toBe("notes/a.md")
  })

  it('arity "one" with several matches still refuses (exactly-one stays exactly-one)', async () => {
    const { workdir, ledgerRoot } = setup()
    const oneOutput = z.object({ artifacts: z.string() })
    const loop = artifactLoop(ledgerRoot, artifactFromEffects("artifacts"), oneOutput)
    const outcome = await runLoop(loop, {}, deps(workdir, writer(["notes/a.md", "notes/b.md"])))
    expect(outcome.state.status).toBe("needs_human")
    expect(outcome.decision.summary).toContain("signature")
  })
})

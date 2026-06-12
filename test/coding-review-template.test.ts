// The coding-review template (templates/coding-review) through the generic
// tick interpreter with FAKE executors — the loop declaration cannot tell
// the difference, which is the agent-agnosticism claim in test form. The
// loop's steps declare the BINDING TARGET `agent`; the shipped config binds
// both roles to codex, and these suites bind them onto fakes through the
// same bindExecutors resolution the CLI applies. This carries the kernel
// coverage the in-tree Pilot 1 suite pinned: the contract-pass path, the
// route-rejected path (needs_human, no retry), the contract-FAIL -> retry ->
// escalate path, route-role generalization (any structured-output executor
// fills the gate), and binding precedence (CLI layer > config layer > loop
// default).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { bindExecutors } from "../src/cli/config.js"
import { runLoop, startRun, tick, type EngineDeps } from "../src/engine/tick.js"
import { defaultContractRegistry } from "../src/kernel/contract.js"
import type { Contract } from "../src/kernel/contract.js"
import type { Loop, PromptTemplate, StepSpec } from "../src/kernel/types.js"
import { Ledger, journalPath } from "../src/ledger/ledger.js"
import { executorRegistry, scriptExecutor } from "../src/executors/script.js"
import { discoverSkills } from "../src/skills/skills.js"
import { templateBindings, templateModule, templateRegistration, templateSkills } from "./templates.js"

const registration = await templateRegistration("coding-review", "coding-review-loop.mjs")
const mod = await templateModule("coding-review", "coding-review-loop.mjs")
const expectedArtifactPath = mod.expectedArtifactPath as (traceId: string) => string
const planWorkReviewLoop = registration.loop as Loop

const TASK = "Create the dry-run note. Do not edit any other file."

function setup() {
  const root = mkdtempSync(join(tmpdir(), "vernier-coding-review-"))
  const workdir = join(root, "work")
  mkdirSync(workdir, { recursive: true })
  return {
    workdir,
    ledgerRoot: join(root, "ledger"),
    // The test cast: route on a fake gate, implement on a fake worker —
    // bound through the same layer mechanism the CLI uses.
    loop: (lr: string) =>
      bindExecutors({ ...planWorkReviewLoop, ledger: { root: lr } }, [
        new Map([
          ["route", "fake-gate"],
          ["implement", "fake-worker"],
        ]),
      ]),
  }
}

/** A fake gate: returns the decision verbatim, like a router parsing route JSON. */
function fakeGate(gateDecision: string, routeToWorker = true, worker = "Implement") {
  return scriptExecutor("fake-gate", () => ({
    output: {
      gateDecision,
      routeToWorker,
      worker,
      reason: "Task is narrow, local, harmless, reviewable.",
      route: { gate_decision: gateDecision, route_to_worker: routeToWorker, worker },
    },
  }))
}

/** Render a note satisfying dry-run-note.v1 for this spec (what a live agent is asked to write). */
function conformingNote(spec: Omit<StepSpec, "prompt">): string {
  const expected = expectedArtifactPath(spec.traceId)
  return `# Dry-Run Note: ${spec.traceId}

## Route
- loop_id: \`${spec.loopId}\`
- loop_version: \`${spec.loopVersion}\`
- worker: \`implement\` executed the worker pass after the router approved the route.

## Bundle
- bundle path: \`${spec.runDir}\`
- artifact path: \`${expected}\`

## Runner Verification
The runner validates this artifact against the contract and writes the trace.

## Improvement Candidate
Drive this loop from the scheduler instead of a manual run.
`
}

/**
 * A fake worker: writes a note (conforming or not) and reports only prose —
 * the `artifact` output field must come from the engine's effect attribution.
 */
function fakeWorker(opts: { conforming: boolean }) {
  return scriptExecutor("fake-worker", (spec, ctx) => {
    const expected = expectedArtifactPath(spec.traceId)
    const absolute = join(ctx.workdir, expected)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, opts.conforming ? conformingNote(spec) : `# A note that ignores the contract\n\nNothing required is here.\n`, "utf8")
    return { output: { text: "Wrote the dry-run note." } }
  })
}

// The template's shipped skill registrations, discovered the way the CLI
// would discover them (implement declares skills: ["dry-run-note-style"]).
const templateSkillRegistry = discoverSkills({ explicit: templateSkills("coding-review") })

function deps(workdir: string, executors: ReturnType<typeof scriptExecutor>[]): EngineDeps {
  const contracts = defaultContractRegistry()
  for (const contract of registration.contracts ?? []) contracts.register(contract as Contract)
  return {
    executors: executorRegistry(...executors),
    contracts,
    workdir,
    skills: templateSkillRegistry.skills,
  }
}

describe("coding-review template: plan-work-review through tick()", () => {
  it("declares NO provider: both steps name the binding target `agent`; the shipped config binds them", () => {
    expect(planWorkReviewLoop.id).toBe("plan-work-review")
    expect(planWorkReviewLoop.steps.map((s) => s.executor)).toEqual(["agent", "agent"])
    // The shipped vernier.config.json is the layer that names a provider.
    expect(templateBindings("coding-review")).toEqual(
      new Map([
        ["route", "codex"],
        ["implement", "codex"],
      ]),
    )
  })

  it("contract-pass path: route -> implement -> done, with artifact and verdict", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    const d = deps(workdir, [fakeGate("approve"), fakeWorker({ conforming: true })])

    const outcome = await runLoop(loop(ledgerRoot), { task: TASK }, d)

    expect(outcome.state.status).toBe("done")
    expect(outcome.decision.kind).toBe("stop")
    expect(outcome.output?.verdict).toBe("success")
    expect(outcome.output?.artifact).toBe(expectedArtifactPath(outcome.state.traceId))

    const entries = Ledger.load(journalPath(ledgerRoot, outcome.state.runId))
    expect(entries.map((e) => e.type)).toEqual([
      "meta",
      "step_started", "step_result", "contract", "effects", "decision", // route
      "step_started", "step_result", "contract", "effects", "decision", // implement
    ])
    const contracts = entries.filter((e) => e.type === "contract")
    expect(contracts.map((c) => (c.type === "contract" ? c.result.valid : null))).toEqual([true, true])
    const effects = entries.filter((e) => e.type === "effects").at(-1)
    expect(effects?.type === "effects" && effects.observation.changed).toEqual([expectedArtifactPath(outcome.state.traceId)])
  })

  it("implement declares the shipped Agent Skill, and its SKILL.md body reaches the bound worker's prompt, delimited and attributed", async () => {
    // The declaration is loop data; the registration is the template's config.
    expect(planWorkReviewLoop.steps.find((s) => s.id === "implement")?.skills).toEqual(["dry-run-note-style"])
    expect(planWorkReviewLoop.steps.find((s) => s.id === "route")?.skills).toBeUndefined()
    expect(templateSkillRegistry.skills.get("dry-run-note-style")).toMatchObject({ origin: "config" })

    const { workdir, ledgerRoot, loop } = setup()
    let seenPrompt = ""
    const spy = scriptExecutor("fake-worker", (spec, ctx) => {
      seenPrompt = spec.prompt ?? ""
      const absolute = join(ctx.workdir, expectedArtifactPath(spec.traceId))
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, conformingNote(spec), "utf8")
      return { output: { text: "ok" } }
    })
    const outcome = await runLoop(loop(ledgerRoot), { task: TASK }, deps(workdir, [fakeGate("approve"), spy]))
    expect(outcome.state.status).toBe("done")
    expect(seenPrompt).toContain('<skill name="dry-run-note-style"')
    expect(seenPrompt).toContain("Runner dry-run note style") // the SKILL.md body itself

    const started = Ledger.load(journalPath(ledgerRoot, outcome.state.runId)).filter((e) => e.type === "step_started")
    expect(started.at(-1)).toMatchObject({ skills: { delivery: "prompt", resolved: [{ name: "dry-run-note-style" }] } })
  })

  it("threads the route decision into the implement step's inputs (the data plane)", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    let seenRoute: unknown
    const spy = scriptExecutor("fake-worker", (spec, ctx) => {
      seenRoute = spec.inputs.route
      const absolute = join(ctx.workdir, expectedArtifactPath(spec.traceId))
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, conformingNote(spec), "utf8")
      return { output: { text: "ok" } }
    })
    await runLoop(loop(ledgerRoot), { task: TASK }, deps(workdir, [fakeGate("approve"), spy]))
    expect(seenRoute).toMatchObject({ gate_decision: "approve", route_to_worker: true })
  })

  it("route-rejected path: needs_human after ONE tick — route gate failures are not retryable", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    const d = deps(workdir, [fakeGate("reject", false), fakeWorker({ conforming: true })])
    const run = startRun(loop(ledgerRoot), { task: TASK }, d)

    const outcome = await tick(run, d)
    expect(outcome.decision.kind).toBe("escalate")
    expect(outcome.state.status).toBe("needs_human")
    expect(outcome.decision.notes.join("\n")).toContain("not retryable")
  })

  it("route gate pins the worker ROLE, not a provider: a gate naming something else fails route-decision.v1", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    // Approves, routes — but names a provider instead of the loop's worker role.
    const d = deps(workdir, [fakeGate("approve", true, "codex"), fakeWorker({ conforming: true })])
    const run = startRun(loop(ledgerRoot), { task: TASK }, d)

    const outcome = await tick(run, d)
    expect(outcome.decision.kind).toBe("escalate")
    expect(outcome.decision.notes.join("\n")).toContain("expected worker `implement`")
  })

  it("contract-FAIL -> retry (attempt 2, with the exact failed checks) -> escalate at the policy cap", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    const d = deps(workdir, [fakeGate("approve"), fakeWorker({ conforming: false })])
    const run = startRun(loop(ledgerRoot), { task: TASK }, d)

    const route = await tick(run, d)
    expect(route.decision.kind).toBe("continue")

    const first = await tick(run, d)
    expect(first.decision.kind).toBe("retry")
    expect(first.decision.retryHint).toContain("dry-run-note.v1")
    expect(first.state.attempt).toBe(2)

    const second = await tick(run, d)
    expect(second.decision.kind).toBe("escalate")
    expect(second.state.status).toBe("needs_human")
    expect(second.decision.notes.join("\n")).toContain("reached policy max 2")

    const entries = Ledger.load(journalPath(ledgerRoot, run.state.runId))
    const implementAttempts = entries.filter((e) => e.type === "step_started" && e.stepId === "implement")
    expect(implementAttempts.map((a) => (a.type === "step_started" ? a.attempt : 0))).toEqual([1, 2])
    const failedContract = entries.filter((e) => e.type === "contract" && e.stepId === "implement").at(-1)
    expect(failedContract?.type === "contract" && failedContract.result.valid).toBe(false)
  })

  it("derives `artifact` from effect attribution: a worker that writes nothing (or two files) yields no artifact, deterministically", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    // Writes NOTHING: zero changed-and-allowed files -> no artifact field -> signature retry.
    const idle = scriptExecutor("fake-worker", () => ({ output: { text: "did nothing" } }))
    const d = deps(workdir, [fakeGate("approve"), idle])
    const run = startRun(loop(ledgerRoot), { task: TASK }, d)
    await tick(run, d) // route
    const outcome = await tick(run, d)
    expect(outcome.decision.kind).toBe("retry")
    expect(outcome.decision.summary).toContain("signature")

    // Writes TWO allowed files: no single candidate -> same deterministic failure.
    const { workdir: wd2, ledgerRoot: lr2, loop: loop2 } = setup()
    const sprawling = scriptExecutor("fake-worker", (spec, ctx) => {
      for (const name of [expectedArtifactPath(spec.traceId), "docs/agent-workflows/extra.md"]) {
        const absolute = join(ctx.workdir, name)
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, conformingNote(spec), "utf8")
      }
      return { output: { text: "wrote two files" } }
    })
    const d2 = deps(wd2, [fakeGate("approve"), sprawling])
    const run2 = startRun(loop2(lr2), { task: TASK }, d2)
    await tick(run2, d2) // route
    const outcome2 = await tick(run2, d2)
    expect(outcome2.decision.kind).toBe("retry")
  })

  it("injects attempt 1's exact failed contract checks into attempt 2's prompt; the fixed attempt succeeds", async () => {
    const { workdir, ledgerRoot, loop } = setup()
    const prompts: string[] = []
    // Attempt 1 violates dry-run-note.v1; attempt 2 conforms.
    const learning = scriptExecutor("fake-worker", (spec, ctx) => {
      prompts.push(spec.prompt ?? "")
      const absolute = join(ctx.workdir, expectedArtifactPath(spec.traceId))
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, spec.attempt === 1 ? "# A note that ignores the contract\n" : conformingNote(spec), "utf8")
      return { output: { text: "wrote the note" } }
    })
    const d = deps(workdir, [fakeGate("approve"), learning])

    const outcome = await runLoop(loop(ledgerRoot), { task: TASK }, d)
    expect(outcome.state.status).toBe("done")
    expect(outcome.output?.verdict).toBe("success")

    expect(prompts).toHaveLength(2)
    // Attempt 1's prompt carries no failure context; attempt 2's carries the
    // exact failed check labels AND details from attempt 1's contract result.
    expect(prompts[0]).not.toContain("Failed contract checks")
    expect(prompts[1]).toContain("Failed contract checks")
    expect(prompts[1]).toContain(`contract \`dry-run-note.v1\` failed`)
    expect(prompts[1]).toContain("trace id recorded")
    expect(prompts[1]).toContain(`expected \`${outcome.state.traceId}\` in artifact title or metadata`)
    expect(prompts[1]).toContain("one improvement candidate recorded")
  })

  it("renders the route and implement prompts from the loop's own templates, naming the worker ROLE", () => {
    const [route, implement] = planWorkReviewLoop.steps
    const base = {
      runId: "plan-work-review-test",
      traceId: "plan-work-review-test",
      loopId: planWorkReviewLoop.id,
      loopVersion: planWorkReviewLoop.version,
      attempt: 1,
      iteration: 1,
      effects: { allow: [] },
      runDir: "/tmp/run",
      timeoutMs: 1000,
    }
    const routePrompt = (route!.prompt as PromptTemplate)({ ...base, stepId: "route", inputs: { task: TASK } })
    expect(routePrompt).toContain("control-plane router")
    expect(routePrompt).toContain(expectedArtifactPath("plan-work-review-test"))
    expect(routePrompt).toContain("gateDecision")
    expect(routePrompt).toContain("routeToWorker")
    expect(routePrompt).not.toContain("codex") // no provider named anywhere in the loop's prompts

    const implPrompt = (implement!.prompt as PromptTemplate)({
      ...base,
      stepId: "implement",
      inputs: { task: TASK, route: { gate_decision: "approve" } },
    })
    expect(implPrompt).toContain("## Improvement Candidate")
    expect(implPrompt).toContain("/tmp/run") // the bundle path reaches the worker
    expect(implPrompt).toContain("worker name `implement`") // the role, not a provider
    expect(implPrompt).not.toContain("codex")
    const retryPrompt = (implement!.prompt as PromptTemplate)({
      ...base,
      attempt: 2,
      stepId: "implement",
      retryHint: "Failed contract checks:\n- trace id recorded — expected `plan-work-review-test`",
      inputs: { task: TASK, route: {} },
    })
    expect(retryPrompt).toContain("worker retry")
    expect(retryPrompt).toContain("dry-run-note.v1")
    expect(retryPrompt).toContain("trace id recorded — expected `plan-work-review-test`")
  })

  it("route role is provider-agnostic: a NON-default structured-output fake fills the gate", async () => {
    const { workdir, ledgerRoot } = setup()
    // Some other vendor's agent. It receives the JSON Schema the engine
    // derives from the step's zod output signature (the route step declares
    // structuredOutput) and emits ONLY the four decision fields: no
    // gate-shaped raw `route` record anywhere.
    let seenSchema: Record<string, unknown> | undefined
    const otherVendor = scriptExecutor("some-other-agent", (spec) => {
      seenSchema = spec.outputSchema
      return { output: { gateDecision: "approve", routeToWorker: true, worker: "implement", reason: "Narrow, local, reviewable." } }
    })
    let seenRoute: unknown
    const worker = scriptExecutor("fake-worker", (spec, ctx) => {
      seenRoute = spec.inputs.route
      const absolute = join(ctx.workdir, expectedArtifactPath(spec.traceId))
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, conformingNote(spec), "utf8")
      return { output: { text: "ok" } }
    })
    const loop = bindExecutors({ ...planWorkReviewLoop, ledger: { root: ledgerRoot } }, [
      new Map([
        ["route", "some-other-agent"],
        ["implement", "fake-worker"],
      ]),
    ])

    const outcome = await runLoop(loop, { task: TASK }, deps(workdir, [otherVendor, worker]))

    expect(outcome.state.status).toBe("done")
    expect(outcome.output?.verdict).toBe("success")
    // The structured-output seam delivered the schema derived from routeOutput…
    expect(seenSchema).toBeDefined()
    const properties = Object.keys((seenSchema as { properties?: Record<string, unknown> }).properties ?? {})
    expect(properties).toEqual(expect.arrayContaining(["gateDecision", "routeToWorker", "worker", "reason"]))
    // …and the routeRecord projection derived the route record from the
    // decision fields, so the data plane works without any executor-specific shape.
    expect(seenRoute).toMatchObject({ gateDecision: "approve", routeToWorker: true })
  })

  it("executor resolution: a CLI --executor layer outranks config bindings and the loop default", async () => {
    const { workdir, ledgerRoot } = setup()
    const ran: string[] = []
    const decision = { gateDecision: "approve", routeToWorker: true, worker: "implement", reason: "Narrow, local, reviewable." }
    const cliRouter = scriptExecutor("cli-router", () => {
      ran.push("cli-router")
      return { output: decision }
    })
    const configRouter = scriptExecutor("config-router", () => {
      ran.push("config-router")
      return { output: decision }
    })
    const worker = scriptExecutor("fake-worker", (spec, ctx) => {
      ran.push("fake-worker")
      const absolute = join(ctx.workdir, expectedArtifactPath(spec.traceId))
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, conformingNote(spec), "utf8")
      return { output: { text: "ok" } }
    })
    // Exactly the layers cmdRun builds: CLI --executor route=cli-router
    // first, config bindings { route: config-router, implement: fake-worker }
    // second; implement is bound only by the config layer.
    const layers = [
      new Map([["route", "cli-router"]]),
      new Map([
        ["route", "config-router"],
        ["implement", "fake-worker"],
      ]),
    ]
    const loop = bindExecutors({ ...planWorkReviewLoop, ledger: { root: ledgerRoot } }, layers)

    const outcome = await runLoop(loop, { task: TASK }, deps(workdir, [cliRouter, configRouter, worker]))

    expect(outcome.state.status).toBe("done")
    expect(outcome.output?.verdict).toBe("success")
    // route ran on the CLI binding — the config layer was shadowed; implement,
    // unbound at the CLI, fell through to the config layer. The config-bound
    // router never ran at all.
    expect(ran).toEqual(["cli-router", "fake-worker"])
  })
})

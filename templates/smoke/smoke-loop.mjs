// The smoke template: control-plane-smoke-test as a five-slot Loop.
//
// A deterministic, no-agent loop that proves gateway / job / no-op / trace /
// delivery behavior — no model call, no auth; the simplicity is the point.
// It descends from the Python predecessor's control-plane-smoke-test.toml
// loop card and shipped in-tree as vernier's Pilot 0 before becoming this
// template.
//
// Every slot here is hand-rolled on purpose — plain objects, zod for the
// signature schemas (the one bare specifier; your project's node_modules
// wins when present, else the vernier CLI lends its own copy), a pure
// function for the policy — so nothing about the five-slot shape is hidden
// behind a helper. The other templates show the
// idiomatic path: importing `sig`, `fsScope`, `retryPolicy`, `until`, …
// from "vernier".

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"

const LOOP_ID = "control-plane-smoke-test"
const LOOP_VERSION = "0.2.0"
const TRACE_ROOT = `evidence/traces/${LOOP_ID}`

// ------------------------------------------------------------- executor
// Any executor is an id plus run(spec, ctx) -> StepResult. This one is a
// deterministic script: it simulates the control-plane checks, classifies
// no-op vs changed, skips delivery on silence, and writes a redacted run
// trace satisfying the built-in run-trace.v1 contract.

const smokeExecutor = {
  id: "script:control-plane-smoke",
  async run(spec, ctx) {
    const jobName = String(spec.inputs.jobName)
    const upstreamChanged = Boolean(spec.inputs.upstreamChanged)

    // Control-plane checks (simulated deterministically for the smoke loop).
    const gateway = { installed: true, running: true }
    const job = { name: jobName, active: true, mode: "no-agent" }
    const watcherOutcome = upstreamChanged ? "changed" : "no_op"
    const deliverySkipped = watcherOutcome === "no_op" // silent runs skip delivery

    const trace = `${TRACE_ROOT}/${spec.traceId}.md`
    const body = `# Trace: ${spec.traceId}

| Field | Value |
|---|---|
| \`trace_id\` | \`${spec.traceId}\` |
| \`loop_id\` | \`${spec.loopId}\` |
| \`loop_version\` | \`${spec.loopVersion}\` |
| \`orchestrator\` | vernier engine |
| \`worker\` | No-agent script |
| \`model_or_provider\` | None |

## Gate

| Field | Value |
|---|---|
| \`gate.decision\` | \`pass\` |
| \`gate.reason\` | Gateway running, job \`${job.name}\` present and active, trace path writable. |

## Result

| Field | Value |
|---|---|
| \`result.classification\` | \`success\` |
| \`watcher_outcome\` | \`${watcherOutcome}\` |
| \`delivery\` | ${deliverySkipped ? "skipped (silent run)" : "delivered"} |
| \`result.summary\` | Watcher ran under the engine; gateway/job/no-op/trace/delivery behavior verified. |

## Review And Improvement

| Field | Value |
|---|---|
| \`improvement_candidate.summary\` | Drive this loop from a scheduler tick instead of a manual run. |
`
    const absolute = join(ctx.workdir, trace)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, body, "utf8")

    return {
      status: "completed",
      output: { ok: true, trace, gatewayRunning: gateway.running, jobActive: job.active, watcherOutcome, deliverySkipped },
      evidence: [{ role: "trace", path: trace }],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
    }
  },
}

// ---------------------------------------------------------------- policy
// A pure Observation -> Decision function (this loop's retry budget is 1
// attempt, so a failure escalates instead of retrying). The engine hands it
// deterministic facts only; nothing here reads files or calls a model.

const policy = (obs) => {
  const passed = obs.stepStatus === "completed" && obs.outputValid && obs.contractValid && obs.effectsAllowed
  if (!passed) {
    return {
      kind: "escalate",
      classification: "failure",
      summary: `step \`${obs.stepId}\` failed: ${obs.contractFailedChecks.join("; ") || "see the journal"}.`,
      notes: obs.contractFailedChecks,
      improvement: "none",
    }
  }
  const last = obs.stepIndex + 1 >= obs.stepCount
  return {
    kind: last ? "stop" : "continue",
    classification: "success",
    summary: last ? `step \`${obs.stepId}\` completed, its contract passed, and all changes stayed in scope; the loop is done.` : `step \`${obs.stepId}\` passed; continue.`,
    notes: [],
    improvement: "none",
  }
}

// ------------------------------------------------------------------ loop
// The five slots. `run-trace.v1` is vernier's built-in trace contract —
// every config loop's runtime registers it, so the id resolves here.

const smokeOutput = z.object({
  ok: z.boolean(),
  trace: z.string(),
  gatewayRunning: z.boolean(),
  jobActive: z.boolean(),
  watcherOutcome: z.enum(["changed", "no_op"]),
  deliverySkipped: z.boolean(),
})

const loop = {
  id: LOOP_ID,
  version: LOOP_VERSION,
  signature: {
    input: z.object({ jobName: z.string(), upstreamChanged: z.boolean().optional() }),
    output: z.object({ ok: z.boolean(), trace: z.string() }),
  },
  steps: [
    {
      id: "smoke",
      signature: {
        input: z.object({ jobName: z.string(), upstreamChanged: z.boolean().optional() }),
        output: smokeOutput,
      },
      executor: "script:control-plane-smoke",
      contract: "run-trace.v1",
      effects: { allow: [`${TRACE_ROOT}/**`] }, // fsScope: writes outside this escalate
    },
  ],
  policy,
  trust: "dry-run",
  ledger: {},
}

// ---------------------------------------------------------- registration
// The runtime facts pure data cannot carry: the executor, default inputs,
// and where the loop works when --workdir is not given (the ledger root's
// work dir — $VERNIER_HOME, else ./.vernier).

export default {
  loop,
  summary: "Deterministic no-agent control-plane smoke (gateway/job/no-op/trace/delivery).",
  signature: "jobName:string, upstreamChanged?:boolean -> ok:boolean, trace:path",
  defaultInputs: { jobName: "watch-upstream" },
  executors: [smokeExecutor],
  defaultWorkdir: () => {
    const workdir = join(process.env.VERNIER_HOME ?? join(process.cwd(), ".vernier"), "work")
    mkdirSync(workdir, { recursive: true })
    return workdir
  },
}

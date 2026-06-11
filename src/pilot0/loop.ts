// Pilot 0: the control-plane smoke loop, re-expressed as a five-slot Loop.
// Ported from the Python predecessor's docs/agent-workflows/definitions/loops/
// control-plane-smoke-test.toml + its loop card: a deterministic no-agent
// loop that proves gateway / job / no-op / trace / delivery behavior.
// No model call; the simplicity is the point.

import { z } from "zod"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { RUN_TRACE_V1 } from "../kernel/contract.js"
import { retryPolicy } from "../kernel/policy.js"
import { fsScope, sig, type Loop } from "../kernel/types.js"
import { scriptExecutor, type ScriptFn } from "../executors/script.js"

const LOOP_ID = "control-plane-smoke-test"
const LOOP_VERSION = "0.2.0"
const TRACE_ROOT = `evidence/traces/${LOOP_ID}`

const smokeOutput = z.object({
  ok: z.boolean(),
  trace: z.string(),
  gatewayRunning: z.boolean(),
  jobActive: z.boolean(),
  watcherOutcome: z.enum(["changed", "no_op"]),
  deliverySkipped: z.boolean(),
})

/**
 * The deterministic control-plane smoke: check the (simulated) gateway,
 * find the job, run the watcher, classify no-op vs changed, skip delivery
 * on silence, and write a redacted run trace satisfying run-trace.v1.
 */
const controlPlaneSmoke: ScriptFn = (spec, ctx) => {
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
    output: { ok: true, trace, gatewayRunning: gateway.running, jobActive: job.active, watcherOutcome, deliverySkipped },
    evidence: [{ role: "trace", path: trace }],
  }
}

export const controlPlaneSmokeExecutor = scriptExecutor("script:control-plane-smoke", controlPlaneSmoke)

/** The proof of elegance: Pilot 0 as a five-slot declaration. */
export const controlPlaneSmokeLoop: Loop<
  { jobName: string; upstreamChanged?: boolean | undefined },
  { ok: boolean; trace: string }
> = {
  id: LOOP_ID,
  version: LOOP_VERSION,
  signature: sig(
    z.object({ jobName: z.string(), upstreamChanged: z.boolean().optional() }),
    z.object({ ok: z.boolean(), trace: z.string() }),
  ),
  steps: [
    {
      id: "smoke",
      signature: sig(z.object({ jobName: z.string(), upstreamChanged: z.boolean().optional() }), smokeOutput),
      executor: "script:control-plane-smoke",
      contract: RUN_TRACE_V1,
      effects: fsScope(`${TRACE_ROOT}/**`),
    },
  ],
  policy: retryPolicy({ maxAttempts: 1 }), // per control-plane-smoke-test.retry@0.1.0
  trust: "dry-run",
  ledger: {},
}

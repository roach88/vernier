// Pilot 1: plan-work-review, re-expressed as a five-slot Loop.
//
// Mirrors the frozen Python spec's executable facts (docs/agent-workflows/
// definitions/loops/plan-work-review.toml + policies/plan-work-review.retry.toml):
//   worker = codex, contract = dry-run-note.v1,
//   allowed worker artifact root = docs/agent-workflows,
//   retry policy = max 2 worker attempts, auto-execute, escalate to needs_human.
// The 833-line RunLoop.run() sequence (route -> render prompt -> snapshot ->
// exec -> diff -> validate -> decide -> maybe retry once) is no longer code;
// it is this declaration plus the generic tick interpreter.
//
// THE ROUTE ROLE IS PROVIDER-AGNOSTIC. The Python spec hardwired
// orchestrator = hermes; here the route step is just "an LLM gate that
// returns route-decision JSON" — its prompt plus the route-decision.v1
// contract are the whole role. Any structured-output-capable executor can
// fill it (`structuredOutput: true` hands the executor a JSON Schema
// derived from the step's zod output signature). The DEFAULT binding is
// codex for both steps, so `vernier run plan-work-review` needs only one
// authed CLI; rebind with `--executor route=hermes` (or config bindings)
// to route on hermes — it is one binding among many, not a requirement.
//
// Prompt templates are ported from agent_workflows/rendering/prompts.py
// (build_route_prompt / build_codex_prompt) and dynamic_workflow_harness.py
// (build_retry_prompt renders when attempt > 1).

import { z } from "zod"
import { artifactFromEffects } from "../kernel/effects.js"
import type { Policy } from "../kernel/policy.js"
import { retryPolicy } from "../kernel/policy.js"
import { fsScope, noEffects, sig, type Loop, type OutputProjection, type PromptTemplate } from "../kernel/types.js"
import { ALLOWED_WORKER_ROOT, DRY_RUN_NOTE_V1, ROUTE_DECISION_V1, expectedArtifactPath } from "./contracts.js"

const LOOP_ID = "plan-work-review"
const LOOP_VERSION = "0.3.0" // 0.2.0 + provider-agnostic route role (default binding: codex)
const ROUTER = "codex" // the route step's DEFAULT binding — overridable per run, not a requirement
const WORKER = "codex"

// ------------------------------------------------------------------ prompts

const routePrompt: PromptTemplate = (spec) => {
  const task = String(spec.inputs.task)
  return `You are acting only as a control-plane router for a local agent workflow loop.
Do not use tools. Do not edit files. Return compact JSON only, no markdown.

Loop card summary:
- loop_id: ${spec.loopId}
- loop_version: ${spec.loopVersion}
- router: this step (an LLM gate returning route-decision JSON; the engine, not you, applies stop/retry policy)
- worker: ${WORKER}
- mutation authority: workspace docs under ${ALLOWED_WORKER_ROOT} (workdir-relative)
- forbidden: global agent config edits, scheduler activation, remote writes, secret inspection
- success: artifact updated, verification passes, trace recorded, improvement candidate named
- reject if scope is too broad, needs secrets, modifies global config, starts live automation, or lacks reviewable output

Candidate task:
${task}

Expected worker artifact:
${expectedArtifactPath(spec.traceId)}

Return JSON fields:
gateDecision (approve|reject), routeToWorker (boolean), worker (the worker name above), reason (one sentence).
`
}

const implementPrompt: PromptTemplate = (spec) => {
  const task = String(spec.inputs.task)
  const expected = expectedArtifactPath(spec.traceId)
  // Retry attempts get the smaller, contract-focused prompt
  // (dynamic_workflow_harness.build_retry_prompt, as a template branch),
  // carrying the previous attempt's exact failed contract checks.
  if (spec.attempt > 1) {
    return `You are the ${WORKER} worker retry for loop \`${spec.loopId}\`.

Retry reason:
${spec.retryHint ?? "A previous attempt did not satisfy the artifact contract."}

Expected artifact:
\`${expected}\`

Artifact contract:
\`${DRY_RUN_NOTE_V1}\`

Rules:
- Edit only the expected artifact.
- Do not edit loop cards, traces, scripts, task bundles, configs, or external services.
- Write a short artifact that satisfies the artifact contract exactly.
- Include trace id \`${spec.traceId}\`.
- Include loop id \`${spec.loopId}\`.
- Include loop version \`${spec.loopVersion}\`.
- Include worker \`${WORKER}\`.
- Include bundle path \`${spec.runDir}\`.
- Include artifact path \`${expected}\`.
- Include runner verification ownership and exactly one improvement candidate.
- Use exactly these sections: H1 title, \`## Route\`, \`## Bundle\`, \`## Runner Verification\`, \`## Improvement Candidate\`.
- Stop if satisfying the contract would require any other file change.
`
  }
  const route = spec.inputs.route ?? {}
  return `You are the ${WORKER} worker for loop \`${spec.loopId}\`.

Approved route decision:
\`\`\`json
${JSON.stringify(route, null, 2)}
\`\`\`

Allowed mutation boundary (workdir-relative):
\`${ALLOWED_WORKER_ROOT}\`

Expected artifact:
\`${expected}\`

Task:
${task}

Rules:
- Create or update only the expected artifact named above.
- Write the artifact once in a concise, stable format.
- Do not run shell commands for verification.
- Do not paste command output into the artifact.
- Do not inspect secrets.
- Do not edit global agent config.
- Do not start schedulers or live automations.
- Do not write to external services.
- Do not edit loop cards, traces, task bundles, scripts, or other files.
- Stop if the task expands beyond the route decision.

Required content for the expected artifact:
- Title with trace id \`${spec.traceId}\`.
- The loop id \`${spec.loopId}\` and loop version \`${spec.loopVersion}\`.
- The worker name \`${WORKER}\`.
- A short statement that the router approved the route and ${WORKER} executed the worker pass.
- The bundle path \`${spec.runDir}\`.
- The artifact path \`${expected}\`.
- A verification note saying the runner will validate the artifact and write the trace.
- One improvement candidate for the loop.

Use exactly these sections:
- H1 title.
- \`## Route\`
- \`## Bundle\`
- \`## Runner Verification\`
- \`## Improvement Candidate\`

When finished, respond with a concise summary and list the artifact you changed. The runner, not you, will run verification and write the trace.
`
}

// ------------------------------------------------------------------- policy

const base = retryPolicy({ maxAttempts: 2 }) // plan-work-review.retry@0.1.0: max_worker_attempts = 2

/**
 * Python parity (dynamic_workflow_harness.decide_pilot1_next_step +
 * policies/retry.py): only WORKER outcomes are retryable
 * (retryable_outcomes = ["retry_with_smaller_prompt"]); a rejected or
 * unparseable route was always needs_human, never a retry.
 */
export const planWorkReviewPolicy: Policy = (obs) => {
  const decision = base(obs)
  if (obs.stepId === "route" && decision.kind === "retry") {
    return {
      ...decision,
      kind: "escalate",
      notes: [...decision.notes, "Route gate failures are not retryable; the loop needs a human."],
    }
  }
  return decision
}

// --------------------------------------------------------------------- loop

/**
 * `route` (the raw decision record threaded to the implement prompt) is
 * optional in the schema because the engine derives it when the executor
 * does not report one — see routeRecord below. Executors that surface the
 * raw parsed JSON (hermes) keep theirs; structured-output executors (codex,
 * a judge, a config-registered agent) just emit the four decision fields.
 */
const routeOutput = z.object({
  gateDecision: z.string(),
  routeToWorker: z.boolean(),
  worker: z.string(),
  reason: z.string(),
  route: z.record(z.unknown()).optional(),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * OutputProjection for the route step: when the executor reported no raw
 * route record, the decision fields ARE the record. Deterministic — no
 * second model turn, no executor-specific shape leaking into the loop.
 */
const routeRecord: OutputProjection = ({ output }) => {
  if (isRecord(output.route) && Object.keys(output.route).length > 0) return {}
  const { route: _route, ...fields } = output
  return { route: fields }
}

/**
 * `artifact` is not model-reported: the engine derives it from effect
 * attribution (the one changed-and-allowed file), so codex needs no second
 * structured-output extraction turn — the diff is the report.
 */
const implementOutput = z.object({
  artifact: z.string(),
})

/** Pilot 1 as data: signature `task:str -> artifact:path, verdict:str`. */
export const planWorkReviewLoop: Loop<{ task: string }, { artifact: string; verdict: string }> = {
  id: LOOP_ID,
  version: LOOP_VERSION,
  signature: sig(z.object({ task: z.string() }), z.object({ artifact: z.string(), verdict: z.string() })),
  steps: [
    {
      id: "route",
      signature: sig(z.object({ task: z.string() }), routeOutput),
      executor: ROUTER, // an LLM gate is just a step; the id is a DEFAULT binding, resolved at the CLI/registry layer
      contract: ROUTE_DECISION_V1,
      effects: noEffects(), // the router may touch nothing
      prompt: routePrompt,
      outputFrom: routeRecord,
      // Any structured-output-capable executor can fill the route role: the
      // engine derives the JSON Schema from routeOutput (one source of truth).
      structuredOutput: true,
      timeoutMs: 60_000, // Python hermes_timeout = 60 (codex routing reuses the same budget)
    },
    {
      id: "implement",
      signature: sig(z.object({ task: z.string(), route: z.record(z.unknown()) }), implementOutput),
      executor: WORKER,
      contract: DRY_RUN_NOTE_V1,
      effects: fsScope(`${ALLOWED_WORKER_ROOT}/**`), // the TOML's allowed_worker_artifact_root
      prompt: implementPrompt,
      outputFrom: artifactFromEffects("artifact"),
      timeoutMs: 600_000, // Python codex_timeout = 600
    },
  ],
  policy: planWorkReviewPolicy,
  trust: "active", // auto-execute per trust (the TOML's auto_execute = true)
  ledger: {},
}

// The coding-review template: plan-work-review as a five-slot Loop.
//
//   route      an LLM gate approves/rejects the task     contract: route-decision.v1   effects: none
//   implement  an agent writes ONE artifact              contract: dry-run-note.v1     effects: fsScope("docs/agent-workflows/**")
//
// This is the shape most people come for: an LLM gate, then an LLM worker,
// with a contract and a bounded blast radius. It descends from vernier's
// live Pilot 1 (itself a port of the Python predecessor's plan-work-review
// loop card): max 2 worker attempts, route failures non-retryable, the
// artifact derived from effect attribution — the diff is the report.
//
// NO PROVIDER IS SPECIAL HERE. Both steps declare the executor id `agent` —
// a deliberate placeholder that reads as what it is: a binding target. The
// shipped vernier.config.json points both roles at codex; point them
// anywhere (config `bindings`, or per run):
//
//   vernier run plan-work-review --executor implement=claude ...
//   vernier run plan-work-review --executor route=opencode ...
//   vernier run plan-work-review --executor agent=claude ...   # both roles at once
//
// Honest provider notes: `implement` writes files, so bind it to a provider
// with enforced write boundaries (codex: OS sandbox derived from the effect
// scope; claude: acceptEdits + workspace boundary). cursor-agent, opencode,
// and pi fail closed on write scopes — they can fill `route` (effect-free),
// not `implement`. `hermes` is also wired as a route binding if you have it.
//
// Where the original pinned the worker to `codex` (in the route contract and
// the prompts), this template names the worker by ROLE — the literal string
// `implement` — because the bound provider is a run-time choice the loop
// data cannot (and should not) see.

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { artifactFromEffects, fsScope, noEffects, retryPolicy, sig } from "vernier"
import { z } from "zod"

const LOOP_ID = "plan-work-review"
const LOOP_VERSION = "0.5.1" // 0.5.0 + route prompt names the `route` field explicitly (strict-mode schemas require it)
/** The worker ROLE name: used in prompts and contracts instead of a provider name. */
const WORKER_ROLE = "implement"

// ---------------------------------------------------------------- contracts
// route-decision.v1: "was the route approved" as a deterministic check on
// the gate's output value. dry-run-note.v1: the artifact contract, ported
// check-for-check from the Python predecessor's dry_run_note contract; the
// artifact path arrives derived from effect attribution, so the contract
// first pins it to the runner-expected path.

const ROUTE_DECISION_V1 = "route-decision.v1"
const DRY_RUN_NOTE_V1 = "dry-run-note.v1"

const APPROVE_DECISIONS = new Set(["accept", "accepted", "allow", "allowed", "approve", "approved", "pass"])

/** The worker artifact lives under the allowed root, named by trace id. */
export const ALLOWED_WORKER_ROOT = "docs/agent-workflows"
export function expectedArtifactPath(traceId) {
  return `${ALLOWED_WORKER_ROOT}/runner-dry-runs/${traceId}.md`
}

export const routeDecisionV1 = {
  id: ROUTE_DECISION_V1,
  validate(output) {
    const gateDecision = typeof output.gateDecision === "string" ? output.gateDecision : ""
    const worker = typeof output.worker === "string" ? output.worker : ""
    const reason = typeof output.reason === "string" ? output.reason : ""
    const checks = [
      {
        label: "gate decision approves",
        passed: APPROVE_DECISIONS.has(gateDecision.toLowerCase()),
        detail: `expected gate_decision in {${[...APPROVE_DECISIONS].join(", ")}}, got \`${gateDecision || "<missing>"}\``,
      },
      {
        label: "route to worker",
        passed: output.routeToWorker === true,
        detail: "expected route_to_worker to be true",
      },
      {
        // The gate must confirm it is routing to THIS loop's worker role.
        // (The original pinned a provider name here; the role replaces it —
        // which provider fills the role is a binding the gate cannot see.)
        label: "worker is the loop's worker role",
        passed: worker.toLowerCase() === WORKER_ROLE,
        detail: `expected worker \`${WORKER_ROLE}\`, got \`${worker || "<missing>"}\``,
      },
      {
        label: "reason recorded",
        passed: reason.trim().length > 0,
        detail: "expected a non-empty routing reason",
      },
    ]
    return { contractId: ROUTE_DECISION_V1, valid: checks.every((c) => c.passed), checks }
  },
}

/** The body between a heading and the next `## `. */
function markdownSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`^${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m").exec(text)
  return match ? match[1].trim() : ""
}

export const dryRunNoteV1 = {
  id: DRY_RUN_NOTE_V1,
  validate(output, ctx) {
    const artifact = typeof output.artifact === "string" ? output.artifact : ""
    const expected = expectedArtifactPath(ctx.traceId)
    const absolute = artifact && !isAbsolute(artifact) ? join(ctx.workdir, artifact) : artifact
    const exists = Boolean(absolute) && existsSync(absolute)
    const text = exists ? readFileSync(absolute, "utf8") : ""
    const lower = text.toLowerCase()
    const improvementHeadings = text.match(/^## Improvement Candidate\s*$/gm) ?? []
    const improvementText = markdownSection(text, "## Improvement Candidate")

    const checks = [
      {
        label: "artifact path matches the runner-expected path",
        passed: artifact === expected,
        detail: `expected \`${expected}\`, effect attribution yielded \`${artifact || "<missing>"}\``,
      },
      {
        label: "expected artifact is readable",
        passed: exists,
        detail: `${expected} ${exists ? "exists" : "does not exist"}`,
      },
      {
        label: "trace id recorded",
        passed: text.includes(ctx.traceId),
        detail: `expected \`${ctx.traceId}\` in artifact title or metadata`,
      },
      {
        label: "loop id recorded",
        passed: text.includes(ctx.loopId) && (lower.includes("loop_id") || lower.includes("loop id")),
        detail: `expected loop id \`${ctx.loopId}\` with a loop_id/loop id label`,
      },
      {
        label: "loop version recorded",
        passed: text.includes(ctx.loopVersion) && (lower.includes("loop_version") || lower.includes("loop version")),
        detail: `expected loop version \`${ctx.loopVersion}\` with a loop_version/loop version label`,
      },
      {
        // The role, not the provider: the artifact names the worker role the
        // prompt asked for, so the check holds under any executor binding.
        label: "worker recorded",
        passed: lower.includes(WORKER_ROLE) && lower.includes("worker"),
        detail: `expected worker \`${WORKER_ROLE}\` to be named`,
      },
      {
        label: "bundle path recorded",
        passed: text.includes(ctx.runDir),
        detail: `expected bundle path \`${ctx.runDir}\``,
      },
      {
        label: "artifact path recorded",
        passed: Boolean(artifact) && text.includes(expected),
        detail: `expected artifact path \`${expected}\``,
      },
      {
        label: "runner owns verification",
        passed: lower.includes("runner") && (lower.includes("validat") || lower.includes("verification")) && lower.includes("trace"),
        detail: "expected artifact to say the runner validates and writes the trace",
      },
      {
        label: "one improvement candidate recorded",
        passed: improvementHeadings.length === 1 && improvementText.length > 0,
        detail: "expected exactly one non-empty `## Improvement Candidate` section",
      },
    ]
    return { contractId: DRY_RUN_NOTE_V1, valid: checks.every((c) => c.passed), checks }
  },
}

// ------------------------------------------------------------------ prompts

const routePrompt = (spec) => {
  const task = String(spec.inputs.task)
  return `You are acting only as a control-plane router for a local agent workflow loop.
Do not use tools. Do not edit files. Return compact JSON only, no markdown.

Loop card summary:
- loop_id: ${spec.loopId}
- loop_version: ${spec.loopVersion}
- router: this step (an LLM gate returning route-decision JSON; the engine, not you, applies stop/retry policy)
- worker: the loop's \`${WORKER_ROLE}\` step (an agent bound at run time)
- mutation authority: workspace docs under ${ALLOWED_WORKER_ROOT} (workdir-relative)
- forbidden: global agent config edits, scheduler activation, remote writes, secret inspection
- success: artifact updated, verification passes, trace recorded, improvement candidate named
- reject if scope is too broad, needs secrets, modifies global config, starts live automation, or lacks reviewable output

Candidate task:
${task}

Expected worker artifact:
${expectedArtifactPath(spec.traceId)}

Return JSON fields:
gateDecision (approve|reject), routeToWorker (boolean), worker (the literal worker role name: ${WORKER_ROLE}), reason (one sentence).
If the output schema includes a \`route\` field, set it to null — the runner reconstructs it from the fields above.
`
}

const implementPrompt = (spec) => {
  const task = String(spec.inputs.task)
  const expected = expectedArtifactPath(spec.traceId)
  // Retry attempts get the smaller, contract-focused prompt, carrying the
  // previous attempt's exact failed contract checks (spec.retryHint).
  if (spec.attempt > 1) {
    return `You are the \`${WORKER_ROLE}\` worker retry for loop \`${spec.loopId}\`.

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
- Include worker \`${WORKER_ROLE}\`.
- Include bundle path \`${spec.runDir}\`.
- Include artifact path \`${expected}\`.
- Include runner verification ownership and exactly one improvement candidate.
- Use exactly these sections: H1 title, \`## Route\`, \`## Bundle\`, \`## Runner Verification\`, \`## Improvement Candidate\`.
- Stop if satisfying the contract would require any other file change.
`
  }
  const route = spec.inputs.route ?? {}
  return `You are the \`${WORKER_ROLE}\` worker for loop \`${spec.loopId}\`.

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
- The worker name \`${WORKER_ROLE}\`.
- A short statement that the router approved the route and the \`${WORKER_ROLE}\` worker executed the worker pass.
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
// Max 2 worker attempts; only WORKER outcomes are retryable — a rejected or
// unparseable route was always needs_human, never a retry.

const base = retryPolicy({ maxAttempts: 2 })

export const planWorkReviewPolicy = (obs) => {
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
 * does not report one — see routeRecord below.
 */
const routeOutput = z.object({
  gateDecision: z.string(),
  routeToWorker: z.boolean(),
  worker: z.string(),
  reason: z.string(),
  route: z.record(z.unknown()).optional(),
})

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * OutputProjection for the route step: when the executor reported no raw
 * route record, the decision fields ARE the record. Deterministic — no
 * second model turn, no executor-specific shape leaking into the loop.
 */
const routeRecord = ({ output }) => {
  if (isRecord(output.route) && Object.keys(output.route).length > 0) return {}
  const { route: _route, ...fields } = output
  return { route: fields }
}

/**
 * `artifact` is not model-reported: the engine derives it from effect
 * attribution (the one changed-and-allowed file) — the diff is the report.
 */
const implementOutput = z.object({
  artifact: z.string(),
})

const loop = {
  id: LOOP_ID,
  version: LOOP_VERSION,
  signature: sig(z.object({ task: z.string() }), z.object({ artifact: z.string(), verdict: z.string() })),
  steps: [
    {
      id: "route",
      signature: sig(z.object({ task: z.string() }), routeOutput),
      executor: "agent", // a binding target, not a provider — see the header
      contract: ROUTE_DECISION_V1,
      effects: noEffects(), // the router may touch nothing
      prompt: routePrompt,
      outputFrom: routeRecord,
      // Any structured-output-capable executor can fill the route role: the
      // engine derives the JSON Schema from routeOutput (one source of truth).
      structuredOutput: true,
      timeoutMs: 60_000,
    },
    {
      id: "implement",
      signature: sig(z.object({ task: z.string(), route: z.record(z.unknown()) }), implementOutput),
      executor: "agent", // a binding target, not a provider — see the header
      // The loop's default Agent Skill for this step (shipped under
      // ./skills, registered by the template's vernier.config). Rebind per
      // run exactly like the executor: --skill implement=<name>, or
      // --skill implement= to clear. Claude receives it natively
      // (--plugin-dir); every other provider gets the SKILL.md body
      // embedded in this prompt, delimited and attributed.
      skills: ["dry-run-note-style"],
      contract: DRY_RUN_NOTE_V1,
      effects: fsScope(`${ALLOWED_WORKER_ROOT}/**`), // the allowed worker artifact root
      prompt: implementPrompt,
      outputFrom: artifactFromEffects("artifact"),
      timeoutMs: 600_000,
    },
  ],
  policy: planWorkReviewPolicy,
  trust: "active",
  ledger: {},
}

// ---------------------------------------------------------- registration

export default {
  loop,
  summary:
    "An LLM router gates, a bound agent implements a contract-checked dry-run note (LIVE; bindings ship on codex — point route/implement at any wired agent).",
  signature: "task:string -> artifact:path, verdict:string",
  live: true,
  contracts: [routeDecisionV1, dryRunNoteV1],
  observer: "git", // git-aware effect attribution; the default workdir below is a git repo
  defaultWorkdir: () => {
    // A throwaway scratch git repo with the allowed artifact root. Pass
    // --workdir only if it points at a git repo (the observer needs one).
    const workdir = mkdtempSync(join(tmpdir(), "vernier-plan-work-review-"))
    mkdirSync(join(workdir, "docs", "agent-workflows"), { recursive: true })
    execFileSync("git", ["init", "--quiet"], { cwd: workdir })
    writeFileSync(join(workdir, "README.md"), "# vernier plan-work-review scratch\n", "utf8")
    return workdir
  },
}

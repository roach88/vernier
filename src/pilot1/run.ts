// Run Pilot 1 LIVE end-to-end: `npm run pilot1`
//
// Safety posture (deliberate, do not loosen):
//   - The workdir is a THROWAWAY scratch git repo under /tmp (or argv[2]).
//   - Codex runs via the app-server with sandbox "workspace-write" rooted
//     at that scratch dir (derived from the step's EffectScope; this runner
//     can never produce danger-full-access).
//   - All runner-managed evidence (prompts, route JSON, transcripts, the
//     trace) lands in the ledger run dir, not the workdir.
//
// Requires live `hermes` and `codex` CLIs on PATH, authed. The default
// `npm test` never runs this; the live test is gated by VERNIER_LIVE=1.

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { bindExecutors } from "../cli/config.js"
import { runLoop } from "../engine/tick.js"
import { defaultContractRegistry } from "../kernel/contract.js"
import { gitObserver } from "../kernel/git-effects.js"
import { Ledger, journalPath, resolveLedgerRoot, type LedgerEntry } from "../ledger/ledger.js"
import { CodexExecutor } from "../executors/codex.js"
import { HermesExecutor } from "../executors/hermes.js"
import { executorRegistry } from "../executors/script.js"
import { dryRunNoteV1, routeDecisionV1 } from "./contracts.js"
import { planWorkReviewLoop } from "./loop.js"

// This demo preserves the original cast — hermes routes, codex implements.
// The loop's DEFAULT binding routes on codex (no required providers); the
// rebind below is the binding seam in action, not a requirement.
const loop = bindExecutors(planWorkReviewLoop, [new Map([["route", "hermes"]])])

// --- scratch workdir: fresh git repo, docs/agent-workflows skeleton -------
const workdir = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync("/tmp/vernier-pilot1-scratch-")
mkdirSync(join(workdir, "docs", "agent-workflows"), { recursive: true })
execFileSync("git", ["init", "--quiet"], { cwd: workdir })
writeFileSync(
  join(workdir, "README.md"),
  "# vernier pilot-1 scratch\n\nThrowaway workdir for the live plan-work-review run.\n",
  "utf8",
)

// --- trace id mirrors the Python runner's format ---------------------------
const now = new Date()
const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`
const traceId = `${planWorkReviewLoop.id}-${stamp}`
const expectedFile = `docs/agent-workflows/runner-dry-runs/${traceId}.md`
const task = `Create \`${expectedFile}\` as a harmless automated worker dry-run note for \`${planWorkReviewLoop.id}\`. Do not edit any other file.`

const codex = new CodexExecutor()
const deps = {
  executors: executorRegistry(new HermesExecutor(), codex),
  contracts: defaultContractRegistry().register(routeDecisionV1).register(dryRunNoteV1),
  workdir,
  observer: gitObserver,
}

console.log(`loop      ${planWorkReviewLoop.id}@${planWorkReviewLoop.version} (trust: ${planWorkReviewLoop.trust})`)
console.log(`workdir   ${workdir}`)
console.log(`trace id  ${traceId}`)
console.log(`task      ${task}`)
console.log("--- running (hermes route, then live codex implement) ---")

const startedAt = new Date()
const outcome = await runLoop(loop, { task }, deps, { runId: traceId })
const finishedAt = new Date()
await codex.shutdown()

const { state, decision, output } = outcome
const ledgerRoot = resolveLedgerRoot(planWorkReviewLoop.ledger)
const journal = journalPath(ledgerRoot, state.runId)
const entries = Ledger.load(journal)

// --- render a human trace from the ledger (the Python build_trace analog) --
const tracePath = join(ledgerRoot, "runs", state.runId, "trace.md")
writeFileSync(tracePath, renderTrace(entries, startedAt, finishedAt), "utf8")

console.log(`status    ${state.status}`)
console.log(`decision  ${decision.kind} / ${decision.classification} — ${decision.summary}`)
console.log(`output    ${JSON.stringify(output)}`)
console.log(`artifact  ${output ? join(workdir, String(output.artifact)) : "none"}`)
console.log(`ledger    ${journal}`)
console.log(`trace     ${tracePath}`)
console.log("--- ledger entries ---")
for (const entry of entries) {
  const detail =
    entry.type === "meta"
      ? `${entry.loopId}@${entry.loopVersion}`
      : entry.type === "decision"
        ? `${entry.stepId} attempt=${entry.attempt} -> ${entry.decision.kind}/${entry.decision.classification}`
        : entry.type === "contract"
          ? `${entry.stepId} attempt=${entry.attempt} ${entry.result.contractId} valid=${entry.result.valid}`
          : entry.type === "effects"
            ? `${entry.stepId} attempt=${entry.attempt} changed=[${entry.observation.changed.join(", ")}] allowed=${entry.observation.allowed}`
            : `${entry.stepId} attempt=${entry.attempt}`
  console.log(`  ${entry.type.padEnd(13)} ${detail}`)
}

process.exit(state.status === "done" ? 0 : 1)

// ---------------------------------------------------------------------------

function renderTrace(all: readonly LedgerEntry[], started: Date, finished: Date): string {
  const meta = all.find((e) => e.type === "meta")
  const route = all.filter((e) => e.type === "contract" && e.stepId === "route").at(-1)
  const routeResult = all.filter((e) => e.type === "step_result" && e.stepId === "route").at(-1)
  const implResult = all.filter((e) => e.type === "step_result" && e.stepId === "implement").at(-1)
  const implEffects = all.filter((e) => e.type === "effects" && e.stepId === "implement").at(-1)
  const implContract = all.filter((e) => e.type === "contract" && e.stepId === "implement").at(-1)
  const final = all.filter((e) => e.type === "decision").at(-1)
  const routeOut = routeResult?.type === "step_result" ? routeResult.output : {}
  const gate = route?.type === "contract" ? route.result : null
  const fd = final?.type === "decision" ? final.decision : null
  const usage = implResult?.type === "step_result" ? implResult.usage : null
  const attempts = all.filter((e) => e.type === "step_started" && e.stepId === "implement").length
  const wall = Math.round((finished.getTime() - started.getTime()) / 1000)

  return `# Trace: ${meta?.type === "meta" ? meta.traceId : state.runId}

| Field | Value |
|---|---|
| \`trace_id\` | \`${state.traceId}\` |
| \`loop_id\` | \`${planWorkReviewLoop.id}\` |
| \`loop_version\` | \`${planWorkReviewLoop.version}\` |
| \`run_started_at\` | ${started.toISOString()} |
| \`run_finished_at\` | ${finished.toISOString()} |
| \`orchestrator\` | Hermes route JSON captured by the vernier engine |
| \`worker\` | \`codex\` (app-server, sandbox workspace-write) |
| \`mutation_authority\` | \`${workdir}/docs/agent-workflows\` |

## Gate

| Field | Value |
|---|---|
| \`gate.decision\` | \`${String((routeOut as Record<string, unknown>).gateDecision ?? "unavailable")}\` |
| \`gate.contract\` | \`route-decision.v1\` ${gate ? (gate.valid ? "passed" : "FAILED") : "not evaluated"} |
| \`gate.reason\` | ${String((routeOut as Record<string, unknown>).reason ?? "unavailable")} |

## Result

| Field | Value |
|---|---|
| \`result.classification\` | \`${fd?.classification ?? "unknown"}\` |
| \`worker_status\` | \`${implResult?.type === "step_result" ? implResult.status : "did not run"}\` |
| \`artifact_contract\` | \`dry-run-note.v1\` ${implContract?.type === "contract" ? (implContract.result.valid ? "passed" : "FAILED") : "not evaluated"} |
| \`changed_files\` | ${implEffects?.type === "effects" ? implEffects.observation.changed.map((p) => `\`${p}\``).join(", ") || "none" : "unknown"} |
| \`worker_attributed_changed_files\` | ${implEffects?.type === "effects" ? implEffects.observation.changed.map((p) => `\`${p}\``).join(", ") || "none" : "unknown"} (workdir changes are worker-attributed by construction) |
| \`changes_allowed\` | \`${implEffects?.type === "effects" ? implEffects.observation.allowed : "unknown"}\` |
| \`result.summary\` | ${fd?.summary ?? "unknown"} |

## Budget

| Field | Value |
|---|---|
| \`budget.tokens\` | ${usage ? `${usage.inputTokens} in / ${usage.outputTokens} out` : "Unknown"} |
| \`budget.wall_time_seconds\` | \`${wall}\` |
| \`budget.iterations\` | 1 Hermes routing decision, ${attempts} Codex worker pass${attempts === 1 ? "" : "es"} |

## Review And Improvement

| Field | Value |
|---|---|
| \`human_review.result\` | Pending |
| \`improvement_candidate.summary\` | ${fd?.improvement ?? "none recorded"} |
`
}

// Pilot-1 contracts.
//
// route-decision.v1: the Python predecessor computed route approval inline in
// RunLoop.run (gate_decision in an approve-set, route_to_worker true,
// worker == the loop's worker). Here those gate semantics are a contract —
// loop data — because in the five-slot model the router is just a Step and
// "was the route approved" is a deterministic check on its output value.
//
// dry-run-note.v1: ported check-for-check from the frozen Python spec
// (agent_workflows/contracts/dry_run_note.py + docs/agent-workflows/
// contracts/dry-run-note.v1.md). One addition: the artifact path arrives
// derived from effect attribution (the one changed-and-allowed file —
// kernel/effects.ts artifactFromEffects), so the contract first pins it
// to the runner-expected path — what Python guaranteed by construction.

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { Contract, ContractCheck } from "../kernel/contract.js"

export const ROUTE_DECISION_V1 = "route-decision.v1"
export const DRY_RUN_NOTE_V1 = "dry-run-note.v1"

/** This loop family's worker (the TOML's `worker = "codex"` — an executable fact). */
const EXPECTED_WORKER = "codex"

const APPROVE_DECISIONS = new Set(["accept", "accepted", "allow", "allowed", "approve", "approved", "pass"])

/** Python layout, mirrored: the worker artifact lives under the allowed root, named by trace id. */
export const ALLOWED_WORKER_ROOT = "docs/agent-workflows"
export function expectedArtifactPath(traceId: string): string {
  return `${ALLOWED_WORKER_ROOT}/runner-dry-runs/${traceId}.md`
}

export const routeDecisionV1: Contract = {
  id: ROUTE_DECISION_V1,
  validate(output) {
    const gateDecision = typeof output.gateDecision === "string" ? output.gateDecision : ""
    const worker = typeof output.worker === "string" ? output.worker : ""
    const reason = typeof output.reason === "string" ? output.reason : ""
    const checks: ContractCheck[] = [
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
        label: "worker is the loop's worker",
        passed: worker.toLowerCase() === EXPECTED_WORKER,
        detail: `expected worker \`${EXPECTED_WORKER}\`, got \`${worker || "<missing>"}\``,
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

/** Port of dry_run_note.markdown_section: the body between a heading and the next `## `. */
function markdownSection(text: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`^${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m").exec(text)
  return match ? match[1]!.trim() : ""
}

export const dryRunNoteV1: Contract = {
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

    const checks: ContractCheck[] = [
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
        label: "worker recorded",
        passed: lower.includes(ctx.executorId.toLowerCase()) && lower.includes("worker"),
        detail: `expected worker \`${ctx.executorId}\` to be named`,
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

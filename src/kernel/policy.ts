// The Policy slot: a pure function from deterministic Observation to Decision.
//
// Ported from looper's decide_pilot1_next_step (agent_workflows/
// dynamic_workflow_harness.py), generalized from Pilot-1 fields to per-step
// observations. The mapping:
//   route_available/route_approved/worker_ran  -> executorRan (stopped-before gates)
//   worker_exit_status != 0                    -> stepStatus !== "completed"
//   expected_artifact_exists/content_valid     -> outputValid / contractValid
//   worker_changes_allowed/unexpected_changes  -> effectsAllowed / unexpectedChanges
// looper's LoopRetryPolicy attempt cap (policies/retry.py) becomes the
// retryPolicy combinator below.

export type DecisionKind = "continue" | "retry" | "escalate" | "stop"
export type Classification = "success" | "failure" | "no_op"

/** Only deterministic facts. No prose from the executor, no model output. */
export interface Observation {
  readonly loopId: string
  readonly loopVersion: string
  readonly runId: string
  readonly stepId: string
  readonly stepIndex: number
  readonly stepCount: number
  readonly attempt: number // 1-based
  readonly executorId: string
  /** False when the engine stopped before execution (dry-run stop-points, trust gate). */
  readonly executorRan: boolean
  readonly stepStatus: import("./types.js").StepStatus | null
  /** Output parsed cleanly against the step signature. */
  readonly outputValid: boolean
  readonly contractId: string | null
  /** True when the step has no contract. */
  readonly contractValid: boolean
  readonly contractFailedChecks: readonly string[]
  readonly effectsAllowed: boolean
  readonly unexpectedChanges: readonly string[]
}

export interface Decision {
  readonly kind: DecisionKind
  readonly classification: Classification
  readonly summary: string
  readonly notes: readonly string[]
  /** For retry decisions: what the next attempt should fix. */
  readonly retryHint?: string
}

export type Policy = (obs: Observation) => Decision

/** The default per-step decision procedure (the ported crown jewel). */
export function decideNextStep(obs: Observation): Decision {
  if (!obs.executorRan) {
    return {
      kind: "escalate",
      classification: "no_op",
      summary: `step \`${obs.stepId}\` stopped before executor \`${obs.executorId}\` ran, so the loop needs a human before proceeding.`,
      notes: ["Executor was not run."],
    }
  }

  if (obs.stepStatus !== "completed") {
    const reason = `executor \`${obs.executorId}\` ${obs.stepStatus === "interrupted" ? "was interrupted" : "failed"} on step \`${obs.stepId}\`.`
    return {
      kind: "retry",
      classification: "failure",
      summary: `${reason} Retry with a smaller, contract-focused attempt.`,
      notes: [reason],
      retryHint: retryHint(obs, reason),
    }
  }

  if (!obs.outputValid || !obs.contractValid) {
    const reason = !obs.outputValid
      ? `step \`${obs.stepId}\` output did not satisfy its signature.`
      : `contract \`${obs.contractId}\` failed.`
    return {
      kind: "retry",
      classification: "failure",
      summary: `${reason} Retry targeting the contract exactly.`,
      notes: [reason, ...obs.contractFailedChecks.map((c) => `failed check: ${c}`)],
      retryHint: retryHint(obs, reason),
    }
  }

  if (!obs.effectsAllowed || obs.unexpectedChanges.length > 0) {
    const notes: string[] = []
    if (!obs.effectsAllowed) notes.push("At least one attributed change was outside the allowed effect scope.")
    if (obs.unexpectedChanges.length > 0) notes.push(`Unexpected changes: ${obs.unexpectedChanges.join(", ")}`)
    return {
      kind: "escalate",
      classification: "failure",
      summary: `step \`${obs.stepId}\` produced valid output, but the changed-file boundary needs human review.`,
      notes,
    }
  }

  const last = obs.stepIndex + 1 >= obs.stepCount
  return {
    kind: last ? "stop" : "continue",
    classification: "success",
    summary: last
      ? `step \`${obs.stepId}\` completed, its contract passed, and all changes stayed in scope; the loop is done.`
      : `step \`${obs.stepId}\` completed and passed; continue to the next step.`,
    notes: [],
  }
}

function retryHint(obs: Observation, reason: string): string {
  const failed = obs.contractFailedChecks.map((c) => `- ${c}`).join("\n") || "- none recorded"
  return [
    `Retry of step \`${obs.stepId}\` in loop \`${obs.loopId}\` (trace \`${obs.runId}\`).`,
    `Reason: ${reason}`,
    `Contract: \`${obs.contractId ?? "none"}\``,
    `Failed contract checks:\n${failed}`,
    `Rules: touch only the allowed effect scope; satisfy the contract exactly; stop if anything else would need to change.`,
  ].join("\n")
}

/**
 * Combinator: cap retries, escalating when exhausted. Ports
 * LoopRetryPolicy.plan_retry's max_worker_attempts check.
 */
export function retryPolicy(opts: { maxAttempts: number; base?: Policy }): Policy {
  const base = opts.base ?? decideNextStep
  return (obs) => {
    const decision = base(obs)
    if (decision.kind === "retry" && obs.attempt >= opts.maxAttempts) {
      return {
        ...decision,
        kind: "escalate",
        notes: [...decision.notes, `attempt ${obs.attempt} reached policy max ${opts.maxAttempts}; escalating.`],
      }
    }
    return decision
  }
}

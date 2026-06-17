// The Policy slot: a pure function from deterministic Observation to Decision.
//
// Ported from the Python predecessor's decide_pilot1_next_step (agent_workflows/
// dynamic_workflow_harness.py), generalized from Pilot-1 fields to per-step
// observations. The mapping:
//   route_available/route_approved/worker_ran  -> executorRan (stopped-before gates)
//   worker_exit_status != 0                    -> stepStatus !== "completed"
//   expected_artifact_exists/content_valid     -> outputValid / contractValid
//   worker_changes_allowed/unexpected_changes  -> effectsAllowed / unexpectedChanges
// the Python predecessor's LoopRetryPolicy attempt cap (policies/retry.py) becomes the
// retryPolicy combinator below.

// retry   = run the SAME step again (transient/contract failure).
// iterate = re-run the sub-sequence from an earlier step (the sequence
//           completed, but the result wasn't good enough yet — Pilot 2's
//           produce -> verify -> iterate-with-feedback shape).
export type DecisionKind = "continue" | "retry" | "escalate" | "stop" | "iterate"
export type Classification = "success" | "failure" | "no_op"

/**
 * Deterministic facts, plus the step's signature-VALIDATED output value.
 * The decision procedure stays a pure function over this record; what is
 * banned is free prose, not typed values. For judged loops the honest claim
 * is the design doc's: the deterministic part is the evidence and the
 * decision procedure, not the judgment itself.
 */
export interface Observation {
  readonly loopId: string
  readonly loopVersion: string
  readonly runId: string
  readonly stepId: string
  readonly stepIndex: number
  readonly stepCount: number
  readonly attempt: number // 1-based attempts of the CURRENT step (retry semantics)
  readonly iteration: number // 1-based passes over the step sequence (iterate semantics)
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
  readonly effectsObserved?: boolean
  readonly unexpectedChanges: readonly string[]
  /** The signature-validated output value of this step; null when outputValid is false. */
  readonly output: Readonly<Record<string, unknown>> | null
}

export interface Decision {
  readonly kind: DecisionKind
  readonly classification: Classification
  readonly summary: string
  readonly notes: readonly string[]
  /** The named improvement candidate (Python WorkflowDecision.improvement — feeds the trace). */
  readonly improvement: string
  /**
   * What the next execution should fix. Set by retry decisions (failed
   * contract checks) and by `until` loop-backs (the verifier's feedback);
   * the engine threads it into the next StepSpec for prompts to render.
   */
  readonly retryHint?: string
  /** For iterate decisions: step id to re-run from. Undefined = the loop's first step. */
  readonly restartAt?: string
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
      improvement: "Run the loop with execution enabled when the next pass should exercise this step.",
    }
  }

  if (obs.effectsObserved === false) {
    return {
      kind: "escalate",
      classification: "failure",
      summary: `step \`${obs.stepId}\` has unknown file effects after crash recovery; human review is required before proceeding.`,
      notes: ["Post-step effects were not observed before the prior process stopped."],
      improvement: "Inspect the worktree and ledger, then resume only after the side-effect boundary is understood.",
    }
  }

  if (obs.stepStatus !== "completed") {
    const reason = `executor \`${obs.executorId}\` ${obs.stepStatus === "interrupted" ? "was interrupted" : "failed"} on step \`${obs.stepId}\`.`
    return {
      kind: "retry",
      classification: "failure",
      summary: `${reason} Retry with a smaller, contract-focused attempt.`,
      notes: [reason],
      improvement: "Shrink the step prompt to only the expected output and contract fields before retrying.",
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
      improvement: `Make the next attempt explicitly satisfy \`${obs.contractId ?? "the step signature"}\` and nothing else.`,
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
      improvement: "Add a stricter mutation-boundary preflight before executor subdelegation.",
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
    improvement: obs.contractId
      ? `Use \`${obs.contractId}\` as the first callable contract boundary for this loop.`
      : "Name the smallest contract this step should enforce next.",
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

export interface UntilOpts {
  /** Hard iteration ceiling — the termination guarantee. Escalates when reached unmet. */
  readonly maxIterations: number
  /**
   * Step id whose successful completion the predicate grades. Default: the
   * loop's last step (Pilot 2's grade-is-last shape). When the graded step
   * sits mid-sequence (Pilot 3: grade before distill/remember),
   * predicate-met simply lets the base decision stand — the normal
   * positional `continue` — so the loop proceeds to the steps after it.
   */
  readonly at?: string
  /** Step id to loop back to when the predicate is unmet. Default: the loop's first step. */
  readonly restartAt?: string
  /** Extract feedback from the graded step's validated output, threaded into the next iteration. */
  readonly feedbackFrom?: (output: Readonly<Record<string, unknown>>) => string | undefined
  /** Per-step decision procedure for everything BEFORE the sequence completes. Default: decideNextStep. */
  readonly base?: Policy
}

/**
 * Combinator: iterate the step sequence until a predicate over the graded
 * step's validated output is met (the Ax-image loop: produce -> verify ->
 * if-fail-iterate-with-feedback -> until-passed).
 *
 * Composition with retry semantics: `base` governs every non-graded
 * outcome unchanged — transient executor/contract failures stay retries of
 * the SAME step. `until` intercepts only the graded step's successful
 * completion (`at`, default the last step): predicate met -> the base
 * decision stands, which is the existing positional progression (continue
 * when steps follow, stop when the graded step is last — no new branch);
 * iterations left -> iterate back to `restartAt`, threading
 * `feedbackFrom(output)` as the retryHint; ceiling reached -> escalate. An
 * `iterate` decision is therefore only ever emitted while iteration <
 * maxIterations, so a run cannot loop forever.
 */
export function until(
  predicate: (output: Readonly<Record<string, unknown>>, obs: Observation) => boolean,
  opts: UntilOpts,
): Policy {
  if (!Number.isInteger(opts.maxIterations) || opts.maxIterations < 1) {
    throw new Error(`until: maxIterations must be a positive integer, got ${opts.maxIterations}.`)
  }
  const base = opts.base ?? decideNextStep
  return (obs) => {
    const decision = base(obs)
    const success = decision.classification === "success" && (decision.kind === "continue" || decision.kind === "stop")
    const graded = opts.at !== undefined ? obs.stepId === opts.at : obs.stepIndex + 1 >= obs.stepCount
    if (!success || !graded) return decision

    const output = obs.output ?? {}
    if (predicate(output, obs)) {
      return {
        ...decision,
        summary: `${decision.summary} The until-predicate was met on iteration ${obs.iteration}.`,
      }
    }
    if (obs.iteration >= opts.maxIterations) {
      return {
        ...decision,
        kind: "escalate",
        classification: "failure",
        summary: `step \`${obs.stepId}\` completed but the until-predicate is unmet after ${obs.iteration} of ${opts.maxIterations} iterations; escalating.`,
        notes: [...decision.notes, `iteration ${obs.iteration} reached policy max ${opts.maxIterations}; escalating.`],
      }
    }
    const feedback = opts.feedbackFrom?.(output)
    return {
      kind: "iterate",
      classification: "failure",
      summary: `the until-predicate is unmet on iteration ${obs.iteration} of ${opts.maxIterations}; iterating from step \`${opts.restartAt ?? "<first>"}\` with feedback.`,
      notes: feedback !== undefined ? [`feedback: ${feedback}`] : [],
      improvement: "Tighten the producing step's prompt so the verifier's feedback is needed less often.",
      ...(opts.restartAt !== undefined ? { restartAt: opts.restartAt } : {}),
      ...(feedback !== undefined ? { retryHint: feedback } : {}),
    }
  }
}

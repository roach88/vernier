// Resume is replay of the ledger, not re-execution.
//
// resumeRun() rebuilds a Run from its journal alone: the meta entry restores
// the inputs, and each journaled decision is folded through the SAME
// nextState projection the live tick used — so the reconstructed
// (stepIndex, iteration, attempt, values, retryHint) is exactly where the
// crashed driver stood, including mid-iteration in an iterating loop. No
// executor runs during the fold; completed steps' outputs come from their
// step_result entries, re-parsed through the step signature (deterministic).
//
// The fold lands on the first slot WITHOUT a decision. If that slot already
// has a completed step_result (the crash landed between result and
// decision), tick() replays it by resume key (engine/tick.ts replayTick) —
// the one remaining gap the decision fold cannot cover.

import type { Run, RunState, RunStatus } from "./tick.js"
import { nextState } from "./tick.js"
import type { LedgerEntry, RunMetaEntry, StepResultEntry } from "../ledger/ledger.js"
import { journalPath, KEY_VERSION, Ledger, replay, resolveLedgerRoot } from "../ledger/ledger.js"
import type { Loop } from "../kernel/types.js"

/** Rebuild a Run from its journal. Pure read: no executor runs, nothing is appended. */
export function resumeRun(loop: Loop, runId: string): Run {
  const root = resolveLedgerRoot(loop.ledger)
  const path = journalPath(root, runId)
  const entries = Ledger.load(path)
  const view = replay(entries)
  const meta = view.meta
  if (!meta) {
    throw new Error(`Run \`${runId}\` has no journal (or no meta entry) under \`${root}\`. Nothing to resume.`)
  }
  if (meta.loopId !== loop.id) {
    throw new Error(`Run \`${runId}\` belongs to loop \`${meta.loopId}\`, not \`${loop.id}\`.`)
  }
  if (meta.loopVersion !== loop.version) {
    throw new Error(
      `Run \`${runId}\` was started by \`${meta.loopId}\`@${meta.loopVersion}; the registered loop is @${loop.version}. ` +
        `Refusing to resume across loop versions — the step shapes may have changed.`,
    )
  }

  const inputs = loop.signature.input.parse(meta.inputs) as Record<string, unknown>
  let state: RunState = {
    runId: meta.runId,
    traceId: meta.traceId,
    stepIndex: 0,
    attempt: 1,
    iteration: 1,
    status: "running",
    values: inputs,
  }

  // The fold: every journaled decision advances the state exactly as the
  // live tick did. Results are matched to decisions by resume key.
  const resultsByKey = new Map<string, StepResultEntry>()
  for (const entry of entries) {
    if (entry.type === "step_result") resultsByKey.set(entry.key, entry)
    else if (entry.type === "decision") {
      const step = loop.steps.find((s) => s.id === entry.stepId)
      if (!step) {
        throw new Error(`Journal for \`${runId}\` names step \`${entry.stepId}\`, which loop \`${loop.id}\`@${loop.version} does not declare.`)
      }
      const result = resultsByKey.get(entry.key)
      const validated =
        result && result.status === "completed" && result.outputValid
          ? (step.signature.output.parse(result.output) as Record<string, unknown>)
          : {}
      state = nextState(loop, state, entry.decision, validated)
    }
  }

  // Mid-tick replay (replayTick) trusts only keys written under the current
  // key scheme; pre-v2 journals still get the decision fold above.
  const replayed =
    meta.keyVersion === KEY_VERSION
      ? view
      : { ...view, terminal: new Map<string, StepResultEntry>(), completed: new Map<string, StepResultEntry>() }
  return { loop, ledger: new Ledger(path), state, replayed }
}

// ----------------------------------------------------- loop-agnostic summary

/**
 * What `vernier runs` needs without knowing the loop: status is derivable
 * from decisions alone (only escalate/stop change it), the rest from meta
 * and the last step_started entry.
 */
export interface JournalSummary {
  readonly meta: RunMetaEntry | undefined
  readonly status: RunStatus
  readonly lastStep: string | undefined
  readonly startedAt: string | undefined
}

export function summarizeJournal(entries: readonly LedgerEntry[]): JournalSummary {
  let meta: RunMetaEntry | undefined
  let status: RunStatus = "running"
  let lastStep: string | undefined
  for (const entry of entries) {
    if (entry.type === "meta") meta = entry
    else if (entry.type === "step_started") lastStep = `${entry.stepId} (iteration ${entry.iteration ?? 1}, attempt ${entry.attempt})` // pre-iteration journals lack the field
    else if (entry.type === "decision") {
      if (entry.decision.kind === "escalate") status = "needs_human"
      else if (entry.decision.kind === "stop") status = entry.decision.classification === "success" ? "done" : "stopped"
    }
  }
  return { meta, status, lastStep, startedAt: meta?.at }
}

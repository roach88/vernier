// The interpreter: tick, don't run a hardcoded sequence.
//
// One tick = run the next Step via its Executor, validate output against
// signature + contract, observe effects, call the pure Policy, append
// everything to the Ledger, return the next state. This is the generic
// version of what looper's RunLoop.run() did by hand for Pilot 1.
// run() stays `while (tick)` so the simple case is one call.

import { randomBytes } from "node:crypto"
import { dirname } from "node:path"
import type { ContractRegistry, ContractResult } from "../kernel/contract.js"
import { failedCheckMessages } from "../kernel/contract.js"
import { hashObserver, type EffectObservation, type EffectsObserver } from "../kernel/effects.js"
import type { Decision, Observation } from "../kernel/policy.js"
import type { Executor, Loop, StepResult } from "../kernel/types.js"
import { zeroUsage } from "../kernel/types.js"
import { journalPath, Ledger, resolveLedgerRoot, resumeKey, KEY_VERSION } from "../ledger/ledger.js"

export type RunStatus = "running" | "done" | "needs_human" | "stopped"

export interface RunState {
  readonly runId: string
  readonly traceId: string
  readonly stepIndex: number
  readonly attempt: number // 1-based attempt for the CURRENT step
  readonly status: RunStatus
  /** The data plane: loop inputs plus every completed step's outputs, by field name. */
  readonly values: Record<string, unknown>
  /** Set by a retry decision; rendered into the next attempt's spec so the prompt names what to fix. */
  readonly retryHint?: string | undefined
}

export interface EngineDeps {
  readonly executors: ReadonlyMap<string, Executor>
  readonly contracts: ContractRegistry
  /** Absolute path effects are observed under; scripts and agents work here. */
  readonly workdir: string
  /**
   * How effects are observed. Default: the hash-all-files observer (clean
   * scratch workdirs, Pilot 0). Loops whose workdir is a git repo should
   * pass the git-aware `gitObserver` from kernel/git-effects.ts.
   */
  readonly observer?: EffectsObserver
}

export interface Run {
  readonly loop: Loop
  readonly ledger: Ledger
  state: RunState
}

const now = (): string => new Date().toISOString()

export function startRun<I>(loop: Loop<I, any>, inputs: I, deps: EngineDeps, opts?: { runId?: string }): Run {
  if (loop.trust === "draft") {
    throw new Error(`Loop \`${loop.id}\` is draft; draft loops may not execute. Promote to dry-run first.`)
  }
  const parsed = loop.signature.input.parse(inputs) as Record<string, unknown>
  const runId = opts?.runId ?? `${loop.id}-${now().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`
  const ledger = new Ledger(journalPath(resolveLedgerRoot(loop.ledger), runId))
  ledger.append({
    type: "meta",
    runId,
    traceId: runId,
    loopId: loop.id,
    loopVersion: loop.version,
    trust: loop.trust,
    inputs: parsed,
    keyVersion: KEY_VERSION,
    at: now(),
  })
  return {
    loop,
    ledger,
    state: { runId, traceId: runId, stepIndex: 0, attempt: 1, status: "running", values: parsed },
  }
}

export interface TickOutcome {
  readonly state: RunState
  readonly decision: Decision
}

export async function tick(run: Run, deps: EngineDeps): Promise<TickOutcome> {
  const { loop, ledger, state } = run
  if (state.status !== "running") throw new Error(`Run \`${state.runId}\` is ${state.status}; nothing to tick.`)
  const step = loop.steps[state.stepIndex]
  if (!step) throw new Error(`Run \`${state.runId}\` has no step at index ${state.stepIndex}.`)

  // 1. Render the spec: validate inputs against the step signature.
  const inputs = step.signature.input.parse(state.values) as Record<string, unknown>
  const key = resumeKey(step.id, inputs)
  const executor = deps.executors.get(step.executor)
  if (!executor) throw new Error(`Unknown executor id \`${step.executor}\` for step \`${step.id}\`.`)

  ledger.append({ type: "step_started", key, stepId: step.id, attempt: state.attempt, executorId: executor.id, at: now() })

  // 2. Snapshot effects, 3. execute, 4. attribute changes against the scope.
  const observer = deps.observer ?? hashObserver
  const before = await observer.snapshot(deps.workdir)
  const base = {
    runId: state.runId,
    traceId: state.traceId,
    loopId: loop.id,
    loopVersion: loop.version,
    stepId: step.id,
    attempt: state.attempt,
    inputs,
    effects: step.effects,
    runDir: dirname(ledger.path),
    timeoutMs: step.timeoutMs ?? 600_000,
    ...(state.retryHint !== undefined ? { retryHint: state.retryHint } : {}),
  }
  const prompt = step.prompt?.(base)
  const spec = { ...base, ...(prompt !== undefined ? { prompt } : {}) }
  let result: StepResult
  try {
    result = await executor.run(spec, { workdir: deps.workdir })
  } catch (error) {
    result = {
      status: "failed",
      output: { error: error instanceof Error ? error.message : String(error) },
      evidence: [],
      usage: zeroUsage(),
    }
  }
  const effects: EffectObservation = await observer.assess(deps.workdir, before, step.effects)

  // 5. Project engine-observed fields over the executor's output (e.g. an
  //    artifact path from effect attribution — the projection wins on
  //    collision, so a self-report can never contradict the diff), then
  //    validate the output value: signature, then contract.
  const output = step.outputFrom ? { ...result.output, ...step.outputFrom(result, effects) } : result.output
  const outputParse = step.signature.output.safeParse(output)
  const outputValid = result.status === "completed" && outputParse.success
  let contractResult: ContractResult | null = null
  if (step.contract) {
    contractResult = deps.contracts.lookup(step.contract).validate(output, {
      traceId: state.traceId,
      loopId: loop.id,
      loopVersion: loop.version,
      workdir: deps.workdir,
      executorId: executor.id,
      runDir: dirname(ledger.path),
    })
  }

  ledger.append({ type: "step_result", key, stepId: step.id, attempt: state.attempt, status: result.status, output, outputValid, evidence: result.evidence, usage: result.usage, at: now() })
  if (contractResult) ledger.append({ type: "contract", key, stepId: step.id, attempt: state.attempt, result: contractResult, at: now() })
  ledger.append({ type: "effects", key, stepId: step.id, attempt: state.attempt, observation: effects, at: now() })

  // 6. Build the Observation from deterministic facts only; consult the pure Policy.
  const observation: Observation = {
    loopId: loop.id,
    loopVersion: loop.version,
    runId: state.runId,
    stepId: step.id,
    stepIndex: state.stepIndex,
    stepCount: loop.steps.length,
    attempt: state.attempt,
    executorId: executor.id,
    executorRan: true,
    stepStatus: result.status,
    outputValid,
    contractId: step.contract ?? null,
    contractValid: contractResult ? contractResult.valid : true,
    contractFailedChecks: contractResult ? failedCheckMessages(contractResult) : [],
    effectsAllowed: effects.allowed,
    unexpectedChanges: effects.unexpected,
  }
  const decision = loop.policy(observation)
  ledger.append({ type: "decision", key, stepId: step.id, attempt: state.attempt, decision, at: now() })

  // 7. Advance state. The journal is the only durable state; this is its projection.
  run.state = nextState(state, decision, outputValid && outputParse.success ? (outputParse.data as Record<string, unknown>) : {})
  return { state: run.state, decision }
}

function nextState(state: RunState, decision: Decision, output: Record<string, unknown>): RunState {
  const values = { ...state.values, ...output }
  switch (decision.kind) {
    case "continue":
      return { ...state, stepIndex: state.stepIndex + 1, attempt: 1, values, retryHint: undefined }
    case "retry":
      return { ...state, attempt: state.attempt + 1, values: state.values, retryHint: decision.retryHint }
    case "escalate":
      return { ...state, status: "needs_human", values }
    case "stop":
      return { ...state, status: decision.classification === "success" ? "done" : "stopped", values }
  }
}

export interface RunOutcome<O> {
  readonly state: RunState
  readonly decision: Decision
  readonly output: O | null
}

/** The simple case stays one call: run = while (tick). */
export async function runLoop<I, O>(loop: Loop<I, O>, inputs: I, deps: EngineDeps, opts?: { runId?: string }): Promise<RunOutcome<O>> {
  const run = startRun(loop, inputs, deps, opts)
  let outcome: TickOutcome
  do {
    outcome = await tick(run, deps)
  } while (outcome.state.status === "running")
  // `verdict` is the engine's one reserved output field — the final decision's
  // classification, merged so a loop signature can promise a verdict no step
  // produces (step values win on collision). Kept as a reserved name: an
  // explicit projection slot on Loop would be more machinery than this one
  // deterministic, engine-owned field justifies.
  const output =
    outcome.state.status === "done"
      ? (loop.signature.output.parse({ verdict: outcome.decision.classification, ...run.state.values }) as O)
      : null
  return { state: outcome.state, decision: outcome.decision, output }
}

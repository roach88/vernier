// The interpreter: tick, don't run a hardcoded sequence.
//
// One tick = run the next Step via its Executor, validate output against
// signature + contract, observe effects, call the pure Policy, append
// everything to the Ledger, return the next state. This is the generic
// version of what the Python predecessor's RunLoop.run() did by hand for Pilot 1.
// run() stays `while (tick)` so the simple case is one call.

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import type { ContractRegistry, ContractResult } from "../kernel/contract.js"
import { failedCheckMessages } from "../kernel/contract.js"
import { hashObserver, type EffectObservation, type EffectsObserver } from "../kernel/effects.js"
import type { Decision, Observation } from "../kernel/policy.js"
import type { Executor, Loop, MemoryStore, Step, StepResult, StepSkill } from "../kernel/types.js"
import { derivedOutputSchema, zeroUsage } from "../kernel/types.js"
import { journalPath, Ledger, resolveLedgerRoot, resumeKey, KEY_VERSION, type Replay, type StepResultEntry } from "../ledger/ledger.js"
import { embedSkillsInPrompt, nativeSkillsDirective, skillBody } from "../skills/skills.js"

export type RunStatus = "running" | "done" | "needs_human" | "stopped"

export interface RunState {
  readonly runId: string
  readonly traceId: string
  readonly stepIndex: number
  readonly attempt: number // 1-based attempt for the CURRENT step
  readonly iteration: number // 1-based pass over the step sequence; incremented by iterate decisions
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
  /**
   * The durable rule store (memory/memory.ts), threaded to executors via
   * RunContext. Inject ONE store across consecutive runs to let learning
   * compound — that sharing, not the store itself, is the memory feature.
   * Only loops with recall/remember steps need it.
   */
  readonly memory?: MemoryStore
  /**
   * Resolved Agent Skills by name (skills/skills.ts discovery, performed at
   * the CLI layer). Only loops whose steps declare `skills` need it; a step
   * naming a skill this map lacks fails before its step_started entry.
   */
  readonly skills?: ReadonlyMap<string, StepSkill>
}

export interface Run {
  readonly loop: Loop
  readonly ledger: Ledger
  state: RunState
  /**
   * The ledger's replay view, attached by resumeRun (engine/resume.ts).
   * When a slot's resume key hits `replayed.completed`, tick() returns the
   * LEDGERED result instead of executing — LLM steps are non-deterministic
   * and side-effecting steps must not double-apply, so a completed step is
   * replayed, never re-run. Fresh runs have no view and always execute.
   */
  readonly replayed?: Replay
}

const now = (): string => new Date().toISOString()

/** Fresh run id: loopId + timestamp + entropy. Exposed so a driver can lease the run dir BEFORE the first journal write. */
export function newRunId(loop: Loop): string {
  return `${loop.id}-${now().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`
}

export function startRun<I>(loop: Loop<I, any>, inputs: I, deps: EngineDeps, opts?: { runId?: string }): Run {
  if (loop.trust === "draft") {
    throw new Error(`Loop \`${loop.id}\` is draft; draft loops may not execute. Promote to dry-run first.`)
  }
  const parsed = loop.signature.input.parse(inputs) as Record<string, unknown>
  const runId = opts?.runId ?? newRunId(loop)
  const path = journalPath(resolveLedgerRoot(loop.ledger), runId)
  if (existsSync(path)) {
    throw new Error(`Run \`${runId}\` already has a journal at \`${path}\`. Resume it instead of starting it again.`)
  }
  const ledger = new Ledger(path)
  ledger.append({
    type: "meta",
    runId,
    traceId: runId,
    loopId: loop.id,
    loopVersion: loop.version,
    trust: loop.trust,
    inputs: parsed,
    keyVersion: KEY_VERSION,
    workdir: deps.workdir,
    at: now(),
  })
  return {
    loop,
    ledger,
    state: { runId, traceId: runId, stepIndex: 0, attempt: 1, iteration: 1, status: "running", values: parsed },
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
  const key = resumeKey(step.id, inputs, state.iteration, state.attempt)

  // RESUME IS REPLAY: when the ledger already holds a completed result for
  // this exact (stepId, iteration, attempt, inputs) slot — a crash landed
  // after the step_result but before its decision — the slot is replayed
  // from the ledger, never re-executed. LLM steps are non-deterministic and
  // side-effecting steps (codex writes, `remember`) must not double-apply.
  const journaled = run.replayed?.completed.get(key)
  if (journaled) return replayTick(run, deps, step, key, journaled)

  const executor = deps.executors.get(step.executor)
  if (!executor) throw new Error(`Unknown executor id \`${step.executor}\` for step \`${step.id}\`.`)

  // Resolve the step's Agent Skills BEFORE the step_started entry: an
  // unresolvable name or a skill on a promptless step is a wiring error,
  // not an attempt the journal should record. Delivery is the executor's
  // declared mode: "native" executors load skills provider-side (the spec's
  // progressive disclosure intact); everyone else gets the bodies embedded
  // in the prompt below.
  const stepSkills: StepSkill[] = (step.skills ?? []).map((name) => {
    const skill = deps.skills?.get(name)
    if (!skill) {
      throw new Error(
        `Unknown skill \`${name}\` for step \`${step.id}\`. Register it in vernier.config (skills: [...]) or place it under .claude/skills.`,
      )
    }
    return skill
  })
  if (stepSkills.length > 0 && !step.prompt) {
    throw new Error(`Step \`${step.id}\` declares skills but no prompt template; skills are delivered through the prompt seam.`)
  }
  const skillsDelivery: "native" | "prompt" | undefined =
    stepSkills.length === 0 ? undefined : executor.skillDelivery === "native" ? "native" : "prompt"

  ledger.append({
    type: "step_started",
    key,
    stepId: step.id,
    attempt: state.attempt,
    iteration: state.iteration,
    executorId: executor.id,
    ...(skillsDelivery !== undefined
      ? { skills: { resolved: stepSkills.map(({ name, dir }) => ({ name, dir })), delivery: skillsDelivery } }
      : {}),
    at: now(),
  })

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
    iteration: state.iteration,
    inputs,
    effects: step.effects,
    runDir: dirname(ledger.path),
    timeoutMs: step.timeoutMs ?? 600_000,
    ...(state.retryHint !== undefined ? { retryHint: state.retryHint } : {}),
    // Structured-output opt-in: the schema is DERIVED from the step's zod
    // output signature here, never hand-written (see kernel/types.ts).
    ...(step.structuredOutput ? { outputSchema: derivedOutputSchema(step.signature) } : {}),
  }
  // Skill delivery happens at prompt-render time: native executors get the
  // structured skills (spec.skills) plus a short use-these directive; every
  // other executor gets the SKILL.md bodies embedded, delimited and
  // attributed. spec.skills present ⇔ the executor owes native delivery.
  const rendered = step.prompt?.(base)
  const prompt =
    rendered === undefined || skillsDelivery === undefined
      ? rendered
      : skillsDelivery === "native"
        ? rendered + nativeSkillsDirective(stepSkills)
        : embedSkillsInPrompt(
            rendered,
            stepSkills.map((skill) => ({ ...skill, body: skillBody(skill.file) })),
          )
  const spec = {
    ...base,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(skillsDelivery === "native" ? { skills: stepSkills } : {}),
  }
  let result: StepResult
  try {
    result = await executor.run(spec, { workdir: deps.workdir, ...(deps.memory ? { memory: deps.memory } : {}) })
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

  ledger.append({ type: "step_result", key, stepId: step.id, attempt: state.attempt, iteration: state.iteration, status: result.status, output, outputValid, evidence: result.evidence, usage: result.usage, at: now() })
  if (contractResult) ledger.append({ type: "contract", key, stepId: step.id, attempt: state.attempt, iteration: state.iteration, result: contractResult, at: now() })
  ledger.append({ type: "effects", key, stepId: step.id, attempt: state.attempt, iteration: state.iteration, observation: effects, at: now() })

  // 6. Build the Observation (deterministic facts + the validated output value);
  //    consult the pure Policy.
  const validatedOutput = outputValid && outputParse.success ? (outputParse.data as Record<string, unknown>) : null
  const observation: Observation = {
    loopId: loop.id,
    loopVersion: loop.version,
    runId: state.runId,
    stepId: step.id,
    stepIndex: state.stepIndex,
    stepCount: loop.steps.length,
    attempt: state.attempt,
    iteration: state.iteration,
    executorId: executor.id,
    executorRan: true,
    stepStatus: result.status,
    outputValid,
    contractId: step.contract ?? null,
    contractValid: contractResult ? contractResult.valid : true,
    contractFailedChecks: contractResult ? failedCheckMessages(contractResult) : [],
    effectsAllowed: effects.allowed,
    unexpectedChanges: effects.unexpected,
    output: validatedOutput,
  }
  const decision = loop.policy(observation)
  ledger.append({ type: "decision", key, stepId: step.id, attempt: state.attempt, iteration: state.iteration, decision, at: now() })

  // 7. Advance state. The journal is the only durable state; this is its projection.
  run.state = nextState(loop, state, decision, validatedOutput ?? {})
  return { state: run.state, decision }
}

/**
 * Replay one completed slot from the ledger: the journaled output stands in
 * for execution (the executor is NOT invoked), the journaled contract and
 * effects entries stand in for re-observation, and only the missing tail of
 * the tick — at minimum the decision — is appended. Deterministic pieces
 * (signature parse; the contract, when its entry is missing) are recomputed;
 * non-deterministic and side-effecting pieces are never re-run.
 */
function replayTick(run: Run, deps: EngineDeps, step: Step, key: string, journaled: StepResultEntry): TickOutcome {
  const { loop, ledger, state } = run
  // Tolerant lookup: replaying must not require the executor to be wired.
  const executorId = deps.executors.get(step.executor)?.id ?? step.executor

  const output = journaled.output
  const outputParse = step.signature.output.safeParse(output)
  const outputValid = outputParse.success

  let contractResult: ContractResult | null = null
  if (step.contract) {
    const ledgered = run.replayed?.contracts.get(key)
    if (ledgered) {
      contractResult = ledgered.result
    } else {
      // Crash landed before the contract entry: recompute (deterministic) and append it.
      contractResult = deps.contracts.lookup(step.contract).validate(output, {
        traceId: state.traceId,
        loopId: loop.id,
        loopVersion: loop.version,
        workdir: deps.workdir,
        executorId,
        runDir: dirname(ledger.path),
      })
      ledger.append({ type: "contract", key, stepId: step.id, attempt: state.attempt, iteration: state.iteration, result: contractResult, at: now() })
    }
  }

  // Effects: replay the ledgered observation. If the crash landed before the
  // effects entry was written, the before-snapshot is gone and observation is
  // impossible — assume a clean scope rather than re-executing the step.
  const effects: EffectObservation =
    run.replayed?.effects.get(key)?.observation ?? { changed: [], allowed: true, unexpected: [] }

  const validatedOutput = outputValid ? (outputParse.data as Record<string, unknown>) : null
  const observation: Observation = {
    loopId: loop.id,
    loopVersion: loop.version,
    runId: state.runId,
    stepId: step.id,
    stepIndex: state.stepIndex,
    stepCount: loop.steps.length,
    attempt: state.attempt,
    iteration: state.iteration,
    executorId,
    executorRan: true, // it ran — before the crash; that execution is what's being replayed
    stepStatus: journaled.status,
    outputValid,
    contractId: step.contract ?? null,
    contractValid: contractResult ? contractResult.valid : true,
    contractFailedChecks: contractResult ? failedCheckMessages(contractResult) : [],
    effectsAllowed: effects.allowed,
    unexpectedChanges: effects.unexpected,
    output: validatedOutput,
  }
  const decision = loop.policy(observation)
  ledger.append({ type: "decision", key, stepId: step.id, attempt: state.attempt, iteration: state.iteration, decision, at: now() })
  run.state = nextState(loop, state, decision, validatedOutput ?? {})
  return { state: run.state, decision }
}

/** The journal-to-state projection. Exported for the resume fold (engine/resume.ts); not a public API. */
export function nextState(loop: Loop, state: RunState, decision: Decision, output: Record<string, unknown>): RunState {
  const values = { ...state.values, ...output }
  switch (decision.kind) {
    case "continue":
      return { ...state, stepIndex: state.stepIndex + 1, attempt: 1, values, retryHint: undefined }
    case "retry":
      return { ...state, attempt: state.attempt + 1, values: state.values, retryHint: decision.retryHint }
    case "iterate": {
      // Loop back over the sub-sequence: a fresh pass (attempt resets, the
      // iteration counter is the termination guard `until` enforces), with
      // the verifier's feedback threaded into the next spec via retryHint.
      const stepIndex = decision.restartAt === undefined ? 0 : loop.steps.findIndex((s) => s.id === decision.restartAt)
      if (stepIndex < 0) {
        throw new Error(`Decision restartAt \`${decision.restartAt}\` names no step in loop \`${loop.id}\`.`)
      }
      return { ...state, stepIndex, attempt: 1, iteration: state.iteration + 1, values, retryHint: decision.retryHint }
    }
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

/** Drive a running run to a terminal state: while (tick). Works on fresh AND resumed runs. */
export async function driveRun(run: Run, deps: EngineDeps): Promise<TickOutcome> {
  let outcome: TickOutcome
  do {
    outcome = await tick(run, deps)
  } while (outcome.state.status === "running")
  return outcome
}

/**
 * The loop's promised output, parsed from the final values. `verdict` is the
 * engine's one reserved output field — the final decision's classification,
 * merged so a loop signature can promise a verdict no step produces (step
 * values win on collision). Kept as a reserved name: an explicit projection
 * slot on Loop would be more machinery than this one deterministic,
 * engine-owned field justifies.
 */
export function finalOutput<O>(loop: Loop<any, O>, state: RunState, decision: Decision): O | null {
  return state.status === "done"
    ? (loop.signature.output.parse({ verdict: decision.classification, ...state.values }) as O)
    : null
}

/** The simple case stays one call: run = while (tick). */
export async function runLoop<I, O>(loop: Loop<I, O>, inputs: I, deps: EngineDeps, opts?: { runId?: string }): Promise<RunOutcome<O>> {
  const run = startRun(loop, inputs, deps, opts)
  const outcome = await driveRun(run, deps)
  return { state: outcome.state, decision: outcome.decision, output: finalOutput(loop, run.state, outcome.decision) }
}

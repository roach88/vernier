// `vernier doctor`: can this installation actually run its registered loops?
//
// Two layers, reported in order:
//
//   executors  every executor the registered loops' runtimes register plus
//              the config-registered ones (with ZERO loops registered: the
//              baseline set every config loop's default runtime would get,
//              so a fresh install still learns what this machine could
//              run), each probed for
//              the ONE thing it needs: CLI-backed executors a binary on
//              PATH (claude included — the Claude Code CLI, like every
//              other provider; judge/distill the binary of whichever
//              provider actually backs them), in-process executors nothing
//              (loading the module that declared them already proved
//              them). The memory RETRIEVER is probed here too (one
//              `memory:<tier>` row per selected tier): the embedding tier
//              needs its optional package; the lexical default needs
//              nothing.
//   loops      per registered loop, every step's executor binding resolved
//              through the same chain a run would use (config bindings >
//              the step's declared default — doctor reports the at-rest
//              state, so CLI --executor overrides do not apply), and judged
//              runnable iff the resolved executor is registered AND its
//              probe passed. A step on the builtin recall/remember
//              executors is additionally blocked when the runtime's memory
//              retriever probe failed (a custom memory executor makes no
//              such claim — same caveat as the judge probe).
//
// Truth over declaration: doctor enumerates executors by building each
// entry's REAL runtime in a throwaway scratch dir (construction is lazy —
// nothing spawns), so the report can never drift from what `vernier run`
// would resolve. Probes never execute the probed thing: binaries are
// looked up on PATH, optional packages are resolved but not imported.
// Exit 0 iff every registered loop is runnable; an unusable executor no
// step resolves to is reported but does not fail the doctor.

import { accessSync, constants, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { ClaudeExecutor } from "../executors/claude.js"
import { CodexExecutor } from "../executors/codex.js"
import { CursorExecutor } from "../executors/cursor.js"
import { HermesExecutor } from "../executors/hermes.js"
import { JudgeExecutor } from "../executors/judge.js"
import { recallExecutor, rememberExecutor } from "../executors/memory.js"
import { OpencodeExecutor } from "../executors/opencode.js"
import { PiExecutor } from "../executors/pi.js"
import type { ProviderId } from "../executors/vendor/omegacode/types.js"
import type { Executor } from "../kernel/types.js"
import { EMBEDDING_PACKAGE, EmbeddingRetriever } from "../memory/embedding.js"
import { Memory, retrieverFromEnv } from "../memory/memory.js"
import type { Retriever } from "../memory/retriever.js"
import { resolveExecutorId, type BindingLayer, type LoadedConfig } from "./config.js"
import type { RegisteredLoop } from "./registry.js"

// ------------------------------------------------------------------- probes

/** The two environment questions doctor asks, injectable for tests. */
export interface DoctorProbes {
  /** PATH lookup: absolute path of the first executable match, or undefined. Never runs the binary. */
  which(bin: string): string | undefined
  /** Module presence: resolvable from vernier's own location, without importing it. */
  resolvable(specifier: string): boolean
}

export const defaultProbes: DoctorProbes = {
  which(bin) {
    if (isAbsolute(bin)) return executable(bin) ? bin : undefined
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (!dir) continue
      const candidate = join(dir, bin)
      if (executable(candidate)) return candidate
    }
    return undefined
  },
  resolvable(specifier) {
    try {
      import.meta.resolve(specifier)
      return true
    } catch {
      return false
    }
  },
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// ------------------------------------------------------------------- report

export interface ExecutorReport {
  readonly id: string
  readonly ok: boolean
  /** What the probe checked: a binary name, an optional-package specifier (the embedding retriever), or null for in-process executors. */
  readonly requires: string | null
  readonly detail: string
}

export interface StepReport {
  readonly stepId: string
  /** The executor id the step declares. */
  readonly declared: string
  /** After config bindings — what a run would actually resolve. */
  readonly resolved: string
  readonly ok: boolean
  readonly why: string
}

export interface LoopReport {
  readonly loopId: string
  readonly source: string
  readonly runnable: boolean
  readonly steps: readonly StepReport[]
  /** Set when the loop's runtime factory itself threw (e.g. a tool it shells out to is missing). */
  readonly error?: string
}

export interface DoctorReport {
  readonly executors: readonly ExecutorReport[]
  readonly loops: readonly LoopReport[]
  /** True iff every registered loop is runnable. The doctor's exit code. */
  readonly ok: boolean
}

// ---------------------------------------------------------------- diagnosis

/** The binary each provider id spawns — what doctor looks up on PATH. */
const PROVIDER_BIN: Record<ProviderId, string> = {
  codex: "codex",
  "cursor-agent": "cursor-agent",
  "claude-code": "claude",
  opencode: "opencode",
  pi: "pi",
}

/** Probe one executor for the one thing it needs. Classification is by implementation, not id string. */
function checkExecutor(executor: Executor, fromConfig: boolean, probes: DoctorProbes): ExecutorReport {
  const id = executor.id
  if (fromConfig) {
    return { id, ok: true, requires: null, detail: "config-registered executor (its module loaded)" }
  }
  const bin =
    executor instanceof CodexExecutor
      ? "codex"
      : executor instanceof JudgeExecutor
        ? PROVIDER_BIN[executor.provider] // whichever provider actually backs judge/distill
        : executor instanceof ClaudeExecutor
          ? "claude" // the Claude Code CLI, probed like every other provider
          : executor instanceof CursorExecutor
            ? "cursor-agent"
            : executor instanceof OpencodeExecutor
              ? "opencode"
              : executor instanceof PiExecutor
                ? "pi"
                : executor instanceof HermesExecutor
                  ? "hermes"
                  : null
  if (bin !== null) {
    const found = probes.which(bin)
    return {
      id,
      ok: found !== undefined,
      requires: bin,
      detail: found !== undefined ? `\`${bin}\` on PATH (${found})` : `\`${bin}\` not found on PATH`,
    }
  }
  // Anything else exists in-process (a script step, a store op, a loop
  // module's own executor) — the module that declared it already loaded.
  return { id, ok: true, requires: null, detail: "in-process executor (module loaded)" }
}

/**
 * Probe the memory retriever for the one thing it needs — the embedding
 * tier its optional package (the one remaining optional-peer probe); every
 * other tier is in-process. Classification is by implementation, not id string.
 */
function checkRetriever(retriever: Retriever, probes: DoctorProbes): ExecutorReport {
  const id = `memory:${retriever.id}`
  if (retriever instanceof EmbeddingRetriever) {
    const ok = probes.resolvable(EMBEDDING_PACKAGE)
    return {
      id,
      ok,
      requires: EMBEDDING_PACKAGE,
      detail: ok
        ? `${EMBEDDING_PACKAGE} resolvable`
        : `${EMBEDDING_PACKAGE} not installed (optional peer) — npm install ${EMBEDDING_PACKAGE}`,
    }
  }
  return { id, ok: true, requires: null, detail: "in-process retriever (no external dependency)" }
}

/**
 * Build the full report. Each entry's runtime is constructed in a fresh
 * scratch dir and shut down immediately — executor construction is lazy
 * everywhere in this repo, so nothing spawns.
 */
export async function diagnose(
  registry: ReadonlyMap<string, RegisteredLoop>,
  config: LoadedConfig | undefined,
  probes: DoctorProbes = defaultProbes,
): Promise<DoctorReport> {
  const bindings: BindingLayer[] = [config?.bindings ?? new Map<string, string>()]
  const configIds = new Set((config?.executors ?? []).map((e) => e.id))
  const checked = new Map<string, ExecutorReport>()
  const check = (executor: Executor): ExecutorReport => {
    let report = checked.get(executor.id)
    if (!report) {
      report = checkExecutor(executor, configIds.has(executor.id), probes)
      checked.set(executor.id, report)
    }
    return report
  }

  // ZERO LOOPS REGISTERED: there is no runtime to enumerate executors from,
  // but the environment question is still worth answering — probe the set
  // every config-registered loop's default runtime would get (the wired
  // providers, the judge, hermes, the store ops, the selected memory
  // retriever), so a fresh install learns what this machine could run.
  // No loops means nothing is blocked: the doctor exits 0.
  if (registry.size === 0) {
    const baseline: Executor[] = [
      new CodexExecutor(),
      new CursorExecutor(),
      new ClaudeExecutor(),
      new OpencodeExecutor(),
      new PiExecutor(),
      new JudgeExecutor(),
      new HermesExecutor(),
      recallExecutor,
      rememberExecutor,
    ]
    for (const executor of baseline) check(executor)
    for (const executor of config?.executors ?? []) check(executor)
    const retrieverReport = checkRetriever(retrieverFromEnv(), probes)
    checked.set(retrieverReport.id, retrieverReport)
    for (const executor of baseline) await (executor as { shutdown?: () => Promise<void> }).shutdown?.()
    return { executors: [...checked.values()], loops: [], ok: true }
  }

  const loops: LoopReport[] = []
  for (const entry of registry.values()) {
    let runtime: ReturnType<RegisteredLoop["runtime"]>
    try {
      runtime = entry.runtime(mkdtempSync(join(tmpdir(), "vernier-doctor-")))
    } catch (error) {
      loops.push({
        loopId: entry.loop.id,
        source: entry.source,
        runnable: false,
        steps: [],
        error: `runtime factory failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    try {
      // The same merge `vernier run` performs: config executors over the entry's set.
      const executors = new Map(runtime.deps.executors)
      for (const executor of config?.executors ?? []) executors.set(executor.id, executor)
      for (const executor of executors.values()) check(executor)

      // The runtime's memory retriever, probed like any executor (the
      // builtin Memory only — a user's own MemoryStore makes no claim).
      const memory = runtime.deps.memory
      let retrieverReport: ExecutorReport | undefined
      if (memory instanceof Memory) {
        retrieverReport = checked.get(`memory:${memory.retriever.id}`) ?? checkRetriever(memory.retriever, probes)
        checked.set(retrieverReport.id, retrieverReport)
      }

      const steps: StepReport[] = entry.loop.steps.map((step) => {
        const resolved = resolveExecutorId(step, bindings)
        const registered = executors.get(resolved)
        if (registered === undefined) {
          return {
            stepId: step.id,
            declared: step.executor,
            resolved,
            ok: false,
            why: `executor \`${resolved}\` is not registered for this loop (registered: ${[...executors.keys()].join(", ")})`,
          }
        }
        const report = check(registered)
        // A store op is only as usable as the store's retriever: recall and
        // remember run THROUGH it, so a failed retriever probe blocks them.
        const memoryBlocked =
          retrieverReport !== undefined && !retrieverReport.ok && (registered === recallExecutor || registered === rememberExecutor)
        const ok = report.ok && !memoryBlocked
        const why = !report.ok ? report.detail : memoryBlocked ? retrieverReport!.detail : "ok"
        return { stepId: step.id, declared: step.executor, resolved, ok, why }
      })
      loops.push({ loopId: entry.loop.id, source: entry.source, runnable: steps.every((s) => s.ok), steps })
    } finally {
      await runtime.shutdown()
    }
  }

  return {
    executors: [...checked.values()],
    loops,
    ok: loops.every((l) => l.runnable),
  }
}

// ------------------------------------------------------------- human output

export function renderDoctor(report: DoctorReport): string[] {
  const mark = (ok: boolean): string => (ok ? "ok" : "!!")
  const lines: string[] = ["EXECUTORS"]
  for (const e of report.executors) {
    lines.push(`  ${mark(e.ok)}  ${e.id.padEnd(28)} ${e.detail}`)
  }
  lines.push("", "LOOPS")
  if (report.loops.length === 0) {
    lines.push("  none registered — nothing is broken, and nothing can run yet.")
    lines.push("  Scaffold a starter with `vernier init` (templates) or register loops via vernier.config.")
  }
  for (const l of report.loops) {
    const blocked = l.steps.filter((s) => !s.ok).length
    const summary = l.error ?? (l.runnable ? `runnable (${l.steps.length} step${l.steps.length === 1 ? "" : "s"})` : `${blocked} of ${l.steps.length} steps blocked`)
    lines.push(`  ${mark(l.runnable)}  ${l.loopId.padEnd(28)} ${summary}`)
    for (const s of l.steps) {
      const binding = s.resolved === s.declared ? s.resolved : `${s.declared} => ${s.resolved}`
      lines.push(`        ${s.stepId} -> ${binding}${s.ok ? "" : `  (${s.why})`}`)
    }
  }
  lines.push(
    "",
    report.loops.length === 0
      ? "no loops registered; the executor probes above say what this machine could run."
      : report.ok
        ? "all registered loops are runnable."
        : "some loops are not runnable; see above.",
  )
  return lines
}

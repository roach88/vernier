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
//              them).
//   loops      per registered loop, every step's executor binding resolved
//              through the same chain a run would use (config bindings >
//              the step's declared default — doctor reports the at-rest
//              state, so CLI --executor overrides do not apply), and judged
//              runnable iff the resolved executor is registered AND its
//              probe passed. A step on the builtin recall/remember
//              executors only needs the in-process store op to be registered.
//
// Truth over declaration: doctor enumerates executors by building each
// entry's REAL runtime in a throwaway scratch dir (construction is lazy —
// nothing spawns), so the report can never drift from what `vernier run`
// would resolve. Probes never execute the probed thing: binaries are
// looked up on PATH; nothing is executed.
// Exit 0 iff every registered loop is runnable; an unusable executor no
// step resolves to is reported but does not fail the doctor.

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeExecutor } from "../executors/claude.js"
import { CodexExecutor } from "../executors/codex.js"
import { defaultWhich, resolveCursorBin } from "../executors/cursor-bin.js"
import { CursorExecutor } from "../executors/cursor.js"
import { JudgeExecutor } from "../executors/judge.js"
import { recallExecutor, rememberExecutor } from "../executors/memory.js"
import { OpencodeExecutor } from "../executors/opencode.js"
import { PiExecutor } from "../executors/pi.js"
import type { ProviderId } from "../executors/vendor/omegacode/types.js"
import { derivedOutputSchema } from "../kernel/types.js"
import type { Executor, Step } from "../kernel/types.js"
import { resolveSkillNames, type SkillBindingLayer, type SkillOrigin, type SkillRegistry } from "../skills/skills.js"
import { judgeBackingProvider, resolveExecutorId, type BindingLayer, type LoadedConfig } from "./config.js"
import type { RegisteredLoop } from "./registry.js"

// ------------------------------------------------------------------- probes

/** The two environment questions doctor asks, injectable for tests. */
export interface DoctorProbes {
  /** PATH lookup: absolute path of the first executable match, or undefined. Never runs the binary. */
  which(bin: string): string | undefined
  /** Environment relevant to executor probing. Tests inject this so local VERNIER_* vars do not leak into reports. */
  env(): NodeJS.ProcessEnv
}

export const defaultProbes: DoctorProbes = {
  which: defaultWhich,
  env() {
    return process.env
  },
}

// ------------------------------------------------------------------- report

export interface ExecutorReport {
  readonly id: string
  readonly ok: boolean
  /** What the probe checked: a binary name, or null for in-process executors. */
  readonly requires: string | null
  readonly detail: string
}

export interface StepSkillReport {
  readonly name: string
  readonly ok: boolean
  /** The skill dir when ok; the reason when not. */
  readonly detail: string
}

export interface StepReport {
  readonly stepId: string
  /** The executor id the step declares. */
  readonly declared: string
  /** After config bindings — what a run would actually resolve. */
  readonly resolved: string
  /** The step's Agent Skills after config skillBindings, each probed against the discovered registry. Present only when the step resolves skills. */
  readonly skills?: readonly StepSkillReport[]
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

/** One discovered (or rejected) Agent Skill in the inventory section. */
export interface SkillReport {
  /** The skill name; for invalid entries, the offending path. */
  readonly name: string
  readonly ok: boolean
  readonly origin: SkillOrigin
  /** The skill dir when ok; the spec violation when not. */
  readonly detail: string
}

export interface DoctorReport {
  readonly executors: readonly ExecutorReport[]
  /** The discovered skill inventory (config > project > user) plus standard-location skills that fail the spec. */
  readonly skills: readonly SkillReport[]
  readonly loops: readonly LoopReport[]
  /** Reserved for non-fatal advisories. Kept in --json for downstream parsers; currently empty. */
  readonly warnings: readonly string[]
  /** True iff every registered loop is runnable. The doctor's exit code. */
  readonly ok: boolean
}

// ---------------------------------------------------------------- diagnosis

/** The binary each provider id spawns — what doctor looks up on PATH. */
const PROVIDER_BIN: Record<Exclude<ProviderId, "cursor-agent">, string> = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
  pi: "pi",
}

function providerBin(provider: ProviderId, probes: DoctorProbes): ExecutorReport {
  if (provider === "cursor-agent") {
    const cursor = resolveCursorBin({ env: probes.env(), which: probes.which })
    return { id: provider, ok: cursor.ok, requires: cursor.requires, detail: cursor.detail }
  }
  const bin = PROVIDER_BIN[provider]
  const found = probes.which(bin)
  return {
    id: provider,
    ok: found !== undefined,
    requires: bin,
    detail: found !== undefined ? `\`${bin}\` on PATH (${found})` : `\`${bin}\` not found on PATH`,
  }
}

/** Probe one executor for the one thing it needs. Classification is by implementation, not id string. */
function checkExecutor(executor: Executor, fromConfig: boolean, probes: DoctorProbes): ExecutorReport {
  const id = executor.id
  if (fromConfig) {
    return { id, ok: true, requires: null, detail: "config-registered executor (its module loaded)" }
  }
  if (executor instanceof CursorExecutor) {
    const cursor = providerBin("cursor-agent", probes)
    return {
      id,
      ok: cursor.ok,
      requires: cursor.requires,
      detail: cursor.detail,
    }
  }

  const bin =
    executor instanceof CodexExecutor
      ? "codex"
      : executor instanceof JudgeExecutor
        ? null
        : executor instanceof ClaudeExecutor
          ? "claude" // the Claude Code CLI, probed like every other provider
          : executor instanceof OpencodeExecutor
              ? "opencode"
              : executor instanceof PiExecutor
                ? "pi"
                : null
  if (executor instanceof JudgeExecutor) {
    const report = providerBin(executor.provider, probes)
    return { id, ok: report.ok, requires: report.requires, detail: report.detail }
  }
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

/** The empty skill registry: what diagnose assumes when the caller skipped discovery. */
export const NO_SKILLS: SkillRegistry = { skills: new Map(), invalid: [] }

/**
 * Resolve a step's skills (config skillBindings > declared default; --skill
 * overrides do not apply at rest) and probe each against the discovered
 * registry. Shared by the runnable and broken-runtime paths so a loop whose
 * runtime factory threw STILL reports its declared skills — otherwise a
 * user-tier skill it needs would be wrongly elided from the inventory.
 */
function stepSkillReports(step: Step, skillBindings: readonly SkillBindingLayer[], skills: SkillRegistry): StepSkillReport[] {
  return resolveSkillNames(step, skillBindings).map((name) => {
    const found = skills.skills.get(name)
    return found !== undefined
      ? { name, ok: true, detail: found.dir }
      : { name, ok: false, detail: `skill \`${name}\` is not discovered (vernier.config skills, <project>/.agents/skills, ~/.agents/skills)` }
  })
}

/**
 * Build the full report. Each entry's runtime is constructed in a fresh
 * scratch dir and shut down immediately — executor construction is lazy
 * everywhere in this repo, so nothing spawns. The skill registry arrives
 * discovered (cmdDoctor runs the real discovery; tests inject) so this
 * stays deterministic under injected probes.
 */
export async function diagnose(
  registry: ReadonlyMap<string, RegisteredLoop>,
  config: LoadedConfig | undefined,
  probes: DoctorProbes = defaultProbes,
  skills: SkillRegistry = NO_SKILLS,
): Promise<DoctorReport> {
  const bindings: BindingLayer[] = [config?.bindings ?? new Map<string, string>()]
  const skillBindings: SkillBindingLayer[] = [config?.skillBindings ?? new Map<string, readonly string[]>()]
  const skillRows: SkillReport[] = [
    ...[...skills.skills.values()].map((s) => ({ name: s.name, ok: true, origin: s.origin, detail: s.dir })),
    ...skills.invalid.map((i) => ({ name: i.path, ok: false, origin: i.origin, detail: i.reason })),
  ]
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
  // providers, the judge, and the store ops), so a fresh install
  // learns what this machine could run.
  // No loops means nothing is blocked: the doctor exits 0.
  if (registry.size === 0) {
    const baseline: Executor[] = [
      new CodexExecutor(),
      new CursorExecutor(),
      new ClaudeExecutor(),
      new OpencodeExecutor(),
      new PiExecutor(),
      // The baseline judge honors the config's `judge` block too — a config
      // with a judge block but zero loops still reports the right binary.
      new JudgeExecutor({ provider: judgeBackingProvider(config) }),
      recallExecutor,
      rememberExecutor,
    ]
    for (const executor of baseline) check(executor)
    for (const executor of config?.executors ?? []) check(executor)
    for (const executor of baseline) await (executor as { shutdown?: () => Promise<void> }).shutdown?.()
    return { executors: [...checked.values()], skills: skillRows, loops: [], warnings: [], ok: true }
  }

  const loops: LoopReport[] = []
  for (const entry of registry.values()) {
    let runtime: ReturnType<RegisteredLoop["runtime"]>
    try {
      runtime = entry.runtime(mkdtempSync(join(tmpdir(), "vernier-doctor-")))
    } catch (error) {
      // The runtime is gone, but the loop's DECLARED skills are still known —
      // report them (marked not-ok, loop unavailable) so the inventory's
      // elision counts a user-tier skill this loop needs as referenced.
      const steps: StepReport[] = entry.loop.steps.map((step) => {
        const skillReports = stepSkillReports(step, skillBindings, skills)
        const base = { stepId: step.id, declared: step.executor, resolved: resolveExecutorId(step, bindings), ok: false, why: "loop runtime unavailable" }
        return skillReports.length > 0 ? { ...base, skills: skillReports } : base
      })
      loops.push({
        loopId: entry.loop.id,
        source: entry.source,
        runnable: false,
        steps,
        error: `runtime factory failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    try {
      // The same merge `vernier run` performs: config executors over the entry's set.
      const executors = new Map(runtime.deps.executors)
      for (const executor of config?.executors ?? []) executors.set(executor.id, executor)
      for (const executor of executors.values()) check(executor)

      const steps: StepReport[] = entry.loop.steps.map((step) => {
        // The step's skills, through the SAME chain a run would use at rest
        // (config skillBindings > the step's declared default; CLI --skill
        // overrides do not apply, same as --executor), each probed against
        // the discovered registry.
        const skillReports = stepSkillReports(step, skillBindings, skills)
        const promptlessSkills = skillReports.length > 0 && !step.prompt
        const withSkills = (report: Omit<StepReport, "skills">): StepReport =>
          skillReports.length > 0 ? { ...report, skills: skillReports } : report

        const resolved = resolveExecutorId(step, bindings)
        const registered = executors.get(resolved)
        if (registered === undefined) {
          return withSkills({
            stepId: step.id,
            declared: step.executor,
            resolved,
            ok: false,
            why: `executor \`${resolved}\` is not registered for this loop (registered: ${[...executors.keys()].join(", ")})`,
          })
        }
        const report = check(registered)
        // Derive-probe (zod-skew / typeless / unrepresentable): a structuredOutput
        // step's schema is derived at tick time, before the paid turn. If
        // derivation throws here — z.any()/z.unknown() collapsing to {} (typeless),
        // an unrepresentable type, or the loop module having built its signature
        // with a DIFFERENT zod than the kernel converts with (skew) — the run would
        // crash on this step. Surface it at rest instead of mid-run.
        let schemaError: string | undefined
        if (step.structuredOutput) {
          try {
            derivedOutputSchema(step.signature)
          } catch (error) {
            schemaError = error instanceof Error ? error.message : String(error)
          }
        }
        const skillBlocked = skillReports.some((s) => !s.ok) || promptlessSkills
        // Block priority, most fundamental first: executor unresolved/probe-failed
        // > schema won't derive > skill unresolved.
        // schemaError is set only for structuredOutput steps, so it is vacuously
        // absent (undefined) for every other step.
        const ok = report.ok && !schemaError && !skillBlocked
        const why = !report.ok
          ? report.detail
          : schemaError
            ? schemaError
            : promptlessSkills
              ? "declares skills but no prompt template (skills travel through the prompt seam)"
              : skillReports.find((s) => !s.ok)?.detail ?? "ok"
        return withSkills({ stepId: step.id, declared: step.executor, resolved, ok, why })
      })
      loops.push({ loopId: entry.loop.id, source: entry.source, runnable: steps.every((s) => s.ok), steps })
    } finally {
      await runtime.shutdown()
    }
  }

  return {
    executors: [...checked.values()],
    skills: skillRows,
    loops,
    warnings: [],
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
  if (report.skills.length > 0) {
    // Config/project skills and every invalid skill print in full; valid
    // user-tier (~/.agents/skills) skills that no step references collapse
    // to a count — a big personal skill library must not drown the report
    // (--json always carries every row).
    const referenced = new Set(report.loops.flatMap((l) => l.steps.flatMap((s) => (s.skills ?? []).map((sk) => sk.name))))
    const shown = report.skills.filter((s) => !s.ok || s.origin !== "user" || referenced.has(s.name))
    const elided = report.skills.length - shown.length
    lines.push("", "SKILLS")
    for (const s of shown) {
      lines.push(`  ${mark(s.ok)}  ${s.name.padEnd(28)} ${s.origin}: ${s.detail}`)
    }
    if (elided > 0) lines.push(`      (+ ${elided} more spec-valid skill${elided === 1 ? "" : "s"} under ~/.agents/skills; see --json)`)
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
      for (const sk of s.skills ?? []) {
        lines.push(`          skill ${sk.name}${sk.ok ? "" : `  (${sk.detail})`}`)
      }
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

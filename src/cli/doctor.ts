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

import { accessSync, constants, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { ClaudeExecutor } from "../executors/claude.js"
import { CodexExecutor } from "../executors/codex.js"
import { CursorExecutor } from "../executors/cursor.js"
import { HermesExecutor } from "../executors/hermes.js"
import { JudgeExecutor } from "../executors/judge.js"
import { recallExecutor, rememberExecutor } from "../executors/memory.js"
import { OpencodeExecutor } from "../executors/opencode.js"
import { PiExecutor } from "../executors/pi.js"
import type { ProviderId } from "../executors/vendor/omegacode/types.js"
import { derivedOutputSchema } from "../kernel/types.js"
import type { Executor, Step } from "../kernel/types.js"
import { EMBEDDING_PACKAGE, EmbeddingRetriever } from "../memory/embedding.js"
import { Memory, retrieverFromEnv } from "../memory/memory.js"
import type { Retriever } from "../memory/retriever.js"
import { resolveSkillNames, type SkillBindingLayer, type SkillOrigin, type SkillRegistry } from "../skills/skills.js"
import { judgeBackingProvider, resolveExecutorId, type BindingLayer, type LoadedConfig } from "./config.js"
import type { RegisteredLoop } from "./registry.js"

// ------------------------------------------------------------------- probes

/** A node_modules/zod install on the resolution chain: its dir and the version its package.json declares (`""` when unreadable). */
export interface ZodInstall {
  readonly path: string
  readonly version: string
}

/** The two environment questions doctor asks, injectable for tests. */
export interface DoctorProbes {
  /** PATH lookup: absolute path of the first executable match, or undefined. Never runs the binary. */
  which(bin: string): string | undefined
  /** Module presence: resolvable from vernier's own location, without importing it. */
  resolvable(specifier: string): boolean
  /** Every node_modules/zod on the upward dir chain from cwd, nearest first, each with its declared version — the zod-skew shadow probe. Never imports zod. */
  zodInstalls(): readonly ZodInstall[]
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
  zodInstalls() {
    const found: ZodInstall[] = []
    let dir = process.cwd()
    for (;;) {
      const here = join(dir, "node_modules", "zod")
      const manifest = join(here, "package.json")
      try {
        if (statSync(manifest).isFile()) found.push({ path: here, version: zodVersion(manifest) })
      } catch {
        // no zod install at this level; keep climbing
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return found
  },
}

/** A zod install's declared version; "" when its package.json is unreadable/unparseable (treated as a skew, never silently equal). */
function zodVersion(manifest: string): string {
  try {
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version
    return typeof version === "string" ? version : ""
  } catch {
    return ""
  }
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
  /** Non-fatal environment advisories — e.g. a second zod resolvable above the project (a skew shadow). Never affects `ok`. */
  readonly warnings: readonly string[]
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

/** The empty skill registry: what diagnose assumes when the caller skipped discovery. */
export const NO_SKILLS: SkillRegistry = { skills: new Map(), invalid: [] }

/**
 * Turn the zod-install probe into a skew advisory. The NEAREST node_modules/zod
 * is what this project resolves (nearest wins — a correctly installed project is
 * never shadowed). Any install ABOVE it never reaches THIS project, but it DOES
 * catch a dependency-less dir under it — a loop scaffolded but not yet
 * `npm install`ed, or a globally installed vernier driving a bare loop file —
 * which then resolves a DIFFERENT zod than the kernel converts with. A v3/v4
 * skew there fails schema derivation (z.toJSONSchema rejects a foreign schema).
 * Surfaced before it bites; a warning, never a doctor failure. NOTE: this walks
 * from cwd, not from each loop module's own resolution path, so it can miss a
 * global-install skew — the per-step derive-probe is the AUTHORITATIVE check
 * (it catches a foreign-zod schema by the derivation throw, wherever the stray
 * install sits). This is the cheaper proactive hint. SAME-version installs above
 * are not a skew (z.toJSONSchema accepts a same-version schema), so they are
 * suppressed — only a genuine version divergence from the nearest zod is surfaced.
 */
function zodSkewWarnings(installs: readonly ZodInstall[]): string[] {
  const [nearest, ...rest] = installs
  if (!nearest || rest.length === 0) return []
  // Only a DIFFERENT version above can fail derivation; a same-version shadow is benign.
  // Unknown versions ("") stay in — never claim a sameness we can't prove.
  const skews = rest.filter((s) => s.version !== nearest.version || nearest.version === "")
  if (skews.length === 0) return []
  const plural = skews.length === 1 ? "" : "s"
  const list = skews.map((s) => `${s.path} (zod ${s.version || "version unknown"})`).join(", ")
  return [
    `zod resolves here from ${nearest.path} (zod ${nearest.version || "version unknown"}), but ${skews.length} ` +
      `version-skewed zod install${plural} sit above it (${list}). A dependency-less dir under those — a freshly ` +
      `scaffolded loop run before \`npm install\`, or a global vernier driving a bare loop file — resolves that zod ` +
      `instead, and the skew against the kernel's zod then fails schema derivation. Remove the stray install${plural}.`,
  ]
}

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
      : { name, ok: false, detail: `skill \`${name}\` is not discovered (vernier.config skills, <project>/.claude/skills, ~/.claude/skills)` }
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
  // Environment advisory, loop-independent: a second zod resolvable above the project.
  const warnings = zodSkewWarnings(probes.zodInstalls())
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
      // The baseline judge honors the config's `judge` block too — a config
      // with a judge block but zero loops still reports the right binary.
      new JudgeExecutor({ provider: judgeBackingProvider(config) }),
      new HermesExecutor(),
      recallExecutor,
      rememberExecutor,
    ]
    for (const executor of baseline) check(executor)
    for (const executor of config?.executors ?? []) check(executor)
    const retrieverReport = checkRetriever(retrieverFromEnv(), probes)
    checked.set(retrieverReport.id, retrieverReport)
    for (const executor of baseline) await (executor as { shutdown?: () => Promise<void> }).shutdown?.()
    return { executors: [...checked.values()], skills: skillRows, loops: [], warnings, ok: true }
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

      // The runtime's memory retriever, probed like any executor (the
      // builtin Memory only — a user's own MemoryStore makes no claim).
      const memory = runtime.deps.memory
      let retrieverReport: ExecutorReport | undefined
      if (memory instanceof Memory) {
        retrieverReport = checked.get(`memory:${memory.retriever.id}`) ?? checkRetriever(memory.retriever, probes)
        checked.set(retrieverReport.id, retrieverReport)
      }

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
        // A store op is only as usable as the store's retriever: recall and
        // remember run THROUGH it, so a failed retriever probe blocks them.
        const memoryBlocked =
          retrieverReport !== undefined && !retrieverReport.ok && (registered === recallExecutor || registered === rememberExecutor)
        const skillBlocked = skillReports.some((s) => !s.ok) || promptlessSkills
        // Block priority, most fundamental first: executor unresolved/probe-failed
        // > schema won't derive > memory retriever down > skill unresolved.
        // schemaError is set only for structuredOutput steps, so it is vacuously
        // absent (undefined) for every other step.
        const ok = report.ok && !schemaError && !memoryBlocked && !skillBlocked
        const why = !report.ok
          ? report.detail
          : schemaError
            ? schemaError
            : memoryBlocked
              ? retrieverReport!.detail
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
    warnings,
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
    // user-tier (~/.claude/skills) skills that no step references collapse
    // to a count — a big personal skill library must not drown the report
    // (--json always carries every row).
    const referenced = new Set(report.loops.flatMap((l) => l.steps.flatMap((s) => (s.skills ?? []).map((sk) => sk.name))))
    const shown = report.skills.filter((s) => !s.ok || s.origin !== "user" || referenced.has(s.name))
    const elided = report.skills.length - shown.length
    lines.push("", "SKILLS")
    for (const s of shown) {
      lines.push(`  ${mark(s.ok)}  ${s.name.padEnd(28)} ${s.origin}: ${s.detail}`)
    }
    if (elided > 0) lines.push(`      (+ ${elided} more spec-valid skill${elided === 1 ? "" : "s"} under ~/.claude/skills; see --json)`)
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
  if (report.warnings.length > 0) {
    lines.push("", "WARNINGS")
    for (const w of report.warnings) lines.push(`  !!  ${w}`)
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

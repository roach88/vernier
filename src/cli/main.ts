// The vernier CLI: drive loops by name, resume runs from their ledgers.
//
// Agent-ergonomic by design — this tool orchestrates agents, so its own CLI
// serves them: every command takes --json (machine output on stdout,
// diagnostics on stderr), exit codes are classed (below), and errors say
// what to do next. node:util parseArgs only; no CLI framework.
//
// EXIT CODES
//   0  success (run done; data printed)
//   1  terminal-but-not-success (needs_human / stopped) or unexpected failure
//   2  usage error (unknown command / loop / run, bad input JSON)
//   3  run lease held by a live driver
//
// The dogma holds here too: `run` is startRun + while(tick); `resume` is
// replay of the ledger (engine/resume.ts) + while(tick); `tick` is the loom
// `continue` inversion — anything (cron, a human, another agent) can advance
// a run one step, and the engine, not the caller, knows what is next.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { register as registerModuleHooks } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { ZodError } from "zod"
import { acquireLease, LeaseHeldError } from "../engine/lease.js"
import { resumeRun, summarizeJournal, type JournalSummary } from "../engine/resume.js"
import { driveRun, finalOutput, newRunId, startRun, tick, type EngineDeps, type Run, type TickOutcome } from "../engine/tick.js"
import type { Executor, Loop } from "../kernel/types.js"
import { journalPath, Ledger, resolveLedgerRoot, type LedgerEntry } from "../ledger/ledger.js"
import { buildTimeline, computedCostUsd, renderStats, renderTimeline, rollupByLoop, runStatsRow, type PriceModel, type RunStatsRow } from "../ledger/stats.js"
import { bindExecutors, ConfigError, loadConfig, type BindingLayer, type LoadedConfig } from "./config.js"
import { diagnose, renderDoctor } from "./doctor.js"
import { loopRegistry, type LoopRuntime, type RegisteredLoop } from "./registry.js"

// Lend the CLI's own dependencies to config modules: scaffolded templates
// import `zod` and `"vernier"` as bare specifiers, which a bare directory
// (no node_modules ancestry) cannot resolve. The hook retries ONLY failed
// resolutions against vernier's own tree — a project's node_modules always
// wins when it exists. Registered here because this module is the one
// entry point every mode shares (compiled bin, source-checkout bin,
// `npm run vernier`), and it runs before any config module is imported.
// Full rationale + trust note: bin/lend-deps-hooks.mjs.
registerModuleHooks(new URL("../../bin/lend-deps-hooks.mjs", import.meta.url))

const EXIT = { ok: 0, failed: 1, usage: 2, leaseHeld: 3 } as const

class UsageError extends Error {}

const out = (line: string): void => void process.stdout.write(line + "\n")
const note = (line: string): void => void process.stderr.write(line + "\n")
const json = (value: unknown): void => out(JSON.stringify(value, null, 2))

const HELP = `vernier — the loop is data; the ledger is append-only; resume is replay.

USAGE
  vernier init [template]                             list starter templates, or scaffold one into
                                                     the current directory (never overwrites)
  vernier loops                                       list registered loops (from vernier.config)
  vernier run <loopId> [--input '<json>'] [--input-file <path>] [--workdir <dir>]
             [--executor <stepIdOrExecutorId>=<executorId>]...
                                                     start a run, drive to terminal
  vernier tick <runId> [--workdir <dir>] [--executor ...]
                                                     advance ONE step from the ledger
  vernier resume <runId> [--workdir <dir>] [--executor ...]
                                                     continue a run to terminal
  vernier runs                                        list runs under the ledger root
  vernier show <runId>                                run timeline + per-step usage from the journal
  vernier stats [--loop <id>] [--last <n>]            usage/cost roll-ups across runs, per run and
               [--price-in <usd> --price-out <usd>]  per loop (prices are USD per 1M tokens; without
                                                     them the output is tokens only — never invented $)
  vernier doctor                                      probe executors + per-loop runnability
                                                     (exit 0 iff every registered loop is runnable)

Every command accepts --json (machine output on stdout; diagnostics on stderr).
Ledger root: $VERNIER_HOME, else ./.vernier

CONFIG
  vernier.config.{ts,js,mjs,json} — discovered from cwd upward (stops at the
  repo root), or set $VERNIER_CONFIG. Registers user loops, user executors,
  and executor bindings. vernier ships NO built-in loops: the registry is
  exactly what your config registers (\`vernier init\` scaffolds starters).
  Trust: loading a config EXECUTES its code with this process's privileges —
  the same trust you give any npm script.

EXECUTOR BINDING
  A step names an executor id; the implementation is resolved at run time:
  --executor overrides > config bindings > the loop's declared default.
  Keys may be a step id (binds that step) or an executor id (binds the role
  everywhere it appears in the loop).

EXIT CODES
  0 success   1 needs_human/stopped/failed   2 usage error   3 lease held`

// ------------------------------------------------------------------ helpers

interface Flags {
  readonly json: boolean
  readonly input?: string
  readonly inputFile?: string
  readonly workdir?: string
  /** Repeatable --executor <stepIdOrExecutorId>=<executorId> overrides. */
  readonly executor: readonly string[]
  /** `stats` filters/prices (raw strings; validated in cmdStats). */
  readonly loop?: string
  readonly last?: string
  readonly priceIn?: string
  readonly priceOut?: string
  readonly positionals: readonly string[]
}

function parseFlags(args: readonly string[]): Flags {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: {
        json: { type: "boolean", default: false },
        input: { type: "string" },
        "input-file": { type: "string" },
        workdir: { type: "string" },
        executor: { type: "string", multiple: true },
        loop: { type: "string" },
        last: { type: "string" },
        "price-in": { type: "string" },
        "price-out": { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    })
    if (values.help) {
      out(HELP)
      process.exit(EXIT.ok)
    }
    return {
      json: values.json === true,
      ...(values.input !== undefined ? { input: values.input } : {}),
      ...(values["input-file"] !== undefined ? { inputFile: values["input-file"] } : {}),
      ...(values.workdir !== undefined ? { workdir: resolve(values.workdir) } : {}),
      executor: values.executor ?? [],
      ...(values.loop !== undefined ? { loop: values.loop } : {}),
      ...(values.last !== undefined ? { last: values.last } : {}),
      ...(values["price-in"] !== undefined ? { priceIn: values["price-in"] } : {}),
      ...(values["price-out"] !== undefined ? { priceOut: values["price-out"] } : {}),
      positionals,
    }
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Parse --executor overrides, strictly: a key must name a step id or an
 * executor id the loop actually declares — a typo is a usage error, not a
 * silent no-op. (Config bindings are the lenient layer: global, applied
 * where they match.)
 */
function parseExecutorOverrides(pairs: readonly string[], loop: Loop): BindingLayer {
  const map = new Map<string, string>()
  if (pairs.length === 0) return map
  const stepIds = [...new Set(loop.steps.map((s) => s.id))]
  const executorIds = [...new Set(loop.steps.map((s) => s.executor))]
  for (const pair of pairs) {
    const eq = pair.indexOf("=")
    if (eq <= 0 || eq === pair.length - 1) {
      throw new UsageError(`--executor expects <stepIdOrExecutorId>=<executorId>, got \`${pair}\`.`)
    }
    const key = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    if (!stepIds.includes(key) && !executorIds.includes(key)) {
      throw new UsageError(
        `--executor \`${key}\` names no step or executor in \`${loop.id}\` (steps: ${stepIds.join(", ")}; executors: ${executorIds.join(", ")}).`,
      )
    }
    map.set(key, value)
  }
  return map
}

/** Layered bindings for one invocation: CLI overrides first, then config bindings. */
function bindingLayers(flags: Flags, loop: Loop, config: LoadedConfig | undefined): BindingLayer[] {
  return [parseExecutorOverrides(flags.executor, loop), config?.bindings ?? new Map<string, string>()]
}

/** Config-registered executors merge OVER the entry's runtime set (the user's config is closest to the user's intent). */
function withConfigExecutors(deps: EngineDeps, extra: readonly Executor[]): EngineDeps {
  if (extra.length === 0) return deps
  const executors = new Map(deps.executors)
  for (const executor of extra) executors.set(executor.id, executor)
  return { ...deps, executors }
}

/** Fail BEFORE the first journal write when a bound step names an executor nobody registered. */
function assertExecutorsResolvable(loop: Loop, executors: ReadonlyMap<string, Executor>): void {
  const missing = loop.steps.filter((s) => !executors.has(s.executor))
  if (missing.length === 0) return
  const detail = missing.map((s) => `step \`${s.id}\` -> executor \`${s.executor}\``).join("; ")
  throw new UsageError(
    `Unresolved executor binding(s): ${detail}. Registered executors: ${[...executors.keys()].join(", ")}. ` +
      `Register the executor in vernier.config (executors: [...]) or rebind with --executor <stepId>=<executorId>.`,
  )
}

function lookupLoop(registry: ReadonlyMap<string, RegisteredLoop>, loopId: string | undefined): RegisteredLoop {
  if (registry.size === 0) {
    throw new UsageError(
      "No loops are registered. vernier ships no built-in loops — scaffold a starter with `vernier init` " +
        "(`vernier init smoke` needs no agent or auth), or register loops via vernier.config.{ts,js,mjs,json}.",
    )
  }
  if (!loopId) throw new UsageError(`Missing <loopId>. Registered loops: ${[...registry.keys()].join(", ")}`)
  const entry = registry.get(loopId)
  if (!entry) throw new UsageError(`Unknown loop \`${loopId}\`. Registered loops: ${[...registry.keys()].join(", ")} (see \`vernier loops\`).`)
  return entry
}

function parseInputs(entry: RegisteredLoop, flags: Flags): Record<string, unknown> {
  let raw: string | undefined = flags.input
  if (flags.inputFile !== undefined) {
    if (raw !== undefined) throw new UsageError("Pass --input or --input-file, not both.")
    try {
      raw = readFileSync(flags.inputFile, "utf8")
    } catch {
      throw new UsageError(`Could not read --input-file \`${flags.inputFile}\`.`)
    }
  }
  let inputs: unknown = entry.defaultInputs ?? {}
  if (raw !== undefined) {
    try {
      inputs = JSON.parse(raw)
    } catch (error) {
      throw new UsageError(`--input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const parsed = entry.loop.signature.input.safeParse(inputs)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n")
    throw new UsageError(`Inputs do not satisfy \`${entry.loop.id}\`'s signature (${entry.signature}):\n${issues}`)
  }
  return inputs as Record<string, unknown>
}

function loadJournal(runId: string | undefined): { runId: string; path: string; entries: LedgerEntry[]; summary: JournalSummary } {
  if (!runId) throw new UsageError("Missing <runId>. See `vernier runs`.")
  const root = resolveLedgerRoot({})
  const path = journalPath(root, runId)
  const entries = Ledger.load(path)
  if (entries.length === 0) throw new UsageError(`No run \`${runId}\` under \`${root}\` (no journal at ${path}). See \`vernier runs\`.`)
  return { runId, path, entries, summary: summarizeJournal(entries) }
}

function entryLine(entry: LedgerEntry): string {
  const detail =
    entry.type === "meta"
      ? `${entry.loopId}@${entry.loopVersion} keys=${entry.keyVersion}`
      : entry.type === "decision"
        ? `${entry.stepId} iter=${entry.iteration} attempt=${entry.attempt} -> ${entry.decision.kind}/${entry.decision.classification}`
        : entry.type === "contract"
          ? `${entry.stepId} iter=${entry.iteration} attempt=${entry.attempt} ${entry.result.contractId} valid=${entry.result.valid}`
          : entry.type === "effects"
            ? `${entry.stepId} iter=${entry.iteration} attempt=${entry.attempt} changed=[${entry.observation.changed.join(", ")}] allowed=${entry.observation.allowed}`
            : entry.type === "step_result"
              ? `${entry.stepId} iter=${entry.iteration} attempt=${entry.attempt} status=${entry.status}`
              : `${entry.stepId} iter=${entry.iteration} attempt=${entry.attempt}`
  return `  ${entry.type.padEnd(13)} ${detail}`
}

function printOutcome(run: Run, outcome: TickOutcome, flags: Flags, extra: Record<string, unknown> = {}): void {
  const { state, decision } = outcome
  const output = finalOutput(run.loop, state, decision)
  if (flags.json) {
    json({
      runId: state.runId,
      loopId: run.loop.id,
      loopVersion: run.loop.version,
      status: state.status,
      stepIndex: state.stepIndex,
      iteration: state.iteration,
      attempt: state.attempt,
      decision: { kind: decision.kind, classification: decision.classification, summary: decision.summary },
      output,
      journal: run.ledger.path,
      ...extra,
    })
    return
  }
  out(`loop      ${run.loop.id}@${run.loop.version}`)
  out(`run       ${state.runId}`)
  out(`status    ${state.status}`)
  out(`decision  ${decision.kind} / ${decision.classification} — ${decision.summary}`)
  out(`output    ${JSON.stringify(output)}`)
  out(`ledger    ${run.ledger.path}`)
  out("--- ledger entries ---")
  for (const entry of Ledger.load(run.ledger.path)) out(entryLine(entry))
}

const terminalExit = (status: string): number => (status === "done" ? EXIT.ok : EXIT.failed)

// ----------------------------------------------------------------- commands

async function cmdLoops(flags: Flags): Promise<number> {
  const config = await loadConfig()
  const registry = loopRegistry(config)
  if (registry.size === 0) {
    // The friendly empty state: a fresh install has NO loops (vernier ships
    // none) — say so, and say how to start. stdout stays machine-clean
    // under --json ([]), so the pointers go to stderr there.
    const hint = [
      "no loops registered.",
      "",
      "vernier ships no built-in loops. Start with a template:",
      "  vernier init              list the starter templates",
      "  vernier init smoke        scaffold the deterministic starter (no agent, no auth)",
      "",
      config
        ? `config found at ${config.path}, but it registers no loops.`
        : "loops register via vernier.config.{ts,js,mjs,json}, discovered from the current",
      ...(config ? [] : ["directory upward (stopping at the repo root), or via $VERNIER_CONFIG."]),
    ]
    if (flags.json) {
      json([])
      for (const line of hint) note(line)
    } else {
      for (const line of hint) out(line)
    }
    return EXIT.ok
  }
  if (flags.json) {
    json(
      [...registry.values()].map((entry) => ({
        id: entry.loop.id,
        version: entry.loop.version,
        signature: entry.signature,
        trust: entry.loop.trust,
        steps: entry.loop.steps.map((s) => s.id),
        live: entry.live,
        source: entry.source,
        summary: entry.summary,
      })),
    )
    return EXIT.ok
  }
  for (const entry of registry.values()) {
    out(`${entry.loop.id}@${entry.loop.version}  trust=${entry.loop.trust}  source=${entry.source}${entry.live ? "  [live]" : ""}`)
    out(`  ${entry.signature}`)
    out(`  ${entry.summary}`)
  }
  return EXIT.ok
}

// -------------------------------------------------------------------- init

interface TemplateInfo {
  readonly name: string
  readonly dir: string
  readonly order: number
  /** The loop id the template registers (what `vernier run` will take). */
  readonly loop: string
  readonly description: string
  readonly requires: string
  /** Files the scaffold copies, template-dir-relative (template.json is metadata, never copied). */
  readonly files: readonly string[]
}

/**
 * templates/ ships at the package root (package.json `files`), two levels up
 * from this module — the SAME relative position from dist/cli/main.js
 * (compiled bin) and src/cli/main.ts (tsx dev), so one resolution covers both.
 */
function templatesRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates")
}

const TEMPLATE_META = "template.json"

function readTemplate(root: string, name: string): TemplateInfo {
  const dir = join(root, name)
  const meta = JSON.parse(readFileSync(join(dir, TEMPLATE_META), "utf8")) as {
    order?: number
    loop?: string
    description?: string
    requires?: string
  }
  const files = (readdirSync(dir, { recursive: true }) as string[])
    .filter((path) => path !== TEMPLATE_META && statSync(join(dir, path)).isFile())
    .sort()
  return {
    name,
    dir,
    order: meta.order ?? Number.MAX_SAFE_INTEGER,
    loop: meta.loop ?? name,
    description: meta.description ?? "",
    requires: meta.requires ?? "",
    files,
  }
}

function listTemplates(root: string): TemplateInfo[] {
  const names = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, TEMPLATE_META)))
    .map((d) => d.name)
  return names.map((name) => readTemplate(root, name)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

function cmdInit(flags: Flags): number {
  const root = templatesRoot()
  const templates = existsSync(root) ? listTemplates(root) : []
  if (templates.length === 0) {
    throw new UsageError(`No templates found under ${root} — this installation looks incomplete (templates/ ships with the package).`)
  }

  const name = flags.positionals[0]
  if (name === undefined) {
    if (flags.json) {
      json(templates.map(({ name, loop, description, requires, files }) => ({ name, loop, description, requires, files })))
      return EXIT.ok
    }
    out("TEMPLATES")
    for (const t of templates) {
      out(`  ${t.name.padEnd(16)} ${t.description}`)
      out(`  ${"".padEnd(16)} loop: ${t.loop} · requires: ${t.requires}`)
    }
    out("")
    out("scaffold one into the current directory: vernier init <template>")
    return EXIT.ok
  }

  const template = templates.find((t) => t.name === name)
  if (!template) {
    throw new UsageError(`Unknown template \`${name}\`. Templates: ${templates.map((t) => t.name).join(", ")} (see \`vernier init\`).`)
  }

  // Refuse-then-copy, atomically: check EVERY destination first so a
  // conflict copies nothing (a half-scaffold would be worse than none).
  const dest = process.cwd()
  const conflicts = template.files.filter((file) => existsSync(join(dest, file)))
  if (conflicts.length > 0) {
    throw new UsageError(
      `refusing to overwrite existing file(s): ${conflicts.join(", ")}. ` +
        `Scaffold into an empty directory, or remove the conflicting files first.`,
    )
  }
  for (const file of template.files) {
    const target = join(dest, file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(template.dir, file), target)
  }

  const next = [
    `vernier loops             the scaffolded config registers \`${template.loop}\``,
    `vernier run ${template.loop}`,
    "vernier doctor            probe what this machine can actually run",
  ]
  if (flags.json) {
    json({ template: template.name, loop: template.loop, dir: dest, files: template.files, next: next.map((n) => n.split(/\s{2,}/)[0]) })
    return EXIT.ok
  }
  out(`scaffolded template \`${template.name}\` into ${dest}:`)
  for (const file of template.files) out(`  ${file}`)
  out("")
  out("next steps:")
  for (const line of next) out(`  ${line}`)
  return EXIT.ok
}

async function cmdRun(flags: Flags): Promise<number> {
  const config = await loadConfig()
  const registry = loopRegistry(config)
  const entry = lookupLoop(registry, flags.positionals[0])
  const inputs = parseInputs(entry, flags)
  // Resolve executor bindings BEFORE the run: the Loop stays declarative
  // data — binding is a pure rewrite of step.executor ids at this layer.
  const loop = bindExecutors(entry.loop, bindingLayers(flags, entry.loop, config))
  const workdir = flags.workdir ?? entry.defaultWorkdir()
  if (entry.live) note(`note: \`${entry.loop.id}\` drives live LLM CLIs; this requires authed binaries on PATH.`)

  // Lease BEFORE the first journal write: the run dir is leased from birth.
  const runId = newRunId(loop)
  const runDir = dirname(journalPath(resolveLedgerRoot(loop.ledger), runId))
  const { lease } = acquireLease(runDir)
  let runtime: LoopRuntime | undefined
  try {
    runtime = entry.runtime(workdir)
    const deps = withConfigExecutors(runtime.deps, config?.executors ?? [])
    assertExecutorsResolvable(loop, deps.executors)
    const run = startRun(loop, inputs, deps, { runId })
    const outcome = await driveRun(run, deps)
    printOutcome(run, outcome, flags, { workdir })
    return terminalExit(outcome.state.status)
  } finally {
    lease.release()
    await runtime?.shutdown()
  }
}

interface ResumeTarget {
  readonly entry: RegisteredLoop
  readonly runId: string
  readonly runDir: string
  readonly workdir: string
}

function resumeTarget(flags: Flags, registry: ReadonlyMap<string, RegisteredLoop>): ResumeTarget {
  const { runId, path, summary } = loadJournal(flags.positionals[0])
  const meta = summary.meta
  if (!meta) throw new UsageError(`Run \`${runId}\` has a journal but no meta entry; it cannot be resumed.`)
  const entry = lookupLoop(registry, meta.loopId)
  const workdir = flags.workdir ?? meta.workdir
  if (!workdir) {
    throw new UsageError(`Run \`${runId}\` predates workdir recording in the journal; pass --workdir <dir> (the dir the run originally used).`)
  }
  return { entry, runId, runDir: dirname(path), workdir }
}

async function cmdTickOrResume(flags: Flags, mode: "tick" | "resume"): Promise<number> {
  const config = await loadConfig()
  const target = resumeTarget(flags, loopRegistry(config))
  // Same binding resolution as `run`: completed steps replay from the
  // ledger regardless (the resume key ignores the executor), so a rebind
  // only affects steps that still have to execute.
  const loop = bindExecutors(target.entry.loop, bindingLayers(flags, target.entry.loop, config))
  const { lease, tookOver } = acquireLease(target.runDir)
  if (tookOver) note(`note: took over a stale lease (pid ${tookOver.pid} on ${tookOver.host}, heartbeat ${tookOver.heartbeatAt}).`)
  let runtime: LoopRuntime | undefined
  try {
    runtime = target.entry.runtime(target.workdir)
    const deps = withConfigExecutors(runtime.deps, config?.executors ?? [])
    assertExecutorsResolvable(loop, deps.executors)
    const run = resumeRun(loop, target.runId)
    if (run.state.status !== "running") {
      const lastDecision = run.replayed?.lastDecision?.decision
      if (flags.json) {
        json({
          runId: run.state.runId,
          loopId: run.loop.id,
          status: run.state.status,
          alreadyTerminal: true,
          decision: lastDecision ? { kind: lastDecision.kind, classification: lastDecision.classification, summary: lastDecision.summary } : null,
          journal: run.ledger.path,
        })
      } else {
        out(`run ${run.state.runId} is already terminal: ${run.state.status}. Nothing to ${mode}.`)
      }
      return terminalExit(run.state.status)
    }
    const outcome = mode === "tick" ? await tick(run, deps) : await driveRun(run, deps)
    printOutcome(run, outcome, flags, { workdir: target.workdir, resumed: true })
    return outcome.state.status === "running" ? EXIT.ok : terminalExit(outcome.state.status)
  } finally {
    lease.release()
    await runtime?.shutdown()
  }
}

function cmdRuns(flags: Flags): number {
  const root = resolveLedgerRoot({})
  const runsDir = join(root, "runs")
  let ids: string[] = []
  try {
    ids = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    ids = [] // no runs yet
  }
  const summaries = ids
    .map((id) => ({ runId: id, summary: summarizeJournal(Ledger.load(journalPath(root, id))) }))
    .filter((r) => r.summary.meta !== undefined)
    .sort((a, b) => (a.summary.startedAt ?? "").localeCompare(b.summary.startedAt ?? ""))
  if (flags.json) {
    json(
      summaries.map(({ runId, summary }) => ({
        runId,
        loopId: summary.meta?.loopId,
        loopVersion: summary.meta?.loopVersion,
        status: summary.status,
        lastStep: summary.lastStep ?? null,
        startedAt: summary.startedAt,
      })),
    )
    return EXIT.ok
  }
  if (summaries.length === 0) {
    note(`no runs under ${runsDir}`)
    return EXIT.ok
  }
  for (const { runId, summary } of summaries) {
    out(`${runId}  ${summary.meta?.loopId}@${summary.meta?.loopVersion}  ${summary.status}  last=${summary.lastStep ?? "<none>"}  started=${summary.startedAt}`)
  }
  return EXIT.ok
}

function cmdShow(flags: Flags): number {
  const { runId, path, entries, summary } = loadJournal(flags.positionals[0])
  // The timeline is a pure derivation of the journal (ledger/stats.ts);
  // this command only loads and renders.
  const timeline = buildTimeline(entries)
  if (flags.json) {
    json({
      runId,
      loopId: summary.meta?.loopId,
      loopVersion: summary.meta?.loopVersion,
      status: summary.status,
      lastStep: summary.lastStep ?? null,
      startedAt: summary.startedAt,
      workdir: summary.meta?.workdir ?? null,
      journal: path,
      entries,
      timeline, // additive: events with offsets, per-step usage, totals
    })
    return EXIT.ok
  }
  out(`run       ${runId}`)
  out(`loop      ${summary.meta?.loopId}@${summary.meta?.loopVersion}`)
  out(`status    ${summary.status}`)
  out(`last      ${summary.lastStep ?? "<none>"}`)
  out(`started   ${summary.startedAt}`)
  out(`workdir   ${summary.meta?.workdir ?? "<not recorded>"}`)
  out(`journal   ${path}`)
  for (const line of renderTimeline(timeline)) out(line)
  return EXIT.ok
}

/** `stats` flag validation: --last a positive integer; prices both-or-neither (a one-sided price would lie). */
function parseStatsFlags(flags: Flags): { loop: string | null; last: number | null; prices: PriceModel | null } {
  let last: number | null = null
  if (flags.last !== undefined) {
    last = Number(flags.last)
    if (!Number.isInteger(last) || last <= 0) throw new UsageError(`--last expects a positive integer, got \`${flags.last}\`.`)
  }
  if ((flags.priceIn === undefined) !== (flags.priceOut === undefined)) {
    throw new UsageError("Pass BOTH --price-in and --price-out (USD per 1M tokens), or neither — a one-sided price would misstate cost.")
  }
  let prices: PriceModel | null = null
  if (flags.priceIn !== undefined && flags.priceOut !== undefined) {
    const inUsdPerMTok = Number(flags.priceIn)
    const outUsdPerMTok = Number(flags.priceOut)
    if (!Number.isFinite(inUsdPerMTok) || inUsdPerMTok < 0 || !Number.isFinite(outUsdPerMTok) || outUsdPerMTok < 0) {
      throw new UsageError(`--price-in/--price-out expect non-negative USD per 1M tokens, got \`${flags.priceIn}\` / \`${flags.priceOut}\`.`)
    }
    prices = { inUsdPerMTok, outUsdPerMTok }
  }
  return { loop: flags.loop ?? null, last, prices }
}

function cmdStats(flags: Flags): number {
  const { loop, last, prices } = parseStatsFlags(flags)
  const root = resolveLedgerRoot({})
  const runsDir = join(root, "runs")
  let ids: string[] = []
  try {
    ids = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    ids = [] // no runs yet
  }
  let rows = ids
    .map((id) => runStatsRow(id, Ledger.load(journalPath(root, id))))
    .filter((r): r is RunStatsRow => r !== null)
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.runId.localeCompare(b.runId))
  if (loop !== null) rows = rows.filter((r) => r.loopId === loop)
  if (last !== null) rows = rows.slice(-last)
  const rollups = rollupByLoop(rows)
  if (flags.json) {
    // Computed cost appears ONLY when prices were supplied; reportedCostUsd
    // (inside totals) is what executors themselves billed, always present.
    const withCost = <T extends { totals: RunStatsRow["totals"] }>(item: T): T & { costUsd?: number } =>
      prices === null ? item : { ...item, costUsd: computedCostUsd(item.totals, prices) }
    json({
      ledgerRoot: root,
      filters: { loop, last },
      prices,
      runs: rows.map(withCost),
      loops: rollups.map(withCost),
    })
    return EXIT.ok
  }
  if (rows.length === 0) {
    note(`no runs under ${runsDir}${loop === null ? "" : ` for loop \`${loop}\``}`)
    return EXIT.ok
  }
  for (const line of renderStats(rows, rollups, prices)) out(line)
  return EXIT.ok
}

async function cmdDoctor(flags: Flags): Promise<number> {
  const config = await loadConfig()
  const registry = loopRegistry(config)
  const report = await diagnose(registry, config)
  if (flags.json) {
    json(report)
  } else {
    for (const line of renderDoctor(report)) out(line)
  }
  return report.ok ? EXIT.ok : EXIT.failed
}

// --------------------------------------------------------------------- main

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === "help") {
    out(HELP)
    return command === "help" ? EXIT.ok : EXIT.usage
  }
  if (command === "--help" || command === "-h") {
    out(HELP)
    return EXIT.ok
  }
  const flags = parseFlags(rest)
  switch (command) {
    case "init":
      return cmdInit(flags)
    case "loops":
      return cmdLoops(flags)
    case "run":
      return cmdRun(flags)
    case "tick":
      return cmdTickOrResume(flags, "tick")
    case "resume":
      return cmdTickOrResume(flags, "resume")
    case "runs":
      return cmdRuns(flags)
    case "show":
      return cmdShow(flags)
    case "stats":
      return cmdStats(flags)
    case "doctor":
      return cmdDoctor(flags)
    default:
      throw new UsageError(`Unknown command \`${command}\`. Commands: init, loops, run, tick, resume, runs, show, stats, doctor.`)
  }
}

// Make Ctrl-C / SIGTERM run the process 'exit' hooks (lease release); the
// run itself stays resumable — that is the whole point of the ledger.
process.once("SIGINT", () => process.exit(130))
process.once("SIGTERM", () => process.exit(143))

try {
  process.exit(await main(process.argv.slice(2)))
} catch (error) {
  if (error instanceof UsageError) {
    note(`usage error: ${error.message}`)
    note(`run \`vernier --help\` for the command surface.`)
    process.exit(EXIT.usage)
  }
  if (error instanceof ConfigError) {
    note(`config error: ${error.message}`)
    note(`reminder: vernier.config code runs with this process's full privileges — only load configs you trust.`)
    process.exit(EXIT.usage)
  }
  if (error instanceof LeaseHeldError) {
    note(`lease held: ${error.message}`)
    process.exit(EXIT.leaseHeld)
  }
  if (error instanceof ZodError) {
    note(`invalid value: ${error.message}`)
    process.exit(EXIT.usage)
  }
  note(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exit(EXIT.failed)
}

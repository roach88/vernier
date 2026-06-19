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
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { ZodError } from "zod"
import { acquireLease, LeaseHeldError } from "../engine/lease.js"
import { resumeRun, summarizeJournal, type JournalSummary } from "../engine/resume.js"
import { driveRun, finalOutput, newRunId, startRun, tick, type EngineDeps, type Run, type TickOutcome } from "../engine/tick.js"
import { bindingVocabulary } from "../kernel/bindings.js"
import type { Executor, Loop } from "../kernel/types.js"
import { projectRunEvidence, type RunEvidenceProjection } from "../ledger/evidence.js"
import { journalPath, Ledger, resolveLedgerRoot, type LedgerEntry } from "../ledger/ledger.js"
import { buildTimeline, computedCostUsd, renderStats, renderTimeline, rollupByLoop, runStatsRow, type PriceModel, type RunStatsRow } from "../ledger/stats.js"
import { evaluateTrustStatus, type TrustStatusReport } from "../ledger/trust.js"
import { bindSkills, discoverSkills, SKILL_NAME_PATTERN, SkillError, type SkillBindingLayer, type SkillRegistry } from "../skills/skills.js"
import { bindExecutors, ConfigError, loadConfig, type BindingLayer, type LoadedConfig } from "./config.js"
import { defaultProbes, diagnose, renderDoctor } from "./doctor.js"
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
  vernier skills                                       list discovered Agent Skills (config + .claude/skills)
  vernier run <loopId> [--input '<json>'] [--input-file <path>] [--workdir <dir>]
             [--executor <stepIdOrExecutorId>=<executorId>]...
             [--skill <stepIdOrExecutorId>=<name[,name...]>]...
                                                     start a run, drive to terminal
  vernier tick <runId> [--workdir <dir>] [--executor ...] [--skill ...]
                                                     advance ONE step from the ledger
  vernier resume <runId> [--workdir <dir>] [--executor ...] [--skill ...]
                                                     continue a run to terminal
  vernier runs                                        list runs under the ledger root
  vernier show <runId>                                run timeline + per-step usage from the journal
  vernier stats [--loop <id>] [--last <n>]            usage/cost roll-ups across runs, per run and
               [--price-in <usd> --price-out <usd>]  per loop (prices are USD per 1M tokens; without
                                                     them the output is tokens only — never invented $)
  vernier trust status <loopId> [--last <n>] [--min-runs <n>]
                                                     read-only trust evidence over strict current-v2 ledgers
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

SKILLS (Agent Skills, agentskills.io)
  A step may declare skill names (skills: ["security-review"]); they resolve
  through the executor chain: --skill overrides > config skillBindings > the
  loop's declared default. Keys are a step id or an executor id (the loop's
  DECLARED vocabulary); \`--skill <step>=\` clears a step's skills.
  Discovery: vernier.config \`skills\` paths, then <project>/.claude/skills,
  then ~/.claude/skills — earlier tiers win name collisions. Delivery is
  provider-native where supported (claude: a session --plugin-dir, spec
  progressive disclosure intact); for every other executor the SKILL.md
  body is embedded in the step prompt, delimited and attributed. The ledger
  records resolved skills and the delivery mode per step.

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
  /** Repeatable --skill <stepIdOrExecutorId>=<name[,name...]> overrides. */
  readonly skill: readonly string[]
  /** `stats` filters/prices (raw strings; validated in cmdStats). */
  readonly loop?: string
  readonly last?: string
  readonly priceIn?: string
  readonly priceOut?: string
  readonly minRuns?: string
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
        skill: { type: "string", multiple: true },
        loop: { type: "string" },
        last: { type: "string" },
        "price-in": { type: "string" },
        "price-out": { type: "string" },
        "min-runs": { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    })
    if (values.help) {
      out(HELP)
      // Safe hard exit: HELP is a few KB and fits the pipe buffer — the
      // exit-discipline note at the bottom of this file applies to outputs
      // that can exceed ~64KB (--json inventories, journals).
      process.exit(EXIT.ok)
    }
    return {
      json: values.json === true,
      ...(values.input !== undefined ? { input: values.input } : {}),
      ...(values["input-file"] !== undefined ? { inputFile: values["input-file"] } : {}),
      ...(values.workdir !== undefined ? { workdir: resolve(values.workdir) } : {}),
      executor: values.executor ?? [],
      skill: values.skill ?? [],
      ...(values.loop !== undefined ? { loop: values.loop } : {}),
      ...(values.last !== undefined ? { last: values.last } : {}),
      ...(values["price-in"] !== undefined ? { priceIn: values["price-in"] } : {}),
      ...(values["price-out"] !== undefined ? { priceOut: values["price-out"] } : {}),
      ...(values["min-runs"] !== undefined ? { minRuns: values["min-runs"] } : {}),
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
  return parseLoopBindingOverrides({
    pairs,
    loop,
    flag: "--executor",
    expects: "<stepIdOrExecutorId>=<executorId>",
    allowEmptyValue: false,
    set(map, key, raw) {
      map.set(key, raw)
    },
  })
}

/** Layered bindings for one invocation: CLI overrides first, then config bindings. */
function bindingLayers(flags: Flags, loop: Loop, config: LoadedConfig | undefined): BindingLayer[] {
  return [parseExecutorOverrides(flags.executor, loop), config?.bindings ?? new Map<string, string>()]
}

/**
 * Parse --skill overrides, strictly (the --executor rule): a key must name
 * a step id or an executor id the loop declares. Values are skill names —
 * repeats and comma lists accumulate per key, in order; a layer that names
 * a key REPLACES lower layers for it, so `--skill <step>=` (empty value)
 * clears that step's skills.
 */
function parseSkillOverrides(pairs: readonly string[], loop: Loop): SkillBindingLayer {
  return parseLoopBindingOverrides({
    pairs,
    loop,
    flag: "--skill",
    expects: "<stepIdOrExecutorId>=<skillName[,skillName...]>",
    allowEmptyValue: true,
    set(map, key, raw, pair) {
      // An EMPTY value (`step=`) is an explicit clear, and it WINS over any
      // earlier accumulation for this key — `--skill s=a --skill s=` clears.
      if (raw.trim() === "") {
        map.set(key, [])
        return
      }
      // A non-empty value must be real skill names. A value that splits to
      // blank tokens (`step=,` / `step=a,,b`) is a typo, not a silent clear —
      // and an invalid name fails HERE, not later, with the grammar named.
      const names = raw.split(",").map((name) => name.trim())
      const bad = names.find((name) => name.length === 0 || !SKILL_NAME_PATTERN.test(name))
      if (bad !== undefined) {
        throw new UsageError(
          `--skill \`${pair}\`: \`${bad}\` is not a valid skill name (lowercase letters, numbers, and hyphens). ` +
            `Use \`--skill ${key}=\` with no value to clear a step's skills.`,
        )
      }
      // Accumulate, de-duping both against earlier flags for this key AND
      // within this flag's own comma list (`s=a,a` is one `a`, not two).
      const merged = [...(map.get(key) ?? [])]
      for (const name of names) if (!merged.includes(name)) merged.push(name)
      map.set(key, merged)
    },
  })
}

function parseLoopBindingOverrides<T>(args: {
  readonly pairs: readonly string[]
  readonly loop: Loop
  readonly flag: "--executor" | "--skill"
  readonly expects: string
  readonly allowEmptyValue: boolean
  readonly set: (map: Map<string, T>, key: string, raw: string, pair: string) => void
}): Map<string, T> {
  const map = new Map<string, T>()
  if (args.pairs.length === 0) return map
  const { stepIds, executorIds } = bindingVocabulary(args.loop)
  for (const pair of args.pairs) {
    const eq = pair.indexOf("=")
    if (eq <= 0 || (!args.allowEmptyValue && eq === pair.length - 1)) {
      throw new UsageError(`${args.flag} expects ${args.expects}, got \`${pair}\`.`)
    }
    const key = pair.slice(0, eq)
    if (!stepIds.includes(key) && !executorIds.includes(key)) {
      throw new UsageError(
        `${args.flag} \`${key}\` names no step or executor in \`${args.loop.id}\` (steps: ${stepIds.join(", ")}; executors: ${executorIds.join(", ")}).`,
      )
    }
    args.set(map, key, pair.slice(eq + 1), pair)
  }
  return map
}

/** Layered skill bindings: CLI --skill first, then config skillBindings. Keys speak the loop's DECLARED vocabulary. */
function skillBindingLayers(flags: Flags, loop: Loop, config: LoadedConfig | undefined): SkillBindingLayer[] {
  return [parseSkillOverrides(flags.skill, loop), config?.skillBindings ?? new Map<string, readonly string[]>()]
}

/**
 * The standard three-tier discovery a run/doctor/skills invocation uses:
 * config-registered paths, then <config-dir>/.claude/skills, then
 * ~/.claude/skills. `home` is injectable (defaults to os.homedir()) so the
 * user tier is controllable without spawning a process.
 */
function discoverConfiguredSkills(config: LoadedConfig | undefined, home: string = homedir()): SkillRegistry {
  return discoverSkills({
    ...(config !== undefined ? { explicit: config.skills } : {}),
    projectRoot: config !== undefined ? dirname(config.path) : process.cwd(),
    home,
  })
}

/**
 * Discover skills only when this invocation needs them (a bound step names
 * one, or --skill was passed): discovery reads SKILL.md frontmatter across
 * three locations, and loops without skills must not pay for that. Missing
 * names fail here — BEFORE the first journal write, like executors.
 */
function resolveSkillRegistry(loop: Loop, flags: Flags, config: LoadedConfig | undefined): SkillRegistry | undefined {
  const used = loop.steps.some((step) => (step.skills?.length ?? 0) > 0)
  if (!used && flags.skill.length === 0) return undefined
  const registry = discoverConfiguredSkills(config)
  assertSkillsResolvable(loop, registry)
  return registry
}

/** Fail BEFORE the first journal write when a bound step names a skill nobody discovered (or cannot receive one). */
function assertSkillsResolvable(loop: Loop, registry: SkillRegistry): void {
  const problems: string[] = []
  for (const step of loop.steps) {
    const names = step.skills ?? []
    if (names.length === 0) continue
    if (!step.prompt) problems.push(`step \`${step.id}\` declares skills but no prompt template (skills travel through the prompt seam)`)
    for (const name of names) {
      if (!registry.skills.has(name)) problems.push(`step \`${step.id}\` -> skill \`${name}\``)
    }
  }
  if (problems.length === 0) return
  const known = [...registry.skills.keys()]
  throw new UsageError(
    `Unresolved skill binding(s): ${problems.join("; ")}. Discovered skills: ${known.length > 0 ? known.join(", ") : "(none)"}. ` +
      `Register skills in vernier.config (skills: [...]) or under .claude/skills (project or ~), or rebind with --skill <stepId>=<name>.`,
  )
}

/** Thread the discovered skills into the engine deps (EngineDeps.skills). */
function withSkills(deps: EngineDeps, registry: SkillRegistry | undefined): EngineDeps {
  return registry === undefined ? deps : { ...deps, skills: registry.skills }
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
  let path: string
  try {
    path = journalPath(root, runId)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
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

/**
 * `vernier skills`: the Agent Skill inventory, the cheap parallel to
 * `vernier loops`. Pure discovery (config paths > project/.claude/skills >
 * ~/.claude/skills) — no loop runtimes, no executor probes, so an agent can
 * enumerate what it can bind without paying the full `doctor` cost. Exit 0
 * always: an inventory is not a health check (use `doctor` for runnability).
 * Spec-invalid skills in the standard locations are surfaced, never hidden.
 */
async function cmdSkills(flags: Flags): Promise<number> {
  const config = await loadConfig()
  const { skills, invalid } = discoverConfiguredSkills(config)
  if (flags.json) {
    json([
      ...[...skills.values()].map((s) => ({ name: s.name, origin: s.origin, dir: s.dir, description: s.description, ok: true })),
      ...invalid.map((i) => ({ name: null, origin: i.origin, dir: i.path, reason: i.reason, ok: false })),
    ])
    if (skills.size === 0 && invalid.length === 0) {
      note("no skills discovered.")
      note("Register skills in vernier.config (skills: [...]) or place them under .claude/skills (project) or ~/.claude/skills (user).")
    }
    return EXIT.ok
  }
  if (skills.size === 0 && invalid.length === 0) {
    out("no skills discovered.")
    out("")
    out("Skills are discovered from three locations (earlier wins name collisions):")
    out("  vernier.config `skills`   explicitly registered SKILL.md / skill dirs")
    out("  <project>/.claude/skills  per-project skills")
    out("  ~/.claude/skills          your personal skills")
    return EXIT.ok
  }
  for (const s of skills.values()) {
    out(`${s.name}  [${s.origin}]  ${s.dir}`)
    out(`  ${s.description}`)
  }
  for (const i of invalid) {
    out(`!! ${i.path}  [${i.origin}]  invalid: ${i.reason}`)
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

const SHUTDOWN_TIMEOUT_MS = 5_000

async function shutdownRuntime(runtime: LoopRuntime | undefined): Promise<void> {
  if (!runtime?.shutdown) return
  const timedOut = Symbol("shutdown timed out")
  const shutdown = runtime.shutdown()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS, timedOut)
  })
  try {
    const result = await Promise.race([shutdown.then(() => undefined), timer])
    if (result === timedOut) {
      shutdown.catch(() => {})
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function cmdRun(flags: Flags): Promise<number> {
  const config = await loadConfig()
  const registry = loopRegistry(config)
  const entry = lookupLoop(registry, flags.positionals[0])
  const inputs = parseInputs(entry, flags)
  // Resolve bindings BEFORE the run: the Loop stays declarative data — both
  // rewrites are pure. Skills bind FIRST so --skill/skillBindings keys speak
  // the loop's DECLARED step/executor vocabulary, exactly like --executor keys.
  const loop = bindExecutors(
    bindSkills(entry.loop, skillBindingLayers(flags, entry.loop, config)),
    bindingLayers(flags, entry.loop, config),
  )
  const skills = resolveSkillRegistry(loop, flags, config)
  const workdir = flags.workdir ?? entry.defaultWorkdir()
  if (entry.live) note(`note: \`${entry.loop.id}\` drives live LLM CLIs; this requires authed binaries on PATH.`)

  // Lease BEFORE the first journal write: the run dir is leased from birth.
  const runId = newRunId(loop)
  const runDir = dirname(journalPath(resolveLedgerRoot(loop.ledger), runId))
  const { lease } = acquireLease(runDir)
  let runtime: LoopRuntime | undefined
  try {
    runtime = entry.runtime(workdir)
    const deps = withSkills(withConfigExecutors(runtime.deps, config?.executors ?? []), skills)
    assertExecutorsResolvable(loop, deps.executors)
    const run = startRun(loop, inputs, deps, { runId })
    const outcome = await driveRun(run, deps)
    printOutcome(run, outcome, flags, { workdir })
    return terminalExit(outcome.state.status)
  } finally {
    try {
      await shutdownRuntime(runtime)
    } finally {
      lease.release()
    }
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
  // ledger regardless (the resume key ignores the executor AND the skills),
  // so a rebind only affects steps that still have to execute.
  const loop = bindExecutors(
    bindSkills(target.entry.loop, skillBindingLayers(flags, target.entry.loop, config)),
    bindingLayers(flags, target.entry.loop, config),
  )
  const skills = resolveSkillRegistry(loop, flags, config)
  const { lease, tookOver } = acquireLease(target.runDir)
  if (tookOver) note(`note: took over a stale lease (pid ${tookOver.pid} on ${tookOver.host}, heartbeat ${tookOver.heartbeatAt}).`)
  let runtime: LoopRuntime | undefined
  try {
    runtime = target.entry.runtime(target.workdir)
    const deps = withSkills(withConfigExecutors(runtime.deps, config?.executors ?? []), skills)
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
    try {
      await shutdownRuntime(runtime)
    } finally {
      lease.release()
    }
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
    .flatMap((id) => {
      try {
        return [{ runId: id, summary: summarizeJournal(Ledger.load(journalPath(root, id))) }]
      } catch {
        return []
      }
    })
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
    .flatMap((id) => {
      try {
        const row = runStatsRow(id, Ledger.load(journalPath(root, id)))
        return row ? [row] : []
      } catch {
        return []
      }
    })
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

function parsePositiveIntegerFlag(value: string | undefined, name: string, defaultValue: number | null): number | null {
  if (value === undefined) return defaultValue
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${name} expects a positive integer, got \`${value}\`.`)
  return parsed
}

function loadRunEvidence(root: string): RunEvidenceProjection[] {
  const runsDir = join(root, "runs")
  let ids: string[] = []
  try {
    ids = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    ids = []
  }
  return ids.map((id) => {
    try {
      const path = journalPath(root, id)
      return projectRunEvidence({ ledgerPath: path, entries: Ledger.load(path) })
    } catch (error) {
      return projectRunEvidence({ ledgerPath: join(root, "runs", id, "journal.jsonl"), loadError: error })
    }
  })
}

function renderTrustStatus(report: TrustStatusReport): string[] {
  const lines = [
    `loop        ${report.loopId}@${report.loopVersion}`,
    `status      ${report.status}`,
    `policy      required=${report.policy.requiredRuns}${report.policy.last === null ? "" : ` last=${report.policy.last}`}`,
    `evidence    matching=${report.totals.matchingVersionRuns} considered=${report.totals.consideredRuns} clean=${report.totals.cleanRuns} mismatched-version=${report.totals.versionMismatchRuns}`,
  ]
  if (report.reasons.length === 0) {
    lines.push("reasons     <none>")
  } else {
    lines.push("reasons")
    for (const reason of report.reasons) lines.push(`  - ${reason}`)
  }
  if (report.considered.length > 0) {
    lines.push("runs")
    for (const evidence of report.considered) {
      lines.push(
        `  ${evidence.runId ?? "<unknown>"}  ${evidence.terminalStatus}  trust=${evidence.strict.usableForTrust ? "clean" : "rejected"}  diagnostics=${evidence.diagnostics.length}`,
      )
    }
  }
  return lines
}

async function cmdTrust(flags: Flags): Promise<number> {
  const [subcommand, loopId, ...extra] = flags.positionals
  if (subcommand !== "status") throw new UsageError("trust currently supports only `vernier trust status <loopId>`.")
  if (!loopId) throw new UsageError("Missing <loopId>. Usage: vernier trust status <loopId> [--last <n>] [--min-runs <n>].")
  if (extra.length > 0) throw new UsageError(`Unexpected argument(s) for trust status: ${extra.join(", ")}.`)
  const config = await loadConfig()
  const entry = lookupLoop(loopRegistry(config), loopId)
  const requiredRuns = parsePositiveIntegerFlag(flags.minRuns, "--min-runs", 3) ?? 3
  const last = parsePositiveIntegerFlag(flags.last, "--last", null)
  const root = resolveLedgerRoot(entry.loop.ledger)
  const evidence = loadRunEvidence(root)
  const report = evaluateTrustStatus({ loopId: entry.loop.id, loopVersion: entry.loop.version, evidence, policy: { requiredRuns, last } })
  if (flags.json) {
    json({ ledgerRoot: root, report })
  } else {
    for (const line of renderTrustStatus(report)) out(line)
  }
  return report.promotable ? EXIT.ok : EXIT.failed
}

async function cmdDoctor(flags: Flags): Promise<number> {
  const config = await loadConfig()
  const registry = loopRegistry(config)
  // Doctor always discovers skills (it is the diagnostic surface): the
  // inventory says what THIS machine could bind, and per-step reports say
  // what each loop would actually resolve at rest.
  const skills = discoverConfiguredSkills(config)
  const report = await diagnose(registry, config, defaultProbes, skills)
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
    case "skills":
      return cmdSkills(flags)
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
    case "trust":
      return cmdTrust(flags)
    case "doctor":
      return cmdDoctor(flags)
    default:
      throw new UsageError(`Unknown command \`${command}\`. Commands: init, loops, skills, run, tick, resume, runs, show, stats, trust, doctor.`)
  }
}

// Make Ctrl-C / SIGTERM run the process 'exit' hooks (lease release); the
// run itself stays resumable — that is the whole point of the ledger.
process.once("SIGINT", () => process.exit(130))
process.once("SIGTERM", () => process.exit(143))

// Every command promises "machine output on stdout under --json". Errors are
// output too: under --json a structured `{ error, type, exitCode }` document
// goes to stdout so an agent can branch on the failure class without parsing
// prose; the human-readable diagnostics always go to stderr, and the exit
// code is unchanged. --json is read from argv because the top-level catch has
// no parsed flags (a parse failure is itself one of these errors).
//
// EXIT DISCIPLINE: drain, THEN hard-exit — never a bare process.exit() after
// writing output, and never a bare exitCode either. A piped stdout drains
// asynchronously, and process.exit() truncates it at the pipe buffer
// (~64KB): any --json output past that (a big skill inventory, a long run's
// `show`) would arrive cut mid-document. But relying on process.exitCode
// alone has the opposite failure: a stray handle (a hung agent subprocess,
// a lingering timer) would hold the event loop — and the CLI — hostage on
// the way out. exitAfterDrain gives both halves: the nested write callbacks
// fire only once stdout THEN stderr have flushed to the OS, and the hard
// exit then guarantees departure. exitCode is set first as a fallback so the
// right code survives even if the exit is never reached. The SIGINT/SIGTERM
// handlers above keep immediate hard exits — an interactive kill must not
// wait on a drain.
const exitAfterDrain = (code: number): void => {
  process.exitCode = code
  process.stdout.write("", () => {
    process.stderr.write("", () => process.exit(code))
  })
}
const wantsJson = (): boolean => process.argv.includes("--json")
/** Terminal in effect: schedules the hard exit for after output drains. Typed void because the exit is asynchronous — nothing may follow a failWith call in its branch. */
const failWith = (type: string, exitCode: number, message: string, ...extraNotes: string[]): void => {
  if (wantsJson()) json({ error: message, type, exitCode })
  note(`${type.replace(/_/g, " ")}: ${message}`)
  for (const line of extraNotes) note(line)
  exitAfterDrain(exitCode)
}

try {
  exitAfterDrain(await main(process.argv.slice(2)))
} catch (error) {
  if (error instanceof UsageError) {
    failWith("usage_error", EXIT.usage, error.message, "run `vernier --help` for the command surface.")
  } else if (error instanceof ConfigError) {
    failWith("config_error", EXIT.usage, error.message, "reminder: vernier.config code runs with this process's full privileges — only load configs you trust.")
  } else if (error instanceof SkillError) {
    failWith("skill_error", EXIT.usage, error.message)
  } else if (error instanceof LeaseHeldError) {
    failWith("lease_held", EXIT.leaseHeld, error.message)
  } else if (error instanceof ZodError) {
    failWith("invalid_value", EXIT.usage, error.message)
  } else {
    if (wantsJson()) json({ error: error instanceof Error ? error.message : String(error), type: "error", exitCode: EXIT.failed })
    note(error instanceof Error ? (error.stack ?? error.message) : String(error))
    exitAfterDrain(EXIT.failed)
  }
}

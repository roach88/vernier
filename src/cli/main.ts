// The looper CLI: drive loops by name, resume runs from their ledgers.
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

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { ZodError } from "zod"
import { acquireLease, LeaseHeldError } from "../engine/lease.js"
import { resumeRun, summarizeJournal, type JournalSummary } from "../engine/resume.js"
import { driveRun, finalOutput, newRunId, startRun, tick, type Run, type TickOutcome } from "../engine/tick.js"
import { journalPath, Ledger, resolveLedgerRoot, type LedgerEntry } from "../ledger/ledger.js"
import { loopRegistry, type LoopRuntime, type RegisteredLoop } from "./registry.js"

const EXIT = { ok: 0, failed: 1, usage: 2, leaseHeld: 3 } as const

class UsageError extends Error {}

const out = (line: string): void => void process.stdout.write(line + "\n")
const note = (line: string): void => void process.stderr.write(line + "\n")
const json = (value: unknown): void => out(JSON.stringify(value, null, 2))

const HELP = `looper — the loop is data; the ledger is append-only; resume is replay.

USAGE
  looper loops                                       list registered loops
  looper run <loopId> [--input '<json>'] [--input-file <path>] [--workdir <dir>]
                                                     start a run, drive to terminal
  looper tick <runId> [--workdir <dir>]              advance ONE step from the ledger
  looper resume <runId> [--workdir <dir>]            continue a run to terminal
  looper runs                                        list runs under the ledger root
  looper show <runId>                                print a run's journal

Every command accepts --json (machine output on stdout; diagnostics on stderr).
Ledger root: $LOOPER_HOME, else ./.looper

EXIT CODES
  0 success   1 needs_human/stopped/failed   2 usage error   3 lease held`

// ------------------------------------------------------------------ helpers

interface Flags {
  readonly json: boolean
  readonly input?: string
  readonly inputFile?: string
  readonly workdir?: string
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
      positionals,
    }
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

function lookupLoop(registry: ReadonlyMap<string, RegisteredLoop>, loopId: string | undefined): RegisteredLoop {
  if (!loopId) throw new UsageError(`Missing <loopId>. Registered loops: ${[...registry.keys()].join(", ")}`)
  const entry = registry.get(loopId)
  if (!entry) throw new UsageError(`Unknown loop \`${loopId}\`. Registered loops: ${[...registry.keys()].join(", ")} (see \`looper loops\`).`)
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
  if (!runId) throw new UsageError("Missing <runId>. See `looper runs`.")
  const root = resolveLedgerRoot({})
  const path = journalPath(root, runId)
  const entries = Ledger.load(path)
  if (entries.length === 0) throw new UsageError(`No run \`${runId}\` under \`${root}\` (no journal at ${path}). See \`looper runs\`.`)
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

function cmdLoops(flags: Flags): number {
  const registry = loopRegistry()
  if (flags.json) {
    json(
      [...registry.values()].map((entry) => ({
        id: entry.loop.id,
        version: entry.loop.version,
        signature: entry.signature,
        trust: entry.loop.trust,
        steps: entry.loop.steps.map((s) => s.id),
        live: entry.live,
        summary: entry.summary,
      })),
    )
    return EXIT.ok
  }
  for (const entry of registry.values()) {
    out(`${entry.loop.id}@${entry.loop.version}  trust=${entry.loop.trust}${entry.live ? "  [live]" : ""}`)
    out(`  ${entry.signature}`)
    out(`  ${entry.summary}`)
  }
  return EXIT.ok
}

async function cmdRun(flags: Flags): Promise<number> {
  const registry = loopRegistry()
  const entry = lookupLoop(registry, flags.positionals[0])
  const inputs = parseInputs(entry, flags)
  const workdir = flags.workdir ?? entry.defaultWorkdir()
  if (entry.live) note(`note: \`${entry.loop.id}\` drives live LLM CLIs; this requires authed binaries on PATH.`)

  // Lease BEFORE the first journal write: the run dir is leased from birth.
  const runId = newRunId(entry.loop)
  const runDir = dirname(journalPath(resolveLedgerRoot(entry.loop.ledger), runId))
  const { lease } = acquireLease(runDir)
  let runtime: LoopRuntime | undefined
  try {
    runtime = entry.runtime(workdir)
    const run = startRun(entry.loop, inputs, runtime.deps, { runId })
    const outcome = await driveRun(run, runtime.deps)
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

function resumeTarget(flags: Flags): ResumeTarget {
  const { runId, path, summary } = loadJournal(flags.positionals[0])
  const meta = summary.meta
  if (!meta) throw new UsageError(`Run \`${runId}\` has a journal but no meta entry; it cannot be resumed.`)
  const entry = lookupLoop(loopRegistry(), meta.loopId)
  const workdir = flags.workdir ?? meta.workdir
  if (!workdir) {
    throw new UsageError(`Run \`${runId}\` predates workdir recording in the journal; pass --workdir <dir> (the dir the run originally used).`)
  }
  return { entry, runId, runDir: dirname(path), workdir }
}

async function cmdTickOrResume(flags: Flags, mode: "tick" | "resume"): Promise<number> {
  const target = resumeTarget(flags)
  const { lease, tookOver } = acquireLease(target.runDir)
  if (tookOver) note(`note: took over a stale lease (pid ${tookOver.pid} on ${tookOver.host}, heartbeat ${tookOver.heartbeatAt}).`)
  let runtime: LoopRuntime | undefined
  try {
    runtime = target.entry.runtime(target.workdir)
    const run = resumeRun(target.entry.loop, target.runId)
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
    const outcome = mode === "tick" ? await tick(run, runtime.deps) : await driveRun(run, runtime.deps)
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
  out("--- ledger entries ---")
  for (const entry of entries) out(entryLine(entry))
  return EXIT.ok
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
    default:
      throw new UsageError(`Unknown command \`${command}\`. Commands: loops, run, tick, resume, runs, show.`)
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
    note(`run \`looper --help\` for the command surface.`)
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

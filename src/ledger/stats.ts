// Observability: pure derivations over append-only journals.
//
// Two read surfaces, one source of truth (the ledger):
//   buildTimeline(entries)            one run  -> events with relative
//     offsets, per-STEP usage attribution, totals      (`looper show`)
//   runStatsRow / rollupByLoop        many runs -> usage/cost roll-ups
//     per run and per loop id                          (`looper stats`)
//
// Everything here is a pure function of journal entries: no I/O, no state,
// no ledger-format changes — the CLI loads journals (Ledger.load, torn-line
// tolerant) and renders what these functions derive. Degradation is
// graceful by construction: pre-`loop-v2` journals (no `iteration` field),
// entries without usage (blank, never invented zeros), and unknown entry
// types (skipped, counted) all render, never crash.
//
// COST IS HONEST. Tokens are the unit the ledger actually records. The only
// dollar figures that ever appear are (a) what executors themselves
// reported (`usage.costUsd` — claude reports real spend; most report 0),
// surfaced as `reportedCostUsd`, and (b) a computed estimate that exists
// ONLY when the caller supplies prices (computedCostUsd). No prices, no
// dollars.

import { summarizeJournal } from "../engine/resume.js"
import type { RunStatus } from "../engine/tick.js"
import type { LedgerEntry } from "./ledger.js"

// ------------------------------------------------------------------- usage

/** Token/duration sums plus the executor-reported spend, if any. */
export interface UsageRollup {
  readonly inputTokens: number
  readonly outputTokens: number
  /** Sum of step durations (busy time; wall time is measured separately). */
  readonly durationMs: number
  /** Sum of executor-REPORTED usage.costUsd — never computed from prices. */
  readonly reportedCostUsd: number
  /** False when no step_result in scope carried a usage object (legacy journals): render blanks, not fake zeros. */
  readonly hasUsage: boolean
}

/** Per-STEP attribution: the number an operator tunes on (which step ate the tokens). */
export interface StepUsage extends UsageRollup {
  readonly stepId: string
  /** step_result entries observed for this step, across iterations and attempts. */
  readonly executions: number
}

interface UsageView {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly durationMs: number
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

const usageView = (u: unknown): UsageView | null =>
  u !== null && typeof u === "object"
    ? {
        inputTokens: num((u as Record<string, unknown>).inputTokens),
        outputTokens: num((u as Record<string, unknown>).outputTokens),
        costUsd: num((u as Record<string, unknown>).costUsd),
        durationMs: num((u as Record<string, unknown>).durationMs),
      }
    : null

// ---------------------------------------------------------------- timeline

interface EventBase {
  /** ms since the run's first parseable timestamp; null when this entry's timestamp is missing/unparseable. */
  readonly offsetMs: number | null
  readonly stepId: string
  readonly iteration: number
  readonly attempt: number
}

export type TimelineEvent =
  | { readonly type: "meta"; readonly offsetMs: number | null; readonly loopId: string; readonly loopVersion: string; readonly keyVersion: string; readonly trust: string }
  | (EventBase & { readonly type: "step_started"; readonly executorId: string })
  | (EventBase & { readonly type: "step_result"; readonly status: string; readonly usage: UsageView | null })
  | (EventBase & { readonly type: "contract"; readonly contractId: string; readonly valid: boolean; readonly failedChecks: readonly string[] })
  | (EventBase & { readonly type: "effects"; readonly changed: number; readonly allowed: boolean; readonly unexpected: readonly string[] })
  | (EventBase & { readonly type: "decision"; readonly kind: string; readonly classification: string; readonly summary: string; readonly restartAt: string | null })

export interface RunTimeline {
  readonly runId: string | null
  readonly loopId: string | null
  readonly loopVersion: string | null
  readonly status: RunStatus
  readonly startedAt: string | null
  /** First parseable timestamp -> last parseable timestamp; null when the journal has no parseable times. */
  readonly wallMs: number | null
  /** Highest iteration observed (1 for single-pass runs; 0 when nothing ran). */
  readonly iterations: number
  /** step_result entries observed (executions that finished, in any status). */
  readonly stepsRun: number
  readonly events: readonly TimelineEvent[]
  readonly steps: readonly StepUsage[]
  readonly totals: UsageRollup
  /** Entries with an unrecognized type: skipped, never fatal. */
  readonly skipped: number
}

interface MutableUsage {
  inputTokens: number
  outputTokens: number
  durationMs: number
  reportedCostUsd: number
  hasUsage: boolean
  executions: number
}

const newUsage = (): MutableUsage => ({ inputTokens: 0, outputTokens: 0, durationMs: 0, reportedCostUsd: 0, hasUsage: false, executions: 0 })

function addUsage(into: MutableUsage, usage: UsageView | null): void {
  into.executions += 1
  if (usage === null) return
  into.hasUsage = true
  into.inputTokens += usage.inputTokens
  into.outputTokens += usage.outputTokens
  into.durationMs += usage.durationMs
  into.reportedCostUsd += usage.costUsd
}

const KNOWN_TYPES = new Set(["meta", "step_started", "step_result", "contract", "effects", "decision"])

/** Derive one run's timeline from its journal entries. Pure; tolerant of legacy and partial journals. */
export function buildTimeline(entries: readonly LedgerEntry[]): RunTimeline {
  const summary = summarizeJournal(entries)
  const startMs = entries.map((e) => Date.parse((e as { at?: string }).at ?? "")).find((ms) => Number.isFinite(ms)) ?? null

  const events: TimelineEvent[] = []
  const perStep = new Map<string, MutableUsage>()
  const totals = newUsage()
  let iterations = 0
  let stepsRun = 0
  let skipped = 0
  let lastMs = startMs

  for (const entry of entries) {
    const atMs = Date.parse((entry as { at?: string }).at ?? "")
    const offsetMs = startMs !== null && Number.isFinite(atMs) ? atMs - startMs : null
    if (Number.isFinite(atMs)) lastMs = atMs
    if (typeof entry.type !== "string" || !KNOWN_TYPES.has(entry.type)) {
      skipped += 1
      continue
    }
    if (entry.type === "meta") {
      events.push({
        type: "meta",
        offsetMs,
        loopId: String(entry.loopId ?? "<unknown>"),
        loopVersion: String(entry.loopVersion ?? "?"),
        keyVersion: String(entry.keyVersion ?? "<pre-keyed>"),
        trust: String(entry.trust ?? "?"),
      })
      continue
    }
    const base: EventBase = {
      offsetMs,
      stepId: String(entry.stepId ?? "<unknown>"),
      iteration: num((entry as { iteration?: unknown }).iteration) || 1, // pre-loop-v2 journals lack the field
      attempt: num(entry.attempt) || 1,
    }
    iterations = Math.max(iterations, base.iteration)
    switch (entry.type) {
      case "step_started":
        events.push({ ...base, type: "step_started", executorId: String(entry.executorId ?? "<unknown>") })
        break
      case "step_result": {
        const usage = usageView(entry.usage)
        stepsRun += 1
        addUsage(totals, usage)
        const step = perStep.get(base.stepId) ?? newUsage()
        addUsage(step, usage)
        perStep.set(base.stepId, step)
        events.push({ ...base, type: "step_result", status: String(entry.status ?? "<unknown>"), usage })
        break
      }
      case "contract": {
        const checks = Array.isArray(entry.result?.checks) ? entry.result.checks : []
        events.push({
          ...base,
          type: "contract",
          contractId: String(entry.result?.contractId ?? "<unknown>"),
          valid: entry.result?.valid === true,
          failedChecks: checks.filter((c) => c?.passed !== true).map((c) => String(c?.label ?? "<unnamed check>")),
        })
        break
      }
      case "effects": {
        const changed = Array.isArray(entry.observation?.changed) ? entry.observation.changed : []
        const unexpected = Array.isArray(entry.observation?.unexpected) ? entry.observation.unexpected : []
        events.push({ ...base, type: "effects", changed: changed.length, allowed: entry.observation?.allowed === true, unexpected: unexpected.map(String) })
        break
      }
      case "decision":
        events.push({
          ...base,
          type: "decision",
          kind: String(entry.decision?.kind ?? "<unknown>"),
          classification: String(entry.decision?.classification ?? "<unknown>"),
          summary: String(entry.decision?.summary ?? ""),
          restartAt: entry.decision?.restartAt !== undefined ? String(entry.decision.restartAt) : null,
        })
        break
    }
  }

  return {
    runId: summary.meta?.runId ?? null,
    loopId: summary.meta?.loopId ?? null,
    loopVersion: summary.meta?.loopVersion ?? null,
    status: summary.status,
    startedAt: summary.startedAt ?? null,
    wallMs: startMs !== null && lastMs !== null ? lastMs - startMs : null,
    iterations,
    stepsRun,
    events,
    steps: [...perStep.entries()].map(([stepId, u]) => ({ stepId, ...u })),
    totals: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, durationMs: totals.durationMs, reportedCostUsd: totals.reportedCostUsd, hasUsage: totals.hasUsage },
    skipped,
  }
}

// ------------------------------------------------------- timeline rendering

const fmtInt = (n: number): string => n.toLocaleString("en-US")

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`
}

export const fmtUsd = (v: number): string => `$${v.toFixed(4)}`

const fmtOffset = (ms: number | null): string => (ms === null ? "+?" : `+${(ms / 1000).toFixed(2)}s`)

const usageNote = (u: UsageView | null): string => (u === null ? "" : ` — in=${fmtInt(u.inputTokens)} out=${fmtInt(u.outputTokens)} · ${fmtMs(u.durationMs)}`)

const RESULT_GLYPH: Record<string, string> = { completed: "✔", failed: "✖", interrupted: "⊘" }
const DECISION_GLYPH: Record<string, string> = { continue: "→", retry: "↻", iterate: "⟲", stop: "■", escalate: "‼" }

const slot = (e: EventBase): string => `${e.stepId}#${e.iteration}.${e.attempt}`

function eventLine(e: TimelineEvent): [glyph: string, body: string] {
  switch (e.type) {
    case "meta":
      return ["◷", `run start — ${e.loopId}@${e.loopVersion} (trust=${e.trust}, keys=${e.keyVersion})`]
    case "step_started":
      return ["▶", `${slot(e)} started (${e.executorId})`]
    case "step_result":
      return [RESULT_GLYPH[e.status] ?? "·", `${slot(e)} ${e.status}${usageNote(e.usage)}`]
    case "contract":
      return e.valid
        ? ["✔", `${slot(e)} contract ${e.contractId} passed`]
        : ["✖", `${slot(e)} contract ${e.contractId} FAILED: ${e.failedChecks.join("; ")}`]
    case "effects":
      return e.allowed
        ? ["±", `${slot(e)} effects: ${e.changed} file${e.changed === 1 ? "" : "s"} changed (allowed)`]
        : ["⚠", `${slot(e)} effects: ${e.changed} changed — OUT OF SCOPE: ${e.unexpected.join(", ")}`]
    case "decision": {
      const glyph = DECISION_GLYPH[e.kind] ?? "·"
      if (e.kind === "iterate") return [glyph, `${slot(e)} ITERATE → re-run from ${e.restartAt ?? "first step"} (iteration ${e.iteration + 1}) — ${e.summary}`]
      if (e.kind === "retry") return [glyph, `${slot(e)} RETRY → attempt ${e.attempt + 1} — ${e.summary}`]
      if (e.kind === "escalate") return [glyph, `${slot(e)} ESCALATE/${e.classification} — ${e.summary}`]
      return [glyph, `${slot(e)} ${e.kind}/${e.classification} — ${e.summary}`]
    }
  }
}

/** Simple column-aligned table; first row is the header. */
function table(rows: readonly (readonly string[])[], indent = ""): string[] {
  const widths: number[] = []
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)))
  return rows.map((row) => indent + row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd())
}

const blankable = (t: UsageRollup, value: number): string => (t.hasUsage ? fmtInt(value) : "-")

/** Render a timeline for humans: events, per-step usage, closing summary. Pure (string building only). */
export function renderTimeline(t: RunTimeline): string[] {
  const lines: string[] = [`--- timeline (${t.events.length} events) ---`]
  const offsets = t.events.map((e) => fmtOffset(e.offsetMs))
  const width = Math.max(0, ...offsets.map((o) => o.length))
  t.events.forEach((e, i) => {
    const [glyph, body] = eventLine(e)
    lines.push(`${(offsets[i] ?? "").padStart(width)}  ${glyph} ${body}`)
  })

  if (t.steps.length > 0) {
    lines.push("--- per-step usage ---")
    lines.push(
      ...table([
        ["step", "execs", "tok-in", "tok-out", "time"],
        ...t.steps.map((s) => [s.stepId, String(s.executions), blankable(s, s.inputTokens), blankable(s, s.outputTokens), s.hasUsage ? fmtMs(s.durationMs) : "-"]),
      ]),
    )
  }

  lines.push("--- summary ---")
  lines.push(`status      ${t.status} (${t.iterations} iteration${t.iterations === 1 ? "" : "s"}, ${t.stepsRun} step${t.stepsRun === 1 ? "" : "s"} run)`)
  lines.push(`wall        ${t.wallMs === null ? "<no timestamps>" : fmtMs(t.wallMs)}${t.totals.hasUsage ? ` (busy ${fmtMs(t.totals.durationMs)})` : ""}`)
  lines.push(`tokens      ${t.totals.hasUsage ? `in=${fmtInt(t.totals.inputTokens)} out=${fmtInt(t.totals.outputTokens)}` : "<no usage recorded>"}`)
  if (t.totals.reportedCostUsd > 0) lines.push(`cost        ${fmtUsd(t.totals.reportedCostUsd)} (executor-reported)`)
  if (t.skipped > 0) lines.push(`skipped     ${t.skipped} unknown ${t.skipped === 1 ? "entry" : "entries"}`)
  return lines
}

// ------------------------------------------------------------------- stats

export interface RunStatsRow {
  readonly runId: string
  readonly loopId: string
  readonly loopVersion: string
  readonly status: RunStatus
  readonly startedAt: string | null
  readonly iterations: number
  readonly stepsRun: number
  readonly wallMs: number | null
  readonly totals: UsageRollup
  readonly steps: readonly StepUsage[]
}

/** One run's stats row, or null when the journal has no meta entry (not a run). */
export function runStatsRow(runId: string, entries: readonly LedgerEntry[]): RunStatsRow | null {
  const t = buildTimeline(entries)
  if (t.loopId === null) return null
  return {
    runId,
    loopId: t.loopId,
    loopVersion: t.loopVersion ?? "?",
    status: t.status,
    startedAt: t.startedAt,
    iterations: t.iterations,
    stepsRun: t.stepsRun,
    wallMs: t.wallMs,
    totals: t.totals,
    steps: t.steps,
  }
}

export interface LoopRollup {
  readonly loopId: string
  readonly runs: number
  /** Runs whose terminal status is `done`. */
  readonly succeeded: number
  readonly successRate: number
  readonly meanIterations: number
  /** Sum of the known wall times (runs without timestamps contribute nothing). */
  readonly wallMs: number
  readonly totals: UsageRollup
  readonly steps: readonly StepUsage[]
}

/** Aggregate rows per loop id, preserving first-seen order. Per-step usage is merged across runs. */
export function rollupByLoop(rows: readonly RunStatsRow[]): LoopRollup[] {
  const byLoop = new Map<string, RunStatsRow[]>()
  for (const row of rows) byLoop.set(row.loopId, [...(byLoop.get(row.loopId) ?? []), row])
  return [...byLoop.entries()].map(([loopId, group]) => {
    const totals = newUsage()
    const steps = new Map<string, MutableUsage>()
    for (const row of group) {
      totals.inputTokens += row.totals.inputTokens
      totals.outputTokens += row.totals.outputTokens
      totals.durationMs += row.totals.durationMs
      totals.reportedCostUsd += row.totals.reportedCostUsd
      totals.hasUsage ||= row.totals.hasUsage
      for (const s of row.steps) {
        const into = steps.get(s.stepId) ?? newUsage()
        into.executions += s.executions
        into.inputTokens += s.inputTokens
        into.outputTokens += s.outputTokens
        into.durationMs += s.durationMs
        into.reportedCostUsd += s.reportedCostUsd
        into.hasUsage ||= s.hasUsage
        steps.set(s.stepId, into)
      }
    }
    const succeeded = group.filter((r) => r.status === "done").length
    return {
      loopId,
      runs: group.length,
      succeeded,
      successRate: succeeded / group.length,
      meanIterations: group.reduce((sum, r) => sum + r.iterations, 0) / group.length,
      wallMs: group.reduce((sum, r) => sum + (r.wallMs ?? 0), 0),
      totals: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, durationMs: totals.durationMs, reportedCostUsd: totals.reportedCostUsd, hasUsage: totals.hasUsage },
      steps: [...steps.entries()].map(([stepId, u]) => ({ stepId, ...u })),
    }
  })
}

// --------------------------------------------------------------------- cost

/** USD per 1M tokens. Supplied by the caller (flags); the ledger holds tokens, not prices. */
export interface PriceModel {
  readonly inUsdPerMTok: number
  readonly outUsdPerMTok: number
}

/** The ONLY place a dollar figure is computed from tokens. Requires explicit prices. */
export function computedCostUsd(totals: Pick<UsageRollup, "inputTokens" | "outputTokens">, prices: PriceModel): number {
  return (totals.inputTokens * prices.inUsdPerMTok + totals.outputTokens * prices.outUsdPerMTok) / 1_000_000
}

// --------------------------------------------------------- stats rendering

/** Render the cross-run roll-up for humans: per-run rows, then per-loop aggregates with per-step usage. Pure. */
export function renderStats(rows: readonly RunStatsRow[], rollups: readonly LoopRollup[], prices: PriceModel | null): string[] {
  const costCol = (t: UsageRollup): string[] => (prices === null ? [] : [t.hasUsage ? fmtUsd(computedCostUsd(t, prices)) : "-"])
  const lines: string[] = [`runs (${rows.length})`]
  lines.push(
    ...table(
      [
        ["RUN", "LOOP", "STATUS", "ITER", "STEPS", "TOK-IN", "TOK-OUT", "WALL", ...(prices === null ? [] : ["COST"])],
        ...rows.map((r) => [
          r.runId,
          `${r.loopId}@${r.loopVersion}`,
          r.status,
          String(r.iterations),
          String(r.stepsRun),
          blankable(r.totals, r.totals.inputTokens),
          blankable(r.totals, r.totals.outputTokens),
          r.wallMs === null ? "-" : fmtMs(r.wallMs),
          ...costCol(r.totals),
        ]),
      ],
      "  ",
    ),
  )
  lines.push("per loop")
  for (const l of rollups) {
    const cost = prices !== null && l.totals.hasUsage ? `  est-cost=${fmtUsd(computedCostUsd(l.totals, prices))}` : ""
    const reported = l.totals.reportedCostUsd > 0 ? `  reported-cost=${fmtUsd(l.totals.reportedCostUsd)}` : ""
    lines.push(
      `  ${l.loopId}  runs=${l.runs}  success=${Math.round(l.successRate * 100)}%  mean-iter=${l.meanIterations.toFixed(1)}  ` +
        `tok-in=${blankable(l.totals, l.totals.inputTokens)}  tok-out=${blankable(l.totals, l.totals.outputTokens)}  wall=${fmtMs(l.wallMs)}${cost}${reported}`,
    )
    lines.push(
      ...table(
        [["step", "execs", "tok-in", "tok-out", "time", ...(prices === null ? [] : ["est-cost"])], ...l.steps.map((s) => [s.stepId, String(s.executions), blankable(s, s.inputTokens), blankable(s, s.outputTokens), s.hasUsage ? fmtMs(s.durationMs) : "-", ...costCol(s)])],
        "    ",
      ),
    )
  }
  if (prices === null) lines.push("(tokens only — pass --price-in/--price-out USD per 1M tokens for computed cost)")
  return lines
}

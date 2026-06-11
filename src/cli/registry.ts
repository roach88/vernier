// The loop registry: every loop this looper installation can run, by id.
//
// A registry entry is the loop (data) plus the one thing data cannot carry —
// how to build its runtime dependencies (executors, contracts, observer,
// memory, workdir prep). The per-pilot run.ts scripts each wired this by
// hand; the registry is that wiring, named, so `looper run <loopId>` and
// `looper resume <runId>` can reconstruct the same deps the original driver
// used. Executor construction is lazy where it matters: CodexWorker spawns
// its app-server on first runAgent(), so listing loops costs nothing.
//
// User loops arrive through looper.config (cli/config.ts) and merge in here
// with `source` naming where they came from; the in-tree pilots stay
// registered as examples. Executor BINDING is resolved before a run starts
// (config.ts bindExecutors) — the registry maps ids to implementations, the
// binding decides which id a step resolves to.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineDeps } from "../engine/tick.js"
import { ClaudeExecutor } from "../executors/claude.js"
import { CodexExecutor } from "../executors/codex.js"
import { CursorExecutor } from "../executors/cursor.js"
import { HermesExecutor } from "../executors/hermes.js"
import { JudgeExecutor } from "../executors/judge.js"
import { recallExecutor, rememberExecutor } from "../executors/memory.js"
import { executorRegistry } from "../executors/script.js"
import { ContractRegistry, defaultContractRegistry } from "../kernel/contract.js"
import { gitObserver } from "../kernel/git-effects.js"
import type { Executor, Loop } from "../kernel/types.js"
import { resolveLedgerRoot } from "../ledger/ledger.js"
import { Memory, resolveMemoryRoot, rulesPath } from "../memory/memory.js"
import { controlPlaneSmokeExecutor, controlPlaneSmokeLoop } from "../pilot0/loop.js"
import { dryRunNoteV1, routeDecisionV1 } from "../pilot1/contracts.js"
import { planWorkReviewLoop } from "../pilot1/loop.js"
import { verifiedAnswerLoop } from "../pilot2/loop.js"
import { compoundingAnswerLoop } from "../pilot3/loop.js"
import { ConfigError, type LoadedConfig, type LoopRegistration } from "./config.js"

export interface LoopRuntime {
  readonly deps: EngineDeps
  /** Tear down whatever the deps spawned (codex app-servers). Always called by the CLI, even on failure. */
  shutdown(): Promise<void>
}

export interface RegisteredLoop {
  readonly loop: Loop
  /** Human-readable `in -> out` (zod schemas don't render themselves). */
  readonly signature: string
  readonly summary: string
  /** Where the loop came from: "builtin", or the config/module path that registered it. */
  readonly source: string
  /** True when the loop drives live LLM CLIs — `looper run` warns; the test suite never runs these. */
  readonly live: boolean
  /** Inputs used when `looper run` gets no --input. Omitted = inputs are required. */
  readonly defaultInputs?: Record<string, unknown>
  /** Create (if needed) and return the workdir used when --workdir is not given. */
  defaultWorkdir(): string
  /** Build the runtime deps rooted at a workdir, preparing the workdir as the loop expects. */
  runtime(workdir: string): LoopRuntime
}

const BUILTIN = "builtin"

const noShutdown = async (): Promise<void> => {}

function scratchDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `looper-${label}-`))
}

/**
 * The wired provider executors (codex / cursor-agent / claude), constructed
 * lazily as a set: every agent-driven entry registers ALL of them so any
 * role can be rebound onto any agent (`--executor <step>=claude`) without a
 * custom runtime. Nothing spawns or imports an SDK until a step actually
 * runs on one of them, so registering the full set costs nothing.
 */
function wiredProviders(): { readonly executors: readonly Executor[]; shutdown(): Promise<void> } {
  const codex = new CodexExecutor()
  const cursor = new CursorExecutor()
  const claude = new ClaudeExecutor()
  return {
    executors: [codex, cursor, claude],
    async shutdown() {
      await codex.shutdown()
      await cursor.shutdown()
      await claude.shutdown()
    },
  }
}

function smokeEntry(): RegisteredLoop {
  return {
    loop: controlPlaneSmokeLoop,
    signature: "jobName:string, upstreamChanged?:boolean -> ok:boolean, trace:path",
    summary: "Pilot 0: deterministic no-agent control-plane smoke (gateway/job/no-op/trace/delivery).",
    source: BUILTIN,
    live: false,
    defaultInputs: { jobName: "watch-every-compound-engineering-upstream" },
    defaultWorkdir() {
      const workdir = join(resolveLedgerRoot(controlPlaneSmokeLoop.ledger), "work")
      mkdirSync(workdir, { recursive: true })
      return workdir
    },
    runtime(workdir) {
      return {
        deps: {
          executors: executorRegistry(controlPlaneSmokeExecutor),
          contracts: defaultContractRegistry(),
          workdir,
        },
        shutdown: noShutdown,
      }
    },
  }
}

function planWorkReviewEntry(): RegisteredLoop {
  return {
    loop: planWorkReviewLoop,
    signature: "task:string -> artifact:path, verdict:string",
    summary:
      "Pilot 1: an LLM router gates, codex implements a contract-checked dry-run note (LIVE; route + implement default to codex — bind route=hermes to route on hermes).",
    source: BUILTIN,
    live: true,
    defaultWorkdir: () => scratchDir("plan-work-review"),
    runtime(workdir) {
      // The pilot-1 scratch shape: a git repo with the allowed artifact root.
      mkdirSync(join(workdir, "docs", "agent-workflows"), { recursive: true })
      if (!existsSync(join(workdir, ".git"))) execFileSync("git", ["init", "--quiet"], { cwd: workdir })
      if (!existsSync(join(workdir, "README.md"))) {
        writeFileSync(join(workdir, "README.md"), "# looper plan-work-review scratch\n", "utf8")
      }
      const providers = wiredProviders()
      return {
        deps: {
          executors: executorRegistry(new HermesExecutor(), ...providers.executors),
          contracts: defaultContractRegistry().register(routeDecisionV1).register(dryRunNoteV1),
          workdir,
          observer: gitObserver,
        },
        shutdown: () => providers.shutdown(),
      }
    },
  }
}

function verifiedAnswerEntry(): RegisteredLoop {
  return {
    loop: verifiedAnswerLoop,
    signature: "goal:string, rubric:string -> answer:string, verdict:string",
    summary: "Pilot 2: codex answers, an independent judge grades, until passed (LIVE codex).",
    source: BUILTIN,
    live: true,
    defaultWorkdir: () => scratchDir("verified-answer"),
    runtime(workdir) {
      const providers = wiredProviders()
      const judge = new JudgeExecutor()
      return {
        deps: {
          executors: executorRegistry(...providers.executors, judge),
          contracts: defaultContractRegistry(),
          workdir,
        },
        shutdown: async () => {
          await providers.shutdown()
          await judge.shutdown()
        },
      }
    },
  }
}

function compoundingAnswerEntry(): RegisteredLoop {
  return {
    loop: compoundingAnswerLoop,
    signature: "goal:string, rubric:string -> answer:string, verdict:string, learnedRule:string",
    summary: "Pilot 3: recall -> answer -> grade -> distill -> remember; memory compounds across runs (LIVE codex).",
    source: BUILTIN,
    live: true,
    defaultWorkdir: () => scratchDir("compounding-answer"),
    runtime(workdir) {
      const providers = wiredProviders()
      const judge = new JudgeExecutor()
      const distiller = new JudgeExecutor({ id: "distill" })
      // ONE durable store under the looper root — sharing it across CLI
      // invocations is the compounding seam (pilot3/run.ts shares it across
      // two in-process runs; the CLI shares it across processes).
      const memory = new Memory(rulesPath(resolveMemoryRoot({})))
      return {
        deps: {
          executors: executorRegistry(...providers.executors, judge, distiller, recallExecutor, rememberExecutor),
          contracts: new ContractRegistry(),
          workdir,
          memory,
        },
        shutdown: async () => {
          await providers.shutdown()
          await judge.shutdown()
          await distiller.shutdown()
        },
      }
    },
  }
}

/**
 * A user loop from looper.config, behind the same RegisteredLoop seam as
 * the pilots. The default runtime hands it the full built-in executor set
 * (construction is lazy — nothing spawns until a step actually runs on it)
 * plus whatever the registration brings; `runtime` on the registration
 * overrides all of that for full control.
 */
function userEntry(reg: LoopRegistration, source: string): RegisteredLoop {
  return {
    loop: reg.loop,
    signature: reg.signature ?? "(zod signature; see the loop module)",
    summary: reg.summary ?? `User loop \`${reg.loop.id}\`.`,
    source,
    live: reg.live ?? false,
    ...(reg.defaultInputs !== undefined ? { defaultInputs: reg.defaultInputs } : {}),
    defaultWorkdir: reg.defaultWorkdir ?? (() => scratchDir(reg.loop.id)),
    runtime(workdir) {
      if (reg.runtime) return reg.runtime(workdir)
      const providers = wiredProviders()
      const judge = new JudgeExecutor()
      const contracts = defaultContractRegistry()
      for (const contract of reg.contracts ?? []) contracts.register(contract)
      // Registration executors merge OVER the builtins (the user's module
      // is closest to the user's intent — same rule as config executors).
      const executors = new Map<string, Executor>(
        executorRegistry(...providers.executors, judge, new HermesExecutor(), recallExecutor, rememberExecutor),
      )
      for (const executor of reg.executors ?? []) executors.set(executor.id, executor)
      return {
        deps: {
          executors,
          contracts,
          workdir,
          ...(reg.observer === "git" ? { observer: gitObserver } : {}),
          memory: new Memory(rulesPath(resolveMemoryRoot({}))),
        },
        shutdown: async () => {
          await providers.shutdown()
          await judge.shutdown()
        },
      }
    },
  }
}

export function loopRegistry(config?: LoadedConfig): ReadonlyMap<string, RegisteredLoop> {
  const entries = [smokeEntry(), planWorkReviewEntry(), verifiedAnswerEntry(), compoundingAnswerEntry()]
  for (const { registration, source } of config?.loops ?? []) entries.push(userEntry(registration, source))
  const map = new Map<string, RegisteredLoop>()
  for (const entry of entries) {
    const existing = map.get(entry.loop.id)
    if (existing) {
      throw new ConfigError(
        `Duplicate loop id \`${entry.loop.id}\` (registered by ${existing.source} and ${entry.source}). Rename one of them.`,
      )
    }
    map.set(entry.loop.id, entry)
  }
  return map
}

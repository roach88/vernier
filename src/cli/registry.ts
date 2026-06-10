// The loop registry: every loop this looper installation can run, by id.
//
// A registry entry is the loop (data) plus the one thing data cannot carry —
// how to build its runtime dependencies (executors, contracts, observer,
// memory, workdir prep). The per-pilot run.ts scripts each wired this by
// hand; the registry is that wiring, named, so `looper run <loopId>` and
// `looper resume <runId>` can reconstruct the same deps the original driver
// used. Executor construction is lazy where it matters: CodexWorker spawns
// its app-server on first runAgent(), so listing loops costs nothing.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineDeps } from "../engine/tick.js"
import { CodexExecutor } from "../executors/codex.js"
import { HermesExecutor } from "../executors/hermes.js"
import { JudgeExecutor } from "../executors/judge.js"
import { recallExecutor, rememberExecutor } from "../executors/memory.js"
import { executorRegistry } from "../executors/script.js"
import { ContractRegistry, defaultContractRegistry } from "../kernel/contract.js"
import { gitObserver } from "../kernel/git-effects.js"
import type { Loop } from "../kernel/types.js"
import { resolveLedgerRoot } from "../ledger/ledger.js"
import { Memory, resolveMemoryRoot, rulesPath } from "../memory/memory.js"
import { controlPlaneSmokeExecutor, controlPlaneSmokeLoop } from "../pilot0/loop.js"
import { dryRunNoteV1, routeDecisionV1 } from "../pilot1/contracts.js"
import { planWorkReviewLoop } from "../pilot1/loop.js"
import { verifiedAnswerLoop } from "../pilot2/loop.js"
import { compoundingAnswerLoop } from "../pilot3/loop.js"

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
  /** True when the loop drives live LLM CLIs — `looper run` warns; the test suite never runs these. */
  readonly live: boolean
  /** Inputs used when `looper run` gets no --input. Omitted = inputs are required. */
  readonly defaultInputs?: Record<string, unknown>
  /** Create (if needed) and return the workdir used when --workdir is not given. */
  defaultWorkdir(): string
  /** Build the runtime deps rooted at a workdir, preparing the workdir as the loop expects. */
  runtime(workdir: string): LoopRuntime
}

const noShutdown = async (): Promise<void> => {}

function scratchDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `looper-${label}-`))
}

function smokeEntry(): RegisteredLoop {
  return {
    loop: controlPlaneSmokeLoop,
    signature: "jobName:string, upstreamChanged?:boolean -> ok:boolean, trace:path",
    summary: "Pilot 0: deterministic no-agent control-plane smoke (gateway/job/no-op/trace/delivery).",
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
    summary: "Pilot 1: hermes routes, codex implements a contract-checked dry-run note (LIVE codex + hermes).",
    live: true,
    defaultWorkdir: () => scratchDir("plan-work-review"),
    runtime(workdir) {
      // The pilot-1 scratch shape: a git repo with the allowed artifact root.
      mkdirSync(join(workdir, "docs", "agent-workflows"), { recursive: true })
      if (!existsSync(join(workdir, ".git"))) execFileSync("git", ["init", "--quiet"], { cwd: workdir })
      if (!existsSync(join(workdir, "README.md"))) {
        writeFileSync(join(workdir, "README.md"), "# looper plan-work-review scratch\n", "utf8")
      }
      const codex = new CodexExecutor()
      return {
        deps: {
          executors: executorRegistry(new HermesExecutor(), codex),
          contracts: defaultContractRegistry().register(routeDecisionV1).register(dryRunNoteV1),
          workdir,
          observer: gitObserver,
        },
        shutdown: () => codex.shutdown(),
      }
    },
  }
}

function verifiedAnswerEntry(): RegisteredLoop {
  return {
    loop: verifiedAnswerLoop,
    signature: "goal:string, rubric:string -> answer:string, verdict:string",
    summary: "Pilot 2: codex answers, an independent judge grades, until passed (LIVE codex).",
    live: true,
    defaultWorkdir: () => scratchDir("verified-answer"),
    runtime(workdir) {
      const answerer = new CodexExecutor()
      const judge = new JudgeExecutor()
      return {
        deps: {
          executors: executorRegistry(answerer, judge),
          contracts: defaultContractRegistry(),
          workdir,
        },
        shutdown: async () => {
          await answerer.shutdown()
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
    live: true,
    defaultWorkdir: () => scratchDir("compounding-answer"),
    runtime(workdir) {
      const answerer = new CodexExecutor()
      const judge = new JudgeExecutor()
      const distiller = new JudgeExecutor({ id: "distill" })
      // ONE durable store under the looper root — sharing it across CLI
      // invocations is the compounding seam (pilot3/run.ts shares it across
      // two in-process runs; the CLI shares it across processes).
      const memory = new Memory(rulesPath(resolveMemoryRoot({})))
      return {
        deps: {
          executors: executorRegistry(answerer, judge, distiller, recallExecutor, rememberExecutor),
          contracts: new ContractRegistry(),
          workdir,
          memory,
        },
        shutdown: async () => {
          await answerer.shutdown()
          await judge.shutdown()
          await distiller.shutdown()
        },
      }
    },
  }
}

export function loopRegistry(): ReadonlyMap<string, RegisteredLoop> {
  const entries = [smokeEntry(), planWorkReviewEntry(), verifiedAnswerEntry(), compoundingAnswerEntry()]
  const map = new Map<string, RegisteredLoop>()
  for (const entry of entries) {
    if (map.has(entry.loop.id)) throw new Error(`Duplicate loop id \`${entry.loop.id}\` in the registry.`)
    map.set(entry.loop.id, entry)
  }
  return map
}

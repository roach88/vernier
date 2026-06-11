// The loop registry: every loop this vernier installation can run, by id.
//
// A registry entry is the loop (data) plus the one thing data cannot carry —
// how to build its runtime dependencies (executors, contracts, observer,
// memory, workdir prep). The registry SHIPS EMPTY: vernier has no built-in
// loops. Every loop arrives through vernier.config (cli/config.ts) with
// `source` naming where it came from; `vernier init` scaffolds starter
// templates that register this way. Executor BINDING is resolved before a
// run starts (config.ts bindExecutors) — the registry maps ids to
// implementations, the binding decides which id a step resolves to.
//
// Executor construction is lazy where it matters: provider workers spawn on
// first runAgent(), so registering the full wired set costs nothing.

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineDeps } from "../engine/tick.js"
import { ClaudeExecutor } from "../executors/claude.js"
import { CodexExecutor } from "../executors/codex.js"
import { CursorExecutor } from "../executors/cursor.js"
import { HermesExecutor } from "../executors/hermes.js"
import { JudgeExecutor } from "../executors/judge.js"
import { recallExecutor, rememberExecutor } from "../executors/memory.js"
import { OpencodeExecutor } from "../executors/opencode.js"
import { PiExecutor } from "../executors/pi.js"
import { executorRegistry } from "../executors/script.js"
import { defaultContractRegistry } from "../kernel/contract.js"
import { gitObserver } from "../kernel/git-effects.js"
import type { Executor, Loop } from "../kernel/types.js"
import { Memory, resolveMemoryRoot, retrieverFromEnv, rulesPath } from "../memory/memory.js"
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
  /** Where the loop came from: the config/module path that registered it. */
  readonly source: string
  /** True when the loop drives live LLM CLIs — `vernier run` warns; the test suite never runs these. */
  readonly live: boolean
  /** Inputs used when `vernier run` gets no --input. Omitted = inputs are required. */
  readonly defaultInputs?: Record<string, unknown>
  /** Create (if needed) and return the workdir used when --workdir is not given. */
  defaultWorkdir(): string
  /** Build the runtime deps rooted at a workdir, preparing the workdir as the loop expects. */
  runtime(workdir: string): LoopRuntime
}

function scratchDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `vernier-${label}-`))
}

/**
 * The wired provider executors (codex / cursor-agent / claude / opencode /
 * pi), constructed lazily as a set: every config-registered entry registers
 * ALL of them so any role can be rebound onto any agent (`--executor
 * <step>=claude`) without a custom runtime. Nothing spawns until a step
 * actually runs on one of them, so registering the full set costs nothing.
 */
export function wiredProviders(): { readonly executors: readonly Executor[]; shutdown(): Promise<void> } {
  const executors = [
    new CodexExecutor(),
    new CursorExecutor(),
    new ClaudeExecutor(),
    new OpencodeExecutor(),
    new PiExecutor(),
  ]
  return {
    executors,
    async shutdown() {
      for (const executor of executors) await executor.shutdown()
    },
  }
}

/**
 * A user loop from vernier.config, behind the RegisteredLoop seam. The
 * default runtime hands it the full built-in executor set (construction is
 * lazy — nothing spawns until a step actually runs on it) plus whatever the
 * registration brings; `runtime` on the registration overrides all of that
 * for full control.
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
          memory: new Memory(rulesPath(resolveMemoryRoot({})), retrieverFromEnv()),
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
  const entries: RegisteredLoop[] = []
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

// Out-of-tree loop registration: vernier.config.{ts,js,mjs,json}.
//
// A user defines a Loop (and any Executor) in their OWN repo and registers
// it here — no fork of vernier. The config contributes three things, merged
// over the built-in registry at CLI startup:
//
//   loops      user loop modules (each default-exports a Loop or a
//              defineLoop({ loop, ... }) registration)
//   executors  user executor modules (each default-exports an Executor or
//              an Executor[]) — this is how "any coding agent" arrives
//   bindings   executor bindings: stepId-or-executorId -> executorId,
//              applied to every loop they match (see bindExecutors)
//
// Discovery: $VERNIER_CONFIG (explicit path, missing = error), else walk up
// from cwd until a directory containing a config file or `.git` (the repo
// root) is found. JSON configs are validated by `vernierConfigSchema`; TS/JS
// configs default-export `defineConfig({...})`.
//
// ── TRUST BOUNDARY ─────────────────────────────────────────────────────────
// Loading a config or a module it names EXECUTES that code with this
// process's full privileges — exactly the trust you extend to any npm
// script. v1 documents this honestly instead of pretending a sandbox:
// do not point vernier at a config you would not `node` yourself.
// ───────────────────────────────────────────────────────────────────────────
//
// Loader note: .js/.mjs/.json work under plain node. .ts configs work today
// because bin/vernier.js registers the tsx loader; a compiled bin is coming,
// so a .ts import failure without a loader gets an actionable error instead
// of a stack trace (see importModule). Bare specifiers a config module
// imports that default resolution cannot serve (a bare-dir scaffold
// importing `zod` or `"vernier"`) are retried against vernier's own
// dependency tree — see bin/lend-deps-hooks.mjs, registered in cli/main.

import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import type { JudgeProvider } from "../executors/judge.js"
import type { Contract } from "../kernel/contract.js"
import type { Executor, Loop } from "../kernel/types.js"
import type { SkillBindingLayer } from "../skills/skills.js"
import type { LoopRuntime } from "./registry.js"

/** Config problems are usage problems: the CLI maps this to exit 2 with the message verbatim. */
export class ConfigError extends Error {}

// ------------------------------------------------------------- config shape

/**
 * The JSON form of the config: module paths only (relative paths resolve
 * against the config file's directory). The one source of truth for what a
 * vernier.config.json may contain.
 */
export const vernierConfigSchema = z
  .object({
    /** Paths to loop modules; each default-exports a Loop or defineLoop({...}). */
    loops: z.array(z.string()).optional(),
    /** Paths to executor modules; each default-exports an Executor or Executor[]. */
    executors: z.array(z.string()).optional(),
    /** Executor bindings: stepId-or-executorId -> executorId. */
    bindings: z.record(z.string()).optional(),
    /** Explicit Agent Skill registrations: a SKILL.md file, a skill dir, or a parent dir of skill dirs. Wins name collisions against .claude/skills discovery. */
    skills: z.array(z.string()).optional(),
    /** Skill bindings: stepId-or-executorId -> skill name(s) (a name, a comma-separated list, or an array). */
    skillBindings: z.record(z.union([z.string(), z.array(z.string())])).optional(),
    /** Backing provider for the built-in judge/distill wrapper. The provider value is validated by parseJudgeBlock (see judgeProviderError). */
    judge: z.object({ provider: z.string() }).strict().optional(),
  })
  .strict()

/**
 * One user loop, registered: the Loop (data) plus the runtime facts data
 * cannot carry. Everything beyond `loop` is optional — the registry builds
 * a sensible default runtime (built-in executors + yours, default contracts
 * + yours, hash or git effect observation).
 */
export interface LoopRegistration {
  readonly loop: Loop
  readonly summary?: string
  /** Human-readable `in -> out` for `vernier loops` (zod schemas don't render themselves). */
  readonly signature?: string
  /** True when the loop drives live LLM CLIs — `vernier run` warns. */
  readonly live?: boolean
  /** Inputs used when `vernier run` gets no --input. Omitted = inputs are required. */
  readonly defaultInputs?: Record<string, unknown>
  /** Executors this loop's steps name, in addition to the built-in set. */
  readonly executors?: readonly Executor[]
  /** Contracts this loop's steps name, in addition to the built-in set. */
  readonly contracts?: readonly Contract[]
  /** Effect observation: "hash" (default, walks+hashes the workdir) or "git" (git-aware, needs a git workdir). */
  readonly observer?: "hash" | "git"
  /** Create (if needed) and return the workdir used when --workdir is not given. Default: a fresh tmp scratch dir. */
  readonly defaultWorkdir?: () => string
  /** Full control: build the runtime deps yourself. Overrides executors/contracts/observer above. */
  readonly runtime?: (workdir: string) => LoopRuntime
}

/** The TS/JS form of the config: module paths AND in-place objects are both fine. */
export interface VernierConfig {
  readonly loops?: ReadonlyArray<string | Loop | LoopRegistration>
  readonly executors?: ReadonlyArray<string | Executor>
  readonly bindings?: Readonly<Record<string, string>>
  /** Explicit Agent Skill registrations (paths: a SKILL.md, a skill dir, or a parent dir of skill dirs). */
  readonly skills?: ReadonlyArray<string>
  /** Skill bindings: stepId-or-executorId -> skill name(s). */
  readonly skillBindings?: Readonly<Record<string, string | readonly string[]>>
  /** Backing provider for the built-in judge/distill wrapper. Absent = codex. */
  readonly judge?: { readonly provider: JudgeConfigProvider }
}

/** Typed identity helper for TS/JS configs: `export default defineConfig({...})`. */
export const defineConfig = (config: VernierConfig): VernierConfig => config

/** Typed identity helper for TS/JS loop modules: `export default defineLoop({ loop, ... })`. */
export const defineLoop = (registration: LoopRegistration): LoopRegistration => registration

// -------------------------------------------------------------- judge block

/**
 * Providers the `judge` config block accepts — the USER-FACING executor
 * vocabulary (`claude` is the executor id users bind steps to, not the
 * internal worker id `claude-code`; judgeBackingProvider maps it).
 */
export const JUDGE_CONFIG_PROVIDERS = ["codex", "claude"] as const
export type JudgeConfigProvider = (typeof JUDGE_CONFIG_PROVIDERS)[number]

/** Why a value cannot back the judge — the rejection text IS the documentation. */
export function judgeProviderError(value: unknown): string {
  const got = typeof value === "string" ? `\`${value}\`` : JSON.stringify(value)
  const hint =
    value === "claude-code" ? ` (\`claude-code\` is the internal worker id — the config speaks the executor vocabulary: \`claude\`)` : ""
  return (
    `judge.provider must be "codex" or "claude", got ${got}${hint}. ` +
    `The judge pins its sandbox to read-only for every verdict, so only providers that honor a pinned read-only sandbox can back it: ` +
    `opencode and pi refuse it (their workers expose no enforceable sandbox — a judge that can write is not a judge), and ` +
    `cursor-agent has no per-run config plumbing to pin one yet. ` +
    `Any other backend: inject a custom worker (\`new JudgeExecutor({ worker })\`) in a defineLoop runtime.`
  )
}

/**
 * Map the config vocabulary onto the judge's internal worker provider id
 * (`claude` = the Claude Code CLI). No config, or no `judge` block = codex —
 * a default, not a privilege.
 */
export function judgeBackingProvider(config: { readonly judge?: { readonly provider: JudgeConfigProvider } } | undefined): JudgeProvider {
  return config?.judge?.provider === "claude" ? "claude-code" : "codex"
}

/** Validate the judge block (both config forms — TS/JS configs never pass through zod). */
function parseJudgeBlock(raw: unknown, path: string): { readonly provider: JudgeConfigProvider } | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw) || typeof raw.provider !== "string" || Object.keys(raw).length !== 1) {
    throw new ConfigError(`\`${path}\`: \`judge\` must be \`{ "provider": "codex" | "claude" }\`.`)
  }
  if (!(JUDGE_CONFIG_PROVIDERS as readonly string[]).includes(raw.provider)) {
    throw new ConfigError(`\`${path}\`: ${judgeProviderError(raw.provider)}`)
  }
  return { provider: raw.provider as JudgeConfigProvider }
}

// ---------------------------------------------------------------- discovery

const CONFIG_NAMES = ["vernier.config.ts", "vernier.config.js", "vernier.config.mjs", "vernier.config.json"]

/** Walk up from cwd; stop at the first config found, or at the repo root (`.git`), or the fs root. */
export function findConfigPath(cwd: string): string | undefined {
  let dir = resolve(cwd)
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    if (existsSync(join(dir, ".git"))) return undefined // repo root: stop walking
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// ------------------------------------------------------------------ loading

export interface LoadedConfig {
  /** Absolute path of the config file. */
  readonly path: string
  readonly loops: ReadonlyArray<{ readonly registration: LoopRegistration; readonly source: string }>
  readonly executors: readonly Executor[]
  readonly bindings: ReadonlyMap<string, string>
  /** Explicitly registered skill paths, config-dir-resolved to absolute. */
  readonly skills: readonly string[]
  /** Skill bindings: stepId-or-executorId -> skill names, normalized to lists. */
  readonly skillBindings: SkillBindingLayer
  /** The validated `judge` block; absent = codex backs the wrapper. */
  readonly judge?: { readonly provider: JudgeConfigProvider }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isLoop(value: unknown): value is Loop {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    Array.isArray(value.steps) &&
    typeof value.policy === "function" &&
    isRecord(value.signature)
  )
}

function isExecutor(value: unknown): value is Executor {
  return isRecord(value) && typeof value.id === "string" && typeof value.run === "function"
}

async function importModule(path: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(path).href)) as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = (error as { code?: string }).code
    if (path.endsWith(".ts") && (code === "ERR_UNKNOWN_FILE_EXTENSION" || message.includes("Unknown file extension"))) {
      throw new ConfigError(
        `Could not load \`${path}\`: this runtime has no TypeScript loader. ` +
          `Use a .mjs/.js/.json config instead, or run vernier through a TS-capable loader (e.g. install tsx and run \`tsx\`/the dev bin, which registers it).`,
      )
    }
    throw new ConfigError(`Could not load \`${path}\`: ${message}`)
  }
}

/** Resolve a module path from the config: relative paths are config-dir-relative. */
const fromConfigDir = (configPath: string, entry: string): string =>
  isAbsolute(entry) ? entry : resolve(dirname(configPath), entry)

async function loadLoopEntry(
  entry: string | Loop | LoopRegistration,
  configPath: string,
): Promise<{ registration: LoopRegistration; source: string }> {
  let raw: unknown = entry
  let source = configPath
  if (typeof entry === "string") {
    source = fromConfigDir(configPath, entry)
    const mod = await importModule(source)
    raw = mod.default
    if (raw === undefined) throw new ConfigError(`Loop module \`${source}\` has no default export; export a Loop or defineLoop({ loop, ... }).`)
  }
  if (isLoop(raw)) return { registration: { loop: raw }, source }
  if (isRecord(raw) && isLoop(raw.loop)) return { registration: raw as unknown as LoopRegistration, source }
  throw new ConfigError(
    `\`${source}\` does not provide a loop: expected a Loop ({ id, version, signature, steps, policy, trust, ledger }) or defineLoop({ loop, ... }).`,
  )
}

async function loadExecutorEntry(entry: string | Executor, configPath: string): Promise<Executor[]> {
  if (typeof entry !== "string") {
    if (isExecutor(entry)) return [entry]
    throw new ConfigError(`\`${configPath}\` lists an executor that is not one: expected { id, run() }.`)
  }
  const source = fromConfigDir(configPath, entry)
  const mod = await importModule(source)
  const raw = mod.default
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length === 0 || !list.every(isExecutor)) {
    throw new ConfigError(`Executor module \`${source}\` must default-export an Executor ({ id, run() }) or an array of them.`)
  }
  return list as Executor[]
}

/** Parse + schema-validate the JSON config form. */
function parseJsonConfig(path: string): VernierConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new ConfigError(`\`${path}\` is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = vernierConfigSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n")
    throw new ConfigError(`\`${path}\` does not match the vernier config schema:\n${issues}`)
  }
  // exactOptionalPropertyTypes: zod's .optional() parses to `T | undefined`
  // properties; VernierConfig keeps optional keys strictly ABSENT. Normalize
  // here (drop undefined keys, repo-wide conditional-spread pattern) so the
  // public type stays strict instead of widening it.
  const { loops, executors, bindings, skills, skillBindings, judge } = result.data
  // The schema checks judge's shape; parseJudgeBlock narrows the provider
  // value (and rejects unsupported providers with the actionable WHY).
  const judgeBlock = parseJudgeBlock(judge, path)
  return {
    ...(loops !== undefined ? { loops } : {}),
    ...(executors !== undefined ? { executors } : {}),
    ...(bindings !== undefined ? { bindings } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(skillBindings !== undefined ? { skillBindings } : {}),
    ...(judgeBlock !== undefined ? { judge: judgeBlock } : {}),
  }
}

/**
 * Discover and load the user config. Returns undefined when there is none —
 * the built-in registry stands alone. Throws ConfigError with an actionable
 * message for every malformed case. REMINDER: this executes user code (see
 * the trust-boundary note at the top of this file).
 */
export async function loadConfig(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig | undefined> {
  const explicit = env.VERNIER_CONFIG?.trim()
  let path: string | undefined
  if (explicit) {
    path = resolve(cwd, explicit)
    if (!existsSync(path)) throw new ConfigError(`$VERNIER_CONFIG points at \`${path}\`, which does not exist.`)
  } else {
    path = findConfigPath(cwd)
  }
  if (path === undefined) return undefined

  let config: VernierConfig
  if (path.endsWith(".json")) {
    config = parseJsonConfig(path)
  } else {
    const mod = await importModule(path)
    const raw = mod.default
    if (!isRecord(raw)) {
      throw new ConfigError(`\`${path}\` must default-export the config object: \`export default defineConfig({ loops, executors, bindings })\`.`)
    }
    config = raw as VernierConfig
  }

  const loops = []
  for (const entry of config.loops ?? []) loops.push(await loadLoopEntry(entry, path))
  const executors: Executor[] = []
  for (const entry of config.executors ?? []) executors.push(...(await loadExecutorEntry(entry, path)))
  const bindings = new Map<string, string>()
  for (const [key, value] of Object.entries(config.bindings ?? {})) {
    if (typeof value !== "string") throw new ConfigError(`\`${path}\` binding \`${key}\` must map to an executor id string.`)
    bindings.set(key, value)
  }
  const skills: string[] = []
  for (const entry of config.skills ?? []) {
    if (typeof entry !== "string") throw new ConfigError(`\`${path}\` \`skills\` entries must be path strings (a SKILL.md, a skill dir, or a parent dir of skill dirs).`)
    skills.push(fromConfigDir(path, entry))
  }
  const skillBindings = new Map<string, readonly string[]>()
  for (const [key, value] of Object.entries(config.skillBindings ?? {})) {
    skillBindings.set(key, parseSkillBindingValue(key, value, path))
  }
  // Validated for BOTH forms here: the TS/JS form arrives as an unchecked cast.
  const judge = parseJudgeBlock(config.judge, path)
  return { path, loops, executors, bindings, skills, skillBindings, ...(judge !== undefined ? { judge } : {}) }
}

/**
 * Normalize one skillBindings value to a name list: a single name, a
 * comma-separated list (skill names cannot contain commas), or an array.
 * The EXPLICIT clear is an empty ARRAY (`[]`); a non-empty string that
 * yields only blank tokens (`""`, `","`) is a typo, not a silent clear, and
 * is rejected — otherwise a fat-fingered value would quietly drop a step's
 * skills.
 */
function parseSkillBindingValue(key: string, value: unknown, path: string): readonly string[] {
  if (Array.isArray(value)) {
    if (!value.every((v): v is string => typeof v === "string")) {
      throw new ConfigError(`\`${path}\` skillBindings \`${key}\` array must contain only skill-name strings.`)
    }
    return value.map((v) => v.trim()).filter((v) => v.length > 0) // [] = intentional clear
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw new ConfigError(`\`${path}\` skillBindings \`${key}\` is empty; use an empty array \`[]\` to intentionally clear a step's skills.`)
    }
    const names = value.split(",").map((v) => v.trim())
    if (names.some((v) => v.length === 0)) {
      throw new ConfigError(`\`${path}\` skillBindings \`${key}\` has a blank skill name in \`${value}\`.`)
    }
    return names
  }
  throw new ConfigError(`\`${path}\` skillBindings \`${key}\` must map to a skill name, a comma-separated list, or an array of names.`)
}

// ----------------------------------------------------- executor resolution

/** One layer of executor bindings: stepId-or-executorId -> executorId. */
export type BindingLayer = ReadonlyMap<string, string>

/**
 * The resolution chain for one step, layers ordered highest precedence
 * first (CLI --executor > config bindings); within a layer a stepId match
 * beats an executorId (role) match; no match falls through to the next
 * layer and finally to the step's own declared executor — the loop default.
 */
export function resolveExecutorId(step: { readonly id: string; readonly executor: string }, layers: readonly BindingLayer[]): string {
  for (const layer of layers) {
    const bound = layer.get(step.id) ?? layer.get(step.executor)
    if (bound !== undefined) return bound
  }
  return step.executor
}

/**
 * Apply executor bindings to a Loop, returning a new Loop (the kernel never
 * sees bindings — a Loop stays declarative data; this rewrite IS the
 * resolution, performed at the CLI/registry layer before the run starts).
 * Keys that match nothing are ignored here: config bindings are global
 * across loops. The CLI validates its own --executor keys strictly.
 */
export function bindExecutors(loop: Loop, layers: readonly BindingLayer[]): Loop {
  if (layers.every((layer) => layer.size === 0)) return loop
  let changed = false
  const steps = loop.steps.map((step) => {
    const executor = resolveExecutorId(step, layers)
    if (executor === step.executor) return step
    changed = true
    return { ...step, executor }
  })
  return changed ? { ...loop, steps } : loop
}

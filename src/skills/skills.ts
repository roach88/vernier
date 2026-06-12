// Agent Skills: per-step capability injection, as declarative data.
//
// A skill is a directory with a SKILL.md (YAML frontmatter + Markdown body)
// per the Agent Skills open standard (https://agentskills.io/specification).
// vernier treats skills exactly like executors: a Step DECLARES skill names
// (`skills: ["security-review"]`), the implementation is resolved at the CLI
// layer through the same layered-binding chain (--skill overrides > config
// skillBindings > the step's declared default), and the resolved loop stays
// pure data — the kernel never sees bindings or discovery.
//
// Discovery (resolveSkills callers build this once per invocation, and only
// when a loop actually names skills):
//
//   config    paths registered in vernier.config `skills` (a SKILL.md file,
//             a skill directory, or a parent directory of skill directories)
//   project   <project>/.claude/skills/*  (project = the config file's dir)
//   user      ~/.claude/skills/*
//
// Earlier tiers win name collisions — explicit registration beats both
// standard locations; project beats user. Duplicate names WITHIN the
// explicit tier are an error (same rule as duplicate loop ids). An invalid
// skill in a standard location is recorded and skipped (it is not vernier's
// directory); an invalid explicitly-registered skill is an error (you asked
// for it by path).
//
// Delivery is the executor's choice, decided by the engine per step:
//
//   native    the executor declares `skillDelivery: "native"` (Claude Code:
//             a synthesized plugin dir passed via --plugin-dir) — the spec's
//             progressive disclosure survives intact; the prompt gains only
//             a short directive naming the skills.
//   prompt    every other executor: the SKILL.md body is embedded in the
//             step prompt, clearly delimited and attributed — the pragmatic
//             one-shot equivalent of progressive disclosure (a single
//             non-interactive turn has no later "activation" moment, so
//             activation is the turn itself).
//
// The frontmatter parser below handles the YAML SUBSET the spec defines:
// flat `key: value` scalars (quoted or plain), `key: >`/`|` block scalars,
// one-level nested maps (`metadata:`), and comments. It does not aspire to
// be a YAML parser; a SKILL.md the subset cannot read is reported as
// invalid with the reason.

import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import type { Loop, StepSkill } from "../kernel/types.js"

/** Skill problems are usage/config problems: the CLI maps this to exit 2 with the message verbatim. */
export class SkillError extends Error {}

// -------------------------------------------------------------------- types

/** Where a discovered skill came from — the collision-precedence tiers, highest first. */
export type SkillOrigin = "config" | "project" | "user"

/** One discovered, spec-valid skill: StepSkill (what the engine hands executors) plus provenance. */
export interface SkillRecord extends StepSkill {
  readonly origin: SkillOrigin
}

/** A standard-location directory that LOOKS like a skill but fails the spec — reported, never silently hidden. */
export interface InvalidSkill {
  readonly path: string
  readonly origin: SkillOrigin
  readonly reason: string
}

export interface SkillRegistry {
  /** Spec-valid skills by name, collisions already resolved by tier precedence. */
  readonly skills: ReadonlyMap<string, SkillRecord>
  readonly invalid: readonly InvalidSkill[]
}

export interface SkillDiscoveryOpts {
  /** Absolute paths from vernier.config `skills`: SKILL.md files, skill dirs, or parent dirs of skill dirs. */
  readonly explicit?: readonly string[]
  /** Directory whose `.claude/skills` is the project tier (the config file's dir, else cwd). */
  readonly projectRoot?: string
  /** Directory whose `.claude/skills` is the user tier (os.homedir() in production). */
  readonly home?: string
}

// ------------------------------------------------------- SKILL.md (the spec)

export const SKILL_FILE = "SKILL.md"

/**
 * The spec's `name` grammar: 1-64 chars, lowercase a-z / 0-9 / hyphens,
 * no leading/trailing/consecutive hyphens. The regex shape encodes the
 * hyphen rules; length is checked separately for a clearer message.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface ParsedSkillFile {
  readonly name: string
  readonly description: string
}

/**
 * Parse and spec-validate a SKILL.md's frontmatter. Throws SkillError with
 * the violated rule — the rejection text IS the documentation, same policy
 * as config errors.
 */
export function parseSkillFile(file: string): ParsedSkillFile {
  const fields = frontmatterFields(readFileSync(file, "utf8"), file)
  const name = fields.get("name")
  if (name === undefined || name.length === 0) throw new SkillError(`\`${file}\`: frontmatter is missing the required \`name\` field.`)
  if (name.length > 64) throw new SkillError(`\`${file}\`: \`name\` must be 1-64 characters, got ${name.length}.`)
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillError(
      `\`${file}\`: \`name\` must be lowercase letters, numbers, and hyphens, with no leading/trailing/consecutive hyphen — got \`${name}\`.`,
    )
  }
  const dirName = basename(join(file, ".."))
  if (name !== dirName) {
    throw new SkillError(`\`${file}\`: \`name\` (\`${name}\`) must match the skill's directory name (\`${dirName}\`) per the Agent Skills spec.`)
  }
  const description = fields.get("description")
  if (description === undefined || description.length === 0) {
    throw new SkillError(`\`${file}\`: frontmatter is missing the required \`description\` field.`)
  }
  if (description.length > 1024) throw new SkillError(`\`${file}\`: \`description\` must be at most 1024 characters, got ${description.length}.`)
  return { name, description }
}

/** The Markdown instructions after the frontmatter — what prompt delivery embeds. */
export function skillBody(file: string): string {
  const text = readFileSync(file, "utf8")
  const end = frontmatterEnd(text, file)
  return text.slice(end).trim()
}

/**
 * Top-level frontmatter fields as strings. Nested blocks (`metadata:`) and
 * unknown keys are tolerated and skipped — the spec only obliges vernier to
 * read `name` and `description`, and being liberal here keeps skills with
 * newer optional fields loadable.
 */
function frontmatterFields(text: string, file: string): Map<string, string> {
  const end = frontmatterEnd(text, file) // validates both fences exist
  const all = text.slice(0, end).split("\n")
  const closing = all.findIndex((line, index) => index > 0 && /^---[ \t]*\r?$/.test(line))
  const lines = all.slice(1, closing) // strictly between the fences
  const fields = new Map<string, string>()
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "")
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue
    if (/^\s/.test(line)) continue // nested content (metadata map, block-scalar lines): consumed by its key or skipped
    const colon = line.indexOf(":")
    if (colon <= 0) throw new SkillError(`\`${file}\`: frontmatter line ${i + 2} is not \`key: value\`: \`${line}\`.`)
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      // Block scalar: gather the following more-indented lines. `>` folds
      // with spaces, `|` keeps newlines; the trailing-newline chomp
      // distinction does not matter for name/description validation.
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1] ?? "") || (lines[i + 1] ?? "").trim() === "")) {
        block.push((lines[++i] ?? "").trim())
      }
      value = block.join(value.startsWith(">") ? " " : "\n").trim()
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    fields.set(key, value)
  }
  return fields
}

/** Offset just past the closing `---` line. Throws when the file has no frontmatter. */
function frontmatterEnd(text: string, file: string): number {
  const body = text.startsWith("﻿") ? text.slice(1) : text
  if (!/^---\r?\n/.test(body)) {
    throw new SkillError(`\`${file}\` does not start with YAML frontmatter (\`---\`); a SKILL.md requires \`name\` and \`description\` frontmatter.`)
  }
  // One pass: exec gives the match index AND the matched text, so the
  // closing-fence length is read directly — no redundant re-scan, and no
  // dead "match failed" branch that could return an offset INSIDE the fence.
  const fence = /\r?\n---[ \t]*(\r?\n|$)/.exec(body)
  if (fence === null) throw new SkillError(`\`${file}\`: frontmatter is never closed (no terminating \`---\` line).`)
  const offset = text.length - body.length // BOM, when present
  return offset + fence.index + fence[0].length
}

// ---------------------------------------------------------------- discovery

/** Read one skill from its directory (the dir must contain SKILL.md). */
function readSkillDir(dir: string, origin: SkillOrigin): SkillRecord {
  const file = join(dir, SKILL_FILE)
  if (!existsSync(file)) throw new SkillError(`\`${dir}\` has no ${SKILL_FILE}; a skill is a directory containing one.`)
  const { name, description } = parseSkillFile(file)
  return { name, description, dir, file, origin }
}

/** Expand one explicit config entry: a SKILL.md file, a skill dir, or a parent dir of skill dirs. */
function readExplicit(path: string): SkillRecord[] {
  if (!existsSync(path)) throw new SkillError(`vernier.config \`skills\` entry \`${path}\` does not exist.`)
  if (statSync(path).isFile()) {
    if (basename(path) !== SKILL_FILE) {
      throw new SkillError(`vernier.config \`skills\` entry \`${path}\` is a file but not a ${SKILL_FILE}; register the ${SKILL_FILE} or its directory.`)
    }
    return [readSkillDir(join(path, ".."), "config")]
  }
  if (existsSync(join(path, SKILL_FILE))) return [readSkillDir(path, "config")]
  // A parent directory of skill directories (the `.claude/skills` shape).
  const children = readdirSync(path, { withFileTypes: true })
    .filter((d) => isDir(join(path, d.name), d))
    .map((d) => join(path, d.name))
    .filter((dir) => existsSync(join(dir, SKILL_FILE)))
    .sort()
  if (children.length === 0) {
    throw new SkillError(`vernier.config \`skills\` entry \`${path}\` contains no ${SKILL_FILE} and no skill directories.`)
  }
  return children.map((dir) => readSkillDir(dir, "config"))
}

function isDir(path: string, entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return statSync(path).isDirectory() // follow the link, the .claude/skills convention allows them
  } catch {
    return false
  }
}

/**
 * Build the skill registry for one invocation. Explicit entries throw on
 * any problem (duplicates included); standard locations tolerate invalid
 * skills by recording them — doctor surfaces the reasons.
 */
export function discoverSkills(opts: SkillDiscoveryOpts): SkillRegistry {
  const skills = new Map<string, SkillRecord>()
  const invalid: InvalidSkill[] = []

  for (const entry of opts.explicit ?? []) {
    for (const record of readExplicit(entry)) {
      const existing = skills.get(record.name)
      if (existing) {
        throw new SkillError(
          `Duplicate skill \`${record.name}\` registered by both \`${existing.dir}\` and \`${record.dir}\`. Rename one of them.`,
        )
      }
      skills.set(record.name, record)
    }
  }

  const tiers: ReadonlyArray<{ root: string | undefined; origin: SkillOrigin }> = [
    { root: opts.projectRoot, origin: "project" },
    { root: opts.home, origin: "user" },
  ]
  for (const { root, origin } of tiers) {
    if (root === undefined) continue
    const dir = join(root, ".claude", "skills")
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = join(dir, entry.name)
      if (!isDir(candidate, entry) || !existsSync(join(candidate, SKILL_FILE))) continue
      try {
        const record = readSkillDir(candidate, origin)
        if (!skills.has(record.name)) skills.set(record.name, record) // earlier tier won the name
      } catch (error) {
        invalid.push({ path: candidate, origin, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  return { skills, invalid }
}

// --------------------------------------------------------------- resolution

/** One layer of skill bindings: stepId-or-executorId -> skill names. Same key vocabulary as executor bindings. */
export type SkillBindingLayer = ReadonlyMap<string, readonly string[]>

/**
 * The resolution chain for one step — the executor chain, verbatim: layers
 * ordered highest precedence first (CLI --skill > config skillBindings);
 * within a layer a stepId match beats an executorId (role) match; no match
 * falls through to the next layer and finally to the step's own declared
 * skills — the loop default. Keys speak the loop's DECLARED vocabulary
 * (bind skills before rebinding executors), exactly like --executor keys.
 */
export function resolveSkillNames(
  step: { readonly id: string; readonly executor: string; readonly skills?: readonly string[] },
  layers: readonly SkillBindingLayer[],
): readonly string[] {
  for (const layer of layers) {
    const bound = layer.get(step.id) ?? layer.get(step.executor)
    if (bound !== undefined) return bound
  }
  return step.skills ?? []
}

/**
 * Apply skill bindings to a Loop, returning a new Loop — the same pure
 * pre-run rewrite as bindExecutors: the kernel never sees bindings, a Loop
 * stays declarative data. Keys that match nothing are ignored here (config
 * skillBindings are global across loops); the CLI validates its own --skill
 * keys strictly.
 */
export function bindSkills(loop: Loop, layers: readonly SkillBindingLayer[]): Loop {
  if (layers.every((layer) => layer.size === 0)) return loop
  let changed = false
  const steps = loop.steps.map((step) => {
    const skills = resolveSkillNames(step, layers)
    const declared = step.skills ?? []
    if (skills.length === declared.length && skills.every((name, i) => declared[i] === name)) return step
    changed = true
    return { ...step, skills }
  })
  return changed ? { ...loop, steps } : loop
}

// ----------------------------------------------------------------- delivery

/**
 * Refuse a skill whose directory tree contains ANY symlink. A skill must be
 * a self-contained tree of regular files, for two reasons that both bite at
 * native-delivery copy time:
 *
 *   - Escape: a symlink out of the skill could pull an out-of-tree file (a
 *     secret, anything) into the plugin the provider loads with tool access.
 *   - Snapshot integrity: even an INTERNAL symlink defeats the byte-for-byte
 *     copy the native plugin promises. `cpSync` does not dereference links
 *     inside a recursive copy (Node 22: `dereference: true` is ignored for
 *     in-tree links, and a relative link is even rewritten to an ABSOLUTE
 *     path back at the original, mutable source) — so the copy would still
 *     follow the source, a TOCTOU window, not the recorded snapshot.
 *
 * Rejecting all symlinks INSIDE the tree closes both. The skill directory
 * ITSELF may be a symlink — the .claude/skills marketplace convention links
 * the dir to a cache — callers pass the resolved real path (and copy from
 * it). Spec-shaped skills (SKILL.md + scripts/ + references/ + assets/, all
 * regular files) pass untouched; across 800+ real installed skills surveyed,
 * none contained an internal symlink, so the ban has no observed false
 * positives. A skill that wants an alias ships a real file.
 */
export function assertSkillContained(dir: string, name: string): void {
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new SkillError(
          `skill \`${name}\` contains a symlink (\`${path}\`); a skill must be a self-contained tree of regular files — bundle a real file instead of a link.`,
        )
      }
      if (entry.isDirectory()) walk(path) // never recurse THROUGH a link: symlinked dirs are rejected above
    }
  }
  walk(dir)
}

/**
 * Materialize skills as byte-for-byte snapshots under `destDir/<name>` and
 * return them re-rooted at their snapshots. The ONE copy path both delivery
 * modes share: native plugin synthesis copies into the plugin's skills/,
 * prompt delivery copies under the run dir so the embedded body AND the
 * bundled files the fence's `dir` names come from the same immutable copy.
 * Each skill dir is realpath-resolved first (the dir itself may be a
 * marketplace symlink — cpSync handed a symlinked SOURCE copies a bare
 * link, not the tree) and EVERY skill is containment-checked before ANY is
 * copied, so a hostile skill never yields a partial snapshot.
 */
export function snapshotSkills(skills: readonly StepSkill[], destDir: string): StepSkill[] {
  const sources = skills.map((skill) => ({ skill, src: realpathSync(skill.dir) }))
  for (const { skill, src } of sources) assertSkillContained(src, skill.name)
  return sources.map(({ skill, src }) => {
    const dir = join(destDir, skill.name)
    cpSync(src, dir, { recursive: true })
    return { ...skill, dir, file: join(dir, SKILL_FILE) }
  })
}

/**
 * The synthesized plugin every native delivery uses (Claude Code:
 * `--plugin-dir`). Skills arrive namespaced as `${SKILLS_PLUGIN_NAME}:<name>`
 * in the provider session — the native directive tells the model so.
 */
export const SKILLS_PLUGIN_NAME = "vernier-skills"

export interface EmbeddedSkill extends StepSkill {
  /** The SKILL.md body (frontmatter stripped). */
  readonly body: string
}

const SKILLS_HEADING = "\n\n## Agent Skills\n\n"

/**
 * Prompt delivery: append each skill's SKILL.md body, delimited and
 * attributed. One-shot steps have no later activation moment, so the
 * pragmatic equivalent of progressive disclosure is the body in the turn
 * itself; the source dir is named so file references inside a skill
 * (scripts/, references/) stay resolvable where the provider can read it.
 * The <skill> fences are delimiters for clarity, not a security boundary.
 */
export function embedSkillsInPrompt(prompt: string, skills: readonly EmbeddedSkill[]): string {
  const sections = skills.map((skill) => `<skill name="${skill.name}" dir="${skill.dir}">\n${skill.body}\n</skill>`)
  return (
    prompt +
    SKILLS_HEADING +
    "Apply the following Agent Skill(s) to this step. Each is reproduced verbatim from its SKILL.md " +
    "(Agent Skills format, agentskills.io); paths inside a skill are relative to its `dir`.\n\n" +
    sections.join("\n\n")
  )
}

/**
 * Native delivery's prompt directive: the skills are loaded provider-side
 * (progressive disclosure intact), so the prompt only DICTATES their use —
 * that dictation, not mere availability, is what `Step.skills` means.
 */
export function nativeSkillsDirective(skills: readonly StepSkill[]): string {
  const lines = skills.map((skill) => `- \`${skill.name}\` — ${skill.description} (invoke: /${SKILLS_PLUGIN_NAME}:${skill.name})`)
  return (
    SKILLS_HEADING +
    `Use the following Agent Skill(s) for this step. They are loaded in this session via the \`${SKILLS_PLUGIN_NAME}\` plugin:\n` +
    lines.join("\n")
  )
}

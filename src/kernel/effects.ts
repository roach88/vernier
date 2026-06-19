// Effect observation: "what changed, and was it allowed."
// Ported from the Python predecessor's GitSnapshotter (adapters/git_snapshot.py) and the
// change-attribution semantics of assess_worker_state. omegacode's
// worktree.ts only answers "did anything change?" — this attributes.

import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { EffectScope, OutputProjection } from "./types.js"

// Skip only structural directories that cannot be meaningful step output.
// Generated/cache directories such as .next, .turbo, .cache, and coverage
// remain observable: hiding them would let a step mutate the workdir without
// an effects entry, which is worse than the hashing cost for the default
// correctness-first observer.
const SKIP_DIRS = new Set([".git", "node_modules", ".vernier"])

/** Map of workdir-relative posix path -> sha256 of contents. */
export type Snapshot = ReadonlyMap<string, string>

export function snapshotDir(root: string): Snapshot {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        const rel = relative(root, full).split("\\").join("/")
        out.set(rel, createHash("sha256").update(readFileSync(full)).digest("hex"))
      }
    }
  }
  walk(root)
  return out
}

export function changedFiles(before: Snapshot, after: Snapshot): string[] {
  const changed = new Set<string>()
  for (const [path, digest] of after) if (before.get(path) !== digest) changed.add(path)
  for (const path of before.keys()) if (!after.has(path)) changed.add(path)
  return [...changed].sort()
}

/** Exact path, or `dir/**` prefix. Deliberately tiny; grow only when a third loop needs more. */
export function isAllowed(path: string, scope: EffectScope): boolean {
  return scope.allow.some((pattern) => pathMatchesPattern(pattern, path))
}

export interface EffectObservation {
  readonly changed: readonly string[]
  readonly allowed: boolean
  readonly unexpected: readonly string[]
  /** False only when a crash made post-step effect observation unknowable. Missing means observed=true for old journals. */
  readonly observed?: boolean
  readonly reason?: string
}

export function assessChanges(before: Snapshot, after: Snapshot, scope: EffectScope): EffectObservation {
  const changed = changedFiles(before, after)
  const unexpected = changed.filter((path) => !isAllowed(path, scope))
  return { changed, allowed: unexpected.length === 0, unexpected }
}

/**
 * OutputProjection: derive path-valued output field(s) from effect
 * attribution. The observer already knows, deterministically, which files
 * the step changed — so the artifact paths are taken from the diff, not
 * from a model self-report (which would cost a second structured-output
 * turn). Candidates are the changed-and-allowed files, optionally filtered
 * by an exact path or `dir/**`; exactly one match projects a string field.
 * Zero or several matches project no field, so signature/contract
 * validation fails deterministically and the policy decides.
 */
export function artifactFromEffects(field: string, pattern?: string): OutputProjection {
  if (pattern !== undefined) assertArtifactPattern(pattern)
  return (_result, effects) => {
    const candidates = effects.changed.filter(
      (path) => !effects.unexpected.includes(path) && (pattern === undefined || artifactPatternMatch(pattern, path)),
    )
    return candidates.length === 1 ? { [field]: candidates[0] } : {}
  }
}

function assertArtifactPattern(pattern: string): void {
  if (pattern.endsWith("/**")) return
  if (!pattern.includes("*")) return
  throw new Error(`artifactFromEffects supports exact paths or dir/** only, got \`${pattern}\`.`)
}

function artifactPatternMatch(pattern: string, path: string): boolean {
  return pathMatchesPattern(pattern, path)
}

function pathMatchesPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3)
    return path.startsWith(prefix + "/")
  }
  return path === pattern
}

// ----------------------------------------------------------------- Observer

/**
 * The pluggable observation seam: snapshot before a step, attribute changes
 * after it. The hash observer below walks and hashes every file (fine for
 * small clean workdirs like Pilot 0's); git-effects.ts is the git-aware
 * observer for real-edit loops (respects .gitignore, uses git plumbing).
 */
export interface EffectsObserver {
  snapshot(workdir: string): Promise<unknown>
  assess(workdir: string, before: unknown, scope: EffectScope): Promise<EffectObservation>
}

/** The Step-1 observer: hash-all-files. Default for loops without a git workdir. */
export const hashObserver: EffectsObserver = {
  async snapshot(workdir) {
    return snapshotDir(workdir)
  },
  async assess(workdir, before, scope) {
    return assessChanges(before as Snapshot, snapshotDir(workdir), scope)
  },
}

// Effect observation: "what changed, and was it allowed."
// Ported from the Python predecessor's GitSnapshotter (adapters/git_snapshot.py) and the
// change-attribution semantics of assess_worker_state. omegacode's
// worktree.ts only answers "did anything change?" — this attributes.

import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { EffectScope, OutputProjection } from "./types.js"

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
  return scope.allow.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3)
      return path === prefix || path.startsWith(prefix + "/")
    }
    return path === pattern
  })
}

export interface EffectObservation {
  readonly changed: readonly string[]
  readonly allowed: boolean
  readonly unexpected: readonly string[]
}

export function assessChanges(before: Snapshot, after: Snapshot, scope: EffectScope): EffectObservation {
  const changed = changedFiles(before, after)
  const unexpected = changed.filter((path) => !isAllowed(path, scope))
  return { changed, allowed: unexpected.length === 0, unexpected }
}

/**
 * Tiny glob for artifact filtering: `*` matches within a path segment,
 * `**` across segments (`docs/**` matches everything under docs;
 * `notes/**\/*.md` matches .md files at any depth under notes, including
 * `notes/a.md`). Deliberately small — not a full glob engine.
 */
export function globMatch(pattern: string, path: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001") // `**/` = zero or more whole segments
    .replace(/\*\*/g, "\u0002") // `**`  = anything, across segments
    .replace(/\*/g, "[^/]*") // `*`   = anything within a segment
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0002/g, ".*")
  return new RegExp(`^${regex}$`).test(path)
}

export interface ArtifactProjectionOpts {
  /** Glob filtering which changed-and-allowed files count as the artifact (e.g. `docs/**\/*.md`). Default: all of them. */
  readonly pattern?: string
  /**
   * "one" (default): exactly one matching file -> a string field; zero or
   * several -> no field, so signature/contract validation fails
   * deterministically and the policy decides (retry/escalate).
   * "many": one or more matching files -> a sorted string[] field; zero ->
   * no field (the same deterministic failure path).
   */
  readonly arity?: "one" | "many"
}

/**
 * OutputProjection: derive path-valued output field(s) from effect
 * attribution. The observer already knows, deterministically, which files
 * the step changed — so the artifact paths are taken from the diff, not
 * from a model self-report (which would cost a second structured-output
 * turn). Candidates are the changed-and-allowed files, optionally filtered
 * by `pattern`; `arity` decides whether the field is one path or all of
 * them (see ArtifactProjectionOpts for the exact zero/one/many semantics).
 */
export function artifactsFromEffects(field: string, opts: ArtifactProjectionOpts = {}): OutputProjection {
  const { pattern, arity = "one" } = opts
  return (_result, effects) => {
    const candidates = effects.changed.filter(
      (path) => !effects.unexpected.includes(path) && (pattern === undefined || globMatch(pattern, path)),
    )
    if (arity === "many") return candidates.length > 0 ? { [field]: [...candidates].sort() } : {}
    return candidates.length === 1 ? { [field]: candidates[0] } : {}
  }
}

/** The exactly-one form (Pilot 1's contract pins one note file). `pattern` narrows which changed files count. */
export function artifactFromEffects(field: string, pattern?: string): OutputProjection {
  return artifactsFromEffects(field, pattern === undefined ? {} : { pattern })
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

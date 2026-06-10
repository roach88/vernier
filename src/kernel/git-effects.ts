// Git-aware effect observation, ported from the Python looper's
// GitSnapshotter (agent_workflows/adapters/git_snapshot.py) and the
// worker-change-attribution semantics of RunLoop.assess_worker_state:
// snapshot before, run the step, diff after, attribute the changed files,
// and check them against the Step's EffectScope — "what changed AND was
// it allowed". This replaces the hash-all-files observer for real-edit
// loops: instead of re-hashing the world it asks git, via a throwaway
// index, for the working tree's tree hash (so .gitignore is honored and
// the diff is git's own attribution, not ours).
//
// The Python GitSnapshotter additionally excluded runner-managed files
// (codex-events.jsonl etc.) from worker attribution by name. Here that
// exclusion is structural: executors write runner-managed evidence to
// StepSpec.runDir, which lives under the ledger root OUTSIDE the workdir,
// so every change inside the workdir is worker-attributed by construction.

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAllowed, type EffectsObserver } from "./effects.js"

function git(workdir: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: workdir,
    encoding: "utf8",
    env: env ?? process.env,
    timeout: 30_000,
  }).trim()
}

/**
 * Hash the working tree as a git tree object via a throwaway index:
 * `git add -A` stages everything tracked-or-untracked (minus .gitignore)
 * into GIT_INDEX_FILE, `git write-tree` returns one content hash for the
 * whole tree. Objects land in .git/objects (cheap, content-addressed);
 * the real index is never touched.
 */
export function gitTreeSnapshot(workdir: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "looper-git-index-"))
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") }
  try {
    git(workdir, ["add", "-A"], env)
    return git(workdir, ["write-tree"], env)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Changed paths between two tree hashes (adds, edits, deletes; rename = delete+add). */
export function gitChangedFiles(workdir: string, beforeTree: string, afterTree: string): string[] {
  if (beforeTree === afterTree) return []
  const out = git(workdir, ["diff-tree", "-r", "--name-only", "--no-renames", beforeTree, afterTree])
  return out.split("\n").filter(Boolean).sort()
}

/** `git status --short`, for trace evidence (port of GitSnapshotter.status). */
export function gitStatus(workdir: string): string {
  return git(workdir, ["status", "--short"])
}

/** The git-aware observer for loops whose workdir is a git repository. */
export const gitObserver: EffectsObserver = {
  async snapshot(workdir) {
    return gitTreeSnapshot(workdir)
  },
  async assess(workdir, before, scope) {
    const changed = gitChangedFiles(workdir, String(before), gitTreeSnapshot(workdir))
    const unexpected = changed.filter((path) => !isAllowed(path, scope))
    return { changed, allowed: unexpected.length === 0, unexpected }
  },
}

// The git-aware effects observer against a real git repo in a temp dir:
// snapshot -> change -> assess attributes adds/edits/deletes, checks them
// against the EffectScope, and catches ignored-file writes without touching
// the real index.

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { gitObserver, gitStatus, gitTreeSnapshot } from "../src/kernel/git-effects.js"
import { fsScope } from "../src/kernel/types.js"

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vernier-git-"))
  execFileSync("git", ["init", "--quiet"], { cwd: dir })
  mkdirSync(join(dir, "docs", "agent-workflows"), { recursive: true })
  writeFileSync(join(dir, "README.md"), "scratch\n")
  return dir
}

describe("git-aware effects observer", () => {
  it("sees no changes when nothing changed", async () => {
    const dir = gitRepo()
    const before = await gitObserver.snapshot(dir)
    const obs = await gitObserver.assess(dir, before, fsScope("docs/**"))
    expect(obs.changed).toEqual([])
    expect(obs.allowed).toBe(true)
  })

  it("attributes adds, edits, and deletes between snapshots", async () => {
    const dir = gitRepo()
    writeFileSync(join(dir, "docs", "agent-workflows", "old.md"), "old\n")
    const before = await gitObserver.snapshot(dir)

    writeFileSync(join(dir, "docs", "agent-workflows", "new.md"), "new\n") // add
    writeFileSync(join(dir, "README.md"), "edited\n") // edit
    rmSync(join(dir, "docs", "agent-workflows", "old.md")) // delete

    const obs = await gitObserver.assess(dir, before, fsScope("docs/agent-workflows/**"))
    expect(obs.changed).toEqual(["README.md", "docs/agent-workflows/new.md", "docs/agent-workflows/old.md"])
    expect(obs.allowed).toBe(false)
    expect(obs.unexpected).toEqual(["README.md"]) // the edit escaped the scope
  })

  it("passes when every change stays inside the scope ('what changed AND was it allowed')", async () => {
    const dir = gitRepo()
    const before = await gitObserver.snapshot(dir)
    writeFileSync(join(dir, "docs", "agent-workflows", "note.md"), "fine\n")
    const obs = await gitObserver.assess(dir, before, fsScope("docs/agent-workflows/**"))
    expect(obs.changed).toEqual(["docs/agent-workflows/note.md"])
    expect(obs.allowed).toBe(true)
    expect(obs.unexpected).toEqual([])
  })

  it("attributes ignored file changes while still skipping heavy internal dirs", async () => {
    const dir = gitRepo()
    writeFileSync(join(dir, ".gitignore"), "*.log\nnode_modules/\n")
    const before = await gitObserver.snapshot(dir)
    writeFileSync(join(dir, "debug.log"), "noise\n")
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true })
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "noise\n")
    const obs = await gitObserver.assess(dir, before, fsScope())
    expect(obs.changed).toEqual(["debug.log"])
    expect(obs.allowed).toBe(false)
    expect(obs.unexpected).toEqual(["debug.log"])
  })

  it("never touches the real index (the throwaway-GIT_INDEX_FILE invariant)", async () => {
    const dir = gitRepo()
    gitTreeSnapshot(dir)
    // Nothing staged: git status still shows README.md as untracked, not added.
    expect(gitStatus(dir)).toContain("?? README.md")
  })
})

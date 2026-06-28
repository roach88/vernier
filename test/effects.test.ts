import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { assessChanges, snapshotDir } from "../src/kernel/effects.js"
import { fsScope } from "../src/kernel/types.js"

function temp(): string {
  return mkdtempSync(join(tmpdir(), "vernier-effects-"))
}

describe("snapshotDir", () => {
  it("records symlink topology changes", () => {
    const root = temp()
    writeFileSync(join(root, "a.txt"), "a", "utf8")
    writeFileSync(join(root, "b.txt"), "b", "utf8")
    symlinkSync("a.txt", join(root, "link.txt"))
    const before = snapshotDir(root)

    symlinkSync("b.txt", join(root, "next-link.txt"))
    const afterCreate = snapshotDir(root)
    expect(assessChanges(before, afterCreate, fsScope("link.txt", "next-link.txt")).changed).toContain("next-link.txt")
  })

  it("records writes through in-workdir symlinks", () => {
    const root = temp()
    const outside = join(root, "..", "outside.txt")
    writeFileSync(outside, "before", "utf8")
    symlinkSync(outside, join(root, "linked.txt"))
    const before = snapshotDir(root)

    writeFileSync(join(root, "linked.txt"), "after", "utf8")
    const observation = assessChanges(before, snapshotDir(root), fsScope("linked.txt"))

    expect(observation.changed).toEqual(["linked.txt"])
    expect(observation.allowed).toBe(true)
  })

  it("records writes through directory symlinks", () => {
    const root = temp()
    const outsideDir = mkdtempSync(join(tmpdir(), "vernier-outside-dir-"))
    writeFileSync(join(outsideDir, "note.txt"), "before", "utf8")
    symlinkSync(outsideDir, join(root, "linked-dir"))
    const before = snapshotDir(root)

    writeFileSync(join(root, "linked-dir", "note.txt"), "after", "utf8")
    const observation = assessChanges(before, snapshotDir(root), fsScope("linked-dir"))

    expect(observation.changed).toEqual(["linked-dir"])
  })

  it("flags symlink write-through outside declared scope", () => {
    const root = temp()
    mkdirSync(join(root, "allowed"))
    const outside = join(root, "..", "outside.txt")
    writeFileSync(outside, "before", "utf8")
    symlinkSync(outside, join(root, "linked.txt"))
    const before = snapshotDir(root)

    writeFileSync(join(root, "linked.txt"), "after", "utf8")
    const observation = assessChanges(before, snapshotDir(root), fsScope("allowed/**"))

    expect(observation.allowed).toBe(false)
    expect(observation.unexpected).toEqual(["linked.txt"])
  })
})

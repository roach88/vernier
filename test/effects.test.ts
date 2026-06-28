import { mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
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

  it("records writes through file symlinks without reading unrelated paths", () => {
    const root = temp()
    const outside = join(root, "..", "outside.txt")
    writeFileSync(outside, "before", "utf8")
    symlinkSync(outside, join(root, "linked.txt"))
    const before = snapshotDir(root)
    const { atime, mtime } = statSync(outside)

    writeFileSync(join(root, "linked.txt"), "change", "utf8")
    utimesSync(outside, atime, mtime)
    const observation = assessChanges(before, snapshotDir(root), fsScope("linked.txt"))

    expect(observation.changed).toEqual(["linked.txt"])
    expect(observation.allowed).toBe(true)
  })

  it("does not recurse through outside directory symlink targets", () => {
    const root = temp()
    const outsideDir = mkdtempSync(join(tmpdir(), "vernier-outside-dir-"))
    writeFileSync(join(outsideDir, "note.txt"), "before", "utf8")
    symlinkSync(outsideDir, join(root, "linked-dir"))
    const before = snapshotDir(root)

    writeFileSync(join(root, "linked-dir", "note.txt"), "after", "utf8")
    const observation = assessChanges(before, snapshotDir(root), fsScope("linked-dir"))

    expect(observation.changed).toEqual([])
  })

  it("recurses through contained directory symlink targets with portable POSIX names", () => {
    for (const targetName of ["cache:1", "..data"]) {
      const root = temp()
      const target = join(root, targetName)
      mkdirSync(target)
      writeFileSync(join(target, "note.txt"), "before", "utf8")
      symlinkSync(targetName, join(root, "linked-dir"))
      const before = snapshotDir(root)

      writeFileSync(join(root, "linked-dir", "note.txt"), "change", "utf8")
      const after = snapshotDir(root)

      expect(after.get("linked-dir")).not.toBe(before.get("linked-dir"))
    }
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

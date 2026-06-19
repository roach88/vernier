import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { hashObserver } from "../src/kernel/effects.js"
import { fsScope } from "../src/kernel/types.js"

describe("hash effects observer", () => {
  it("attributes generated/cache directory writes instead of hiding them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vernier-effects-"))
    const before = await hashObserver.snapshot(dir)

    mkdirSync(join(dir, ".next", "cache"), { recursive: true })
    writeFileSync(join(dir, ".next", "cache", "bundle.js"), "generated\n")

    const obs = await hashObserver.assess(dir, before, fsScope())
    expect(obs.changed).toEqual([".next/cache/bundle.js"])
    expect(obs.allowed).toBe(false)
    expect(obs.unexpected).toEqual([".next/cache/bundle.js"])
  })

  it("attributes a write through an in-scope symlink to an outside target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vernier-effects-"))
    const outside = mkdtempSync(join(tmpdir(), "vernier-effects-outside-"))
    const target = join(outside, "target.txt")
    writeFileSync(target, "before\n")
    symlinkSync(target, join(dir, "linked.txt"))
    const before = await hashObserver.snapshot(dir)

    writeFileSync(join(dir, "linked.txt"), "after\n")

    const obs = await hashObserver.assess(dir, before, fsScope())
    expect(obs.changed).toEqual(["linked.txt"])
    expect(obs.allowed).toBe(false)
    expect(obs.unexpected).toEqual(["linked.txt"])
  })

  it("attributes symlink topology changes instead of silently treating them as clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vernier-effects-"))
    const outside = mkdtempSync(join(tmpdir(), "vernier-effects-outside-"))
    const target = join(outside, "target.txt")
    writeFileSync(target, "target\n")
    const before = await hashObserver.snapshot(dir)

    symlinkSync(target, join(dir, "linked.txt"))

    const obs = await hashObserver.assess(dir, before, fsScope())
    expect(obs.changed).toEqual(["linked.txt"])
    expect(obs.allowed).toBe(false)
    expect(obs.unexpected).toEqual(["linked.txt"])
  })

  it("matches exact paths and dir/** prefixes without overmatching sibling prefixes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vernier-effects-"))
    const before = await hashObserver.snapshot(dir)

    mkdirSync(join(dir, "dir2"), { recursive: true })
    writeFileSync(join(dir, "dir2", "escape.txt"), "escape\n")
    mkdirSync(join(dir, "dir"), { recursive: true })
    writeFileSync(join(dir, "dir", "allowed.txt"), "allowed\n")

    const obs = await hashObserver.assess(dir, before, fsScope("dir/**"))
    expect(obs.changed).toEqual(["dir/allowed.txt", "dir2/escape.txt"])
    expect(obs.allowed).toBe(false)
    expect(obs.unexpected).toEqual(["dir2/escape.txt"])
  })
})

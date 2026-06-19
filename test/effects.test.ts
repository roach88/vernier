import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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
})

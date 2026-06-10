// The memory store (append-only, topic-queryable rules.jsonl) and the
// recall/remember executors (Ax's memory primitives as deterministic store
// ops behind the Executor seam).

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { recallExecutor, rememberExecutor } from "../src/executors/memory.js"
import { noEffects, type RunContext, type StepSpec } from "../src/kernel/types.js"
import { Memory, resolveMemoryRoot, rulesPath, topicTokens } from "../src/memory/memory.js"

function freshStore(): Memory {
  return new Memory(rulesPath(mkdtempSync(join(tmpdir(), "looper-memory-"))))
}

const record = (rule: string, topic: string) => ({
  rule,
  evidence: `evidence for: ${rule}`,
  topic,
  sourceRunId: "run-001",
  loopId: "compounding-answer",
})

describe("memory store", () => {
  it("appends rules and recalls them by topic keyword overlap", () => {
    const memory = freshStore()
    memory.remember(record("End with a question.", "write short note apollo mission"))
    const rules = memory.recall("write short note hubble telescope")
    expect(rules.map((r) => r.rule)).toEqual(["End with a question."]) // "write"/"short"/"note" overlap
    expect(rules[0]).toMatchObject({ sourceRunId: "run-001", loopId: "compounding-answer" })
  })

  it("isolates topics: recall on an unrelated topic returns nothing", () => {
    const memory = freshStore()
    memory.remember(record("Use SI units.", "physics homework conversions"))
    memory.remember(record("Cite a primary source.", "history essay citations"))
    expect(memory.recall("physics units").map((r) => r.rule)).toEqual(["Use SI units."])
    expect(memory.recall("gardening tomatoes").map((r) => r.rule)).toEqual([])
  })

  it("persists across two loads of the same root — the file is the store", () => {
    const root = mkdtempSync(join(tmpdir(), "looper-memory-"))
    new Memory(rulesPath(root)).remember(record("Always name the year.", "apollo mission note"))
    const reopened = new Memory(rulesPath(root)) // a second process / a later run
    expect(reopened.recall("apollo note").map((r) => r.rule)).toEqual(["Always name the year."])
  })

  it("is append-only with content-derived ids: re-remembering the same rule keeps one identity", () => {
    const memory = freshStore()
    const first = memory.remember(record("Be concise.", "shared topic words"))
    const second = memory.remember(record("Be concise.", "shared topic words"))
    expect(second.id).toBe(first.id)
    // Two appended lines (nothing is ever rewritten)…
    expect(readFileSync(memory.path, "utf8").trim().split("\n")).toHaveLength(2)
    // …but recall dedupes by id, last record wins.
    expect(memory.recall("shared topic")).toHaveLength(1)
  })

  it("refuses an empty rule — the store holds rules, not blanks", () => {
    expect(() => freshStore().remember(record("   ", "some topic words"))).toThrow(/empty rule/)
  })

  it("resolves the root like the ledger does (explicit root wins)", () => {
    expect(resolveMemoryRoot({ root: "/x" })).toBe("/x")
    expect(rulesPath("/x")).toBe("/x/memory/rules.jsonl")
  })

  it("tokenizes topics into >=4-char keywords — retrieval is keyword overlap, not semantics", () => {
    expect(topicTokens("Why the Apollo 11 mission mattered!")).toEqual(new Set(["apollo", "mission", "mattered"]))
  })
})

// --------------------------------------------------- recall/remember executors

function spec(stepId: string, inputs: Record<string, unknown>): StepSpec {
  return {
    runId: "run-xyz",
    traceId: "run-xyz",
    loopId: "compounding-answer",
    loopVersion: "0.1.0",
    stepId,
    attempt: 1,
    iteration: 1,
    inputs,
    effects: noEffects(),
    runDir: mkdtempSync(join(tmpdir(), "looper-rundir-")),
    timeoutMs: 1_000,
  }
}

describe("recall/remember executors", () => {
  it("conform to the Executor seam: remember writes, recall reads it back, both deterministic", async () => {
    const memory = freshStore()
    const ctx: RunContext = { workdir: "/tmp", memory }

    const stored = await rememberExecutor.run(
      spec("remember", { rule: "End with the exact closing sentence.", evidence: "the verified answer", topic: "short note closing" }),
      ctx,
    )
    expect(stored.status).toBe("completed")
    expect(stored.output.stored).toBe(true)
    expect(typeof stored.output.id).toBe("string")
    expect(stored.usage.costUsd).toBe(0) // a store write is not an LLM turn

    const recalled = await recallExecutor.run(spec("recall", { topic: "another short note" }), ctx)
    expect(recalled.status).toBe("completed")
    expect(recalled.output.rules).toEqual(["End with the exact closing sentence."])
    // Provenance landed on the record: the run that learned it is named.
    expect(memory.recall("short note")[0]).toMatchObject({ sourceRunId: "run-xyz", loopId: "compounding-answer" })
  })

  it("fails loudly without an injected memory store — the handle is required, not optional magic", async () => {
    const ctx: RunContext = { workdir: "/tmp" }
    await expect(recallExecutor.run(spec("recall", { topic: "x" }), ctx)).rejects.toThrow(/without a memory store/)
    await expect(rememberExecutor.run(spec("remember", { rule: "r", evidence: "e", topic: "t" }), ctx)).rejects.toThrow(
      /without a memory store/,
    )
  })
})

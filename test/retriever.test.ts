// The pluggable Retriever seam on Memory, with the one built-in tier:
// lexical BM25. Vectors stay out until measured recall quality justifies
// adding them back.

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { recallExecutor } from "../src/executors/memory.js"
import { noEffects, type RuleRecord, type StepSpec } from "../src/kernel/types.js"
import { Memory, rulesPath } from "../src/memory/memory.js"
import { lexicalRetriever } from "../src/memory/retriever.js"

let seq = 0
const record = (rule: string, topic: string, over: Partial<RuleRecord> = {}): RuleRecord => ({
  id: `rule-${++seq}`,
  rule,
  evidence: `evidence for: ${rule}`,
  topic,
  sourceRunId: "run-001",
  loopId: "compounding-answer",
  at: "2026-06-11T00:00:00.000Z",
  ...over,
})

// ----------------------------------------------------------- lexical (BM25)

describe("lexical retriever (BM25, the default)", () => {
  it("RANKS: the on-topic rule outranks a partially-related one; the unrelated one is not recalled", () => {
    const related = record("Cite a primary source.", "write history essay sources")
    const offTopic = record("Use SI units.", "physics homework conversions")
    const onTopic = record("End with a question.", "write short note apollo mission")
    // Store order deliberately puts the weakest match first: the output
    // order below can only come from scoring, not from insertion order.
    const ranked = lexicalRetriever().retrieve("write a short note about the apollo program", [related, offTopic, onTopic])
    expect(ranked.map((r) => r.rule)).toEqual(["End with a question.", "Cite a primary source."])
  })

  it("never filters a tiny store to nothing: a 1-rule store still recalls on a related goal", () => {
    const only = record("Always name the year.", "apollo mission note")
    expect(lexicalRetriever().retrieve("a note about hubble", [only])).toEqual([only]) // "note" overlaps
  })

  it("matches query terms in the rule/evidence text, not only the topic", () => {
    const r = record("Spell out the year 1969 explicitly.", "formatting requirements")
    expect(lexicalRetriever().retrieve("which year should the note name", [r])).toEqual([r])
  })

  it("empty store and token-free topics recall nothing", () => {
    expect(lexicalRetriever().retrieve("write a short note", [])).toEqual([])
    expect(lexicalRetriever().retrieve("a an of it", [record("Rule.", "some topic words")])).toEqual([])
  })
})

// --------------------------------------------- the seam end-to-end + config

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
    runDir: mkdtempSync(join(tmpdir(), "vernier-rundir-")),
    timeoutMs: 1_000,
  }
}

describe("the seam, end-to-end", () => {
  it("the recall executor returns lexical-ranked rules — the loop never changes shape", async () => {
    const memory = new Memory(rulesPath(mkdtempSync(join(tmpdir(), "vernier-lexical-e2e-"))))
    await memory.remember({
      rule: "Keep it short.",
      evidence: "e",
      topic: "style guidance",
      sourceRunId: "r",
      loopId: "l",
    })
    await memory.remember({
      rule: "Prefer concrete dates.",
      evidence: "e",
      topic: "apollo history notes",
      sourceRunId: "r",
      loopId: "l",
    })

    const result = await recallExecutor.run(spec("recall", { topic: "apollo program history" }), { workdir: "/tmp", memory })
    expect(result.status).toBe("completed")
    expect(result.output.rules).toEqual(["Prefer concrete dates."])
    expect(result.usage.costUsd).toBe(0) // still a deterministic store read, not an LLM turn
  })

  it("custom retrievers are injected through the Memory constructor", async () => {
    const retrieved: RuleRecord[] = []
    const memory = new Memory(rulesPath(mkdtempSync(join(tmpdir(), "vernier-custom-retriever-"))), {
      id: "custom",
      retrieve: (_topic, records) => {
        retrieved.push(...records)
        return []
      },
    })
    await memory.remember({
      rule: "Keep it direct.",
      evidence: "e",
      topic: "style guidance",
      sourceRunId: "r",
      loopId: "l",
    })
    expect(await memory.recall("style")).toEqual([])
    expect(retrieved.map((r) => r.rule)).toEqual(["Keep it direct."])
  })
})

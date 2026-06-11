// The pluggable Retriever seam, both shipped tiers, deterministic and
// auth-free:
//   - lexical (BM25, the default): RANKED results (not unordered matches),
//     graceful on tiny stores, the same shares-a-token relevance gate as
//     the original keyword overlap;
//   - embedding (optional dep): cosine ranking over remember-time vectors,
//     the versioned on-record storage format, lexical fallback for records
//     without comparable embeddings, and the actionable missing-dep error —
//     all proven through an INJECTED embedder/loader, exactly the
//     claude-executor sdk-missing seam. The real package is never imported
//     here; its gated live proof is retriever.live.test.ts.

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { recallExecutor } from "../src/executors/memory.js"
import { noEffects, type RuleEmbedding, type RuleRecord, type StepSpec } from "../src/kernel/types.js"
import { EMBEDDING_PACKAGE, EmbeddingRetriever, cosineSimilarity, embeddingText, type Embedder } from "../src/memory/embedding.js"
import { Memory, retrieverFromEnv, rulesPath } from "../src/memory/memory.js"
import { lexicalRetriever } from "../src/memory/retriever.js"

const FAKE_MODEL = "fake:test-model-v1"

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

const emb = (vector: readonly number[]): RuleEmbedding => ({ v: 1, model: FAKE_MODEL, vector })

/** Deterministic embedder: a fixed text -> vector table; unknown text is a test bug. */
function fakeEmbedder(table: Record<string, readonly number[]>): Embedder {
  return {
    id: FAKE_MODEL,
    async embed(texts) {
      return texts.map((t) => {
        const vector = table[t]
        if (vector === undefined) throw new Error(`fake embedder has no vector for: ${JSON.stringify(t)}`)
        return vector
      })
    },
  }
}

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

  it("matches query terms in the rule/evidence text, not only the topic (the old overlap missed these)", () => {
    const r = record("Spell out the year 1969 explicitly.", "formatting requirements")
    expect(lexicalRetriever().retrieve("which year should the note name", [r])).toEqual([r])
  })

  it("empty store and token-free topics recall nothing", () => {
    expect(lexicalRetriever().retrieve("write a short note", [])).toEqual([])
    expect(lexicalRetriever().retrieve("a an of it", [record("Rule.", "some topic words")])).toEqual([])
  })
})

// ------------------------------------------------------------ embedding tier

describe("embedding retriever (injected embedder — the optional package is never imported)", () => {
  it("cosine-ranks comparable records best-first", async () => {
    const a = record("rule a", "topic a", { embedding: emb([1, 0]) })
    const b = record("rule b", "topic b", { embedding: emb([0.6, 0.8]) })
    const c = record("rule c", "topic c", { embedding: emb([0, 1]) })
    const retriever = new EmbeddingRetriever({ embedder: fakeEmbedder({ "the query": [1, 0] }) })
    const ranked = await retriever.retrieve("the query", [c, b, a])
    expect(ranked.map((r) => r.rule)).toEqual(["rule a", "rule b", "rule c"]) // 1.0, 0.6, 0.0
  })

  it("honors minSimilarity and topK once the store is big enough to filter", async () => {
    const a = record("rule a", "topic a", { embedding: emb([1, 0]) })
    const b = record("rule b", "topic b", { embedding: emb([0.6, 0.8]) })
    const c = record("rule c", "topic c", { embedding: emb([0, 1]) })
    const embedder = fakeEmbedder({ "the query": [1, 0] })
    const filtered = await new EmbeddingRetriever({ embedder, minSimilarity: 0.5 }).retrieve("the query", [a, b, c])
    expect(filtered.map((r) => r.rule)).toEqual(["rule a", "rule b"])
    const capped = await new EmbeddingRetriever({ embedder, topK: 1 }).retrieve("the query", [a, b, c])
    expect(capped.map((r) => r.rule)).toEqual(["rule a"])
  })

  it("computes the embedding at REMEMBER time and stores it on the JSONL record, versioned", async () => {
    const topic = "write short note apollo"
    const rule = "Always name the year."
    const embedder = fakeEmbedder({ [embeddingText({ topic, rule })]: [0.1, 0.2] })
    const memory = new Memory(rulesPath(mkdtempSync(join(tmpdir(), "looper-embed-"))), new EmbeddingRetriever({ embedder }))
    const stored = await memory.remember({ rule, evidence: "the verified answer", topic, sourceRunId: "r1", loopId: "l1" })
    expect(stored.embedding).toEqual({ v: 1, model: FAKE_MODEL, vector: [0.1, 0.2] })
    // The persisted line carries the same versioned embedding — the store
    // format IS the JSONL record, nothing lives beside it.
    const line = JSON.parse(readFileSync(memory.path, "utf8").trim()) as RuleRecord
    expect(line.embedding).toEqual({ v: 1, model: FAKE_MODEL, vector: [0.1, 0.2] })
  })

  it("keeps records WITHOUT a comparable embedding retrievable via the lexical tier (never a hard cutover)", async () => {
    const embedded = record("rule e", "write short note apollo", { embedding: emb([1, 0]) })
    const legacy = record("Always name the year.", "write short note hubble") // a pre-embedding store's record
    const foreign = record("Prefer primary sources.", "write short note sources", {
      embedding: { v: 1, model: "other:model-v9", vector: [9, 9] }, // another model's space: never compared
    })
    const retriever = new EmbeddingRetriever({ embedder: fakeEmbedder({ "write short note venus": [1, 0] }) })
    const ranked = await retriever.retrieve("write short note venus", [legacy, embedded, foreign])
    // Cosine tier first, lexical fallback after (scores across tiers are not comparable).
    expect(ranked[0]).toEqual(embedded)
    expect(ranked).toHaveLength(3)
    expect(ranked.slice(1)).toEqual(expect.arrayContaining([legacy, foreign]))
  })

  it("a store with no embeddings at all never loads the embedder — pure lexical fallback", async () => {
    let loads = 0
    const retriever = new EmbeddingRetriever({
      loadEmbedder: async () => {
        loads += 1
        return fakeEmbedder({})
      },
    })
    const legacy = record("Always name the year.", "apollo mission note")
    expect(await retriever.retrieve("a note about hubble", [legacy])).toEqual([legacy])
    expect(loads).toBe(0)
  })

  it("fails actionably when the optional embedding package is missing (recall and remember)", async () => {
    const missing = Object.assign(new Error(`Cannot find package '${EMBEDDING_PACKAGE}' imported from looper`), {
      code: "ERR_MODULE_NOT_FOUND",
    })
    const retriever = new EmbeddingRetriever({ loadEmbedder: () => Promise.reject(missing) })
    const embedded = record("rule e", "topic e", { embedding: emb([1, 0]) })
    await expect(retriever.retrieve("some topic", [embedded])).rejects.toThrow(`npm install ${EMBEDDING_PACKAGE}`)
    await expect(retriever.retrieve("some topic", [embedded])).rejects.toThrow(/looper doctor/)

    const memory = new Memory(
      rulesPath(mkdtempSync(join(tmpdir(), "looper-embed-missing-"))),
      new EmbeddingRetriever({ loadEmbedder: () => Promise.reject(missing) }),
    )
    await expect(
      memory.remember({ rule: "Rule.", evidence: "e", topic: "some topic", sourceRunId: "r", loopId: "l" }),
    ).rejects.toThrow(`npm install ${EMBEDDING_PACKAGE}`)
  })

  it("propagates loader failures that are NOT the missing optional peer (a broken install is a crash)", async () => {
    const broken = Object.assign(new Error("Cannot find module './some-internal-file.js'"), { code: "ERR_MODULE_NOT_FOUND" })
    const retriever = new EmbeddingRetriever({ loadEmbedder: () => Promise.reject(broken) })
    const embedded = record("rule e", "topic e", { embedding: emb([1, 0]) })
    await expect(retriever.retrieve("some topic", [embedded])).rejects.toThrow(/some-internal-file/)
  })

  it("cosine similarity: identical direction 1, orthogonal 0, length/zero guarded", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0)
  })
})

// -------------------------------------- the seam end-to-end + tier selection

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

describe("the seam, end-to-end", () => {
  it("the recall executor awaits an embedding-backed store and returns RANKED rules — the loop never changes shape", async () => {
    const topicA = "apollo history notes"
    const ruleA = "Prefer concrete dates."
    const topicB = "style guidance"
    const ruleB = "Keep it short."
    const embedder = fakeEmbedder({
      [embeddingText({ topic: topicA, rule: ruleA })]: [1, 0],
      [embeddingText({ topic: topicB, rule: ruleB })]: [0, 1],
      "apollo program history": [0.9, 0.1],
    })
    const memory = new Memory(rulesPath(mkdtempSync(join(tmpdir(), "looper-embed-e2e-"))), new EmbeddingRetriever({ embedder }))
    await memory.remember({ rule: ruleB, evidence: "e", topic: topicB, sourceRunId: "r", loopId: "l" })
    await memory.remember({ rule: ruleA, evidence: "e", topic: topicA, sourceRunId: "r", loopId: "l" })

    const result = await recallExecutor.run(spec("recall", { topic: "apollo program history" }), { workdir: "/tmp", memory })
    expect(result.status).toBe("completed")
    expect(result.output.rules).toEqual([ruleA, ruleB]) // cosine order, not store order
    expect(result.usage.costUsd).toBe(0) // still a deterministic store read, not an LLM turn
  })

  it("retrieverFromEnv: lexical default, embedding by knob, unknown named loudly", () => {
    expect(retrieverFromEnv({}).id).toBe("lexical")
    expect(retrieverFromEnv({ LOOPER_RETRIEVER: "lexical" }).id).toBe("lexical")
    expect(retrieverFromEnv({ LOOPER_RETRIEVER: "embedding" })).toBeInstanceOf(EmbeddingRetriever)
    expect(() => retrieverFromEnv({ LOOPER_RETRIEVER: "vibes" })).toThrow(/LOOPER_RETRIEVER/)
  })
})

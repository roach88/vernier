// EmbeddingRetriever: cosine-similarity recall over rule embeddings, behind
// the same LAZY OPTIONAL DEPENDENCY pattern as the claude executor — the
// embedding package is an optional peer, so this module must import cleanly
// without it. Nothing touches the package until a retrieval/remember
// actually needs vectors: constructing the retriever (registry listing,
// doctor) is free; a use without the package fails with an actionable error
// naming the install command, and `vernier doctor` reports the same probe.
//
// Package choice: @huggingface/transformers (transformers.js) — official,
// actively maintained, pure-node install (ONNX runtime, no Python), and
// after the one-time model download every embed is LOCAL: no network at
// query time. Default model: Xenova/all-MiniLM-L6-v2 (small, standard).
//
// Where the vectors come from and go:
//   remember time  onRemember embeds `topic\n rule` (the recall key plus
//                  the payload; evidence is excluded — a whole verified
//                  answer would drown the rule inside a 512-token window)
//                  and stores it ON the JSONL record (RuleEmbedding,
//                  versioned: v + model).
//   recall time    the query topic is embedded, comparable records (same
//                  model id) are cosine-ranked; records WITHOUT a
//                  comparable embedding — every pre-embedding store — fall
//                  back to the lexical tier and stay retrievable. Hybrid,
//                  never a hard cutover.
//
// Determinism, stated honestly: given the same store contents and the same
// model version, retrieval is deterministic — but vectors from different
// model versions are different spaces, which is why RuleEmbedding.model
// gates comparability and a mismatch demotes to lexical, never to garbage.

import type { RuleEmbedding, RuleRecord } from "../kernel/types.js"
import { lexicalRetriever, type Retriever } from "./retriever.js"

export const EMBEDDING_PACKAGE = "@huggingface/transformers"
export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2"

/** Turns texts into vectors. `id` names the model — vectors from different ids are never compared. */
export interface Embedder {
  readonly id: string
  embed(texts: readonly string[]): Promise<ReadonlyArray<readonly number[]>>
}

export interface EmbeddingRetrieverOpts {
  /** Injectable embedder (tests pass fakes). Default: a lazily-imported transformers.js pipeline. */
  readonly embedder?: Embedder
  /** Test seam for the lazy import; production never sets this. */
  readonly loadEmbedder?: () => Promise<Embedder>
  /** Model for the default embedder. Default: Xenova/all-MiniLM-L6-v2. */
  readonly model?: string
  /** Return at most this many records. Default 5. */
  readonly topK?: number
  /** Drop cosine scores below this. Default 0: tiny stores RANK, they are never filtered to nothing. */
  readonly minSimilarity?: number
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denominator = Math.sqrt(na) * Math.sqrt(nb)
  return denominator === 0 ? 0 : dot / denominator
}

/** What gets embedded for one record: the recall key + the rule (see the header for why not evidence). */
export function embeddingText(record: Pick<RuleRecord, "topic" | "rule">): string {
  return `${record.topic}\n${record.rule}`
}

export class EmbeddingRetriever implements Retriever {
  readonly id = "embedding"
  private embedder: Embedder | undefined
  private readonly loadEmbedder: () => Promise<Embedder>
  private readonly topK: number
  private readonly minSimilarity: number
  private readonly lexical = lexicalRetriever()

  constructor(opts: EmbeddingRetrieverOpts = {}) {
    this.embedder = opts.embedder
    this.topK = opts.topK ?? 5
    this.minSimilarity = opts.minSimilarity ?? 0
    this.loadEmbedder = opts.loadEmbedder ?? (() => loadTransformersEmbedder(opts.model ?? DEFAULT_EMBEDDING_MODEL))
  }

  private async ready(): Promise<Embedder> {
    if (this.embedder !== undefined) return this.embedder
    try {
      this.embedder = await this.loadEmbedder()
    } catch (error) {
      // The one failure this retriever owns: the optional peer is absent.
      // Anything else (a broken install, a bad model id) propagates as the
      // crash it is — same posture as the claude executor's lazy SDK load.
      const code = (error as { code?: string }).code
      const message = error instanceof Error ? error.message : String(error)
      if (code !== "ERR_MODULE_NOT_FOUND" || !message.includes(EMBEDDING_PACKAGE)) throw error
      throw new Error(
        `memory retriever \`embedding\` needs ${EMBEDDING_PACKAGE}, an optional peer dependency this install does not carry. ` +
          `Install it next to vernier (\`npm install ${EMBEDDING_PACKAGE}\`) and re-run, or unset VERNIER_RETRIEVER to stay on the lexical default. ` +
          `\`vernier doctor\` shows the same probe.`,
      )
    }
    return this.embedder
  }

  async retrieve(topic: string, records: readonly RuleRecord[]): Promise<readonly RuleRecord[]> {
    if (!topic.trim() || records.length === 0) return []
    // A store with no embeddings at all (every pre-embedding store) needs
    // no model: pure lexical fallback, and the embedder is never loaded.
    if (records.every((r) => r.embedding === undefined)) {
      return this.lexical.retrieve(topic, records).slice(0, this.topK)
    }
    const embedder = await this.ready()
    const comparable = records.filter((r) => r.embedding !== undefined && r.embedding.model === embedder.id)
    const rest = records.filter((r) => r.embedding === undefined || r.embedding.model !== embedder.id)
    const [query] = await embedder.embed([topic])
    const ranked = comparable
      .map((record) => ({ record, score: cosineSimilarity(query ?? [], record.embedding!.vector) }))
      .filter((s) => s.score >= this.minSimilarity)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.record)
    // Un-comparable records (no embedding, or another model's) stay
    // retrievable through the lexical tier. They rank AFTER the cosine
    // results — scores from different tiers are not comparable.
    const fallback = this.lexical.retrieve(topic, rest)
    return [...ranked, ...fallback].slice(0, this.topK)
  }

  async onRemember(record: RuleRecord): Promise<RuleRecord> {
    const embedder = await this.ready()
    const [vector] = await embedder.embed([embeddingText(record)])
    if (vector === undefined || vector.length === 0) {
      throw new Error(`embedder \`${embedder.id}\` returned no vector for rule \`${record.id}\`.`)
    }
    const embedding: RuleEmbedding = { v: 1, model: embedder.id, vector: [...vector] }
    return { ...record, embedding }
  }
}

/** The real (lazy) embedder: transformers.js feature extraction, mean-pooled and normalized. */
async function loadTransformersEmbedder(model: string): Promise<Embedder> {
  // Dynamic on purpose: this is the only line that needs the package.
  const { pipeline } = await import("@huggingface/transformers")
  const extract = await pipeline("feature-extraction", model)
  return {
    id: `${EMBEDDING_PACKAGE}:${model}`,
    async embed(texts: readonly string[]) {
      const output = await extract([...texts], { pooling: "mean", normalize: true })
      return output.tolist() as number[][]
    },
  }
}

// The pluggable Retriever seam on Memory: HOW recall ranks the store is a
// retriever concern; THAT recall is a deterministic store read is a Memory
// concern, and the loop never sees either. Memory hands every live record
// (deduped, last-wins) to its retriever; the retriever returns them ranked
// best-first. Three tiers share this seam:
//
//   lexical    (default, this file)      BM25 over topic + rule + evidence —
//                                        no deps, no auth, fully deterministic
//   embedding  (memory/embedding.ts)     cosine over remember-time vectors,
//                                        lazy optional dependency
//   yours      (anything implementing    constructed into Memory directly:
//               Retriever)               new Memory(path, myRetriever)
//
// Lexical ranker choice: BM25 (Okapi, k1=1.2 b=0.75) rather than bare
// TF-IDF — term-frequency saturation plus length normalization is exactly
// what raw keyword overlap lacks, and it is ~30 lines with no dependencies.
// The +1 idf variant (log(1 + (N-n+0.5)/(n+0.5))) is load-bearing: it keeps
// every matched term's contribution POSITIVE, so a 1-rule store still
// recalls on a related topic instead of being filtered to nothing — tiny
// stores (the Pilot-3 store holds 1-2 rules) rank, they do not filter.
// The relevance gate is unchanged from the original keyword overlap: a
// record is returned iff it shares >= 1 query token (score > 0); unrelated
// topics still recall nothing.

import type { RuleRecord } from "../kernel/types.js"

/**
 * Rank the store against a query topic, best first. `retrieve` may be async
 * (embedding tiers embed the query); `onRemember` lets a tier enrich a
 * record before it is appended (e.g. attach an embedding) — it must
 * preserve the record's identity fields.
 */
export interface Retriever {
  readonly id: string
  retrieve(topic: string, records: readonly RuleRecord[]): readonly RuleRecord[] | Promise<readonly RuleRecord[]>
  onRemember?(record: RuleRecord): RuleRecord | Promise<RuleRecord>
}

/** The shared tokenizer: lowercase words of >= 4 chars, repeats kept (BM25 needs term frequency). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
}

/** Keyword retrieval's query view: the distinct tokens of a topic. Not semantics — overlap. */
export function topicTokens(topic: string): Set<string> {
  return new Set(tokenize(topic))
}

const K1 = 1.2
const B = 0.75

export class LexicalRetriever implements Retriever {
  readonly id = "lexical"

  retrieve(topic: string, records: readonly RuleRecord[]): readonly RuleRecord[] {
    const query = topicTokens(topic)
    if (query.size === 0 || records.length === 0) return []
    // The document is the WHOLE record text: a query term that appears only
    // in the rule or its evidence still matches (the old topic-only overlap
    // missed those).
    const docs = records.map((r) => tokenize(`${r.topic} ${r.rule} ${r.evidence}`))
    const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / docs.length
    if (avgLen === 0) return []
    const df = new Map<string, number>()
    for (const doc of docs) {
      for (const term of new Set(doc)) if (query.has(term)) df.set(term, (df.get(term) ?? 0) + 1)
    }
    const scored = records.map((record, i) => {
      const doc = docs[i]!
      const tf = new Map<string, number>()
      for (const term of doc) if (query.has(term)) tf.set(term, (tf.get(term) ?? 0) + 1)
      let score = 0
      for (const [term, freq] of tf) {
        const n = df.get(term) ?? 0
        const idf = Math.log(1 + (records.length - n + 0.5) / (n + 0.5)) // always > 0: tiny stores rank, never vanish
        score += (idf * (freq * (K1 + 1))) / (freq + K1 * (1 - B + (B * doc.length) / avgLen))
      }
      return { record, score }
    })
    return scored
      .filter((s) => s.score > 0) // the original relevance gate: >= 1 shared token
      .sort((a, b) => b.score - a.score) // stable sort: ties keep store (append) order
      .map((s) => s.record)
  }
}

/** The default retriever: deterministic, auth-free, dependency-free BM25. */
export function lexicalRetriever(): LexicalRetriever {
  return new LexicalRetriever()
}

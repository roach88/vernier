// The memory store: a durable, append-only, topic-queryable rules.jsonl —
// the ledger's sibling, in the same spirit (append-only JSONL, torn-line
// tolerant, mirrored root resolution). The difference is scope: a journal
// belongs to ONE run; memory is shared ACROSS runs, which is exactly what
// lets a self-improving loop compound instead of merely converging.
//
// What it stores: DISTILLED rules that passed verification (RuleRecord in
// kernel/types.ts) — never raw failure notes. That invariant is enforced by
// loop shape, not by trusting callers: the only path to `remember` runs
// through a passing grade (the self-improving template's loop shape).
//
// HOW the store is ranked at recall time is pluggable (the Retriever seam,
// memory/retriever.ts): the default is the deterministic, dependency-free
// BM25 lexical ranker; an embedding tier (memory/embedding.ts) is selected
// with VERNIER_RETRIEVER=embedding where registry runtimes construct Memory;
// a custom retriever is constructed in directly. Persistence is none of the
// retriever's business — append, dedupe-by-id, and torn-line tolerance all
// live here, identically for every tier.

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { MemoryStore, RuleRecord } from "../kernel/types.js"
import { canonical } from "../ledger/ledger.js"
import { EmbeddingRetriever } from "./embedding.js"
import { lexicalRetriever, type Retriever } from "./retriever.js"

export { topicTokens } from "./retriever.js"

/** Where the rule store lives. Resolved at construction; see resolveMemoryRoot. */
export interface MemorySpec {
  /** Root directory for the rule store. Default: $VERNIER_HOME, else ./.vernier */
  readonly root?: string
}

export function resolveMemoryRoot(spec: MemorySpec): string {
  return spec.root ?? process.env.VERNIER_HOME ?? join(process.cwd(), ".vernier")
}

export function rulesPath(root: string): string {
  return join(root, "memory", "rules.jsonl")
}

/**
 * The retriever-selection knob for registry-built runtimes:
 * VERNIER_RETRIEVER=lexical (the default) or embedding. Construction is
 * cheap either way — the embedding tier never touches its optional package
 * until a recall/remember actually needs vectors.
 */
export function retrieverFromEnv(env: NodeJS.ProcessEnv = process.env): Retriever {
  const choice = env.VERNIER_RETRIEVER?.trim() ?? ""
  if (choice === "" || choice === "lexical") return lexicalRetriever()
  if (choice === "embedding") return new EmbeddingRetriever()
  throw new Error(`Unknown VERNIER_RETRIEVER \`${choice}\`; valid values: lexical (default), embedding.`)
}

export class Memory implements MemoryStore {
  readonly retriever: Retriever

  constructor(
    readonly path: string,
    retriever: Retriever = lexicalRetriever(),
  ) {
    this.retriever = retriever
    mkdirSync(dirname(path), { recursive: true })
  }

  /**
   * Append one verified rule. The id is content-derived (hash of
   * topic + rule), so re-remembering the same rule appends a new record but
   * keeps one identity — recall dedupes by id, last record wins. A
   * retriever with an `onRemember` hook (the embedding tier) enriches the
   * record before it lands — which is why the return may be a promise.
   */
  remember(record: Omit<RuleRecord, "id" | "at" | "embedding">): RuleRecord | Promise<RuleRecord> {
    if (!record.rule.trim()) throw new Error("Memory.remember: refusing to store an empty rule.")
    const id = createHash("sha256").update(canonical({ topic: record.topic, rule: record.rule })).digest("hex").slice(0, 16)
    const full: RuleRecord = { ...record, id, at: new Date().toISOString() }
    if (this.retriever.onRemember === undefined) return this.append(full)
    return Promise.resolve(this.retriever.onRemember(full)).then((enriched) => this.append(enriched))
  }

  /**
   * The live store (deduped by id, last record wins), ranked by the
   * retriever — best first. Reads the file fresh on every call — no cache —
   * so two runs (or two processes) sharing one path always see each other's
   * appends. May be a promise: an embedding retriever embeds the query.
   */
  recall(topic: string): readonly RuleRecord[] | Promise<readonly RuleRecord[]> {
    return this.retriever.retrieve(topic, this.liveRecords())
  }

  private append(record: RuleRecord): RuleRecord {
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8")
    return record
  }

  private liveRecords(): RuleRecord[] {
    const byId = new Map<string, RuleRecord>()
    for (const record of this.loadAll()) byId.set(record.id, record)
    return [...byId.values()]
  }

  private loadAll(): RuleRecord[] {
    if (!existsSync(this.path)) return []
    const records: RuleRecord[] = []
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        records.push(JSON.parse(trimmed) as RuleRecord)
      } catch {
        continue // torn / unparseable line: skip, keep the prefix (same tolerance as the ledger)
      }
    }
    return records
  }
}

// The memory store: a durable, append-only, topic-queryable rules.jsonl —
// the ledger's sibling, in the same spirit (append-only JSONL, torn-line
// tolerant, mirrored root resolution). The difference is scope: a journal
// belongs to ONE run; memory is shared ACROSS runs, which is exactly what
// lets a self-improving loop compound instead of merely converging.
//
// What it stores: DISTILLED rules that passed verification (RuleRecord in
// kernel/types.ts) — never raw failure notes. That invariant is enforced by
// loop shape, not by trusting callers: the only path to `remember` runs
// through a passing grade (pilot3/loop.ts).
//
// Retrieval is deliberately simple and honest: case-insensitive keyword
// overlap between the query topic and each record's topic. Semantic /
// embedding retrieval is a noted future improvement — not built here,
// because a clever index on top of a three-record store proves nothing.

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { MemoryStore, RuleRecord } from "../kernel/types.js"
import { canonical } from "../ledger/ledger.js"

/** Where the rule store lives. Resolved at construction; see resolveMemoryRoot. */
export interface MemorySpec {
  /** Root directory for the rule store. Default: $LOOPER_HOME, else ./.looper */
  readonly root?: string
}

export function resolveMemoryRoot(spec: MemorySpec): string {
  return spec.root ?? process.env.LOOPER_HOME ?? join(process.cwd(), ".looper")
}

export function rulesPath(root: string): string {
  return join(root, "memory", "rules.jsonl")
}

/** Keyword retrieval's tokenizer: lowercase words of >= 4 chars. Not semantics — overlap. */
export function topicTokens(topic: string): Set<string> {
  return new Set(
    topic
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  )
}

export class Memory implements MemoryStore {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
  }

  /**
   * Append one verified rule. The id is content-derived (hash of
   * topic + rule), so re-remembering the same rule appends a new record but
   * keeps one identity — recall dedupes by id, last record wins.
   */
  remember(record: Omit<RuleRecord, "id" | "at">): RuleRecord {
    if (!record.rule.trim()) throw new Error("Memory.remember: refusing to store an empty rule.")
    const id = createHash("sha256").update(canonical({ topic: record.topic, rule: record.rule })).digest("hex").slice(0, 16)
    const full: RuleRecord = { ...record, id, at: new Date().toISOString() }
    appendFileSync(this.path, JSON.stringify(full) + "\n", "utf8")
    return full
  }

  /**
   * Every rule whose topic shares a keyword with the query topic, deduped
   * by id (last wins). Reads the file fresh on every call — no cache — so
   * two runs (or two processes) sharing one path always see each other's
   * appends.
   */
  recall(topic: string): RuleRecord[] {
    const query = topicTokens(topic)
    if (query.size === 0) return []
    const byId = new Map<string, RuleRecord>()
    for (const record of this.loadAll()) {
      if ([...topicTokens(record.topic)].some((t) => query.has(t))) byId.set(record.id, record)
    }
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

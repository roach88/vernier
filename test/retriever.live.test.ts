// LIVE embedding-tier proof, double-gated like the provider live tests: the
// first run downloads the embedding model (network + disk), so it never
// runs in the auth-free suite. Run it deliberately:
//
//   VERNIER_LIVE=1 VERNIER_LIVE_EMBEDDING=1 npm test -- retriever.live
//
// After the one-time model download every embed is local; the proof is the
// dogma sentence made concrete: an embedding lookup is deterministic given
// store + model version — and semantically, "a note about a space telescope"
// must rank the astronomy rule above the cooking rule with zero shared
// >=4-char tokens.

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { EMBEDDING_PACKAGE, EmbeddingRetriever } from "../src/memory/embedding.js"
import { Memory, rulesPath } from "../src/memory/memory.js"

const LIVE_EMBEDDING_REQUESTED = process.env.VERNIER_LIVE === "1" && process.env.VERNIER_LIVE_EMBEDDING === "1"
const EMBEDDING_AVAILABLE = LIVE_EMBEDDING_REQUESTED && packageResolvable()

describe("embedding retriever live proof", () => {
  it.skipIf(!EMBEDDING_AVAILABLE)(
    "remembers with real vectors and recalls semantically related rules first",
    async () => {
      const memory = new Memory(rulesPath(mkdtempSync(join(tmpdir(), "vernier-embed-live-"))), new EmbeddingRetriever())
      await memory.remember({
        rule: "Name the launch year of the observatory.",
        evidence: "verified",
        topic: "astronomy observatory facts",
        sourceRunId: "live-1",
        loopId: "live",
      })
      await memory.remember({
        rule: "Preheat the oven before baking.",
        evidence: "verified",
        topic: "kitchen baking technique",
        sourceRunId: "live-1",
        loopId: "live",
      })
      const ranked = await memory.recall("a note about a space telescope")
      expect(ranked.length).toBeGreaterThan(0)
      expect(ranked[0]!.rule).toContain("observatory")
      expect(ranked[0]!.embedding).toMatchObject({ v: 1, model: `${EMBEDDING_PACKAGE}:Xenova/all-MiniLM-L6-v2` })
    },
    600_000, // first run downloads the model
  )
})

function packageResolvable(): boolean {
  try {
    import.meta.resolve(EMBEDDING_PACKAGE)
    return true
  } catch {
    return false
  }
}

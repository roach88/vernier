// Shared helpers for the getting-started loop. Both sides of the loop —
// the composer that writes haiku and the reviewer that counts them — use
// the SAME naive syllable counter, so they always agree about what the
// rules of the game are. (It counts vowel groups, so it is wrong about
// English exactly as often as any naive counter; consistency, not poetry,
// is what a deterministic verifier needs.)

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Naive syllable count: vowel groups per word, minimum 1 per word. */
export function syllables(text) {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .reduce((n, word) => n + Math.max(1, (word.match(/[aeiouy]+/g) ?? []).length), 0)
}

/** Season words, each exactly one naive syllable — the padding vocabulary. */
const KIGO = ["dusk", "moon", "wind", "mist", "frost"]

/** Pad a base phrase to `target` naive syllables with comma-joined kigo. */
function padTo(base, target) {
  const parts = [base]
  let i = 0
  while (syllables(parts.join(" ")) < target && i < 16) parts.push(KIGO[i++ % KIGO.length])
  return parts.join(", ")
}

/**
 * The deterministic haiku: topic on line 1, the engine on line 2, the
 * ledger on line 3, each line padded to 5-7-5 by the same counter the
 * reviewer uses. A topic longer than 5 naive syllables overflows line 1 —
 * the reviewer will catch it, which is the point.
 */
export function composeHaiku(topic) {
  return [padTo(topic, 5), padTo("the engine ticks on", 7), padTo("the ledger recalls", 5)].join("\n")
}

export function slugify(topic) {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "haiku"
  )
}

/** Write the haiku under the step's allowed scope; return the workdir-relative path. */
export function writeHaiku(workdir, topic, haiku) {
  const path = join("haiku", `${slugify(topic)}.md`)
  const absolute = join(workdir, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, haiku + "\n", "utf8")
  return path
}

export const zeroUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }

// Config-level executors: registered for EVERY loop under this config, so
// any step can be rebound onto them at the CLI — the any-agent-any-role
// seam. Two alternates for the compose role:
//
//   haiku-bot-loud   same haiku, SHOUTED. Passes both contracts (the
//                    counter lowercases), so a rebind visibly changes the
//                    output while staying verified.
//   free-verse-bot   refuses the form: one long line. haiku-shape.v1
//                    catches it and the policy escalates — rebinding never
//                    weakens verification, because the contract belongs to
//                    the STEP, not to the executor.

import { composeHaiku, writeHaiku, zeroUsage } from "./lib.mjs"

const loud = {
  id: "haiku-bot-loud",
  async run(spec, ctx) {
    const topic = String(spec.inputs.topic)
    const haiku = composeHaiku(topic).toUpperCase()
    const path = writeHaiku(ctx.workdir, topic, haiku)
    return { status: "completed", output: { haiku, path }, evidence: [{ role: "haiku", path }], usage: zeroUsage }
  },
}

const freeVerse = {
  id: "free-verse-bot",
  async run(spec, ctx) {
    const topic = String(spec.inputs.topic)
    const haiku = `${topic} sprawls past every counted breath, unmeasured and proud`
    const path = writeHaiku(ctx.workdir, topic, haiku)
    return { status: "completed", output: { haiku, path }, evidence: [{ role: "haiku", path }], usage: zeroUsage }
  },
}

export default [loud, freeVerse]

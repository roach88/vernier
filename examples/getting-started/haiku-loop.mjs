// The getting-started loop: haiku-review. A deterministic composer writes
// a haiku about your topic into the workdir; a separate deterministic
// reviewer counts the syllables; a contract on each step says what "good"
// means. No LLM, no auth — the whole five-slot shape with nothing hidden.
//
// This module is written the way YOU would write one: plain .mjs, zod for
// the signature schemas (the one bare specifier — your node_modules wins
// when present, else the vernier CLI lends its own copy), a pure function
// for the policy, and a default export of { loop, ...runtime facts } that
// vernier.config.json points at.

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { composeHaiku, syllables, writeHaiku, zeroUsage } from "./lib.mjs"

// ------------------------------------------------------------- executors
// ANY agent arrives like this: an id plus run(spec, ctx) -> StepResult.

/** The producer: composes a 5-7-5 haiku and writes it under haiku/. */
const haikuBot = {
  id: "haiku-bot",
  async run(spec, ctx) {
    const topic = String(spec.inputs.topic)
    const haiku = composeHaiku(topic)
    const path = writeHaiku(ctx.workdir, topic, haiku)
    return {
      status: "completed",
      output: { haiku, path },
      evidence: [{ role: "haiku", path }],
      usage: zeroUsage,
    }
  },
}

/** The verifier: counts syllables per line. It never trusts the composer. */
const syllableCounter = {
  id: "syllable-counter",
  async run(spec) {
    // Deterministic crash hook for the walkthrough's resume section: kill
    // the driver mid-run, AFTER compose is journaled, BEFORE review is.
    if (process.env.GETTING_STARTED_CRASH === "1") process.kill(process.pid, "SIGKILL")
    const lines = String(spec.inputs.haiku)
      .split("\n")
      .filter((l) => l.trim().length > 0)
    const counts = lines.map((l) => syllables(l))
    return {
      status: "completed",
      output: { syllables: counts, ok: counts.length === 3 && counts[0] === 5 && counts[1] === 7 && counts[2] === 5 },
      evidence: [],
      usage: zeroUsage,
    }
  },
}

// ------------------------------------------------------------- contracts
// Deterministic semantic validation of each step's OUTPUT VALUE. A failed
// check's `label — detail` is exactly what lands in the journal and in a
// retry prompt, so write the detail for the reader who has to act on it.

const haikuShapeV1 = {
  id: "haiku-shape.v1",
  validate(output, ctx) {
    const haiku = typeof output.haiku === "string" ? output.haiku : ""
    const lines = haiku.split("\n").filter((l) => l.trim().length > 0)
    const path = typeof output.path === "string" ? output.path : ""
    const absolute = path ? join(ctx.workdir, path) : ""
    const written = absolute !== "" && existsSync(absolute)
    const checks = [
      { label: "three lines", passed: lines.length === 3, detail: `expected exactly 3 non-empty lines, got ${lines.length}` },
      { label: "artifact written", passed: written, detail: `expected the haiku file at \`${path || "<missing path output field>"}\`` },
      {
        label: "artifact matches output",
        passed: written && readFileSync(absolute, "utf8").trim() === haiku.trim(),
        detail: "expected the file content to equal the reported haiku",
      },
    ]
    return { contractId: "haiku-shape.v1", valid: checks.every((c) => c.passed), checks }
  },
}

const haiku575V1 = {
  id: "haiku-5-7-5.v1",
  validate(output) {
    const counts = Array.isArray(output.syllables) ? output.syllables : []
    const checks = [5, 7, 5].map((want, i) => ({
      label: `line ${i + 1} has ${want} syllables`,
      passed: counts[i] === want,
      detail: `counted ${counts[i] ?? "no line"}`,
    }))
    return { contractId: "haiku-5-7-5.v1", valid: checks.every((c) => c.passed), checks }
  },
}

// ---------------------------------------------------------------- policy
// A pure Observation -> Decision function. The engine hands it
// deterministic facts (status, validity, contract checks, effect scope);
// it answers continue / retry / iterate / escalate / stop. Nothing here
// may read a file or call a model — that is the dogma's "the policy is
// pure", and it is what makes every decision replayable from the ledger.

const policy = (obs) => {
  const passed = obs.stepStatus === "completed" && obs.outputValid && obs.contractValid && obs.effectsAllowed
  if (!passed) {
    return {
      kind: "escalate",
      classification: "failure",
      summary: `step \`${obs.stepId}\` failed: ${obs.contractFailedChecks.join("; ") || "see the journal"}.`,
      notes: obs.contractFailedChecks,
      improvement: "none",
    }
  }
  const last = obs.stepIndex + 1 >= obs.stepCount
  return {
    kind: last ? "stop" : "continue",
    classification: "success",
    summary: last ? "haiku verified 5-7-5; done." : `step \`${obs.stepId}\` passed; continue.`,
    notes: [],
    improvement: "none",
  }
}

// ------------------------------------------------------------------ loop
// The five slots. Compare with templates/smoke/smoke-loop.mjs — same shape, your data.

const loop = {
  id: "haiku-review",
  version: "0.1.0",
  signature: {
    input: z.object({ topic: z.string() }),
    // `verdict` is the engine's one reserved output field (the final
    // decision's classification) — a loop may promise it without any step
    // producing it.
    output: z.object({ haiku: z.string(), syllables: z.array(z.number()), verdict: z.string() }),
  },
  steps: [
    {
      id: "compose",
      signature: {
        input: z.object({ topic: z.string() }),
        output: z.object({ haiku: z.string(), path: z.string() }),
      },
      executor: "haiku-bot",
      contract: "haiku-shape.v1",
      effects: { allow: ["haiku/**"] }, // fsScope("haiku/**"): writes outside this escalate
    },
    {
      id: "review",
      signature: {
        input: z.object({ haiku: z.string() }),
        output: z.object({ syllables: z.array(z.number()), ok: z.boolean() }),
      },
      executor: "syllable-counter",
      contract: "haiku-5-7-5.v1",
      effects: { allow: [] }, // noEffects(): the reviewer may touch nothing
    },
  ],
  policy,
  trust: "dry-run",
  ledger: {},
}

// ---------------------------------------------------------- registration
// The runtime facts the Loop (pure data) cannot carry: its executors, its
// contracts, default inputs, and where it works by default.

export default {
  loop,
  summary: "Getting-started loop: a deterministic haiku composer, syllable-checked by an independent reviewer.",
  signature: "topic:string -> haiku:string, syllables:number[], verdict:string",
  defaultInputs: { topic: "a vernier scale" },
  executors: [haikuBot, syllableCounter],
  contracts: [haikuShapeV1, haiku575V1],
  defaultWorkdir: () => {
    const dir = join(process.cwd(), "scratch")
    mkdirSync(dir, { recursive: true })
    return dir
  },
}

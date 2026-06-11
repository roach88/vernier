// Fixture: an out-of-tree user loop, written as a USER would write it —
// plain .mjs, no looper imports beyond what a Loop literally is (zod for
// the signature schemas; the policy is just a pure function). The module
// default-exports a registration: { loop, ...runtime facts }, including
// the executor its one step names.
import { z } from "zod"

const zeroUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }

/** The user's own executor: any agent arrives like this — an id plus run(). */
const upper = {
  id: "upper",
  async run(spec) {
    return {
      status: "completed",
      output: { echoed: String(spec.inputs.message).toUpperCase() },
      evidence: [],
      usage: zeroUsage,
    }
  },
}

/** A pure Observation -> Decision policy, written from scratch out of tree. */
const policy = (obs) => {
  if (obs.stepStatus === "completed" && obs.outputValid && obs.contractValid && obs.effectsAllowed) {
    const last = obs.stepIndex + 1 >= obs.stepCount
    return {
      kind: last ? "stop" : "continue",
      classification: "success",
      summary: last ? "echoed; done." : "step passed; continue.",
      notes: [],
      improvement: "none",
    }
  }
  return {
    kind: "escalate",
    classification: "failure",
    summary: `step \`${obs.stepId}\` did not pass.`,
    notes: [],
    improvement: "none",
  }
}

export default {
  loop: {
    id: "echo-shout",
    version: "0.1.0",
    signature: {
      input: z.object({ message: z.string() }),
      output: z.object({ echoed: z.string(), verdict: z.string() }),
    },
    steps: [
      {
        id: "echo",
        signature: {
          input: z.object({ message: z.string() }),
          output: z.object({ echoed: z.string() }),
        },
        executor: "upper",
        effects: { allow: [] },
      },
    ],
    policy,
    trust: "dry-run",
    ledger: {},
  },
  summary: "Fixture: user-defined echo loop registered via looper.config.json.",
  signature: "message:string -> echoed:string, verdict:string",
  defaultInputs: { message: "hello looper" },
  executors: [upper],
}

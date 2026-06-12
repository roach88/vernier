// Fixture: a prompt-bearing user loop whose executor ECHOES the prompt it
// received — the smallest loop that makes skill delivery observable through
// the real CLI surface: whatever the engine put in the prompt (an embedded
// SKILL.md body, or nothing after `--skill speak=` cleared the step) comes
// back as the loop's output.
import { z } from "zod"

const zeroUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }

/** Echo the rendered prompt: the provider-invocation boundary, made visible. */
const speak = {
  id: "speak-script",
  async run(spec) {
    return { status: "completed", output: { text: String(spec.prompt ?? "") }, evidence: [], usage: zeroUsage }
  },
}

const policy = (obs) => {
  if (obs.stepStatus === "completed" && obs.outputValid && obs.contractValid && obs.effectsAllowed) {
    const last = obs.stepIndex + 1 >= obs.stepCount
    return { kind: last ? "stop" : "continue", classification: "success", summary: "spoke.", notes: [], improvement: "none" }
  }
  return { kind: "escalate", classification: "failure", summary: `step \`${obs.stepId}\` did not pass.`, notes: [], improvement: "none" }
}

export default {
  loop: {
    id: "skill-echo",
    version: "0.1.0",
    signature: {
      input: z.object({}),
      output: z.object({ text: z.string(), verdict: z.string() }),
    },
    steps: [
      {
        id: "speak",
        signature: { input: z.object({}), output: z.object({ text: z.string() }) },
        executor: "speak-script",
        skills: ["greeting-style"],
        effects: { allow: [] },
        prompt: () => "Say hello to the reviewer.",
      },
    ],
    policy,
    trust: "dry-run",
    ledger: {},
  },
  summary: "Fixture: prompt-echo loop with a skill-bearing step, registered via vernier.config.json.",
  signature: "{} -> text:string, verdict:string",
  defaultInputs: {},
  executors: [speak],
}

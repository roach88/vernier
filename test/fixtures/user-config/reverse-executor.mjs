// Fixture: a config-level user executor — registered for EVERY loop run
// under this config, so any step can be bound onto it (the "any agent in
// any role" seam, in its smallest possible form).
export default {
  id: "reverse",
  async run(spec) {
    return {
      status: "completed",
      output: { echoed: [...String(spec.inputs.message)].reverse().join("") },
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
    }
  },
}

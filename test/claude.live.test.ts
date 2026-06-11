// LIVE claude proof, double-gated like provider-live.test.ts: it costs
// tokens and needs an authed Claude Code install, so it never runs in the
// auth-free suite. Run it deliberately:
//
//   VERNIER_LIVE=1 VERNIER_LIVE_CLAUDE=1 npm test -- claude.live

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ClaudeExecutor, CLAUDE_SDK } from "../src/executors/claude.js"
import { noEffects, type StepSpec } from "../src/kernel/types.js"

const LIVE_CLAUDE_REQUESTED = process.env.VERNIER_LIVE === "1" && process.env.VERNIER_LIVE_CLAUDE === "1"
const CLAUDE_AVAILABLE = LIVE_CLAUDE_REQUESTED && sdkResolvable()

function spec(): StepSpec {
  return {
    runId: "claude-live",
    traceId: "claude-live",
    loopId: "provider-live",
    loopVersion: "0.1.0",
    stepId: "claude",
    attempt: 1,
    iteration: 1,
    inputs: {},
    prompt: "Reply with exactly this text: vernier claude live proof",
    effects: noEffects(),
    runDir: mkdtempSync(join(tmpdir(), "vernier-claude-live-run-")),
    timeoutMs: 180_000,
  }
}

describe("claude live proof", () => {
  it.skipIf(!CLAUDE_AVAILABLE)(
    "runs a no-effects Claude step through the Executor seam",
    async () => {
      const executor = new ClaudeExecutor()
      const result = await executor.run(spec(), { workdir: mkdtempSync(join(tmpdir(), "vernier-claude-live-work-")) })
      expect(result.status).toBe("completed")
      expect(String(result.output.text).length).toBeGreaterThan(0)
      expect(result.usage.inputTokens).toBeGreaterThan(0)
    },
    240_000,
  )
})

function sdkResolvable(): boolean {
  try {
    import.meta.resolve(CLAUDE_SDK)
    return true
  } catch {
    return false
  }
}

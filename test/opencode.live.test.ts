// LIVE opencode proof, double-gated like provider-live.test.ts: it costs
// tokens and needs an authed opencode CLI (>= 1.16.2) on PATH, so it never
// runs in the auth-free suite. Run it deliberately:
//
//   LOOPER_LIVE=1 LOOPER_LIVE_OPENCODE=1 npm test -- opencode.live

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { OpencodeExecutor } from "../src/executors/opencode.js"
import { noEffects, type StepSpec } from "../src/kernel/types.js"

const LIVE_OPENCODE = process.env.LOOPER_LIVE === "1" && process.env.LOOPER_LIVE_OPENCODE === "1"

function spec(): StepSpec {
  return {
    runId: "opencode-live",
    traceId: "opencode-live",
    loopId: "provider-live",
    loopVersion: "0.1.0",
    stepId: "opencode",
    attempt: 1,
    iteration: 1,
    inputs: {},
    prompt: "Reply with exactly this text: looper opencode live proof",
    effects: noEffects(),
    runDir: mkdtempSync(join(tmpdir(), "looper-opencode-live-run-")),
    timeoutMs: 180_000,
  }
}

describe("opencode live proof", () => {
  it.skipIf(!LIVE_OPENCODE)(
    "runs a no-effects opencode step through the Executor seam",
    async () => {
      const executor = new OpencodeExecutor()
      const result = await executor.run(spec(), { workdir: mkdtempSync(join(tmpdir(), "looper-opencode-live-work-")) })
      expect(result.status).toBe("completed")
      expect(String(result.output.text).length).toBeGreaterThan(0)
      expect(result.usage.inputTokens).toBeGreaterThan(0)
    },
    240_000,
  )
})

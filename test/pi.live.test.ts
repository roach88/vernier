// LIVE pi proof, double-gated like provider-live.test.ts: it costs tokens
// and needs an authed pi CLI (>= 0.79.1, @earendil-works/pi-coding-agent) on
// PATH, so it never runs in the auth-free suite. Run it deliberately:
//
//   VERNIER_LIVE=1 VERNIER_LIVE_PI=1 npm test -- pi.live

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { PiExecutor } from "../src/executors/pi.js"
import { noEffects, type StepSpec } from "../src/kernel/types.js"

const LIVE_PI = process.env.VERNIER_LIVE === "1" && process.env.VERNIER_LIVE_PI === "1"

function spec(): StepSpec {
  return {
    runId: "pi-live",
    traceId: "pi-live",
    loopId: "provider-live",
    loopVersion: "0.1.0",
    stepId: "pi",
    attempt: 1,
    iteration: 1,
    inputs: {},
    prompt: "Reply with exactly this text: vernier pi live proof",
    effects: noEffects(),
    runDir: mkdtempSync(join(tmpdir(), "vernier-pi-live-run-")),
    timeoutMs: 180_000,
  }
}

describe("pi live proof", () => {
  it.skipIf(!LIVE_PI)(
    "runs a no-effects pi step through the Executor seam",
    async () => {
      const executor = new PiExecutor()
      const result = await executor.run(spec(), { workdir: mkdtempSync(join(tmpdir(), "vernier-pi-live-work-")) })
      expect(result.status).toBe("completed")
      expect(String(result.output.text).length).toBeGreaterThan(0)
      expect(result.usage.inputTokens).toBeGreaterThan(0)
    },
    240_000,
  )
})

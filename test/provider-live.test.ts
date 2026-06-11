import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CursorExecutor } from "../src/executors/cursor.js"
import { noEffects, type StepSpec } from "../src/kernel/types.js"

const LIVE_CURSOR_REQUESTED = process.env.VERNIER_LIVE === "1" && process.env.VERNIER_LIVE_CURSOR === "1"
const CURSOR_BIN = process.env.VERNIER_CURSOR_BIN ?? "cursor-agent"
const CURSOR_AVAILABLE = LIVE_CURSOR_REQUESTED && commandAvailable(CURSOR_BIN)

function spec(): StepSpec {
  return {
    runId: "cursor-live",
    traceId: "cursor-live",
    loopId: "provider-live",
    loopVersion: "0.1.0",
    stepId: "cursor",
    attempt: 1,
    iteration: 1,
    inputs: {},
    prompt: "Reply with exactly this text: vernier cursor live proof",
    effects: noEffects(),
    runDir: mkdtempSync(join(tmpdir(), "vernier-cursor-live-run-")),
    timeoutMs: 180_000,
  }
}

describe("cursor-agent live proof", () => {
  it.skipIf(!CURSOR_AVAILABLE)(
    "runs a no-effects Cursor step through the Executor seam",
    async () => {
      const executor = new CursorExecutor({ bin: CURSOR_BIN })
      const result = await executor.run(spec(), { workdir: mkdtempSync(join(tmpdir(), "vernier-cursor-live-work-")) })
      expect(result.status).toBe("completed")
      expect(String(result.output.text).length).toBeGreaterThan(0)
    },
    240_000,
  )
})

function commandAvailable(bin: string): boolean {
  return spawnSync(bin, ["--help"], { stdio: "ignore" }).error === undefined
}

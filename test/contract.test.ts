import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runTraceV1 } from "../src/kernel/contract.js"

function context(workdir: string) {
  return { traceId: "run-1", loopId: "loop", loopVersion: "0.1.0", workdir, executorId: "script", runDir: join(workdir, ".vernier", "runs", "run-1") }
}

function validTrace(): string {
  return [
    "# Trace: run-1",
    "",
    "`loop_id`: loop",
    "`loop_version`: 0.1.0",
    "`result.classification`: success",
    "`improvement_candidate.summary`: none",
    "",
  ].join("\n")
}

describe("run-trace.v1 contract path safety", () => {
  it("accepts a valid workdir-relative trace", () => {
    const workdir = mkdtempSync(join(tmpdir(), "vernier-contract-"))
    mkdirSync(join(workdir, "traces"), { recursive: true })
    writeFileSync(join(workdir, "traces", "trace.md"), validTrace())

    const result = runTraceV1.validate({ trace: "traces/trace.md" }, context(workdir))
    expect(result.valid).toBe(true)
  })

  it("rejects absolute paths and relative escapes without reading them", () => {
    const workdir = mkdtempSync(join(tmpdir(), "vernier-contract-"))
    const absolute = runTraceV1.validate({ trace: "/etc/passwd" }, context(workdir))
    expect(absolute.valid).toBe(false)
    expect(absolute.checks[0]!.detail).toContain("relative")

    const escape = runTraceV1.validate({ trace: "../outside.md" }, context(workdir))
    expect(escape.valid).toBe(false)
    expect(escape.checks[0]!.detail).toContain("inside the workdir")
  })

  it("rejects workdir-contained symlinks that resolve outside the workdir", () => {
    const workdir = mkdtempSync(join(tmpdir(), "vernier-contract-"))
    const outside = mkdtempSync(join(tmpdir(), "vernier-outside-trace-"))
    writeFileSync(join(outside, "trace.md"), validTrace())
    symlinkSync(outside, join(workdir, "traces"))

    const result = runTraceV1.validate({ trace: "traces/trace.md" }, context(workdir))
    expect(result.valid).toBe(false)
    expect(result.checks[0]!.detail).toContain("real workdir")
  })

  it("rejects final symlinks even when they resolve inside the workdir", () => {
    const workdir = mkdtempSync(join(tmpdir(), "vernier-contract-"))
    writeFileSync(join(workdir, "trace.md"), validTrace())
    symlinkSync(join(workdir, "trace.md"), join(workdir, "trace-link.md"))

    const result = runTraceV1.validate({ trace: "trace-link.md" }, context(workdir))
    expect(result.valid).toBe(false)
  })

  it("rejects oversized trace files", () => {
    const workdir = mkdtempSync(join(tmpdir(), "vernier-contract-"))
    writeFileSync(join(workdir, "trace.md"), "# Trace: run-1\n" + "x".repeat(1_000_001))

    const result = runTraceV1.validate({ trace: "trace.md" }, context(workdir))
    expect(result.valid).toBe(false)
    expect(result.checks[0]!.detail).toContain("<= 1000000 bytes")
  })
})

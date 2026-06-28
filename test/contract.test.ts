import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { RUN_TRACE_V1, runTraceV1 } from "../src/kernel/contract.js"

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "vernier-contract-"))
}

function validTrace(root: string, name = "trace.md"): string {
  const path = join(root, name)
  writeFileSync(
    path,
    [
      "# Trace: run-1",
      "`loop_id`: loop-a",
      "`loop_version`: 1.0.0",
      "`result.classification`: success",
      "`improvement_candidate.summary`: keep it simple",
      "run-1",
      "",
    ].join("\n"),
    "utf8",
  )
  return name
}

function validate(root: string, trace: string) {
  return runTraceV1.validate({ trace }, {
    traceId: "run-1",
    loopId: "loop-a",
    loopVersion: "1.0.0",
    workdir: root,
    executorId: "script",
    runDir: join(root, "..", "run"),
  })
}

describe(RUN_TRACE_V1, () => {
  it("accepts readable workdir-relative traces", () => {
    const root = workdir()
    const result = validate(root, validTrace(root))
    expect(result.valid).toBe(true)
  })

  it("rejects absolute trace paths", () => {
    const root = workdir()
    const absolute = join(root, validTrace(root))
    const result = validate(root, absolute)
    expect(result.valid).toBe(false)
    expect(result.checks[0]?.detail).toContain("relative to the workdir")
  })

  it("rejects parent-directory escapes", () => {
    const root = workdir()
    const result = validate(root, "../trace.md")
    expect(result.valid).toBe(false)
    expect(result.checks[0]?.detail).toContain("inside the workdir")
  })

  it("rejects symlinks that resolve outside the workdir", () => {
    const root = workdir()
    const outside = join(root, "..", "outside.md")
    writeFileSync(outside, "# Trace: run-1\n", "utf8")
    symlinkSync(outside, join(root, "trace-link.md"))

    const result = validate(root, "trace-link.md")

    expect(result.valid).toBe(false)
    expect(result.checks[0]?.detail).toContain("inside the real workdir")
  })
})

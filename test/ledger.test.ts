import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  canonical,
  journalPath,
  Ledger,
  replay,
  resumeKey,
  type DecisionEntry,
  type RunMetaEntry,
  type StepResultEntry,
} from "../src/ledger/ledger.js"
import { zeroUsage } from "../src/kernel/types.js"

const meta = (): RunMetaEntry => ({
  type: "meta",
  runId: "run-1",
  traceId: "run-1",
  loopId: "demo",
  loopVersion: "0.1.0",
  trust: "dry-run",
  inputs: { a: 1 },
  keyVersion: "loop-v2",
  at: "2026-06-10T00:00:00.000Z",
})

const result = (key: string, status: StepResultEntry["status"] = "completed"): StepResultEntry => ({
  type: "step_result",
  key,
  stepId: "smoke",
  attempt: 1,
  iteration: 1,
  status,
  output: { ok: true },
  outputValid: true,
  evidence: [],
  usage: zeroUsage(),
  at: "2026-06-10T00:00:01.000Z",
})

const decision = (key: string): DecisionEntry => ({
  type: "decision",
  key,
  stepId: "smoke",
  attempt: 1,
  iteration: 1,
  decision: { kind: "stop", classification: "success", summary: "done", notes: [], improvement: "none" },
  at: "2026-06-10T00:00:02.000Z",
})

function tempJournal(): string {
  return join(mkdtempSync(join(tmpdir(), "vernier-ledger-")), "journal.jsonl")
}

describe("resumeKey", () => {
  it("is stable across object key order (canonical hashing)", () => {
    expect(resumeKey("smoke", { a: 1, b: [2, 3] }, 1, 1)).toBe(resumeKey("smoke", { b: [2, 3], a: 1 }, 1, 1))
  })

  it("differs by stepId and by inputs", () => {
    expect(resumeKey("smoke", { a: 1 }, 1, 1)).not.toBe(resumeKey("other", { a: 1 }, 1, 1))
    expect(resumeKey("smoke", { a: 1 }, 1, 1)).not.toBe(resumeKey("smoke", { a: 2 }, 1, 1))
  })

  it("disambiguates iterations and attempts: same step + same inputs never collide across passes", () => {
    // An `iterate` loop-back re-runs a step with byte-identical inputs (the
    // feedback travels as retryHint, not as an input) — the key must not
    // collapse those slots, or a resume could replay pass 1 into pass 2.
    expect(resumeKey("answer", { goal: "g" }, 1, 1)).not.toBe(resumeKey("answer", { goal: "g" }, 2, 1))
    expect(resumeKey("answer", { goal: "g" }, 1, 1)).not.toBe(resumeKey("answer", { goal: "g" }, 1, 2))
    expect(resumeKey("answer", { goal: "g" }, 2, 1)).not.toBe(resumeKey("answer", { goal: "g" }, 1, 2))
  })

  it("canonical sorts deeply", () => {
    expect(canonical({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}')
  })
})

describe("Ledger", () => {
  it("appends and loads entries in order (append-only round trip)", () => {
    const path = tempJournal()
    const ledger = new Ledger(path)
    const key = resumeKey("smoke", { a: 1 }, 1, 1)
    ledger.append(meta())
    ledger.append(result(key))
    expect(Ledger.load(path).map((e) => e.type)).toEqual(["meta", "step_result"])

    ledger.append(decision(key)) // appending grows the file; earlier entries untouched
    expect(Ledger.load(path).map((e) => e.type)).toEqual(["meta", "step_result", "decision"])
  })

  it("skips torn trailing lines and keeps the prefix", () => {
    const path = tempJournal()
    const ledger = new Ledger(path)
    ledger.append(meta())
    appendFileSync(path, '{"type":"step_result","key":"abc","trunc', "utf8")
    const entries = Ledger.load(path)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.type).toBe("meta")
  })

  it("rejects invalid JSON in the middle of a journal", () => {
    const path = tempJournal()
    const ledger = new Ledger(path)
    const key = resumeKey("smoke", { a: 1 }, 1, 1)
    ledger.append(meta())
    appendFileSync(path, '{"type":"step_result","key":"abc","trunc\n', "utf8")
    ledger.append(decision(key))

    expect(() => Ledger.load(path)).toThrow(/invalid JSON line before the end/)
  })

  it("is replayable: completed results recoverable by resume key, last decision surfaced", () => {
    const path = tempJournal()
    const ledger = new Ledger(path)
    const key = resumeKey("smoke", { a: 1 }, 1, 1)
    ledger.append(meta())
    ledger.append(result(key, "failed"))
    ledger.append(result(key, "completed"))
    ledger.append(decision(key))

    const view = replay(Ledger.load(path))
    expect(view.meta?.runId).toBe("run-1")
    expect(view.completed.get(key)?.status).toBe("completed")
    expect(view.lastDecision?.decision.kind).toBe("stop")
  })
})

describe("ledger path containment", () => {
  it("rejects unsafe run ids before resolving journals", () => {
    expect(() => journalPath("/tmp/vernier-ledger", "../escape")).toThrow(/safe path component/)
    expect(() => journalPath("/tmp/vernier-ledger", "nested/run")).toThrow(/safe path component/)
    expect(() => journalPath("/tmp/vernier-ledger", "CON")).toThrow(/portable safe path component/)
    expect(() => journalPath("/tmp/vernier-ledger", "run.")).toThrow(/portable safe path component/)
  })

  it("keeps safe journal paths under the runs root", () => {
    expect(journalPath("/tmp/vernier-ledger", "safe.run-1_2")).toBe("/tmp/vernier-ledger/runs/safe.run-1_2/journal.jsonl")
  })

  it("rejects symlinked run directories before journal IO can escape", () => {
    const root = mkdtempSync(join(tmpdir(), "vernier-ledger-root-"))
    const outside = mkdtempSync(join(tmpdir(), "vernier-ledger-outside-"))
    mkdirSync(join(root, "runs"), { recursive: true })
    symlinkSync(outside, join(root, "runs", "safe-run"), "dir")

    expect(() => journalPath(root, "safe-run")).toThrow(/ledger run directory must not be a symlink/)
  })

  it("rejects a symlinked runs root", () => {
    const root = mkdtempSync(join(tmpdir(), "vernier-ledger-root-"))
    const outside = mkdtempSync(join(tmpdir(), "vernier-ledger-outside-"))
    symlinkSync(outside, join(root, "runs"), "dir")

    expect(() => journalPath(root, "safe-run")).toThrow(/ledger runs root must not be a symlink/)
  })
})

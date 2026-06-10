// HermesExecutor conformance to the Executor seam with an injected
// subprocess runner (the Python adapter's CommandRunner seam) — no real
// hermes binary, no network. Under test: the exact CLI invocation, the
// loose route-JSON parsing ported from RunLoop.parse_route_json, the
// output mapping, and the evidence files.

import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { HermesExecutor, parseRouteJson, type HermesRunner } from "../src/executors/hermes.js"
import { noEffects, type StepSpec } from "../src/kernel/types.js"

const ROUTE = {
  gate_decision: "approve",
  route_to_worker: true,
  worker: "Codex",
  reason: "Task is narrow, local, harmless, reviewable.",
  allowed_mutation: ["create docs/agent-workflows/runner-dry-runs/x.md only"],
}

function spec(): StepSpec {
  return {
    runId: "run-1",
    traceId: "run-1",
    loopId: "plan-work-review",
    loopVersion: "0.2.0",
    stepId: "route",
    attempt: 1,
    inputs: { task: "write the note" },
    prompt: "Route this task.",
    effects: noEffects(),
    runDir: mkdtempSync(join(tmpdir(), "looper-hermes-run-")),
    timeoutMs: 60_000,
  }
}

const workdir = (): string => mkdtempSync(join(tmpdir(), "looper-hermes-work-"))

function runnerReturning(code: number, stdout: string, stderr = ""): { runner: HermesRunner; calls: unknown[][] } {
  const calls: unknown[][] = []
  const runner: HermesRunner = async (command, args, opts) => {
    calls.push([command, args, opts])
    return { code, stdout, stderr }
  }
  return { runner, calls }
}

describe("parseRouteJson", () => {
  it("parses clean JSON", () => {
    expect(parseRouteJson(JSON.stringify(ROUTE)).gate_decision).toBe("approve")
  })
  it("extracts the JSON object out of surrounding prose (Python fallback path)", () => {
    const raw = `Here is my routing decision:\n${JSON.stringify(ROUTE)}\nLet me know.`
    expect(parseRouteJson(raw).route_to_worker).toBe(true)
  })
  it("rejects non-object JSON", () => {
    expect(() => parseRouteJson("[1,2]")).toThrow(/not a JSON object/)
  })
  it("rejects output with no JSON at all", () => {
    expect(() => parseRouteJson("I refuse to answer in JSON.")).toThrow(/no JSON object/)
  })
})

describe("HermesExecutor", () => {
  it("invokes `hermes -t clarify -z <prompt>` in the workdir (the Python HermesCli invocation)", async () => {
    const { runner, calls } = runnerReturning(0, JSON.stringify(ROUTE))
    const wd = workdir()
    const s = spec()
    await new HermesExecutor({ runner }).run(s, { workdir: wd })
    expect(calls[0]![0]).toBe("hermes")
    expect(calls[0]![1]).toEqual(["-t", "clarify", "-z", s.prompt])
    expect(calls[0]![2]).toMatchObject({ cwd: wd, timeoutMs: 60_000 })
  })

  it("maps the route JSON onto the step output: gate fields + the full route", async () => {
    const { runner } = runnerReturning(0, JSON.stringify(ROUTE))
    const result = await new HermesExecutor({ runner }).run(spec(), { workdir: workdir() })

    expect(result.status).toBe("completed")
    expect(result.output).toMatchObject({
      gateDecision: "approve",
      routeToWorker: true,
      worker: "Codex",
      reason: ROUTE.reason,
    })
    expect((result.output.route as Record<string, unknown>).allowed_mutation).toEqual(ROUTE.allowed_mutation)
  })

  it("writes route-prompt.md, route-raw.txt, route-decision.json under runDir", async () => {
    const { runner } = runnerReturning(0, `prose first\n${JSON.stringify(ROUTE)}`, "warning: something")
    const s = spec()
    const result = await new HermesExecutor({ runner }).run(s, { workdir: workdir() })

    expect(result.evidence.map((e) => e.role)).toEqual(["route-prompt", "route-raw", "route-decision"])
    for (const ref of result.evidence) expect(existsSync(ref.path)).toBe(true)
    expect(readFileSync(join(s.runDir, "route-raw.txt"), "utf8")).toContain("STDERR:\nwarning: something")
    const decision = JSON.parse(readFileSync(join(s.runDir, "route-decision.json"), "utf8"))
    expect(decision.gate_decision).toBe("approve")
    expect(decision.allowed_mutation).toEqual(ROUTE.allowed_mutation) // deep content survives the sorted rewrite
  })

  it("maps a nonzero hermes exit onto a failed StepResult and an empty route-decision.json", async () => {
    const { runner } = runnerReturning(3, "", "boom")
    const s = spec()
    const result = await new HermesExecutor({ runner }).run(s, { workdir: workdir() })
    expect(result.status).toBe("failed")
    expect(String(result.output.error)).toContain("status 3")
    expect(readFileSync(join(s.runDir, "route-decision.json"), "utf8")).toBe("{}\n")
  })

  it("maps unparseable route output onto a failed StepResult", async () => {
    const { runner } = runnerReturning(0, "I will not produce JSON today.")
    const result = await new HermesExecutor({ runner }).run(spec(), { workdir: workdir() })
    expect(result.status).toBe("failed")
    expect(String(result.output.error)).toContain("route JSON")
  })
})

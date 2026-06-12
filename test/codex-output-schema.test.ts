// The codex (OpenAI strict) schema dialect, pinned deterministically.
//
// Found live 2026-06-12: a record-shaped node (`type: "object"`, no
// `properties` — zod's z.record derivation) slipped through strictify's
// properties-gate with its schema-valued `additionalProperties` intact, and
// OpenAI strict mode 400'd the whole turn (`invalid_json_schema`). The route
// step of plan-work-review failed before the model ran. Three nets here:
//
//   1. strictify unit behavior: additionalProperties:false on EVERY
//      object-typed node, records included; null-stripping parity (R5).
//   2. An OpenAI-strict LINT over every shipped template's structured-output
//      surfaces — derived from the same zod signatures a run derives from —
//      so the next dialect regression fails in `npm test`, not live.
//   3. The behavior-preservation mechanism itself: outputFrom projections
//      run BEFORE signature validation, so a model emitting route:null/{}
//      yields the same parsed output as today.

import { describe, expect, it } from "vitest"
import { z } from "zod"
import { derivedOutputSchema, sig } from "../src/kernel/types.js"
import type { EffectObservation } from "../src/kernel/effects.js"
import { stripNullOptionals, toCodexOutputSchema } from "../src/executors/vendor/omegacode/schema.js"
import type { JSONSchema } from "../src/executors/vendor/omegacode/types.js"
import type { OutputProjection, StepResult } from "../src/kernel/types.js"
import { templateModuleFile, templateRegistration, TEMPLATES } from "./templates.js"
import { readdirSync } from "node:fs"
import { zeroUsage } from "../src/kernel/types.js"

// The exact derivation that failed live: an optional open record.
const routeShaped = z.object({
  gateDecision: z.string(),
  routeToWorker: z.boolean(),
  worker: z.string(),
  reason: z.string(),
  route: z.record(z.unknown()).optional(),
})

// ------------------------------------------------------- the strict lint
//
// Walks EVERY schema-bearing position — the same positions strictify
// recurses into (properties values, items, anyOf/oneOf/allOf elements,
// $defs/definitions values, additionalProperties/patternProperties) — and
// asserts the OpenAI-strict invariants. A top-level-only walk would share
// the fix's blind spots instead of checking them.

function lintOpenAiStrict(schema: unknown, path = "$"): string[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return []
  const node = schema as Record<string, unknown>
  const problems: string[] = []

  const types = Array.isArray(node.type) ? node.type : node.type !== undefined ? [node.type] : []
  if (types.includes("object") && node.additionalProperties !== false) {
    problems.push(`${path}: object node without additionalProperties:false`)
  }
  if (node.type === undefined && !("anyOf" in node) && !("oneOf" in node) && !("allOf" in node) && !("enum" in node) && !("const" in node) && !("$ref" in node)) {
    problems.push(`${path}: schema node with no type/anyOf/enum/const`)
  }
  if (types.includes("object") && node.properties && typeof node.properties === "object") {
    const keys = Object.keys(node.properties as Record<string, unknown>)
    const required = Array.isArray(node.required) ? (node.required as string[]) : []
    for (const k of keys) if (!required.includes(k)) problems.push(`${path}: property \`${k}\` not in required`)
  }

  for (const [k, v] of Object.entries(node)) {
    if (k === "properties" || k === "patternProperties" || k === "$defs" || k === "definitions") {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
          problems.push(...lintOpenAiStrict(sub, `${path}.${k}.${name}`))
        }
      }
    } else if (k === "items" || k === "anyOf" || k === "oneOf" || k === "allOf") {
      const list = Array.isArray(v) ? v : [v]
      list.forEach((sub, i) => problems.push(...lintOpenAiStrict(sub, `${path}.${k}[${i}]`)))
    } else if (k === "additionalProperties" && typeof v === "object" && v !== null) {
      // Live only for UN-strictified input (strictified object nodes carry
      // `false` here) — a guard that the lint can also judge raw schemas.
      problems.push(...lintOpenAiStrict(v, `${path}.additionalProperties`))
    } else if (k === "not" || k === "if" || k === "then" || k === "else") {
      problems.push(...lintOpenAiStrict(v, `${path}.${k}`))
    }
  }
  return problems
}

describe("toCodexOutputSchema: additionalProperties:false on EVERY object node", () => {
  it("coerces a record node (the z.record derivation that failed live) to additionalProperties:false", () => {
    const strict = toCodexOutputSchema(derivedOutputSchema(sig(z.object({}), routeShaped)))
    const route = (strict.properties as Record<string, JSONSchema>).route!
    expect(route.additionalProperties).toBe(false)
    expect(route.type).toEqual(["object", "null"]) // optional -> nullable, preserved
  })

  it("characterizes the property-bearing path unchanged: AP false, all keys required, optionals nullable-ized", () => {
    const strict = toCodexOutputSchema(derivedOutputSchema(sig(z.object({}), routeShaped)))
    expect(strict.additionalProperties).toBe(false)
    expect(strict.required).toEqual(["gateDecision", "routeToWorker", "worker", "reason", "route"])
    expect((strict.properties as Record<string, JSONSchema>).gateDecision!.type).toBe("string")
  })

  it("coerces an already-nullable record, a true-AP object, and a bare propertyless object alike", () => {
    expect(toCodexOutputSchema({ type: ["object", "null"], additionalProperties: {} }).additionalProperties).toBe(false)
    expect(toCodexOutputSchema({ type: "object", additionalProperties: true }).additionalProperties).toBe(false)
    expect(toCodexOutputSchema({ type: "object" }).additionalProperties).toBe(false)
  })

  it("coerces NESTED records: inside a property, inside items, inside anyOf", () => {
    const nested = toCodexOutputSchema({
      type: "object",
      properties: {
        inProp: { type: "object", additionalProperties: {} },
        inItems: { type: "array", items: { type: "object", additionalProperties: {} } },
        inAnyOf: { anyOf: [{ type: "object", additionalProperties: {} }, { type: "null" }] },
      },
      required: ["inProp", "inItems", "inAnyOf"],
    })
    expect(lintOpenAiStrict(nested)).toEqual([])
  })

  it("is idempotent: strictify(strictify(s)) === strictify(s)", () => {
    const once = toCodexOutputSchema(derivedOutputSchema(sig(z.object({}), routeShaped)))
    expect(toCodexOutputSchema(once)).toEqual(once)
  })

  it("R5: stripNullOptionals turns a null-emitted OPTIONAL field into an ABSENT key against the original schema", () => {
    const original = derivedOutputSchema(sig(z.object({}), routeShaped))
    const stripped = stripNullOptionals(
      { gateDecision: "approve", routeToWorker: true, worker: "implement", reason: "ok", route: null },
      original as JSONSchema,
    ) as Record<string, unknown>
    expect("route" in stripped).toBe(false)
    expect(stripped.gateDecision).toBe("approve") // required fields untouched
  })

  it("R5 inverse: an AUTHOR-declared nullable field keeps its explicit null — only optionals are stripped", () => {
    const declared = derivedOutputSchema(sig(z.object({}), z.object({ note: z.string().nullable(), tag: z.string().optional() })))
    const stripped = stripNullOptionals({ note: null, tag: null }, declared as JSONSchema) as Record<string, unknown>
    expect("note" in stripped).toBe(true) // .nullable() means null is a VALUE, not absence
    expect(stripped.note).toBeNull()
    expect("tag" in stripped).toBe(false) // .optional() null means absent
  })
})

describe("OpenAI-strict lint over every shipped structured-output surface", () => {
  const templateNames = readdirSync(TEMPLATES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  it("every structuredOutput step in every shipped template derives a strict-valid codex schema", async () => {
    let linted = 0
    const expectStructured: Record<string, number> = {} // template -> count, for the asserted-zero check
    for (const name of templateNames) {
      const registration = await templateRegistration(name, templateModuleFile(name))
      const steps = registration.loop.steps.filter((s) => s.structuredOutput === true)
      expectStructured[name] = steps.length
      for (const step of steps) {
        const strict = toCodexOutputSchema(derivedOutputSchema(step.signature))
        const problems = lintOpenAiStrict(strict)
        expect(problems, `${name}/${step.id}: ${problems.join("; ")}`).toEqual([])
        linted++
      }
    }
    expect(linted).toBeGreaterThanOrEqual(1) // at least the coding-review route step
    // The asserted-zero check, self-documenting rather than a silent gap:
    // smoke is the no-agent template and declares no structured outputs.
    expect(templateNames).toContain("smoke")
    expect(expectStructured["smoke"]).toBe(0)
    // Only coding-review's route exercises the record-node path this fix
    // targets; judge/distill closed shapes ride along as general dialect
    // coverage — the lint self-test below is the recurrence proof.
    expect(expectStructured["coding-review"] ?? 0).toBeGreaterThanOrEqual(1)
  })

  it("lint self-test: a bad node NESTED INSIDE an anyOf branch is caught (the walker recurses, it doesn't skim)", () => {
    const smuggled = {
      type: "object",
      properties: {
        ok: { type: "string" },
        sneaky: { anyOf: [{ type: "object", additionalProperties: {} }, { type: "null" }] },
      },
      required: ["ok", "sneaky"],
      additionalProperties: false,
    }
    const problems = lintOpenAiStrict(smuggled)
    expect(problems.some((p) => p.includes("anyOf[0]") && p.includes("additionalProperties:false"))).toBe(true)
  })

  it("lint self-test: EVERY recursion arm catches a bad node planted in it (a dropped arm cannot pass silently)", () => {
    const bad = { type: "object", additionalProperties: {} }
    const arms: Array<[string, unknown, string]> = [
      ["allOf", { allOf: [bad] }, "allOf[0]"],
      ["oneOf", { oneOf: [bad] }, "oneOf[0]"],
      ["items", { type: "array", items: bad }, "items[0]"],
      ["$defs", { type: "object", additionalProperties: false, $defs: { x: bad } }, "$defs.x"],
      ["patternProperties", { patternProperties: { "^x": bad } }, "patternProperties.^x"],
      ["not", { not: bad }, "not"],
      ["additionalProperties (raw input)", { additionalProperties: bad }, "additionalProperties"],
    ]
    for (const [label, fixture, where] of arms) {
      const problems = lintOpenAiStrict(fixture)
      expect(
        problems.some((p) => p.includes(where) && p.includes("additionalProperties:false")),
        `${label}: expected a finding at ${where}, got: ${problems.join("; ")}`,
      ).toBe(true)
    }
  })
})

describe("behavior preservation: projection runs BEFORE signature validation", () => {
  // The engine's order (engine/tick.ts step 5): output = { ...result.output,
  // ...step.outputFrom(result, effects) }, THEN signature.output.safeParse.
  // So a model emitting route: null / {} under the coerced schema yields the
  // same parsed output as today — routeRecord synthesizes the record.
  const cleanEffects: EffectObservation = { changed: [], allowed: true, unexpected: [] }

  async function routeStep() {
    const registration = await templateRegistration("coding-review", templateModuleFile("coding-review"))
    const step = registration.loop.steps.find((s) => s.id === "route")
    if (!step || !step.outputFrom) throw new Error("coding-review route step (with outputFrom) not found")
    return step as typeof step & { outputFrom: OutputProjection }
  }

  it.each([
    ["route: null", null],
    ["route: {} (empty object)", {}],
  ])("a model emitting %s parses to a synthesized route record", async (_label, emitted) => {
    const step = await routeStep()
    const reported = { gateDecision: "approve", routeToWorker: true, worker: "implement", reason: "scoped task", route: emitted }
    const result: StepResult = { status: "completed", output: reported, evidence: [], usage: zeroUsage() }
    const merged = { ...result.output, ...step.outputFrom(result, cleanEffects) }
    const parsed = step.signature.output.safeParse(merged)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const route = (parsed.data as { route: Record<string, unknown> }).route
      // EXACT projection shape: all four decision fields, nothing else —
      // a renamed/dropped field in routeRecord must fail here.
      expect(route).toEqual({ gateDecision: "approve", routeToWorker: true, worker: "implement", reason: "scoped task" })
    }
  })

  it("the FULL codex chain composes: stripNullOptionals(route:null) -> absent -> projection synthesizes -> safeParse succeeds", async () => {
    const step = await routeStep()
    const original = derivedOutputSchema(step.signature)
    const emitted = { gateDecision: "approve", routeToWorker: true, worker: "implement", reason: "scoped task", route: null }
    const stripped = stripNullOptionals(emitted, original as JSONSchema) as Record<string, unknown>
    expect("route" in stripped).toBe(false) // the codex worker's post-parse strip
    const result: StepResult = { status: "completed", output: stripped, evidence: [], usage: zeroUsage() }
    const merged = { ...result.output, ...step.outputFrom(result, cleanEffects) }
    const parsed = step.signature.output.safeParse(merged)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as { route: Record<string, unknown> }).route).toEqual({
        gateDecision: "approve",
        routeToWorker: true,
        worker: "implement",
        reason: "scoped task",
      })
    }
  })
})

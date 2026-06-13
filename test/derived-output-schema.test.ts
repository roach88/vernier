// derivedOutputSchema is the ONE source of truth for a structuredOutput step's
// provider schema (kernel/types.ts). These guard the two ways it refuses to
// hand a provider a schema that constrains nothing — caught at derivation time,
// before the paid turn, the same pre-turn posture as assertValidSchema:
//   1. a typeless top-level conversion (z.any()/z.unknown() -> {}), which a
//      strict provider rejects and a permissive one silently leaves unvalidated;
//   2. a type with no JSON Schema form anywhere (z.date(), z.bigint(), z.map…),
//      which v4's z.toJSONSchema({unrepresentable:"throw"}) turns into a loud
//      error instead of a silent {} sub-schema.

import { describe, expect, it } from "vitest"
import { z } from "zod"
import { derivedOutputSchema, sig } from "../src/kernel/types.js"

const derive = (output: z.ZodType) => () => derivedOutputSchema(sig(z.object({}), output))

describe("derivedOutputSchema: fail loud on a constraintless conversion", () => {
  it("throws when the output signature is z.any() (derives to {})", () => {
    expect(derive(z.any())).toThrow(/constrains nothing/)
  })

  it("throws when the output signature is z.unknown() (derives to {})", () => {
    expect(derive(z.unknown())).toThrow(/constrains nothing/)
  })

  it("throws on z.any().describe() — an annotation-only schema ({description}) still constrains nothing", () => {
    expect(derive(z.any().describe("a flexible blob"))).toThrow(/constrains nothing/)
  })

  it("passes a structured object through (the judge-verdict shape), optional omitted from required", () => {
    const schema = derivedOutputSchema(sig(z.object({}), z.object({ pass: z.boolean(), note: z.string().optional() })))
    expect(schema).toMatchObject({ type: "object", required: ["pass"] })
  })

  it("passes a top-level union — anyOf is structural even with no top-level `type`", () => {
    const schema = derivedOutputSchema(sig(z.object({}), z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])))
    expect(Array.isArray((schema as { anyOf?: unknown[] }).anyOf)).toBe(true)
  })

  it("throws on an unrepresentable type ANYWHERE in the output (a nested z.date())", () => {
    expect(derive(z.object({ when: z.date() }))).toThrow(/cannot be represented in JSON Schema/i)
  })
})

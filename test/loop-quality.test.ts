import { describe, expect, it } from "vitest"
import { z } from "zod"
import { evaluateLoopQuality, type LoopQualityRuleId } from "../src/kernel/loop-quality.js"
import { noEffects, sig, type Loop } from "../src/kernel/types.js"
import { retryPolicy } from "../src/kernel/policy.js"
import { templateModuleFile, templateRegistration } from "./templates.js"

const shippedTemplates = ["smoke", "coding-review", "verified-answer", "self-improving"] as const

type TemplateName = (typeof shippedTemplates)[number]

interface LoadedTemplate {
  readonly name: TemplateName
  readonly registration: Awaited<ReturnType<typeof templateRegistration>>
}

const loadedTemplates: LoadedTemplate[] = await Promise.all(
  shippedTemplates.map(async (name) => ({ name, registration: await templateRegistration(name, templateModuleFile(name)) })),
)

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "fixture-loop",
    version: "0.1.0",
    signature: sig(z.object({ input: z.string() }), z.object({ ok: z.boolean() })),
    steps: [
      {
        id: "step",
        signature: sig(z.object({ input: z.string() }), z.object({ ok: z.boolean() })),
        executor: "agent",
        effects: noEffects(),
        prompt: () => "Return JSON.",
        structuredOutput: true,
      },
    ],
    policy: retryPolicy({ maxAttempts: 2 }),
    trust: "active",
    ledger: {},
    ...overrides,
  }
}

function failingRuleIds(target: Parameters<typeof evaluateLoopQuality>[0]): LoopQualityRuleId[] {
  return evaluateLoopQuality(target).checks.filter((check) => check.status === "fail").map((check) => check.ruleId)
}

function expectFails(target: Parameters<typeof evaluateLoopQuality>[0], ruleId: LoopQualityRuleId): void {
  const report = evaluateLoopQuality(target)
  expect(report.passed).toBe(false)
  expect(report.checks.filter((check) => check.status === "fail").map((check) => check.ruleId)).toContain(ruleId)
}

function withoutStructuredOutput(step: Loop["steps"][number]): Loop["steps"][number] {
  const { structuredOutput: _structuredOutput, ...rest } = step
  return rest
}

describe("loop-quality evaluator", () => {
  it("passes every shipped template with stable rule IDs exercised", () => {
    const reports = loadedTemplates.map(({ name, registration }) => ({
      name,
      report: evaluateLoopQuality({ loop: registration.loop as Loop, live: registration.live }),
    }))

    expect(reports.map(({ name, report }) => ({ name, passed: report.passed }))).toEqual([
      { name: "smoke", passed: true },
      { name: "coding-review", passed: true },
      { name: "verified-answer", passed: true },
      { name: "self-improving", passed: true },
    ])

    const exercised = new Set(reports.flatMap(({ report }) => report.checks.map((check) => check.ruleId)))
    expect([...exercised].sort()).toEqual([
      "LQ001_TYPED_BOUNDARIES",
      "LQ002_PROVIDER_NEUTRAL_EXECUTORS",
      "LQ003_PROMPT_STEP_HAS_ENFORCEMENT",
      "LQ004_EFFECT_SCOPE_BOUNDED",
      "LQ005_SKILL_STEPS_HAVE_PROMPTS",
      "LQ006_ACTIVE_AGENT_LOOPS_ARE_MARKED_LIVE",
    ])
  })

  it("rejects prompt-backed LLM steps with no contract, structured output, observed projection, or downstream verifier", () => {
    expectFails(
      {
        loop: loop({
          steps: [
            {
              id: "answer",
              signature: sig(z.object({ input: z.string() }), z.object({ text: z.string() })),
              executor: "agent",
              effects: noEffects(),
              prompt: () => "Answer freely.",
            },
          ],
        }),
        live: true,
      },
      "LQ003_PROMPT_STEP_HAS_ENFORCEMENT",
    )
  })

  it("rejects provider ids embedded in loop data where role bindings belong", () => {
    expectFails(
      {
        loop: loop({
          steps: [
            {
              id: "provider-pinned",
              signature: sig(z.object({ input: z.string() }), z.object({ ok: z.boolean() })),
              executor: "codex",
              effects: noEffects(),
              prompt: () => "Return JSON.",
              structuredOutput: true,
            },
          ],
        }),
        live: true,
      },
      "LQ002_PROVIDER_NEUTRAL_EXECUTORS",
    )
  })

  it("rejects overbroad effect scopes", () => {
    expectFails(
      {
        loop: loop({
          steps: [
            {
              id: "writer",
              signature: sig(z.object({ input: z.string() }), z.object({ artifact: z.string() })),
              executor: "agent",
              effects: { allow: ["**"] },
              prompt: () => "Write the artifact.",
              outputFrom: () => ({ artifact: "artifact.md" }),
            },
          ],
        }),
        live: true,
      },
      "LQ004_EFFECT_SCOPE_BOUNDED",
    )
  })

  it("rejects skill-bearing promptless steps before run-time ambiguity", () => {
    expectFails(
      {
        loop: loop({
          steps: [
            {
              id: "skill-without-prompt",
              signature: sig(z.object({ input: z.string() }), z.object({ ok: z.boolean() })),
              executor: "script",
              skills: ["dry-run-note-style"],
              effects: noEffects(),
            },
          ],
        }),
        live: false,
      },
      "LQ005_SKILL_STEPS_HAVE_PROMPTS",
    )
  })

  it("rejects active prompt-backed registrations that are not marked live", () => {
    expectFails({ loop: loop(), live: false }, "LQ006_ACTIVE_AGENT_LOOPS_ARE_MARKED_LIVE")
  })

  it("makes static checks monotonic for removing safeguards from an otherwise passing loop", () => {
    const safe = loop()
    expect(evaluateLoopQuality({ loop: safe, live: true }).passed).toBe(true)

    const mutations: Array<[string, Loop]> = [
      ["remove structured output", loop({ steps: [withoutStructuredOutput(safe.steps[0]!)] })],
      ["pin provider", loop({ steps: [{ ...safe.steps[0]!, executor: "claude" }] })],
      ["widen effects", loop({ steps: [{ ...safe.steps[0]!, effects: { allow: ["*"] } }] })],
      ["hide live marker", safe],
    ]

    expect(mutations.map(([name, mutated]) => ({ name, failures: failingRuleIds({ loop: mutated, live: name === "hide live marker" ? false : true }) }))).toEqual([
      { name: "remove structured output", failures: ["LQ003_PROMPT_STEP_HAS_ENFORCEMENT"] },
      { name: "pin provider", failures: ["LQ002_PROVIDER_NEUTRAL_EXECUTORS"] },
      { name: "widen effects", failures: ["LQ004_EFFECT_SCOPE_BOUNDED"] },
      { name: "hide live marker", failures: ["LQ006_ACTIVE_AGENT_LOOPS_ARE_MARKED_LIVE"] },
    ])
  })
})

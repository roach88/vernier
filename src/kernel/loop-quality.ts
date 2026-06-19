import type { Loop, Step } from "./types.js"

export type LoopQualitySeverity = "error" | "warning"
export type LoopQualityStatus = "pass" | "fail" | "warn"

export type LoopQualityRuleId =
  | "LQ001_TYPED_BOUNDARIES"
  | "LQ002_PROVIDER_NEUTRAL_EXECUTORS"
  | "LQ003_PROMPT_STEP_HAS_ENFORCEMENT"
  | "LQ004_EFFECT_SCOPE_BOUNDED"
  | "LQ005_SKILL_STEPS_HAVE_PROMPTS"
  | "LQ006_ACTIVE_AGENT_LOOPS_ARE_MARKED_LIVE"

export interface LoopQualityCheck {
  readonly ruleId: LoopQualityRuleId
  readonly severity: LoopQualitySeverity
  readonly status: LoopQualityStatus
  readonly subject: string
  readonly detail: string
}

export interface LoopQualityReport {
  readonly loopId: string
  readonly loopVersion: string
  readonly passed: boolean
  readonly checks: readonly LoopQualityCheck[]
}

export interface LoopQualityTarget {
  readonly loop: Loop
  /** Registration-level marker: true when the template drives real provider CLIs by default. */
  readonly live?: boolean | undefined
}

const PROVIDER_IDS = new Set(["codex", "claude", "cursor", "cursor-agent", "opencode", "pi"])
const LLM_EXECUTOR_IDS = new Set(["agent", "judge", ...PROVIDER_IDS])

export function evaluateLoopQuality(target: LoopQualityTarget): LoopQualityReport {
  const { loop } = target
  const checks: LoopQualityCheck[] = []

  for (const step of loop.steps) {
    checks.push(typedBoundaryCheck(loop, step))
    checks.push(providerNeutralExecutorCheck(loop, step))
    checks.push(promptStepEnforcementCheck(loop, step))
    checks.push(effectScopeBoundedCheck(loop, step))
    checks.push(skillPromptCheck(loop, step))
  }
  checks.push(activeAgentLoopLiveCheck(target))

  return {
    loopId: loop.id,
    loopVersion: loop.version,
    passed: checks.every((check) => check.status !== "fail"),
    checks,
  }
}

function pass(ruleId: LoopQualityRuleId, subject: string, detail: string, severity: LoopQualitySeverity = "error"): LoopQualityCheck {
  return { ruleId, severity, status: "pass", subject, detail }
}

function fail(ruleId: LoopQualityRuleId, subject: string, detail: string, severity: LoopQualitySeverity = "error"): LoopQualityCheck {
  return { ruleId, severity, status: severity === "warning" ? "warn" : "fail", subject, detail }
}

function subject(loop: Loop, step?: Step): string {
  return step ? `${loop.id}.${step.id}` : loop.id
}

function typedBoundaryCheck(loop: Loop, step: Step): LoopQualityCheck {
  const hasInput = typeof step.signature?.input?.safeParse === "function"
  const hasOutput = typeof step.signature?.output?.safeParse === "function"
  if (hasInput && hasOutput) {
    return pass("LQ001_TYPED_BOUNDARIES", subject(loop, step), "step declares zod-parseable input and output signatures")
  }
  return fail("LQ001_TYPED_BOUNDARIES", subject(loop, step), "step must declare zod-parseable input and output signatures")
}

function providerNeutralExecutorCheck(loop: Loop, step: Step): LoopQualityCheck {
  if (!PROVIDER_IDS.has(step.executor)) {
    return pass("LQ002_PROVIDER_NEUTRAL_EXECUTORS", subject(loop, step), `executor \`${step.executor}\` is a role/built-in id, not a provider binding`)
  }
  return fail(
    "LQ002_PROVIDER_NEUTRAL_EXECUTORS",
    subject(loop, step),
    `step executor \`${step.executor}\` names a provider; loop data should name a role and leave provider binding to config or --executor`,
  )
}

function promptStepEnforcementCheck(loop: Loop, step: Step): LoopQualityCheck {
  if (!isPromptBacked(step)) {
    return pass("LQ003_PROMPT_STEP_HAS_ENFORCEMENT", subject(loop, step), "deterministic/non-prompt step does not need LLM-specific enforcement")
  }
  const enforced = Boolean(step.contract || step.structuredOutput || step.outputFrom || downstreamVerifier(loop, step))
  if (enforced) {
    return pass("LQ003_PROMPT_STEP_HAS_ENFORCEMENT", subject(loop, step), "prompt-backed step has a contract, structured output, observed projection, or downstream verifier")
  }
  return fail(
    "LQ003_PROMPT_STEP_HAS_ENFORCEMENT",
    subject(loop, step),
    "prompt-backed LLM step has no contract, structured output, observed output projection, or downstream verifier",
  )
}

function effectScopeBoundedCheck(loop: Loop, step: Step): LoopQualityCheck {
  const allow = step.effects?.allow ?? []
  const overbroad = allow.find((entry) => entry === "**" || entry === "*" || entry === "./**" || entry === "." || entry === "")
  if (overbroad === undefined) {
    return pass("LQ004_EFFECT_SCOPE_BOUNDED", subject(loop, step), allow.length === 0 ? "step is effect-free" : `effect scope is bounded: ${allow.join(", ")}`)
  }
  return fail("LQ004_EFFECT_SCOPE_BOUNDED", subject(loop, step), `effect scope \`${overbroad}\` is too broad for deterministic loop-quality evidence`)
}

function skillPromptCheck(loop: Loop, step: Step): LoopQualityCheck {
  if (!step.skills || step.skills.length === 0) {
    return pass("LQ005_SKILL_STEPS_HAVE_PROMPTS", subject(loop, step), "step declares no skills")
  }
  if (typeof step.prompt === "function") {
    return pass("LQ005_SKILL_STEPS_HAVE_PROMPTS", subject(loop, step), "skill-bearing step has a prompt seam for skill delivery")
  }
  return fail("LQ005_SKILL_STEPS_HAVE_PROMPTS", subject(loop, step), "skill-bearing step must have a prompt template so skills can be delivered")
}

function activeAgentLoopLiveCheck(target: LoopQualityTarget): LoopQualityCheck {
  const { loop } = target
  const usesAgent = loop.steps.some((step) => LLM_EXECUTOR_IDS.has(step.executor) || typeof step.prompt === "function" || step.structuredOutput === true)
  if (!usesAgent || loop.trust !== "active" || target.live === true) {
    return pass("LQ006_ACTIVE_AGENT_LOOPS_ARE_MARKED_LIVE", subject(loop), "registration live marker is consistent with loop trust/executor posture")
  }
  return fail("LQ006_ACTIVE_AGENT_LOOPS_ARE_MARKED_LIVE", subject(loop), "active prompt-backed loops must mark the registration live so deterministic checks do not imply auth-free execution")
}

function isPromptBacked(step: Step): boolean {
  return typeof step.prompt === "function" || step.structuredOutput === true || LLM_EXECUTOR_IDS.has(step.executor)
}

function downstreamVerifier(loop: Loop, step: Step): boolean {
  const index = loop.steps.findIndex((candidate) => candidate.id === step.id)
  if (index < 0) return false
  return loop.steps.slice(index + 1).some((candidate) => candidate.executor === "judge" || candidate.structuredOutput === true || Boolean(candidate.contract))
}

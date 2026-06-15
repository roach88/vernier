// JudgeExecutor: an independent structured-output LLM behind the Executor
// seam — LLM-as-judge is its first face; LLM-as-distiller is its second.
//
// INDEPENDENT — Ax's `grade` function, not self-critique. Each run() is a
// fresh provider conversation whose prompt contains only what the loop
// hands it (the rubric and the evidence to grade); it never shares the
// producing step's context. Decorrelating judge from producer further
// (a different model/provider) is policy-level mitigation the caller can opt
// into via the injectable worker; independence of invocation is enforced here.
//
// The id is configurable because the seam is the point: a `distill` step
// (verified answer -> one reusable rule, Pilot 3) is the SAME kind of
// executor — independent, structured-output, read-only — registered as a
// second instance under its own id: new JudgeExecutor({ id: "distill" }).
//
// THE BACKING PROVIDER IS A BINDING, NOT A PRIVILEGE. codex is only the
// default; any agent that honors a pinned read-only sandbox can fill the
// judge role: `provider` selects a constructible backend ("codex" |
// "claude-code"), and `worker` injects anything else (tests inject fakes;
// a custom runtime can hand in any Worker). The chosen provider travels on
// the AgentSpec and is exposed as `this.provider` so `vernier doctor`
// reports which binary actually backs judge/distill. opencode/pi are not
// constructible defaults because their workers refuse a read-only sandbox
// (nothing enforceable behind it — a judge that can write is not a judge);
// Cursor is not wired into this constructor yet. Both remain reachable via
// `worker`.
// Config-level judge binding is the `judge` block in vernier.config
// (`"judge": { "provider": "codex" | "claude" }` — the user-facing executor
// vocabulary, mapped onto this constructor's provider by cli/config.ts);
// the constructor seam remains for custom runtimes and injected workers.
//
// The verdict is model-emitted STRUCTURED output — the first real use of the
// StepSpec.outputSchema escape hatch. The engine derives that schema from
// the step's zod output signature (kernel/types.ts derivedOutputSchema);
// this executor refuses to run without it, because an unstructured verdict
// would be prose, not data.
//
// Sandbox: ALWAYS "read-only", by construction, regardless of the step's
// effect scope — a judge that can write is not a judge. (CodexExecutor
// derives its sandbox from the scope; here the ceiling is pinned lower.)
//
// Evidence under StepSpec.runDir: <id>-prompt.md, <id>-events.jsonl,
// <id>-verdict.json — outside the workdir, like every runner-managed file.

import type { Executor, RunContext, StepResult, StepSpec } from "../kernel/types.js"
import type { Worker } from "./vendor/omegacode/index.js"
import { CodexWorker } from "./vendor/omegacode/codex.js"
import type { AgentSpec, ProviderId } from "./vendor/omegacode/types.js"
import { ClaudeCliWorker } from "./claude.js"
import { beginWorkerStep, isRecord, requirePrompt, runWorkerStep } from "./worker-step.js"

/** Providers this executor can construct a default worker for. Both honor a
 *  pinned read-only sandbox. Any other backend: inject `worker`. */
export type JudgeProvider = "codex" | "claude-code"

export interface JudgeExecutorOpts {
  /** Executor id steps resolve against. Default "judge"; Pilot 3 registers a second instance as "distill". */
  readonly id?: string
  /** Which provider backs the verdict turn. Default "codex" — a default, not a privilege. */
  readonly provider?: JudgeProvider
  /** Injectable worker (tests pass scripted workers; any Worker fills the role). Overrides `provider` construction. */
  readonly worker?: Worker
  /** Binary for the chosen provider's default worker (codex or claude). */
  readonly bin?: string
  readonly model?: string
}

function defaultJudgeWorker(provider: JudgeProvider, bin: string | undefined): Worker {
  switch (provider) {
    case "codex":
      return new CodexWorker({ bin })
    case "claude-code":
      return new ClaudeCliWorker(bin !== undefined ? { bin } : {})
  }
}

export class JudgeExecutor implements Executor {
  readonly id: string
  /** The provider id the verdict turn runs on — `vernier doctor` probes THIS
   *  binary, so the report names what actually backs judge/distill. */
  readonly provider: ProviderId
  private readonly worker: Worker
  private readonly model: string | undefined

  constructor(opts: JudgeExecutorOpts = {}) {
    this.id = opts.id ?? "judge"
    // An injected worker carries its own provider identity; otherwise the
    // chosen (or default) provider names the constructed backend.
    this.provider = opts.worker?.id ?? opts.provider ?? "codex"
    this.worker = opts.worker ?? defaultJudgeWorker(opts.provider ?? "codex", opts.bin)
    this.model = opts.model
  }

  async run(spec: StepSpec, ctx: RunContext): Promise<StepResult> {
    const prompt = requirePrompt(this.id, spec)
    if (!spec.outputSchema) {
      throw new Error(
        `Step \`${spec.stepId}\` reached executor \`${this.id}\` without an outputSchema. ` +
          `A judge's verdict must be structured: set \`structuredOutput: true\` on the step so the engine derives the schema from its zod output signature.`,
      )
    }
    const agentSpec: AgentSpec = {
      prompt,
      provider: this.provider,
      cwd: ctx.workdir,
      sandbox: "read-only", // pinned: judges read, never write
      approval: "never",
      schema: spec.outputSchema,
      ...(this.model ? { model: this.model } : {}),
    }
    return runWorkerStep({
      executorId: this.id,
      spec,
      ctx,
      worker: this.worker,
      agentSpec,
      evidence: beginWorkerStep(spec, this.id, prompt),
      final: {
        kind: "json",
        stem: this.id,
        roles: { prompt: `${this.id}-prompt`, events: `${this.id}-events`, final: `${this.id}-verdict` },
        value: (result) => (isRecord(result.structured) ? result.structured : null),
        missingOutput: (result) => ({ error: `Judge returned no structured verdict despite the output schema (text: ${truncate(result.text)})` }),
      },
    })
  }

  /** Tear down the underlying provider process. */
  shutdown(): Promise<void> {
    return this.worker.shutdown()
  }
}

function truncate(text: string): string {
  return text.length > 200 ? text.slice(0, 199) + "…" : text
}

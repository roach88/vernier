# Orchestration Direction: Loops as Data, Steps as the Unit, Executors as the Seam

Date: 2026-06-10
Status: Proposed direction
Sources studied: this repo (looper), valkor-ai/loom, SawyerHood/omegacode, the Ax (`@ax-llm/ax`) signature pattern.

---

## 1. Recommendation in one paragraph

Rebuild looper around a single declarative object — the **Loop** — composed of typed
**Steps**, where each Step is `signature + executor + contract + effect scope`, and the
engine is a small **tick-based interpreter** that advances a journaled run one step at a
time and consults a pure **Policy** function after every step. Keep everything that makes
looper trustworthy (deterministic contracts, append-only attempts, git-diff effect
attribution, retry policies, promotion rules, evidence) but move it from *hardcoded
control flow* into *slots on the Loop object*. Collapse the orchestrator/worker dichotomy
into one agent-agnostic `Executor` protocol (omegacode's `Worker.runAgent(spec) →
AgentResult`, generalized so a deterministic Python function, an LLM judge, a CLI coding
agent, or a human are all the same kind of thing). Borrow Ax's idea that the typed
signature *is* the contract surface and the loop *is* data — but keep the loop driver
deterministic Python, never the LLM. The result: `RunLoop.run()`'s 370 lines of
Pilot-1-specific procedure become a ~150-line generic interpreter, and a coding loop, a
research loop, and a pure-script loop are all five-slot declarations differing only in
their data.

---

## 2. The single core abstraction

### The Loop: one declarative object with five slots

```
Loop = Signature        # what goes in, what must come out (typed)
     + Steps            # ordered/branching typed units of work
     + Policy           # pure fn: Observation -> Decision (continue/retry/escalate/stop)
     + Trust            # promotion level + per-step effect scopes; gates auto-execution
     + Ledger           # append-only journal of attempts, evidence, decisions
```

The **unit of orchestration is the Step**:

```
Step = Signature (in -> out, typed)
     + Executor  (who runs it: any agent, any script, any human)
     + Contract  (deterministic validation of the out-value)
     + Effects   (what it is allowed to touch; observed via snapshot diff)
```

### Why this and not the alternatives

- **Not "the agent"** (Ax's unit). An agent-centric unit makes the LLM the driver and
  determinism an afterthought. looper's whole value is that the *harness* decides what
  happens next from deterministic observations (`decide_pilot1_next_step` in
  `agent_workflows/dynamic_workflow_harness.py`). Keep that inversion. The agent is an
  Executor — a replaceable backend for one Step.

- **Not "the workflow script"** (omegacode's unit). omegacode workflows are full JS
  programs run in a hardened `node:vm` (note: my caller's framing of omegacode as a
  "deterministic DSL" is slightly off — the DSL calls are deterministic-ish, but the loop
  itself is imperative untrusted *code*, with determinism shims). That is maximally
  expressive but the loop is opaque: you cannot diff two versions of a loop, gate
  promotion on its shape, render a loop card from it, or prove what it will never do.
  looper's promotion rules (`docs/agent-workflows/loop-library.md`: a loop needs a named
  gate, trust boundary, retry rule, stop rule, trace location before leaving Draft)
  require the loop to be *inspectable data*. Code can't be audited that way; data can.

- **Not "the delivery"** (loom's unit). loom hardcodes one giant state machine —
  brainstorm → planning contract → architecture → task plan → execute → review → repair
  → deploy — behind an 1,856-line zod schema file (`src/core/contracts.ts`) and a
  2,071-line `continueDelivery` router (`src/core/operations/continue.ts`). It is a
  *product* for software delivery, not a kit for loops. The lesson is what to steal
  (inverted control, durable state, leases), not the unit.

- **Not "the LoopDefinition as registry pointers"** (looper today).
  `agent_workflows/domain/loop_definitions.py`'s `LoopDefinition` is honest config —
  `worker`, `orchestrator`, `artifact_contract_id`, `retry_policy_id`, paths — but the
  actual *sequence* (route → render prompt → snapshot → exec → diff → validate → decide
  → maybe retry once) lives hardcoded in `RunLoop.run()`
  (`agent_workflows/application/run_loop.py:461-833`). The TOML names the cast; the
  script *is* the play. That's why generalization stalled: a research loop or a
  self-improving loop has a different play, and today that means writing another
  833-line application service.

A Step is the smallest thing that has all four properties looper cares about
(typed boundary, accountable actor, deterministic check, bounded blast radius), and a
Loop is the smallest thing that can carry policy, trust, and evidence across Steps.
Everything else — routing, judging, retrying, distilling — expresses as Steps and
Policy over Steps.

### One sentence of dogma

**The loop is data; the step is typed; the executor is fungible; the policy is pure;
the ledger is append-only.**

---

## 3. API / DSL sketch (Python)

The signature idea is Ax's, ported honestly to Python: a tiny parser over
`"name:type, ... -> name:type, ..."` producing field specs, with dataclass/TypedDict
escape hatches. Values are the data plane; files are one *serialization* of values
(an `artifact:path` field), not the medium itself.

### The kernel types

```python
# agent_workflows/domain/steps.py
from typing import Protocol, Any

class Executor(Protocol):
    """Anything that can run one Step: CLI agent, API agent, script, judge, human."""
    executor_id: str
    def run(self, spec: "StepSpec", ctx: "RunContext") -> "StepResult": ...

@dataclass(frozen=True)
class StepSpec:
    step_id: str
    signature: Signature            # parsed "in -> out"
    inputs: dict[str, Any]          # validated against signature.inputs
    prompt: str | None              # rendered for LLM executors; None for scripts
    effects: EffectScope            # e.g. fs_scope("docs/agent-workflows/**"), or none()
    timeout_s: int
    sandbox: str                    # "read-only" | "workspace-write" | "danger-full-access"

@dataclass(frozen=True)
class StepResult:
    status: Literal["completed", "failed", "interrupted"]
    output: dict[str, Any]          # validated against signature.outputs
    evidence: tuple[ArtifactRef, ...]   # raw logs, prompts, diffs — into the ledger
    usage: Usage                    # tokens/cost/duration; zero for scripts
```

### A coding loop (today's Pilot 1, re-expressed)

```python
from agent_workflows import loop, step, sig, fs_scope, retry_policy

route = step(
    "route",
    sig("task:str -> approved:bool, bounded_task:str, reason:str"),
    executor="hermes",                      # an LLM gate is just a step
    contract="route-decision.v1",           # gate_decision/route_to_worker shape check
)

implement = step(
    "implement",
    sig("bounded_task:str -> artifact:path"),
    executor="codex",
    effects=fs_scope("docs/agent-workflows/**"),   # today's allowed_worker_artifact_root
    contract="dry-run-note.v1",                    # today's contracts/dry_run_note.py
)

plan_work_review = loop(
    "plan-work-review", version="0.2.0",
    signature=sig("task:str -> artifact:path, verdict:str"),
    steps=[route, implement],
    policy=retry_policy(max_attempts=2, retry_on=["contract_failed"],
                        escalate_to="needs_human", auto_execute=True),
    trust="active",                          # promotion level gates auto_execute
)
```

### A research loop (LLM-as-judge, self-correcting) — same shape

```python
research = step(
    "research",
    sig("question:str, feedback:str -> findings:str, sources:list[str]"),
    executor="claude-cli",
)

grade = step(
    "grade",
    sig("rubric:str, findings:str, sources:list[str] -> passed:bool, feedback:str"),
    executor="judge:gpt",                    # a different model on purpose — decorrelated
    contract="judge-verdict.v1",             # verdict must be well-formed to count
)

deep_research = loop(
    "deep-research", version="0.1.0",
    signature=sig("question:str, rubric:str -> findings:str, sources:list[str]"),
    steps=[research, grade],
    policy=until(lambda obs: obs.output("grade", "passed") is True,
                 max_iterations=4, escalate_to="needs_human",
                 feed_back={"research.feedback": "grade.feedback"}),
    trust="dry-run",
)
```

### A deterministic-script loop (Pilot 0, no agent at all) — same shape

```python
smoke = step(
    "smoke",
    sig("-> trace:path, ok:bool"),
    executor="script:control_plane_smoke",   # a registered Python callable
    effects=fs_scope("docs/agent-workflows/evidence/**"),
    contract="run-trace.v1",
)

control_plane_smoke = loop(
    "control-plane-smoke-test", version="0.2.0",
    signature=sig("-> ok:bool"),
    steps=[smoke],
    policy=retry_policy(max_attempts=1, retry_on=[], escalate_to="needs_human"),
    trust="dry-run",
)
```

Three different kinds of work; one shape. The engine never knows whether an executor is
Codex, a judge, or a function — that is the proof of agent-agnosticism, and it is the
exact seam omegacode validated across four providers (`src/worker/index.ts`:
`Worker.runAgent(spec, ctx) → AgentResult`, normalized `{text, structured?, status,
usage}`).

### The engine: tick, don't run

```python
engine = LoopEngine(registry, state_root)

run = engine.start(plan_work_review, inputs={"task": "..."})    # writes journal entry 0
while (decision := engine.tick(run.run_id)).kind == "continue":
    pass                                                         # each tick: one step
# decision.kind in {"done", "needs_human", "stopped"}
```

`tick()` does, generically, what `RunLoop.run()` does today by hand for Pilot 1:

1. Read journal → find next step → render `StepSpec` (validate inputs against signature).
2. Snapshot effects (today's `GitSnapshotter.snapshot()`).
3. `executor.run(spec, ctx)` → `StepResult`.
4. Diff snapshot → attribute changes → check `EffectScope` (today's `allowed`/
   `unexpected_worker_changes` logic in `assess_worker_state`).
5. Run the step's Contract over the output value (today's
   `artifact_contract.validate(...)`).
6. Build an `Observation` from *only deterministic facts* → call `loop.policy(obs)` →
   get `Decision` (continue / retry-with-prompt / escalate / stop). This is today's
   `WorkflowObservation → decide_pilot1_next_step → WorkflowDecision`, generalized.
7. Append everything — spec, result, contract checks, decision — to the run journal
   (today's `RunManifest` with append-only `WorkerAttempt`s, now also the resume log).

Because the journal is the only state, a run survives crashes, can be advanced by cron,
by a human, or by *another agent calling `looper tick`* — which is loom's `continue`
inversion, earned for free.

---

## 4. What to KEEP, DROP, and RENAME from looper

### KEEP (these are the crown jewels — most of this repo's real value)

| Today | Fate |
|---|---|
| `contracts/` (`ContractCheck`, `ContractResult`, `ContractContext`, registry) | Keep as-is conceptually; retarget from "validate this file's text" to "validate this output value" (a `path` value's content remains the common case). |
| `dynamic_workflow_harness.py` (`WorkflowObservation` → `WorkflowDecision`) | Keep the pure-function shape exactly; generalize from Pilot-1 fields to per-step observations. This *is* the Policy slot. |
| `policies/retry.py` (`LoopRetryPolicy`, `RetryPlan`, TOML-loaded, versioned ids) | Keep; becomes one Policy combinator among several (`retry_policy`, `until`, `always_escalate`). Lift the hardcoded `max_worker_attempts <= 2` into per-loop trust gating. |
| `GitSnapshotter` + worker-change attribution (`assess_worker_state`) | Keep verbatim; it becomes the generic `EffectScope` observer. This diff-based attribution is something none of the other three systems do as cleanly. |
| Append-only `RunManifest` / `WorkerAttempt` / `ArtifactRef` (`domain/runs.py`) | Keep; promote from "report written at the end" to "journal written at every tick" — it becomes the resume log too. |
| Promotion rules (Draft → Dry-run → Active, `loop-library.md`) | Keep and make first-class: `trust=` on the Loop object; `auto_execute` and sandbox ceilings derive from it. Neither loom, omegacode, nor Ax has this; it is looper's most original idea. |
| Loop cards (human intent docs) | Keep, but generate the skeleton *from* the Loop object so card and code can't drift. |
| TOML definitions + `LoopDefinitionLoader` cross-validation (definition references must match registered ids) | Keep the validation discipline; see "where definitions live" in §7. |
| `path_safety.py` | Keep verbatim. |

### DROP or collapse

| Today | Why |
|---|---|
| The orchestrator/worker dichotomy (`CapabilityRegistry.orchestrators` vs `.workers` in `capabilities.py`) | A router is just a Step whose executor is an LLM. One `executors` registry. The dichotomy is Pilot-1's cast list frozen into the type system. |
| `RunLoop.run()`'s hardcoded sequence (`run_loop.py:461-833`) | Replaced by the generic tick interpreter. This is the single biggest deletion and the whole point. |
| `Pilot1RunConfig` modes (`bundle-only`, `manual-worker`, `codex-exec`) | Modes are degenerate policies. `bundle-only` = "stop after rendering spec"; `manual-worker` = "stop before executor". Express as `engine.tick(..., stop_before="implement")` / dry-run flags, not a mode enum threaded through everything. |
| `supports_codex_exec` on `Capability` | Dies with the modes. |
| `exercise_contract_failure` / `expect_outcome` plumbing woven through the run | Becomes a test-harness concern (a fault-injecting Executor wrapper), not production-path parameters. |
| Markdown-as-data-plane (prompts and artifacts as the *only* interchange) | Values are the data plane; markdown is a rendering/serialization. `rendering/prompts.py` becomes per-step prompt templates bound to signatures. |

### RENAME

| Today | New name | Why |
|---|---|---|
| `Capability` / `CapabilityRegistry` | `Executor` / `ExecutorRegistry` | "Capability" suggests permission; this is an actor. omegacode's `Worker` naming is honest but collides with looper's narrower worker concept. |
| `dynamic_workflow_harness` | `policy` (module), `Policy` (type) | It is the policy. "Dynamic workflow harness" describes the aspiration, not the object. |
| `WorkflowObservation` / `WorkflowDecision` | `Observation` / `Decision` | Per-step now, not per-workflow. |
| `agent_workflows` (package) | `looper` | The repo already calls itself that internally; ship the name. |
| `allowed_worker_artifact_root` | `EffectScope` (per step) | One root per loop → one scope per step. |

---

## 5. What loom and omegacode each contributed

### omegacode → the executor seam, the journal, and fail-closed trust

- **The `Worker` interface is the proof that agent-agnosticism lives at the step seam.**
  `Worker.runAgent(spec: AgentSpec, ctx) → AgentResult` (`src/worker/index.ts`)
  normalizes Codex (JSON-RPC app-server), Claude Code (agent SDK), OpenCode, and pi
  behind one call with one normalized result `{text, structured?, status, usage}` and
  one error taxonomy (`AgentError{code, retryable, usage}` — failed turns still bill).
  Adopt this shape nearly verbatim as `Executor.run(StepSpec) → StepResult`. looper's
  `RuntimeFactory = Callable[[str, Path], Any]` returning `Any` is the placeholder this
  replaces.
- **Journal + replay-resume.** Every run is journaled; re-running replays completed
  agents and re-executes only the changed/unfinished suffix (`src/runtime/journal.ts`,
  resume keys via `opts.key`). looper already has the append-only `RunManifest`; merging
  "manifest" and "resume log" into one journal gets crash-resume for free.
- **Fail-closed sandbox policy.** opencode/pi can't enforce confinement, so omegacode
  *rejects* them unless the author explicitly writes `sandbox: "danger-full-access"` —
  the error names the remedy. Adopt: an Executor declares the sandboxes it can enforce;
  the engine refuses a Step whose `EffectScope`/sandbox the executor cannot honor.
- **Structured output per call** (`agent("...", { schema })`, provider-native, then
  re-validated client-side) — this is Ax's signature idea arriving from the other
  direction, and it confirms signatures-per-step is the right granularity.
- **What omegacode leaves out (and looper must not):** no semantic contracts (schema
  shape ≠ artifact validity), no policy layer (retry logic is whatever JS the author
  wrote), no trust lifecycle/promotion, and the loop is code, not data — you can't audit
  or diff it. Also no effect attribution: omegacode worktrees isolate, but nothing
  *attributes* changes the way `GitSnapshotter` + `assess_worker_state` does.

### loom → inverted control, durable runs, and a cautionary tale

- **`continue` as the universal verb.** loom's deepest idea: the agent never guesses
  the next internal command; it calls `loom continue` and the deterministic router
  returns a `RouteDecision` instruction (`src/core/operations/continue.ts`). Adopt as
  the tick model: because looper's engine is journal-backed and advances one step per
  tick, *anything* — cron, a human, Hermes, Claude Code — can drive a loop by calling
  `looper tick <run-id>`, and the engine, not the caller, knows what's next. This is
  what makes the engine genuinely *agent-agnostic at the driver level*, not just at the
  worker level.
- **Durable project-local state + operation leases.** `.loom/` as source of truth, with
  `OperationLease`s marking in-flight operations stale-able after interruption. Adopt:
  run state under `state_root` (looper already does this) plus a lease per active run so
  two tickers can't double-advance a step.
- **Evidence as protocol steps.** Verification, repair, preview, handoff are first-class
  protocol states with recorded evidence, not conventions. Confirms looper's
  evidence/trace instinct; the generalization is that *every* step result is evidence.
- **The cautionary tale.** loom's kernel is not separable from its delivery product:
  fixed phases, `contracts.ts` at 1,856 lines, `continue.ts` at 2,071 lines, schemas
  like `WorkflowClosureRequirement` hardwired to frontend user-flows. This is what
  happens when the loop is not data: every new behavior is more router code. looper
  should ship the kernel (Loop/Step/Executor/Policy/Ledger) and express "software
  delivery" as one loop *definition* in the library, never as engine code.

### Ax → the aesthetic (with one correction)

Signatures as the contract surface; tools/functions as typed composable units; loop
config (`maxSteps`, `contextPolicy`) as data. The correction looper must make: in Ax the
*policy is a natural-language prompt* ("If it fails, self-correct and try again") executed
by the LLM. looper keeps the declaration but makes the policy a pure Python function over
deterministic observations. Declarative like Ax, deterministic like looper.

---

## 6. Migration path (smallest valuable step first)

Each step lands green on the existing test suite before the next begins.

1. **Unify the executor seam** (small, immediately valuable). Collapse
   `CapabilityRegistry.{orchestrators,workers}` into one `executors` map; define the
   `Executor` protocol with `run(StepSpec) → StepResult`; wrap `HermesCli.route()` and
   `CodexCli.run_exec()` to implement it; keep `RuntimeFactory` as a deprecated shim.
   Tests: `test_capabilities.py` updated, everything else untouched.
2. **Type the step boundary.** Add `sig()` parser + `Signature` (a ~100-line module:
   parse `"a:str, b:list[str] -> c:bool"`, validate dicts against it). Wrap the two
   existing exchanges (route JSON, dry-run-note path) as signatures. Contracts gain a
   `validate_value()` entry point; `dry-run-note.v1` keeps its text checks behind it.
3. **Extract the play from the script.** Carve `RunLoop.run()` into `route` and
   `implement` Step objects plus a first-cut interpreter that walks `loop.steps`. The
   Pilot-1 TOML gains a `[[steps]]` table. `decide_pilot1_next_step` is registered as
   the `plan-work-review` policy unchanged. Behavior-identical; `test_run_loop.py` is
   the characterization net.
4. **Journal = manifest + resume.** Write the manifest incrementally per tick; add
   `engine.tick()` / `looper tick` CLI; add the operation lease. The `bundle-only` /
   `manual-worker` modes become stop-points and the mode enum dies.
5. **Prove generality with zero engine changes.** Add the deterministic-script loop
   (Pilot 0 re-expressed, `executor="script:..."`) and one research loop with a judge
   executor and an `until` policy. If either needs engine edits, the kernel is wrong —
   stop and fix before proceeding.
6. **Promotion as enforcement.** `trust=` on Loop; `auto_execute` and sandbox ceilings
   derived from it; `looper promote` flips it only when the loop-card promotion
   checklist (already written in `loop-library.md`) is satisfied by ledger evidence.

Step 1 alone is worth doing this week: it deletes the false dichotomy, gives the
`Executor` protocol a real type, and unblocks every later step.

---

## 7. Honest risks & open questions

- **Signature strings in Python are a style transplant.** `sig("a:str -> b:bool")` reads
  beautifully but Python already has types. Risk: a half-typed mini-language nobody
  trusts. Mitigation: `sig()` is sugar over a `Signature` dataclass; dataclass/TypedDict
  signatures are equally first-class. Decide early whether pydantic comes in (richer
  validation, one heavy dependency) or a hand-rolled ~100-line validator suffices.
  I lean hand-rolled until a third contract needs nesting.
- **Loop-as-data can rot into a Turing tarpit.** The moment TOML grows `if`/`while`,
  you've rebuilt a worse programming language (loom's fate, in JSON). Hard rule:
  branching and iteration live *only* in Policy, and Policy is *only* registered Python
  functions referenced by id — never code embedded in definitions. If a loop needs more
  control flow than steps + policy can express, it should be two loops, or a Step whose
  executor is itself an engine run (loop composition — explicitly out of scope for v1,
  same call omegacode made with "no nested `workflow()`").
- **Where do definitions live — TOML or Python?** Today: TOML. With steps, signatures,
  and effect scopes, TOML gets gnarly. My recommendation: loops are declared in Python
  (a `definitions/` package of plain declarations, importable, type-checked), TOML
  remains for *instance/site config* (commands, timeouts, state roots). This reverses
  the current direction of travel (`definitions/loader.py`), and Tyler should
  explicitly decide it. The promotion-rule cross-validation in the loader survives
  either way.
- **The tick model adds state-machine complexity** (leases, stale runs, replay
  semantics) that the current one-shot `run()` doesn't have. If looper's real use stays
  "Tyler runs `scripts/looper` interactively," tick/resume may be over-engineering.
  Counterpoint: every reference system (loom leases, omegacode journal/resume) converged
  on it independently, and the research/self-improving loops Tyler wants are exactly the
  long-running, interruptible kind. I'd still build `run()` as `while tick(): pass` so
  the simple case stays one command.
- **Why not just adopt omegacode?** Fair question — it has the executor seam, journal,
  viewer, four providers, momentum. Answer: omegacode deliberately rejects looper's
  three differentiators (loops-as-auditable-data, semantic contracts, trust/promotion
  lifecycle), its workflows are agent-*authored* untrusted code (a different trust
  model than Tyler's human-promoted loop library), and it is TypeScript while looper's
  contracts/policies/tests are Python. Steal its seams; keep looper's soul. But if the
  promotion/contract layer ever stops feeling load-bearing, omegacode is the honest
  fallback.
- **LLM-as-judge contracts are shallow today.** `judge-verdict.v1` can check a verdict
  is well-formed, not that it is *right*. Decorrelating judge from worker (different
  provider per step — omegacode's bake-off/second-opinion insight) is policy-level
  mitigation, not proof. Don't oversell determinism for judged loops: the deterministic
  part is the *evidence and the decision procedure*, not the judgment.
- **Pilot 1 risks regressing during step 3.** `run_loop.py` encodes many small hard-won
  behaviors (runner-managed file exclusion, note dedup, expected-outcome exit codes).
  The characterization tests must be treated as the spec; any diff in trace output
  during the extraction is a stop-the-line event.

### What Tyler must decide

1. Python-declared loops + TOML site config (recommended) vs. all-TOML definitions.
2. Hand-rolled signature validation vs. pydantic.
3. Whether tick/resume is v1 (recommended) or deferred behind one-shot `run()`.
4. Package rename `agent_workflows` → `looper` (cheap now, expensive later).
5. Whether the first generality proof (step 5) is the research loop or the script loop
   — pick whichever you'd actually use that week, because a fake example proves nothing.

---

## Addendum: the TypeScript question (2026-06-10, after Tyler's follow-up)

Tyler mainly writes TypeScript now and asked whether to follow omegacode into TS.
**Revised recommendation: option (b) — greenfield TypeScript, vendoring omegacode's
leaves (worker adapters, journal shape, worktree module) under the five-slot
architecture above. Not a fork of omegacode; not Python.** This supersedes §6's
implicit Python migration path.

### Slot-by-slot: what omegacode actually implements (re-verified against src/)

| Slot | Coverage | Evidence |
|---|---|---|
| Signature | ~30% | Per-call `schema?: JSONSchema` on `AgentOpts` (`src/dsl/types.ts`), provider-native structured output re-validated client-side (`src/worker/schema.ts`). Output-only; no in→out signature, no input validation, no step boundary. |
| Steps | 0% | The unit is `agent()` inside imperative untrusted JS run in a `node:vm` (`src/runtime/sandbox.ts` parses the `meta` literal then executes the body with Date/Math.random shims). No loop-as-data. The earlier caution holds in full. |
| Policy | 0% | `withRetry` (`src/worker/errors.ts`) is transport-level backoff on retryable `AgentError`s. Loop-level Observation→Decision is whatever JS the author wrote. |
| Trust | ~30% | Fail-closed sandbox enums (`checkSpecEnum`, `src/runtime/primitives.ts`), budget/maxAgents caps, worktree preserve-on-doubt. Confinement of untrusted code — the opposite trust model from promotion of trusted loops. No lifecycle. |
| Ledger | ~70% | `journal.jsonl` + chained v3 resume keys (`src/runtime/journal.ts`, `src/runtime/keys.ts`), resume preconditions (fileHash/args/keyVersion), events.jsonl, per-agent transcripts, heartbeat deadman. Missing: contract results, decisions, effect attribution as ledger entries. |

Net: omegacode supplies the executor seam (~2,800 lines of provider-protocol code
across `src/worker/` — codex JSON-RPC app-server, Claude agent SDK, opencode, pi,
plus `fake.ts` for tests) and a production-quality journal, and **none** of the
kernel. That argues against forking (a): the trunk of the repo — `sandbox.ts`,
`primitives.ts`'s vm-injected globals, the v3 call-tree key lineage — exists to
support workflow-as-untrusted-code, which this design rejects. Under loop-as-data,
resume keys collapse to `hash(step_id + inputs)` and the cleverest part of
omegacode becomes unnecessary. Fork the leaves, not the trunk (MIT license; vendor
freely).

### Why TS over Python (revising §7's "it is TypeScript" objection)

- §7's risk "signature strings in Python are a style transplant" dissolves in TS:
  zod/Ax-style signatures are native, and types-as-contracts is the home idiom.
- The provider adapters are the single most expensive thing to rebuild and they
  already exist in TS. In Python, that's weeks of grotty protocol work against
  worse SDKs (Claude Code's agent SDK is TS-first).
- Tyler's daily language is TS. A tool you maintain in your first language survives.
- looper's genuinely valuable parts are *designs in small pure modules*:
  `decide_pilot1_next_step` (a pure function), `GitSnapshotter` + worker-change
  attribution (a handful of git plumbing calls), retry-policy TOML, contract
  checks. Each ports in an afternoon; the Python tests port as characterization
  specs. The 833-line `RunLoop.run()` was slated for deletion in §6 anyway —
  the rewrite "loss" is mostly code we'd planned to kill.

### What must be built new in TS (no source to steal from)

1. The five-slot kernel types (Loop/Step/Signature/Policy/Trust/Ledger) and the
   tick interpreter.
2. EffectScope + GitSnapshotter-grade attribution. omegacode's `worktree.ts` only
   answers "did anything change?" for cleanup; looper's `assess_worker_state`
   answers "what changed, by whom, and was it allowed" — port that semantics.
3. The contracts registry (semantic artifact validation).
4. Trust/promotion lifecycle enforcement from ledger evidence.
5. The Policy combinators (`retryPolicy`, `until`, escalation).

### Smallest first step on the TS path

One package: vendor `src/worker/` + the journal/worktree shapes from omegacode;
define `Executor.run(StepSpec) → StepResult` as a thin rename of
`Worker.runAgent(spec, ctx) → AgentResult`; write the Loop/Step types; implement
`tick()` for a script executor only; re-express the control-plane smoke loop
(Pilot 0) and run it end-to-end with the ledger written per tick. Then port
`decide_pilot1_next_step` + GitSnapshotter attribution with their tests, and
re-express Pilot 1. The existing Python repo stays as the executable spec until
TS Pilot 1's trace output matches it.

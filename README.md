# vernier

An agent-orchestration kernel. Not a framework.

> The loop is data; the step is typed; the executor is fungible;
> the policy is pure; the ledger is append-only.

New here? Start with [docs/walkthrough.md](docs/walkthrough.md) — the guided tour, zero to mastery.

Design doc: [docs/orchestration-direction.md](docs/orchestration-direction.md)
(authoritative — this repo is its "smallest first step on the TS path").
The Python `agent_workflows` repo remains the frozen executable spec until
the TS plan-work-review trace output matches it.

## The five-slot model

Everything is one declarative object, the **Loop** ([src/kernel/types.ts](src/kernel/types.ts)):

```
Loop = Signature   # what goes in, what must come out (zod, both sides validated)
     + Steps       # ordered typed units of work
     + Policy      # pure fn: Observation -> Decision (continue/retry/escalate/stop)
     + Trust       # promotion level (draft loops may not execute)
     + Ledger      # append-only journal.jsonl of attempts, contracts, effects, decisions
```

The unit of orchestration is the **Step**:

```
Step = Signature (in -> out, typed)
     + Executor  (who runs it: script, CLI agent, API agent, judge, human — fungible)
     + Contract  (deterministic semantic validation of the output value)
     + Effects   (what it may touch; OBSERVED via snapshot diff, not just trusted)
```

The engine is a tick interpreter ([src/engine/tick.ts](src/engine/tick.ts)):
one tick = render spec → snapshot → execute → attribute changes → validate
signature + contract → pure Policy decides → append everything to the ledger →
next state. `runLoop()` is just `while (tick)`.

A coding loop, a research loop, and a pure-script loop are all this shape;
the engine never knows which kind of executor it is driving. vernier ships
NO built-in loops — the proof lives in the four starter templates
([templates/](templates), scaffolded by `vernier init`): `smoke` proves the
shape with a deterministic no-agent script (gateway / job / no-op / trace /
delivery, contract-checked by `run-trace.v1`, journaled per tick);
`coding-review` proves it with REAL agents (an LLM route gate checked by
`route-decision.v1`, then a bound agent writing one `dry-run-note.v1`-checked
artifact inside a git-observed effect scope); `verified-answer` and
`self-improving` prove the iterate-until-verified and compounding-memory
shapes on the same five slots.

## Install

Not yet on npm — the name (`vernier`) is settled; the publish itself is the
remaining step. Install from a checkout:

```sh
git clone https://github.com/roach88/vernier && cd vernier
npm install
npm run build     # tsc -> dist/ (ESM + .d.ts); bin/vernier.js then runs under PLAIN node
npm link          # optional: a global `vernier` on PATH
```

Agent providers are CLIs on PATH — `codex`, `claude` (Claude Code),
`cursor-agent`, `opencode`, `pi` — and none is required to install or to
run the test suite: `vernier doctor` tells you which are usable on this
machine, and any of them can fill any role. The embedding memory retriever
(`VERNIER_RETRIEVER=embedding`) needs `@huggingface/transformers`, an
optional peer dependency — see "Memory & recall".

## Quickstart

```sh
vernier doctor                                # which executors are usable; which loops are runnable
vernier init                                  # list the starter templates
vernier init smoke                            # scaffold the deterministic starter into . (no agent, no auth)
vernier run control-plane-smoke-test --json   # the scaffolded smoke loop end-to-end
vernier loops                                 # everything registered (your config — vernier ships no builtins)
```

## Dev flows (no build needed)

```sh
npm test                   # vitest: all fake/deterministic — no auth, no network
npm run vernier -- loops    # the CLI from source through tsx
VERNIER_LIVE=1 npm test -- coding-review.live   # gated: the coding-review template on real agents
```

`bin/vernier.js` prefers `dist/` when it exists and falls back to running
the TypeScript through tsx — after editing source, rebuild (or remove
`dist/`) before trusting the compiled bin.

## The CLI

Loops are registered by id, via `vernier.config` only — the registry ships
EMPTY (see "Starter templates" and "Write your own loop"); the `vernier`
bin drives them by name and resumes runs from their ledgers:

```sh
vernier init [template]                             # list starter templates / scaffold one into . (never overwrites)
vernier loops                                       # list registered loops (id@version, signature, trust)
vernier run <loopId> [--input '<json>'] [--input-file <path>] [--workdir <dir>]
           [--executor <stepIdOrExecutorId>=<executorId>]...
vernier tick <runId>                                # advance ONE step of an existing run from its ledger
vernier resume <runId>                              # continue an existing run to a terminal state
vernier runs                                        # list runs under the ledger root
vernier show <runId>                                # run timeline: events, per-step usage, totals
vernier stats [--loop <id>] [--last <n>]            # usage/cost roll-ups across runs, per run + per loop
vernier doctor                                      # probe executors + per-loop runnability
```

`doctor` answers "can this installation actually run its loops": every
registered executor is probed for the one thing it needs (CLI executors a
binary on PATH — claude included; judge/distill the binary of whichever
provider backs them; in-process executors nothing — probes look
things up, they never execute them), then every loop's steps are resolved
through the same binding chain a run would use and judged runnable. Exit 0
iff every registered loop is runnable; an unusable executor that no step
resolves to is reported but does not fail the doctor.

`show` renders a run's journal as a timeline: relative time offsets, contract
pass/fail with failed-check names, effect attribution, and retry/iterate
transitions made explicit (a verified-answer fail → iterate → pass arc reads at a
glance) — plus per-STEP token/duration attribution and a closing summary.
The per-step number is the one an operator tunes on; in practice the judge
step, not the answer step, eats most of the tokens. `stats` rolls the ledger
root up per run and per loop id (runs, success rate, mean iterations,
tokens, wall time, per-step usage), filtered by `--loop <id>` / `--last <n>`.
**Cost is honest:** the ledger records tokens, not prices, so `stats` shows
dollars only when you pass `--price-in <usd> --price-out <usd>` (USD per 1M
tokens) — the only other money shown is what an executor itself reported.
No prices, no invented dollar figures. Both commands are pure reads over the
journals (`src/ledger/stats.ts`); legacy and torn journals degrade
gracefully — missing usage renders blank, unknown entry types are skipped
and counted.

Agent-ergonomic by contract: every command takes `--json` (machine output on
stdout, diagnostics on stderr) and exit codes are classed — `0` success,
`1` terminal-but-not-success (needs_human/stopped) or failure, `2` usage
error, `3` run lease held. The ledger root is `$VERNIER_HOME`, else
`./.vernier`.

**Resume is replay of the ledger, not re-execution.** `vernier resume`
rebuilds the run by folding the journal's decisions through the same
state projection the live tick used, landing on the exact
(stepId, iteration, attempt) the crashed driver stood at — completed steps
return their LEDGERED outputs and are never re-run (LLM steps are
non-deterministic; side-effecting steps must not double-apply). A tick torn
mid-write (step_result journaled, decision lost) is replayed by resume key
— `hash(stepId + iteration + attempt + canonical(inputs))`, the `loop-v2`
key scheme — so even that window re-executes nothing.

**One driver per run.** `run`/`tick`/`resume` take a heartbeat lease
(`lease.json` in the run dir, pid/host/heartbeat). A live lease blocks a
second driver with exit 3; a stale lease (heartbeat older than its TTL, or
a same-host pid that no longer exists) is taken over; the lease is released
on terminal state or process exit. A crashed driver therefore never wedges
a run.

`npm test` never needs credentials, agents, or auth — agent executors are
tested against deterministic fake workers and injected subprocess runners,
and the agent templates are driven with fakes through the same binding
resolution the CLI uses. The live template paths (`VERNIER_LIVE=1 npm test
-- coding-review.live` / `verified-answer.live` / `self-improving.live`)
need whichever agent the bindings name — the shipped configs say codex, but
any wired provider can fill any role, and `vernier doctor` tells you what
is usable. Write-scoped steps run under sandbox `workspace-write` rooted at
a throwaway scratch dir — the sandbox level is DERIVED from the step's
`EffectScope` (no scope → read-only; danger-full-access is unconstructible
from a loop declaration).

Run journals land in `./.vernier/runs/<runId>/journal.jsonl` (override the
root with `$VERNIER_HOME`); agent-driven loops also drop their evidence
bundles (route JSON, transcripts, rendered prompts) in that run dir —
runner-managed evidence lives OUTSIDE the workdir by construction, so effect
attribution never excludes files by name.

## Starter templates

vernier ships **no built-in loops** — the registry is exactly what your
config registers. `vernier init` scaffolds a starter into the current
directory (config + loop module + README; it never overwrites existing
files), and the scaffold is yours to edit:

| template | loop id | teaches | needs |
|---|---|---|---|
| `smoke` | `control-plane-smoke-test` | the whole five-slot lifecycle, hand-rolled, nothing hidden | nothing — no agent, no auth |
| `coding-review` | `plan-work-review` | an LLM route gate + a contract-checked artifact in a bounded fs scope | any wired agent (bindings ship on codex; `implement` needs codex or claude for enforced writes) |
| `verified-answer` | `verified-answer` | independent judging + `until` iteration with feedback threading | any wired agent for `answer`; the judge runs on codex unless the config's `judge` block says otherwise |
| `self-improving` | `compounding-answer` | recall → answer → grade → distill → remember; memory compounds across runs | any wired agent for `answer`; judge/distill on codex by default (rebind via the `judge` block) |

The agent templates name NO provider in the loop data: steps declare the
binding target `agent`, and each scaffolded `vernier.config.json` carries
the binding (`"bindings": { "answer": "codex" }`) — visible data you point
at codex, claude, cursor-agent, opencode, or pi (`vernier doctor` says
which are usable; providers without enforced write boundaries fail closed
on write-scoped steps). Each template's README spells out its bindings and
its honest provider caveats.

## Write your own loop

The point of v1: your loops live in **your** repo, not this one. A config
file registers loop modules, executor modules, and bindings; the CLI
discovers it and merges it into the registry. The executable version of
everything below lives in
[test/fixtures/user-config](test/fixtures/user-config) — the test suite
runs it, so it cannot rot.

Three files in your own directory. First, `vernier.config.json`:

```json
{
  "loops": ["./echo-loop.mjs"],
  "executors": ["./reverse-executor.mjs"]
}
```

Relative paths resolve against the config file's directory. Discovery walks
up from cwd to the repo root, or set `$VERNIER_CONFIG`. (TS/JS configs work
too — `vernier.config.{ts,js,mjs}` default-exporting `defineConfig({...})` —
and may register loops/executors as in-place objects instead of paths.)

Second, a loop module. A Loop is plain data — zod signatures, ordered
steps, a pure policy — plus a registration wrapper for the runtime facts
data cannot carry:

```js
// echo-loop.mjs
import { z } from "zod"

/** Your own executor: ANY agent arrives like this — an id plus run(). */
const upper = {
  id: "upper",
  async run(spec) {
    return {
      status: "completed",
      output: { echoed: String(spec.inputs.message).toUpperCase() },
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
    }
  },
}

/** A pure Observation -> Decision policy. */
const policy = (obs) => {
  if (obs.stepStatus === "completed" && obs.outputValid && obs.contractValid && obs.effectsAllowed) {
    const last = obs.stepIndex + 1 >= obs.stepCount
    return { kind: last ? "stop" : "continue", classification: "success", summary: last ? "echoed; done." : "continue.", notes: [], improvement: "none" }
  }
  return { kind: "escalate", classification: "failure", summary: `step \`${obs.stepId}\` did not pass.`, notes: [], improvement: "none" }
}

export default {
  loop: {
    id: "echo-shout",
    version: "0.1.0",
    signature: { input: z.object({ message: z.string() }), output: z.object({ echoed: z.string(), verdict: z.string() }) },
    steps: [
      {
        id: "echo",
        signature: { input: z.object({ message: z.string() }), output: z.object({ echoed: z.string() }) },
        executor: "upper",
        effects: { allow: [] },
      },
    ],
    policy,
    trust: "dry-run",
    ledger: {},
  },
  summary: "User-defined echo loop.",
  signature: "message:string -> echoed:string, verdict:string",
  defaultInputs: { message: "hello vernier" },
  executors: [upper],
}
```

Third, a config-level executor — registered for EVERY loop under this
config, so any step can be bound onto it:

```js
// reverse-executor.mjs
export default {
  id: "reverse",
  async run(spec) {
    return {
      status: "completed",
      output: { echoed: [...String(spec.inputs.message)].reverse().join("") },
      evidence: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
    }
  },
}
```

Run it, then rebind the step onto a different executor — the any-agent-
any-role seam, smallest possible form:

```sh
vernier run echo-shout --json                          # output.echoed: "HELLO VERNIER"
vernier run echo-shout --executor echo=reverse --json  # output.echoed: "reinrev olleh"
```

The resolution chain: `--executor` overrides > config `bindings` > the
step's declared default. Keys are a step id (binds that step) or an
executor id (binds the role everywhere it appears). The same chain rebinds
roles onto the wired agents — every user loop's runtime registers `codex`,
`cursor-agent`, `claude`, `opencode`, and `pi` alongside your own executors, so
`--executor echo=claude` resolves; an LLM-bound step must also declare a
`prompt` template (the echo step doesn't — scripts read inputs, agents
read prompts), and the agent must be usable on this machine
(`vernier doctor`).

One more config key rebinds the built-in **judge/distill wrapper's backing
provider** — distinct from `bindings`, which re-point a step at a different
executor. The wrapper's guarantees (sandbox pinned read-only regardless of
the step's scope, structured verdicts only, verdict evidence files) are the
reason to rebind its backing rather than the step:

```json
{ "judge": { "provider": "claude" } }
```

Default `codex` when absent; values speak the executor vocabulary
(`claude`, not the internal worker id). One wrapper instance serves every
step that names `judge` — the self-improving template's `grade` AND
`distill` both ride it (per-role splits remain the job of `bindings`).
Only `codex` and `claude` can back it: opencode and pi refuse the pinned
read-only sandbox (their workers expose no enforceable sandbox — a judge
that can write is not a judge), and cursor-agent has no per-run config
plumbing to pin one yet; anything else arrives as an injected `worker` in a
`defineLoop` runtime. `vernier doctor` probes whichever binary the block
names.

Dependency lending, named honestly: a loop module's bare specifiers (`zod`
above, and `"vernier"` itself in the scaffolded templates) resolve from
the **config dir's own node_modules** when one exists — and when none does
(a fresh `vernier init` scaffold in a bare directory), the CLI retries
failed resolutions against its OWN dependency tree, so the scaffold runs
with no install step. The project's node_modules always wins (the fallback
fires only when default resolution fails); the flip side is that a
bare-dir template runs against the `zod` version vernier bundles until you
`npm install` your own. Mechanism: a `module.register()` resolve hook,
`bin/lend-deps-hooks.mjs`. Once vernier is published, prefer importing the
helpers — `sig`, `until`, `retryPolicy`, `decideNextStep`,
`fsScope`/`noEffects`, `artifactsFromEffects`, `scriptExecutor`,
`defineConfig`/`defineLoop`, and the types — from `"vernier"`;
that root export is the library surface, and it is deliberately small.

## Trust

Honest v1 status: the `Trust` slot is declared but minimally enforced —
`draft` loops refuse to execute, and that is all. There is no promotion
lifecycle yet (no ledger-evidence gates, no `vernier promote`), so
`dry-run`/`active` are labels, not guarantees.

And the boundary that actually matters: **a registered config module runs
with this process's full privileges** — loading a config or any module it
names executes that code, exactly the trust you extend to any npm script.
Effect scopes bound what a STEP may touch (observed, and for codex
OS-sandboxed; for claude enforced through Claude Code's permission modes
and toolset restriction; cursor, opencode, and pi fail
closed on write scopes); they do not sandbox the config itself. Do not point vernier at a config you would not `node` yourself.

## Memory & recall

Self-improving loops compound through a durable rule store
([src/memory/memory.ts](src/memory/memory.ts)): an append-only
`rules.jsonl` of distilled, VERIFIED rules — the self-improving template's
`remember` step is only reachable after a passing grade, by loop shape. From the loop's
perspective `recall`/`remember` stay deterministic store operations; HOW
recall ranks the store is pluggable — the **Retriever** seam on `Memory`,
three tiers:

- **lexical (the default)** — BM25 over each record's topic + rule +
  evidence text ([src/memory/retriever.ts](src/memory/retriever.ts)).
  Deterministic, auth-free, dependency-free, results ranked best-first.
  The relevance gate is the same as the old keyword overlap (a record is
  recalled iff it shares ≥ 1 query keyword), and the +1 idf variant keeps
  tiny stores recalling — a 1-rule store still surfaces its rule on a
  related goal instead of being score-filtered to nothing.
- **embedding (optional)** — cosine similarity over vectors computed at
  REMEMBER time and stored on the JSONL record, versioned with the model
  id ([src/memory/embedding.ts](src/memory/embedding.ts)). Select it with
  `VERNIER_RETRIEVER=embedding` (read where the registry constructs
  Memory). Needs `@huggingface/transformers`, an optional peer —
  `npm install @huggingface/transformers`, and
  `vernier doctor` probes it. After the one-time model download every
  embed is local: no network at query time. Records without a comparable
  embedding (every pre-embedding store, or vectors from a different
  model) stay retrievable through the lexical tier — hybrid fallback,
  never a hard cutover.
- **yours** — implement `Retriever` (exported from the root) and construct
  the store with it in a `defineLoop` runtime:

  ```ts
  import { Memory, rulesPath, type Retriever } from "vernier"

  const recencyFirst: Retriever = {
    id: "recency",
    retrieve: (_topic, records) => [...records].reverse(),
  }
  const memory = new Memory(rulesPath(".vernier"), recencyFirst)
  // defineLoop({ loop, runtime: (workdir) => ({ deps: { ..., memory }, shutdown: async () => {} }) })
  ```

  Config-level retriever registration (a `retriever` key in
  `vernier.config`) is deferred; the constructor seam is the supported path.

Determinism, stated honestly: an embedding lookup is deterministic given
the store contents and the **model version** — a different model version is
a different vector space. That is why the model id is stored on each
record, and a mismatch demotes the record to lexical retrieval instead of
comparing incomparable vectors; re-remembering a rule under the new model
re-embeds it (same content-derived id, last record wins).

## Providers

| executor | status | needs |
|---|---|---|
| `codex` | wired | `codex` on PATH; sandbox derived from EffectScope, never full-access |
| `cursor-agent` | wired | `cursor-agent` on PATH; read-only steps only (no hard sandbox for writes) |
| `claude` | wired | `claude` (Claude Code >= 2.0) on PATH; effect-free steps run on a read-only toolset (`Read,Glob,Grep`, asks auto-denied), write scopes on `acceptEdits` — edits confined to the workdir by Claude Code's workspace boundary, Bash and out-of-workspace writes denied (print mode cannot grant); permission-bypass flags are never passed |
| `opencode` | wired | `opencode` (>= 1.16.2) on PATH; noEffects() steps only — the provider has no enforceable sandbox, so write scopes fail closed and effect-free steps run unconfined (read-only intent observed post-hoc, not enforced) |
| `pi` | wired | `pi` (>= 0.79.1, `@earendil-works/pi-coding-agent`) on PATH; same posture as opencode — write scopes fail closed, effect-free steps run unconfined |
| `hermes` | optional binding | `hermes` on PATH; a router CLI behind the same seam (`--executor route=hermes`) |
| `judge` / `distill` | wired | independent structured-output grading on whichever provider backs it — codex by default, claude via `"judge": { "provider": "claude" }` in vernier.config (or `new JudgeExecutor({ provider: "claude-code" })` in a custom runtime), anything else via an injected worker; `vernier doctor` reports the bound provider's binary |

## Toolchain

Node 22 + TypeScript (strict) + tsx + vitest + zod, plain npm; `tsc` emits
`dist/` (no bundler — the source is already NodeNext ESM, and a 1:1 emit
keeps the vendored files' MIT headers intact). Node rather than bun because
the vendored code (omegacode's journal shape and its provider adapters —
Codex JSON-RPC over stdio, the subprocess JSONL workers) is written against
Node APIs and Node process semantics; staying on the same runtime keeps that
vendoring honest. zod because in TS the signature *is* the home idiom — no
mini-language parser needed (the design doc's §7 Python risk dissolves here).

## Provenance

- **Vendored from [omegacode](https://github.com/SawyerHood/omegacode)** (MIT — see [NOTICE](NOTICE)):
  the worker family under `src/executors/vendor/omegacode/` — the
  codex app-server worker + JSON-RPC protocol/transport, the subprocess
  JSONL mechanics, schema strictify/validation, the error taxonomy, the
  deterministic `FakeWorker` test double, and the cursor/opencode/pi
  adapters. All five providers — codex, cursor-agent, claude, opencode,
  pi — are wired behind the same seam; claude's adapter is vernier's own
  (it drives the Claude Code CLI; the SDK-based vendored worker was
  removed along with the SDK dependency, with its stream-event mapping
  adapted into `src/executors/claude.ts` — see NOTICE). Also adapted:
  the `journal.jsonl` shape and canonical hashing (`src/ledger/ledger.ts`);
  the Executor seam as a rename of `Worker.runAgent(spec, ctx) →
  AgentResult`. Deliberately left behind: the `node:vm` sandbox trunk, the
  workflow DSL, and the v3 call-tree resume-key lineage — under
  loop-as-data a step has stable identity, so the resume key is
  `hash(stepId + inputs)`.
- **Ported as design from the Python predecessor** (the frozen spec at
  `Dev Workflow Workshop/agent_workflows/`): `decide_pilot1_next_step` →
  `decideNextStep` (`src/kernel/policy.ts`, with its characterization
  tests), `LoopRetryPolicy` → the `retryPolicy` combinator, the contracts
  registry + `run-trace.v1` (`src/kernel/contract.ts`), the hash snapshot +
  change attribution → `src/kernel/effects.ts`, `GitSnapshotter` semantics →
  the git-aware observer (`src/kernel/git-effects.ts`), `HermesCli` + route
  parsing → `src/executors/hermes.ts`, `dry-run-note.v1` + the inline route
  approval check and the Pilot-1 prompts
  (`rendering/prompts.py`, `build_retry_prompt`) → the contracts and prompt
  templates now shipped in `templates/coding-review/`, and the loop
  definitions now shipped as the starter templates.
- **New here**: the five-slot kernel types, the tick interpreter, the
  script executor, the ledger entry types for contracts/effects/decisions
  (the gap omegacode's journal has), the `CodexExecutor` AgentResult →
  StepResult mapping with EffectScope-derived sandboxing, the pluggable
  `EffectsObserver` seam, the resume fold + replay-by-key
  (`src/engine/resume.ts`, the tick's `replayTick`), the heartbeat run
  lease (`src/engine/lease.ts`), and the `vernier` CLI + loop registry
  (`src/cli/`).

## Deliberately deferred (next steps, per the design doc)

- Trust/promotion lifecycle enforcement from ledger evidence (today only
  "draft may not execute" is enforced); a `vernier promote` command.
- npm publish — the name (`vernier`) is settled and `"private": true` is
  gone; what remains is the publish itself.
- Resuming with effect re-observation across the torn-tick window: when a
  crash lands between a step_result and its effects entry, replay assumes a
  clean scope (the before-snapshot is gone). Honest, narrow, documented in
  `replayTick`.
- Observability beyond `show`/`doctor` (run timelines, usage roll-ups);
  config-level retriever registration (semantic recall itself shipped —
  see "Memory & recall"; only the `vernier.config` plumbing is deferred).
- Loop cards generated from the Loop object; deleting the Python repo
  (Tyler's call, after reviewing the trace comparison).

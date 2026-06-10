# looper

An agent-orchestration kernel. Not a framework.

> The loop is data; the step is typed; the executor is fungible;
> the policy is pure; the ledger is append-only.

Design doc: [docs/orchestration-direction.md](docs/orchestration-direction.md)
(authoritative — this repo is its "smallest first step on the TS path").
The Python `agent_workflows` repo remains the frozen executable spec until
the TS Pilot 1 trace output matches it.

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
the engine never knows which kind of executor it is driving. Pilot 0
([src/pilot0/loop.ts](src/pilot0/loop.ts)) proves the shape with a
deterministic no-agent script: gateway / job / no-op / trace / delivery
behavior, contract-checked (`run-trace.v1`) and journaled per tick.
Pilot 1 ([src/pilot1/loop.ts](src/pilot1/loop.ts)) proves it with REAL
agents: a `hermes` route step (an LLM gate is just a Step, checked by
`route-decision.v1`) and a live `codex` implement step (the vendored
omegacode app-server worker behind the same seam, checked by
`dry-run-note.v1`, effects observed by the git-aware observer).

## Run it

```sh
npm install
npm test          # vitest: all fake/deterministic — no auth, no network
npm run pilot0    # the deterministic control-plane smoke loop
npm run pilot1    # LIVE: hermes route + real codex implement in a /tmp scratch git repo
LOOPER_LIVE=1 npm test -- pilot1.live   # the same live path as a gated test
```

`npm test` never needs credentials: agent executors are tested against
omegacode's deterministic `FakeWorker` and injected subprocess runners.
The live Pilot 1 paths (`npm run pilot1`, `LOOPER_LIVE=1`) require authed
`hermes` and `codex` CLIs on PATH; codex runs under sandbox
`workspace-write` rooted at a throwaway scratch dir — the sandbox level is
DERIVED from the step's `EffectScope` (no scope → read-only;
danger-full-access is unconstructible from a loop declaration).

Pilot 0 writes its workdir to `./.looper/work` (pass a path as the first
argument to override). Run journals land in `./.looper/runs/<runId>/journal.jsonl`
(override the root with `$LOOPER_HOME`); Pilot 1 also drops its evidence
bundle (route JSON, codex transcript, rendered `trace.md`) in that run dir —
runner-managed evidence lives OUTSIDE the workdir by construction, so effect
attribution never excludes files by name.

## Toolchain

Node 22 + TypeScript (strict) + tsx + vitest + zod, plain npm. Node rather
than bun because the code we vendor and will vendor next (omegacode's
journal shape today; its provider adapters — Claude agent SDK, Codex
JSON-RPC over stdio — in the next step) is written against Node APIs and
Node process semantics; staying on the same runtime keeps that vendoring
honest. zod because in TS the signature *is* the home idiom — no
mini-language parser needed (the design doc's §7 Python risk dissolves here).

## Provenance

- **Vendored from [omegacode](https://github.com/SawyerHood/omegacode)** (MIT — see [NOTICE](NOTICE)):
  the whole worker family under `src/executors/vendor/omegacode/` — the
  codex app-server worker + JSON-RPC protocol/transport, the subprocess
  JSONL mechanics, schema strictify/validation, the error taxonomy, the
  deterministic `FakeWorker` test double, and the claude/opencode/pi
  adapters (vendored as a family; only codex is wired live this step,
  claude.ts is excluded from compilation pending its SDK). Also adapted:
  the `journal.jsonl` shape and canonical hashing (`src/ledger/ledger.ts`);
  the Executor seam as a rename of `Worker.runAgent(spec, ctx) →
  AgentResult`. Deliberately left behind: the `node:vm` sandbox trunk, the
  workflow DSL, and the v3 call-tree resume-key lineage — under
  loop-as-data a step has stable identity, so the resume key is
  `hash(stepId + inputs)`.
- **Ported as design from Python looper** (the frozen spec at
  `Dev Workflow Workshop/agent_workflows/`): `decide_pilot1_next_step` →
  `decideNextStep` (`src/kernel/policy.ts`, with its characterization
  tests), `LoopRetryPolicy` → the `retryPolicy` combinator, the contracts
  registry + `run-trace.v1` (`src/kernel/contract.ts`), the hash snapshot +
  change attribution → `src/kernel/effects.ts`, `GitSnapshotter` semantics →
  the git-aware observer (`src/kernel/git-effects.ts`), `HermesCli` + route
  parsing → `src/executors/hermes.ts`, `dry-run-note.v1` + the inline route
  approval check → `src/pilot1/contracts.ts`, the Pilot-1 prompts
  (`rendering/prompts.py`, `build_retry_prompt`) → the prompt templates in
  `src/pilot1/loop.ts`, and both pilots' loop definitions.
- **New here**: the five-slot kernel types, the tick interpreter, the
  script executor, the ledger entry types for contracts/effects/decisions
  (the gap omegacode's journal has), the `CodexExecutor` AgentResult →
  StepResult mapping with EffectScope-derived sandboxing, and the
  pluggable `EffectsObserver` seam.

## Deliberately deferred (next steps, per the design doc)

- Wiring claude/opencode/pi behind the seam (vendored, not wired; claude
  needs `@anthropic-ai/claude-agent-sdk`); judge executors.
- Resume-from-ledger (`replay()` exists; tick does not consume it yet),
  operation leases, a `looper tick <runId>` CLI.
- Trust/promotion lifecycle enforcement from ledger evidence (today only
  "draft may not execute" is enforced).
- Policy combinators beyond `retryPolicy` (`until`, feedback threading);
  feeding failed contract checks back into the retry prompt (today the
  retry template is static; the failed checks live in the journal's
  `retryHint`).
- Loop cards generated from the Loop object; deleting the Python repo
  (Tyler's call, after reviewing the trace comparison).

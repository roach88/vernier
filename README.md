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

## Run it

```sh
npm install
npm test          # vitest: policy, ledger, tick, pilot-0 end-to-end
npm run pilot0    # run the control-plane smoke loop; prints ledger + trace paths
```

Pilot 0 writes its workdir to `./.looper/work` (pass a path as the first
argument to override) and its run journals to `./.looper/runs/<runId>/journal.jsonl`
(override the root with `$LOOPER_HOME`).

## Toolchain

Node 22 + TypeScript (strict) + tsx + vitest + zod, plain npm. Node rather
than bun because the code we vendor and will vendor next (omegacode's
journal shape today; its provider adapters — Claude agent SDK, Codex
JSON-RPC over stdio — in the next step) is written against Node APIs and
Node process semantics; staying on the same runtime keeps that vendoring
honest. zod because in TS the signature *is* the home idiom — no
mini-language parser needed (the design doc's §7 Python risk dissolves here).

## Provenance

- **Vendored/adapted from [omegacode](https://github.com/SawyerHood/omegacode)** (MIT — see [NOTICE](NOTICE)):
  the `journal.jsonl` append/load shape and canonical hashing
  (`src/ledger/ledger.ts`); the Executor seam as a rename of
  `Worker.runAgent(spec, ctx) → AgentResult`. Deliberately left behind:
  the `node:vm` sandbox trunk and the v3 call-tree resume-key lineage —
  under loop-as-data a step has stable identity, so the resume key is
  `hash(stepId + inputs)`.
- **Ported as design from Python looper** (the frozen spec at
  `Dev Workflow Workshop/agent_workflows/`): `decide_pilot1_next_step` →
  `decideNextStep` (`src/kernel/policy.ts`, with its characterization
  tests), `LoopRetryPolicy` → the `retryPolicy` combinator, the contracts
  registry + `run-trace.v1` (`src/kernel/contract.ts`), `GitSnapshotter` +
  change attribution → `src/kernel/effects.ts`, and Pilot 0's loop
  definition/card.
- **New here**: the five-slot kernel types, the tick interpreter, the
  script executor, the ledger entry types for contracts/effects/decisions
  (the gap omegacode's journal has).

## Deliberately deferred (next steps, per the design doc)

- Real agent/provider executors (vendor omegacode `src/worker/`): codex,
  claude, judges. The `Executor` interface is their stubbed seam.
- Pilot 1 (`plan-work-review`) re-expression + porting its characterization
  tests; git-aware effect attribution (current snapshot hashes all files).
- Resume-from-ledger (`replay()` exists; tick does not consume it yet),
  operation leases, a `looper tick <runId>` CLI.
- Trust/promotion lifecycle enforcement from ledger evidence (today only
  "draft may not execute" is enforced).
- Policy combinators beyond `retryPolicy` (`until`, feedback threading).

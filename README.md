# vernier

An agent-orchestration kernel. Not a framework.

> The loop is data; the step is typed; the executor is fungible;
> the policy is pure; the ledger is append-only.

## Start here

If you want to use Vernier inside an existing codebase, start in that
codebase. Vernier keeps loops, config, and ledgers project-local; the CLI can
be global, but the work happens wherever you run it.

Prerequisite: **Node 22+**.

Once Vernier is published, the normal project install is:

```sh
npm install -D vernier
npx vernier init smoke
npx vernier run control-plane-smoke-test --json
npx vernier show <runId>
```

Today, install from this checkout, then run the same CLI from your target repo:

```sh
git clone https://github.com/roach88/vernier && cd vernier
npm install
npm run build
npm link

cd /path/to/your/codebase
vernier init smoke
vernier run control-plane-smoke-test --json
vernier show <runId>
```

`vernier init smoke` scaffolds a deterministic starter into the current
directory: `vernier.config.json`, a loop module, and a README. It needs no
agent credentials. Run journals land under `./.vernier/runs/<runId>/`, with
`journal.jsonl` as the source of truth.

For a real agent-backed starter:

```sh
vernier init coding-review
vernier doctor
vernier run plan-work-review --input '{"task":"Write one scoped dry-run note artifact."}'
```

Pick one provider CLI and make sure it is on PATH before binding agent steps:

| provider | use when | setup |
|---|---|---|
| `codex` | read-only and workspace-write steps | `codex` on PATH |
| `claude` | read-only and workspace-write steps with Claude Code | `claude` on PATH |
| `cursor-agent` | read-only and workspace-write steps with Cursor | Cursor `agent` or `cursor-agent` on PATH, or `VERNIER_CURSOR_BIN`; set `VERNIER_CURSOR_MODEL=composer-2.5` to choose Composer 2.5 |
| `opencode` / `pi` | effect-free agent steps | CLI on PATH; write-scoped steps fail closed |

`vernier doctor` reports every discovered provider and then checks whether the
loops registered in the current repo are runnable. Missing providers are fine
until a registered step is actually bound to them.

## Working on Vernier itself

For contributing to this repo:

```sh
git clone https://github.com/roach88/vernier && cd vernier
npm install
npm test
npm run build
npm run typecheck
```

`bin/vernier.js` prefers `dist/` when it exists and falls back to running the
TypeScript through tsx. After editing source, rebuild or remove `dist/` before
trusting the compiled bin.

New here and want the long tour? Read
[docs/walkthrough.md](docs/walkthrough.md). Provider details live in
[docs/provider-executors.md](docs/provider-executors.md), and runnable example
modules live under [examples/getting-started](examples/getting-started).
Current architecture and operator notes live in this README and
[HANDOFF.md](HANDOFF.md). Older rationale is archived under `docs/archive/`.

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
     + Skills    (optional: Agent Skills it runs with — capabilities, dictated
                  per step and rebindable like the executor; see "Skills")
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

### Example: Codex routes, Cursor handles a delegated coding step

There is no special "orchestrator" object. The engine is Vernier; Codex can
play the route/orchestrator **step** because that step's executor binding
resolves to `codex`. A second step can delegate scoped implementation work to
`cursor-agent`.

Cursor supports both read-only and workspace-write steps in Vernier. Cursor's
CLI sandbox provides workspace-level containment; Vernier still records and
checks the actual file effects after the turn. Out-of-scope writes are
journaled and escalated by policy rather than silently accepted.

```jsonc
// vernier.config.json
{
  "loops": ["./codex-cursor-write-loop.mjs"],
  "bindings": {
    "route": "codex",
    "implement": "cursor-agent"
  }
}
```

The loop data stays provider-neutral. Both steps declare the role
`agent`; the config above is what chooses Codex for routing and Cursor for
the delegated coding step:

```js
// codex-cursor-write-loop.mjs
import { z } from "zod"
import { artifactFromEffects, defineLoop, fsScope, noEffects, retryPolicy, sig } from "vernier"

const basePolicy = retryPolicy({ maxAttempts: 1 })
const policy = (obs) => {
  const decision = basePolicy(obs)
  if (obs.stepId !== "route" || decision.kind !== "continue" || decision.classification !== "success") return decision
  if (obs.output?.decision === "reject") {
    return {
      kind: "escalate",
      classification: "no_op",
      summary: "Codex rejected the task before delegation.",
      notes: [String(obs.output.reason ?? "no reason recorded")],
      improvement: "Narrow the task until it is safe to inspect.",
    }
  }
  return { ...decision, summary: "route approved; continue to implement." }
}

const loop = {
  id: "codex-cursor-write",
  version: "0.1.0",
  signature: sig(
    z.object({ task: z.string() }),
    z.object({ decision: z.string(), artifactPath: z.string() }),
  ),
  steps: [
    {
      id: "route",
      executor: "agent",
      signature: sig(
        z.object({ task: z.string() }),
        z.object({ decision: z.enum(["delegate", "reject"]), reason: z.string() }),
      ),
      structuredOutput: true,
      effects: noEffects(),
      prompt: (spec) =>
        `Return decision=delegate only if this coding task can be implemented by writing one docs/agent-workflows file.\n\nTask: ${spec.inputs.task}`,
    },
    {
      id: "implement",
      executor: "agent",
      signature: sig(
        z.object({ task: z.string(), decision: z.string(), reason: z.string() }),
        z.object({ artifactPath: z.string() }),
      ),
      effects: fsScope("docs/agent-workflows/**"),
      outputFrom: artifactFromEffects("artifactPath", "docs/agent-workflows/**"),
      prompt: (spec) =>
        `Implement the approved task by writing exactly one file under docs/agent-workflows/. Do not edit anything else.\n\nTask: ${spec.inputs.task}`,
    },
  ],
  policy,
  trust: "dry-run",
  ledger: {},
}

export default defineLoop({
  loop,
  live: true,
  summary: "Codex gates a coding task, Cursor writes one scoped artifact.",
  signature: "task:string -> decision:string, artifactPath:string",
})
```

Run the live test case:

```sh
vernier doctor
vernier run codex-cursor-write \
  --input '{"task":"Write a short note explaining the cache invalidation strategy."}'
vernier show <runId>
```

Representative `vernier show` output, with paths and token counts varying
by machine and provider:

```
run       codex-cursor-write-20260615-021422-a91c4e
loop      codex-cursor-write@0.1.0
status    done
journal   .vernier/runs/codex-cursor-write-20260615-021422-a91c4e/journal.jsonl
--- timeline (9 events) ---
 +0.00s  ◷ run start — codex-cursor-write@0.1.0 (trust=dry-run, keys=loop-v2)
 +0.00s  ▶ route#1.1 started (codex)
 +5.84s  ✔ route#1.1 completed — in=1,184 out=147 · 5.8s
 +5.84s  ± route#1.1 effects: 0 files changed (allowed)
 +5.84s  → route#1.1 continue/success — route approved; continue to implement.
 +5.85s  ▶ implement#1.1 started (cursor-agent)
+18.20s  ✔ implement#1.1 completed — in=8,942 out=612 · 12.3s
+18.20s  ± implement#1.1 effects: 1 file changed (allowed)
+18.20s  ■ implement#1.1 stop/success — scoped artifact returned.
--- per-step usage ---
step       execs  tok-in  tok-out  time
route      1      1,184   147      5.8s
implement  1      8,942   612      12.3s
```

The underlying `journal.jsonl` is the source of truth. Abridged entries show
the same loop-as-data story as append-only facts:

```jsonl
{"type":"step_started","stepId":"route","iteration":1,"attempt":1,"executorId":"codex"}
{"type":"decision","stepId":"route","decision":{"kind":"continue","classification":"success"}}
{"type":"step_started","stepId":"implement","iteration":1,"attempt":1,"executorId":"cursor-agent"}
{"type":"step_result","stepId":"implement","status":"completed","output":{"artifactPath":"docs/agent-workflows/cache-note.md"},"outputValid":true}
{"type":"effects","stepId":"implement","observation":{"changed":["docs/agent-workflows/cache-note.md"],"allowed":true,"unexpected":[]}}
{"type":"decision","stepId":"implement","decision":{"kind":"stop","classification":"success"}}
```

That is the point of a loop as data: the step ids, signatures, effects, and
policy are stable declarative facts; provider choice is a binding layer, and
the ledger proves which executor actually ran each step.

## Dev flows

```sh
npm test                   # vitest: all fake/deterministic — no auth, no network
npm run vernier -- loops    # the CLI from source through tsx
VERNIER_LIVE=1 npm test -- coding-review.live   # gated: the coding-review template on real agents
```

## The CLI

Loops are registered by id, via `vernier.config` only — the registry ships
EMPTY (see "Starter templates" and "Write your own loop"); the `vernier`
bin drives them by name and resumes runs from their ledgers:

```sh
vernier init [template]                             # list starter templates / scaffold one into . (never overwrites)
vernier loops                                       # list registered loops (id@version, signature, trust)
vernier skills                                      # list discovered Agent Skills (config + .claude/skills); no doctor overhead
vernier run <loopId> [--input '<json>'] [--input-file <path>] [--workdir <dir>]
           [--executor <stepIdOrExecutorId>=<executorId>]...
           [--skill <stepIdOrExecutorId>=<name[,name...]>]...
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
through the same binding chain a run would use and judged runnable —
skills included: the discovered Agent Skill inventory (config > project >
user tiers, spec-invalid skills named with the violated rule) and each
step's resolved skills are reported the same way. Exit 0
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
error, `3` run lease held. Even failures are machine-readable: under `--json`
an error prints a `{ error, type, exitCode }` document to stdout (the human
prose still goes to stderr), so an agent can branch on the failure class
without parsing text. The ledger root is `$VERNIER_HOME`, else `./.vernier`.

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
| `coding-review` | `plan-work-review` | an LLM route gate + a contract-checked artifact in a bounded fs scope; `implement` carries a per-step Agent Skill | any wired agent (bindings ship on codex; write-scoped `implement` works on codex, claude, or cursor-agent) |
| `verified-answer` | `verified-answer` | independent judging + `until` iteration with feedback threading | any wired agent for `answer`; the judge runs on codex unless the config's `judge` block says otherwise |
| `self-improving` | `compounding-answer` | recall → answer → grade → distill → remember; memory compounds across runs | any wired agent for `answer`; judge/distill on codex by default (rebind via the `judge` block) |

The agent templates name NO provider in the loop data: steps declare the
binding target `agent`, and each scaffolded `vernier.config.json` carries
the binding (`"bindings": { "answer": "codex" }`) — visible data you point
at codex, claude, cursor-agent, opencode, or pi (`vernier doctor` says
which are usable; providers without enforced write boundaries, currently
opencode and pi, fail closed on write-scoped steps). Each template's README
spells out its bindings and its honest provider caveats.

## Write your own loop

The point of v1: your loops live in **your** repo, not this one. A config
file registers loop modules, executor modules, and bindings; the CLI
discovers it and merges it into the registry. The repo test suite keeps this
pattern covered in fixtures; installed users can also inspect the packaged
[examples/getting-started](examples/getting-started) modules for a runnable
small-loop setup.

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
Only `codex` and `claude` can back the config-level wrapper today: opencode
and pi refuse the pinned read-only sandbox (their workers expose no
enforceable sandbox — a judge that can write is not a judge), and Cursor is
not yet wired as a constructible judge backend. Anything else arrives as an
injected `worker` in a `defineLoop` runtime. `vernier doctor` probes
whichever binary the block names.

Dependency lending, named honestly: a loop module's bare specifiers (`zod`
above, and `"vernier"` itself in the scaffolded templates) resolve from
the **config dir's own node_modules** when one exists — and when none does
(a fresh `vernier init` scaffold in a bare directory), the CLI retries
failed resolutions against its OWN dependency tree, so the scaffold runs
with no install step. The project's node_modules always wins (the fallback
fires only when default resolution fails); the flip side is that a
bare-dir template runs against the `zod` version vernier bundles until you
`npm install` your own. Mechanism: a `module.register()` resolve hook,
`bin/lend-deps-hooks.mjs`. When Vernier is installed as a dependency, prefer
importing the helpers — `sig`, `until`, `retryPolicy`, `decideNextStep`,
`fsScope`/`noEffects`, `artifactFromEffects`, `scriptExecutor`,
`defineConfig`/`defineLoop`, and the types — from `"vernier"`;
that root export is the library surface, and it is deliberately small.

**zod 4.** vernier bundles **zod v4** and derives every structured-output
schema with its native `z.toJSONSchema` — so build your signatures with zod 4
(`npm install zod@^4` when you bring your own). The v4 break most likely to bite
an existing loop: `z.record` is now two-arg — `z.record(z.string(), valueType)`,
not the single-arg `z.record(valueType)`. A signature built with a *different*
zod than the kernel's fails schema derivation rather than degrading silently,
and `vernier doctor` surfaces the risk at rest: a `structuredOutput` step whose
schema won't derive is reported blocked, and a second `zod` resolvable above
your project (the classic `~/node_modules/zod` footgun) prints a non-fatal
warning.

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
and toolset restriction; for cursor-agent contained by Cursor's sandbox;
opencode and pi fail closed on write scopes); they do not sandbox the config
itself. Do not point vernier at a config you would not `node` yourself.

## Memory & recall

Self-improving loops compound through a durable rule store
([src/memory/memory.ts](src/memory/memory.ts)): an append-only
`rules.jsonl` of distilled, VERIFIED rules — the self-improving template's
`remember` step is only reachable after a passing grade, by loop shape. From the loop's
perspective `recall`/`remember` stay deterministic store operations; HOW
recall ranks the store is pluggable — the **Retriever** seam on `Memory`,
with one built-in tier:

- **lexical (the default)** — BM25 over each record's topic + rule +
  evidence text ([src/memory/retriever.ts](src/memory/retriever.ts)).
  Deterministic, auth-free, dependency-free, results ranked best-first.
  The relevance gate is the same as the old keyword overlap (a record is
  recalled iff it shares ≥ 1 query keyword), and the +1 idf variant keeps
  tiny stores recalling — a 1-rule store still surfaces its rule on a
  related goal instead of being score-filtered to nothing.
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

Determinism, stated honestly: the built-in retriever is lexical BM25 over
the JSONL store contents. If you need vectors, supply a custom
`Retriever` and own its model/version semantics in that implementation.

## Providers

| executor | status | needs |
|---|---|---|
| `codex` | wired | `codex` on PATH; sandbox derived from EffectScope, never full-access |
| `cursor-agent` | wired | Cursor CLI `agent` or `cursor-agent` on PATH, or `VERNIER_CURSOR_BIN`; supports read-only and workspace-write, with `VERNIER_CURSOR_MODEL` for model selection |
| `claude` | wired | `claude` (Claude Code >= 2.0) on PATH; effect-free steps run on a read-only toolset (`Read,Glob,Grep`, asks auto-denied), write scopes on `acceptEdits` — edits confined to the workdir by Claude Code's workspace boundary, Bash and out-of-workspace writes denied (print mode cannot grant); permission-bypass flags are never passed; Agent Skills delivered natively (a synthesized session `--plugin-dir` plugin — see "Skills") |
| `opencode` | wired | `opencode` (>= 1.16.2) on PATH; noEffects() steps only — the provider has no enforceable sandbox, so write scopes fail closed and effect-free steps run unconfined (read-only intent observed post-hoc, not enforced) |
| `pi` | wired | `pi` (>= 0.79.1, `@earendil-works/pi-coding-agent`) on PATH; same posture as opencode — write scopes fail closed, effect-free steps run unconfined |
| `judge` / `distill` | wired | independent structured-output grading on whichever provider backs it — codex by default, claude via `"judge": { "provider": "claude" }` in vernier.config (or `new JudgeExecutor({ provider: "claude-code" })` in a custom runtime), anything else via an injected worker; `vernier doctor` reports the bound provider's binary |

## Skills

vernier implements the [Agent Skills](https://agentskills.io) open standard
(a skill = a directory with a spec-validated `SKILL.md`), so a step can
dictate *capabilities* the same way it dictates an executor — per step,
across every provider:

```js
{ id: "review", executor: "agent", skills: ["security-review"], prompt: …, effects: noEffects() }
```

**Resolution mirrors executors** — the same layered chain, the same key
vocabulary (a step id, or an executor id to bind a role everywhere):

```
--skill review=security-review     >   config skillBindings   >   the step's declared skills
--skill review=                        (clears the step's skills)
```

A step can carry several skills, so repeated/comma'd `--skill` flags for one
key *accumulate* (`--skill r=a --skill r=b` → `a,b`), where `--executor`
(one executor per step) is last-wins. An empty value (`--skill r=`) clears,
and clearing wins over any accumulation for that key.

**Discovery** (only paid for when a step actually names a skill):
`vernier.config` `skills` paths (a `SKILL.md`, a skill dir, or a parent dir
of skill dirs) > `<project>/.claude/skills` > `~/.claude/skills` — earlier
tiers win name collisions; duplicate names within the config tier are an
error. Invalid skills in the standard locations are reported by `vernier
doctor` with the violated spec rule, never silently hidden.

**Delivery is the executor's declared mode.** Claude Code gets the skill
NATIVELY: vernier synthesizes a session plugin under the run's ledger dir
and passes `--plugin-dir` (verified against claude 2.1.x: plugin skills
load even under vernier's hermetic `--setting-sources ""`), so the spec's
progressive disclosure survives — the model sees name + description and
loads the body on demand, namespaced `vernier-skills:<name>`; the prompt
gains only a short use-these directive, and the synthesized plugin doubles
as evidence of exactly what the step ran with. Every other executor gets
the pragmatic one-shot equivalent: the `SKILL.md` body embedded in the
step prompt, delimited (`<skill name=… dir=…>`) and attributed — and the
skill is first snapshotted under the run dir (the same guard + copy native
delivery uses), so the fence's `dir` names an immutable copy: bundled
files (`scripts/`, `references/`) the agent reads cannot drift from what
the ledger recorded. Both modes refuse a skill whose tree contains a
symlink (a skill dir that IS a symlink — the marketplace install shape —
is fine: it's resolved first). The ledger records each `step_started`'s
resolved skills and delivery mode. Skill-bearing steps must have a prompt
template — a missing skill, like a missing executor, fails before the
first journal write, and `vernier doctor` reports resolvable/missing
skills per step.

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
  the git-aware observer (`src/kernel/git-effects.ts`), `dry-run-note.v1` + the inline route
  approval check and the Pilot-1 prompts
  (`rendering/prompts.py`, `build_retry_prompt`) → the contracts and prompt
  templates now shipped in `templates/coding-review/`, and the loop
  definitions now shipped as the starter templates.
- **New here**: the five-slot kernel types, the tick interpreter, the
  script executor, the Agent Skills subsystem (`src/skills/skills.ts`:
  the agentskills.io spec parser, three-tier discovery, the skill binding
  chain, the symlink-containment guard, snapshot delivery for both modes),
  the ledger entry types for contracts/effects/decisions
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
- Observability beyond `show`/`stats`/`doctor` (those already cover run
  timelines, per-step usage, and cost roll-ups); config-level retriever
  registration (semantic recall itself shipped — see "Memory & recall";
  only the `vernier.config` plumbing is deferred).
- Loop cards generated from the Loop object; deleting the Python repo
  (Tyler's call, after reviewing the trace comparison).

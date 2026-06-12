# vernier, from zero to mastery

A guided tour for someone who has never seen this tool. The
[README](../README.md) is the reference card — quickstart, command surface,
the short write-your-own-loop tutorial. This document is the long way
around: you will run a loop without spending a token, read its ledger line
by line, watch real agent runs iterate and learn, build a loop of your own,
crash it on purpose, and resume it.

Every command here was actually executed. The deterministic sections were
re-run for real on 2026-06-11; output that needs live, authed agent CLIs is
not faked either — it is transcribed from real runs of 2026-06-10 and
labeled with its provenance each time.

---

## 1. What this is

vernier is an agent-orchestration kernel. Everything it can do is one
declarative object — the **Loop** — with five slots, driven by a
deterministic tick interpreter. Here is a complete, runnable loop — the
loop the `smoke` starter template scaffolds, lightly inlined from
[templates/smoke/smoke-loop.mjs](../templates/smoke/smoke-loop.mjs) (the
source keeps the id, version, and trace root in constants; §3 scaffolds and
runs it):

```js
const loop = {
  id: "control-plane-smoke-test",
  version: "0.2.0",
  signature: {
    input: z.object({ jobName: z.string(), upstreamChanged: z.boolean().optional() }),
    output: z.object({ ok: z.boolean(), trace: z.string() }),
  },
  steps: [
    {
      id: "smoke",
      signature: {
        input: z.object({ jobName: z.string(), upstreamChanged: z.boolean().optional() }),
        output: smokeOutput,
      },
      executor: "script:control-plane-smoke",
      contract: "run-trace.v1",
      effects: { allow: ["evidence/traces/control-plane-smoke-test/**"] },
    },
  ],
  policy,
  trust: "dry-run",
  ledger: {},
}
```

That is the whole program. No run() method, no workflow script, no graph
builder. The five slots carry everything, and each slot is one piece of
the project's dogma:

**The loop is data.** A Loop is a value: id, version, signature, steps,
policy, trust, ledger. There is no control flow to read, because there is
no control flow — the generic interpreter in
[src/engine/tick.ts](../src/engine/tick.ts) advances any loop one step at a
time. A coding loop, a research loop, and a pure-script loop differ only in
their data. Because the loop is data, it can be diffed, versioned,
registered from a config file, and rendered into documentation without
executing anything.

**The step is typed.** The unit of orchestration is the Step:
`signature + executor + contract + effects`. The signature is a zod
`in -> out` pair, validated on both sides at runtime — the engine, not the
executor, decides whether an output counts. Inputs flow through a shared
data plane (loop inputs plus every completed step's outputs, by field
name), and each step's input schema picks what it needs from that plane.

**The executor is fungible.** An executor is anything with an id and
`run(spec, ctx) -> StepResult`: a deterministic script, the codex CLI, the
claude CLI, an LLM judge, a human at a keyboard. Steps name an executor
*id*, and the binding is resolved at run time — so any agent can fill any
role (`--executor route=hermes`), and swapping providers is a rebind, not
a rewrite.

**The policy is pure.** After every step the engine builds an Observation —
deterministic facts only: step status, output validity, contract checks,
effect attribution — and calls a pure function that returns a Decision:
`continue`, `retry`, `iterate`, `escalate`, or `stop`. The policy never
reads files, never calls a model, never sees the clock. That purity is what
makes every decision replayable from the ledger.

**The ledger is append-only.** Every attempt, contract result, effect
observation, and decision is appended to `journal.jsonl` as it happens.
The journal is the only durable state a run has: `vernier show` renders it,
`vernier stats` rolls it up, and `vernier resume` rebuilds a crashed run
from it without re-executing completed steps. Nothing is ever rewritten.

---

## 2. Install & preflight

Not yet on npm; install from a checkout:

```sh
git clone https://github.com/roach88/vernier && cd vernier
npm install
npm run build     # tsc -> dist/; bin/vernier.js then runs under PLAIN node
npm link          # optional: a global `vernier` on PATH
```

Without `npm link`, substitute `node bin/vernier.js` (or `npm run vernier --`)
everywhere `vernier` appears below. Without `npm run build`, the bin falls
back to running the TypeScript through tsx — fine for development, but note
the gotcha in §11: once `dist/` exists, it wins.

### Global or per-project?

Both are right; they answer different needs:

- **Global (`npm link`, or `npm install -g` once published)** puts the
  `vernier` CLI on your PATH so you can run it from anywhere. This is all
  you need to *drive* loops.
- **Per-project (`npm install vernier` in your repo)** pins the library
  surface your loop modules import — `import { sig, until, retryPolicy, … }
  from "vernier"` resolves from the project's own `node_modules` (and
  brings `zod` with it). Strictly speaking you can defer this: when a
  project has no `node_modules`, the CLI lends its own copies of `vernier`
  and its dependencies to config modules, so scaffolds run before any
  install. Installing per-project is still the hygiene that pins YOUR
  versions — and once present, they win over the lent ones.
- **Either way, everything you DO with vernier is per-project.** Config
  discovery always starts at your current directory and walks up to the
  repo root (`vernier.config.{ts,js,mjs,json}`, or `$VERNIER_CONFIG`); the
  ledger root is `$VERNIER_HOME`, else `./.vernier` *under your cwd*. A
  global CLI does not create global state — it operates on the project you
  are standing in.

So the comfortable setup is: link the CLI globally, install the library in
each project that defines loops.

Then ask the installation what it can actually run:

```sh
vernier doctor
```

Real output from the machine this walkthrough was written on — a fresh
install, before anything is registered:

```
EXECUTORS
  ok  codex                        `codex` on PATH (/Users/tyler/.local/bin/codex)
  !!  cursor-agent                 `cursor-agent` not found on PATH
  ok  claude                       `claude` on PATH (/Users/tyler/.local/bin/claude)
  ok  opencode                     `opencode` on PATH (/Users/tyler/.opencode/bin/opencode)
  ok  pi                           `pi` on PATH (/Users/tyler/.bun/bin/pi)
  ok  judge                        `codex` on PATH (/Users/tyler/.local/bin/codex)
  ok  hermes                       `hermes` on PATH (/Users/tyler/.local/bin/hermes)
  ok  recall                       in-process executor (module loaded)
  ok  remember                     in-process executor (module loaded)
  ok  memory:lexical               in-process retriever (no external dependency)

LOOPS
  none registered — nothing is broken, and nothing can run yet.
  Scaffold a starter with `vernier init` (templates) or register loops via vernier.config.

no loops registered; the executor probes above say what this machine could run.
```

How to read it:

- **EXECUTORS** probes each executor for the one thing it needs: CLI
  executors a binary on PATH (claude included — the Claude Code CLI, like
  every other provider; judge/distill the binary of whichever provider
  backs them — codex above, `claude` once the config says
  `"judge": { "provider": "claude" }`), in-process executors nothing. Probes look things up; they
  never execute anything. `ok` means usable, `!!` means not usable *as
  installed* — above, `cursor-agent` is missing. With zero loops
  registered, doctor probes the baseline set every config loop's runtime
  would get, so a fresh install still learns what this machine could run.
- **LOOPS** resolves every registered loop's steps through the same binding
  chain a run would use and judges each loop runnable or not. vernier ships
  **no built-in loops**, so a fresh install registers none — that is the
  honest empty state above, and it exits 0: nothing is broken.
- **Exit code** is 0 iff every registered loop is runnable (vacuously true
  here). An unusable executor that **no step resolves to** never fails the
  doctor; wire a step to a missing executor and doctor exits 1 — that is
  your CI preflight.

---

## 3. First run — no LLM, no auth

A fresh install has no loops (`vernier loops` will tell you exactly that,
and what to do about it). Scaffold the deterministic starter — in your own
project directory, not the vernier checkout:

```sh
vernier init smoke
```

```
scaffolded template `smoke` into /private/tmp/quickstart-baiAmP:
  README.md
  smoke-loop.mjs
  vernier.config.json

next steps:
  vernier loops             the scaffolded config registers `control-plane-smoke-test`
  vernier run control-plane-smoke-test
  vernier doctor            probe what this machine can actually run
```

(`vernier init` with no argument lists all four starter templates — smoke,
coding-review, verified-answer, self-improving — with what each requires.
`init` never overwrites existing files. The scaffolded modules' bare
specifiers — `zod`, and `"vernier"` in the agent templates — resolve from
your project's `node_modules` when you have one; in a bare directory the
CLI lends its own copies, so the scaffold runs immediately. Your project's
versions always win once installed.)

The scaffold is three files: a `vernier.config.json` that registers the
loop module, the loop module itself (the five slots from §1, plus the
executor and registration — every line yours to edit), and a README. The
config is discovered by walking up from your cwd, so the loop is already
registered:

```sh
vernier loops
```

```
control-plane-smoke-test@0.2.0  trust=dry-run  source=/private/tmp/quickstart-baiAmP/smoke-loop.mjs
  jobName:string, upstreamChanged?:boolean -> ok:boolean, trace:path
  Deterministic no-agent control-plane smoke (gateway/job/no-op/trace/delivery).
```

`control-plane-smoke-test` is a deterministic, script-only loop. Run it:

```sh
vernier run control-plane-smoke-test
```

```
loop      control-plane-smoke-test@0.2.0
run       control-plane-smoke-test-20260611160811-9b03da
status    done
decision  stop / success — step `smoke` completed, its contract passed, and all changes stayed in scope; the loop is done.
output    {"ok":true,"trace":"evidence/traces/control-plane-smoke-test/control-plane-smoke-test-20260611160811-9b03da.md"}
ledger    /private/tmp/quickstart-baiAmP/.vernier/runs/control-plane-smoke-test-20260611160811-9b03da/journal.jsonl
--- ledger entries ---
  meta          control-plane-smoke-test@0.2.0 keys=loop-v2
  step_started  smoke iter=1 attempt=1
  step_result   smoke iter=1 attempt=1 status=completed
  contract      smoke iter=1 attempt=1 run-trace.v1 valid=true
  effects       smoke iter=1 attempt=1 changed=[evidence/traces/control-plane-smoke-test/control-plane-smoke-test-20260611160811-9b03da.md] allowed=true
  decision      smoke iter=1 attempt=1 -> stop/success
```

Exit code 0. Add `--json` to any command for machine output on stdout,
diagnostics on stderr. Now render the run as a timeline:

```sh
vernier show control-plane-smoke-test-20260611160811-9b03da
```

```
run       control-plane-smoke-test-20260611160811-9b03da
loop      control-plane-smoke-test@0.2.0
status    done
last      smoke (iteration 1, attempt 1)
started   2026-06-11T16:08:11.048Z
workdir   /private/tmp/quickstart-baiAmP/.vernier/work
journal   /private/tmp/quickstart-baiAmP/.vernier/runs/control-plane-smoke-test-20260611160811-9b03da/journal.jsonl
--- timeline (6 events) ---
+0.00s  ◷ run start — control-plane-smoke-test@0.2.0 (trust=dry-run, keys=loop-v2)
+0.00s  ▶ smoke#1.1 started (script:control-plane-smoke)
+0.00s  ✔ smoke#1.1 completed — in=0 out=0 · 0ms
+0.00s  ✔ smoke#1.1 contract run-trace.v1 passed
+0.00s  ± smoke#1.1 effects: 1 file changed (allowed)
+0.00s  ■ smoke#1.1 stop/success — step `smoke` completed, its contract passed, and all changes stayed in scope; the loop is done.
--- per-step usage ---
step   execs  tok-in  tok-out  time
smoke  1      0       0        0ms
--- summary ---
status      done (1 iteration, 1 step run)
wall        1ms (busy 0ms)
tokens      in=0 out=0
```

A guided read:

- **Offsets** are relative to run start. Everything here is +0.00s because
  the script runs in a millisecond; live runs spread out (§5–7).
- **The slot notation** `smoke#1.1` is `stepId#iteration.attempt` — which
  pass over the step sequence, and which attempt within it.
- **The glyphs**: `◷` run start · `▶` step started · `✔` completed (also a
  passing contract) · `✖` failed (also a failing contract) · `⊘`
  interrupted · `±` effects in scope · `⚠` effects OUT of scope · then the
  decision: `→` continue · `↻` retry · `⟲` iterate · `‼` escalate · `■`
  stop.
- **The contract line** is deterministic semantic validation of the output
  *value* — here `run-trace.v1` checked that the trace file exists, has the
  right heading, records the trace/loop ids, a classification, and an
  improvement candidate.
- **The effects line** is observed, not trusted: the engine snapshots the
  workdir before the step and attributes every changed file against the
  step's declared scope afterward. "1 file changed (allowed)" means the
  diff stayed inside `fsScope("evidence/traces/control-plane-smoke-test/**")`.
- **The decision line** is the pure policy's verdict, recorded verbatim.

And list what the ledger root knows about:

```sh
vernier runs
```

```
control-plane-smoke-test-20260611160811-9b03da  control-plane-smoke-test@0.2.0  done  last=smoke (iteration 1, attempt 1)  started=2026-06-11T16:08:11.048Z
```

You have now seen a complete loop lifecycle — scaffold, run, journal,
timeline, listing — without an API key in sight. The artifact itself is
real too:

```sh
head -12 .vernier/work/evidence/traces/control-plane-smoke-test/control-plane-smoke-test-20260611160811-9b03da.md
```

```
# Trace: control-plane-smoke-test-20260611160811-9b03da

| Field | Value |
|---|---|
| `trace_id` | `control-plane-smoke-test-20260611160811-9b03da` |
| `loop_id` | `control-plane-smoke-test` |
| `loop_version` | `0.2.0` |
| `orchestrator` | vernier engine |
| `worker` | No-agent script |
| `model_or_provider` | None |
```

This run was made in a truly bare scratch dir (`/private/tmp/quickstart-baiAmP`
— no `node_modules` anywhere up its path, no install step) with the compiled
bin — exactly the scaffolded experience, nothing staged.

---

## 4. The anatomy of a tick

What just happened, slot by slot, against the smoke template's actual
source (now sitting in your scaffold dir as `smoke-loop.mjs`).

**Signature.** `vernier run` parsed your inputs (here the registered
default, `{ jobName: "watch-upstream" }`)
against `loop.signature.input` before anything executed. Bad inputs are a
usage error (exit 2) — no journal is ever written for a run that could not
have been valid.

**Steps.** The engine took step 0, `smoke`, and validated the data plane
against the *step's* input schema. One tick then does, in order
([src/engine/tick.ts](../src/engine/tick.ts)):

1. **Render the spec** — inputs validated, prompt template rendered (none
   here; scripts read inputs), resume key computed:
   `hash(stepId + iteration + attempt + canonical(inputs))`.
2. **Snapshot** the workdir (hash observer here; git-aware observer for
   repo workdirs).
3. **Execute** the executor — `script:control-plane-smoke`, an in-process
   function that simulates the control-plane checks and writes the trace
   file. An executor that throws becomes a `failed` StepResult; the engine
   does not crash.
4. **Attribute changes** — diff the snapshot against the workdir, classify
   every changed path against `fsScope(...)`.
5. **Validate** — output against the step signature, then the contract
   (`run-trace.v1`) against the output value.
6. **Decide** — build the Observation, call the pure policy. The smoke
   template's policy is a hand-rolled pure function with a 1-attempt
   budget: pass → continue/stop, fail → escalate (no retry).
7. **Append everything** to the ledger and project the next state.

`vernier run` is `startRun` + `while (tick)`. Nothing else.

**Policy** saw: status `completed`, output valid, contract valid, effects
allowed, last step of the sequence → `stop/success`, and the run is `done`.

**Trust** is `dry-run`. Honest status of this slot today: `draft` loops
refuse to execute, and that is the only enforcement — `dry-run` and
`active` are labels awaiting the promotion lifecycle.

**Ledger.** The journal lives at
`$VERNIER_HOME/runs/<runId>/journal.jsonl` (default root `./.vernier`) and
holds exactly six entries for this run — you already read all six in the
`--- ledger entries ---` block above: `meta` (loop id/version, inputs,
key version, workdir), `step_started`, `step_result` (output, validity,
evidence, usage), `contract`, `effects`, `decision`. One line per fact,
every line JSON, nothing overwritten. Everything else in this walkthrough —
timelines, stats, resume — is a pure function of files like this one.

---

## 5. A real coding loop — plan-work-review

> **LIVE + HISTORICAL section.** `plan-work-review` is what
> `vernier init coding-review` scaffolds today; it drives real agent CLIs —
> codex in this transcript, but any wired provider can fill either role,
> and `vernier doctor` tells you what is usable. (The test suite never
> needs any agent or auth.) The output below is transcribed from a
> **real run of 2026-06-10** made while building this tool — the
> coding-review template descends from these runs (it shipped in-tree as
> "Pilot 1" then). Those pre-rename ledgers live under the author's
> checkout (gitignored, so not in the repo); they render with today's CLI
> via `VERNIER_HOME=.looper vernier show …`. Two period details you will
> see: `keys=loop-v1` (the journals predate the current `loop-v2` resume
> keys) and `workdir <not recorded>` (they predate workdir recording).
> Legacy journals degrade gracefully — that is a feature, and this is it
> working.

This is the shape most people come for: **an LLM gate, then an LLM
worker, with a contract and a bounded blast radius.**

```
route      an LLM router approves/rejects the task   contract: route-decision.v1   effects: none
implement  an agent writes ONE artifact              contract: dry-run-note.v1     effects: fsScope("docs/agent-workflows/**")
```

The route gate is just a Step — there is no special "orchestrator" object.
Its prompt plus the `route-decision.v1` contract are the entire role, and
`structuredOutput: true` hands the executor a JSON Schema derived from the
step's zod output signature (one source of truth, never hand-written).
The policy
([templates/coding-review/coding-review-loop.mjs](../templates/coding-review/coding-review-loop.mjs))
allows the worker 2 attempts but makes route failures non-retryable — a
rejected gate goes straight to `needs_human`.

```sh
vernier run plan-work-review --input '{"task":"Create docs/agent-workflows/runner-dry-runs/<traceId>.md as a harmless dry-run note. Do not edit any other file."}'
```

Real run, 2026-06-10 (rendered as described above; this run was made on
loop v0.2.0, whose route step defaulted to hermes — see the binding note
below):

```
run       plan-work-review-20260610-095138
loop      plan-work-review@0.2.0
status    done
last      implement (iteration 1, attempt 1)
started   2026-06-10T14:51:38.741Z
workdir   <not recorded>
journal   .looper/runs/plan-work-review-20260610-095138/journal.jsonl
--- timeline (11 events) ---
 +0.00s  ◷ run start — plan-work-review@0.2.0 (trust=active, keys=loop-v1)
 +0.00s  ▶ route#1.1 started (hermes)
+10.01s  ✔ route#1.1 completed — in=0 out=0 · 10.0s
+10.01s  ✔ route#1.1 contract route-decision.v1 passed
+10.01s  ± route#1.1 effects: 0 files changed (allowed)
+10.01s  → route#1.1 continue/success — step `route` completed and passed; continue to the next step.
+10.01s  ▶ implement#1.1 started (codex)
+38.47s  ✔ implement#1.1 completed — in=55,143 out=1,015 · 28.4s
+38.47s  ✔ implement#1.1 contract dry-run-note.v1 passed
+38.47s  ± implement#1.1 effects: 1 file changed (allowed)
+38.47s  ■ implement#1.1 stop/success — step `implement` completed, its contract passed, and all changes stayed in scope; the loop is done.
--- per-step usage ---
step       execs  tok-in  tok-out  time
route      1      0       0        10.0s
implement  1      55,143  1,015    28.4s
--- summary ---
status      done (1 iteration, 2 steps run)
wall        38.5s (busy 38.4s)
tokens      in=55,143 out=1,015
```

Two lines to dwell on.

The route step's journaled output (same run, from the journal itself):

```json
{"gateDecision":"allow","routeToWorker":true,"worker":"codex",
 "reason":"Task is narrow, local, harmless, reviewable, within workspace docs mutation authority, and does not require secrets, global config, live automation, or remote writes."}
```

And the implement step's effects observation — *what changed AND was it
allowed*:

```json
{"changed":["docs/agent-workflows/runner-dry-runs/plan-work-review-20260610-095138.md"],
 "allowed":true,"unexpected":[]}
```

The engine derived the loop's `artifact` output from that observation
(`artifactFromEffects`): the diff is the report. Codex never gets asked
"what did you change?" — a self-report can't contradict the snapshot diff,
because the projection wins on collision. Had codex touched anything
outside `docs/agent-workflows/**`, the effects line would read
`⚠ … OUT OF SCOPE` and the policy would escalate. For codex the scope is
also *enforced up front*: the CLI sandbox level is derived from the step's
`EffectScope` (no scope → read-only; full access is unconstructible from a
loop declaration). For other providers, enforcement varies — §11.

**Any agent in any role.** A step names an executor id; the implementation
is resolved at run time through one chain:

```
--executor overrides  >  config bindings  >  the step's declared default
```

Keys are a step id (binds that step) or an executor id (binds the role
everywhere it appears). Today's plan-work-review (v0.5.0, the template)
names NO provider at all: both steps declare the binding target `agent`,
and the scaffolded `vernier.config.json` binds both roles to codex —
visible data you edit, not a default baked into the loop. One wired agent
suffices, and it does not have to be codex; the run above is what
`--executor route=hermes` produces — the orchestrator role itself is just
a binding, hermes optional:

```sh
vernier run plan-work-review --executor route=hermes --input '{"task":"…"}'   # route on hermes (this is the historical configuration)
vernier run plan-work-review --executor implement=claude --input '{"task":"…"}'  # codex gates, claude implements
```

The only requirements: an LLM-bound step must declare a `prompt` template,
and the agent must be usable on this machine (`vernier doctor`).

**Any skill in any step.** The same dictation works for capabilities:
vernier implements the [Agent Skills](https://agentskills.io) open
standard (a skill = a directory with a spec-validated `SKILL.md`), and
this template's `implement` step declares one — `skills:
["dry-run-note-style"]`, the skill shipped under `./skills` and registered
by the scaffolded config's `skills` list. The resolution chain is the
executor chain, verbatim — keys speak the same step-id/executor-id
vocabulary:

```
--skill overrides  >  config skillBindings  >  the step's declared skills
```

```sh
vernier run plan-work-review --skill implement=dry-run-note-style --input '{"task":"…"}'   # explicit (the shipped default)
vernier run plan-work-review --skill implement= --input '{"task":"…"}'                     # clear the step's skills
```

Discovery: config `skills` paths > `<project>/.claude/skills` >
`~/.claude/skills`, earlier tiers winning name collisions. Delivery is
the executor's declared mode: claude loads skills NATIVELY — vernier
synthesizes a session plugin under the run's ledger dir and passes
`--plugin-dir`, so the spec's progressive disclosure survives and the
plugin doubles as evidence — while every other provider gets the SKILL.md
body embedded in the step prompt, delimited and attributed. Each ledger
`step_started` entry records the resolved skills and the delivery mode;
`vernier doctor` reports resolvable/missing skills per step; a missing
skill fails before the first journal write. Skill-bearing steps must have
a `prompt` template.

---

## 6. Iterate until verified — verified-answer

> **LIVE + HISTORICAL section.** Same provenance as §5: real run of
> 2026-06-10, pre-rename ledger, rendered with today's `vernier show`. The
> verified-answer template (`vernier init verified-answer`) descends from
> these runs (in-tree "Pilot 2" then).

This is the generalizability proof: a non-coding loop in the same five
slots. `answer` (an agent; the template binds it to codex) produces;
`grade` (an **independent** judge — a separate executor invocation with
fresh context, holding a rubric the producer never sees) verifies; the
`until` combinator loops back until the verdict passes:

```ts
policy: until((verdict) => verdict.passed === true, {
  maxIterations: 3,
  restartAt: "answer",
  feedbackFrom: feedbackFromVerdict,
  base: retryPolicy({ maxAttempts: 2 }),  // transient failures stay same-step retries
})
```

The producer/verifier split is what makes the first-iteration failure
genuinely possible — and here is one, for real. The goal: a short note on
why Apollo 11 mattered. The rubric (quoted from the run's journaled
inputs): *"PASS only if ALL of the following hold: 1. States the year
1969. 2. Names Neil Armstrong, Buzz Aldrin, AND Michael Collins. 3. Is
between 50 and 120 words long. 4. Ends with a single question inviting
further study."*

```
run       verified-answer-20260610155616-760b4d
loop      verified-answer@0.1.0
status    done
last      grade (iteration 2, attempt 1)
started   2026-06-10T15:56:16.282Z
workdir   <not recorded>
journal   .looper/runs/verified-answer-20260610155616-760b4d/journal.jsonl
--- timeline (17 events) ---
 +0.00s  ◷ run start — verified-answer@0.1.0 (trust=active, keys=loop-v1)
 +0.00s  ▶ answer#1.1 started (codex)
 +8.37s  ✔ answer#1.1 completed — in=26,432 out=109 · 8.4s
 +8.37s  ± answer#1.1 effects: 0 files changed (allowed)
 +8.37s  → answer#1.1 continue/success — step `answer` completed and passed; continue to the next step.
 +8.38s  ▶ grade#1.1 started (judge)
+24.53s  ✔ grade#1.1 completed — in=53,312 out=520 · 16.2s
+24.53s  ± grade#1.1 effects: 0 files changed (allowed)
+24.53s  ⟲ grade#1.1 ITERATE → re-run from answer (iteration 2) — the until-predicate is unmet on iteration 1 of 3; iterating from step `answer` with feedback.
+24.53s  ▶ answer#2.1 started (codex)
+32.37s  ✔ answer#2.1 completed — in=26,349 out=156 · 7.8s
+32.37s  ± answer#2.1 effects: 0 files changed (allowed)
+32.37s  → answer#2.1 continue/success — step `answer` completed and passed; continue to the next step.
+32.37s  ▶ grade#2.1 started (judge)
+46.73s  ✔ grade#2.1 completed — in=52,982 out=475 · 14.4s
+46.73s  ± grade#2.1 effects: 0 files changed (allowed)
+46.73s  ■ grade#2.1 stop/success — step `grade` completed, its contract passed, and all changes stayed in scope; the loop is done. The until-predicate was met on iteration 2.
--- per-step usage ---
step    execs  tok-in   tok-out  time
answer  2      52,781   265      16.2s
grade   2      106,294  995      30.5s
--- summary ---
status      done (2 iterations, 4 steps run)
wall        46.7s (busy 46.7s)
tokens      in=159,075 out=1,260
```

Read the `⟲` line: the verdict failed, so the policy issued
`iterate` with `restartAt: "answer"` — a fresh pass (the slot notation
flips to `answer#2.1`), bounded by `maxIterations: 3`. **Feedback
threading** is how iteration 2 does better than iteration 1: the judge's
verdict is rendered into the decision's `retryHint`, and the next answer
prompt carries it. From this run's actual iterate decision:

```json
{
  "kind": "iterate",
  "restartAt": "answer",
  "retryHint": "Add the 1969 date, name all three Apollo 11 astronauts, and end with one question inviting further study. The current length is within range.\n- missing: States the year 1969.\n- missing: Names Neil Armstrong, Buzz Aldrin, AND Michael Collins.\n- missing: Ends with a single question inviting further study."
}
```

The producer still never sees the rubric — only this feedback. Independent
verification, with the verifier's exact words journaled.

---

## 7. Loops that learn — compounding-answer

> **LIVE + HISTORICAL section.** Same provenance: two real runs of
> 2026-06-10, one minute apart, pre-rename ledgers rendered with today's
> CLI. The rule texts and recall outputs below are quoted verbatim from the
> journals. The self-improving template (`vernier init self-improving`)
> descends from these runs (in-tree "Pilot 3" then).

verified-answer converges *within* a run. compounding-answer compounds
*across* runs:

```
recall -> answer -> grade -> distill -> remember
```

`recall` and `remember` are deterministic store operations over an
append-only `rules.jsonl` — memory is steps, not magic. `distill` is an
independent LLM that turns one verified answer into ONE reusable rule.
And the loop's *shape* enforces the quality gate: `remember` sits after
`grade`, and a failed grade iterates back to `answer` — there is no path
into the store that does not pass through a passing verdict.

**Run 1** (goal: a note on Apollo 11; rubric requires a specific year,
≤120 words, and the exact final sentence "Further study is encouraged."):

```
run       compounding-answer-20260610172635-937bf6
status    done
--- timeline (29 events) ---
 +0.00s  ◷ run start — compounding-answer@0.1.0 (trust=active, keys=loop-v1)
 +0.00s  ▶ recall#1.1 started (recall)
 +0.00s  ✔ recall#1.1 completed — in=0 out=0 · 0ms
 +0.00s  → recall#1.1 continue/success — step `recall` completed and passed; continue to the next step.
 +0.00s  ▶ answer#1.1 started (codex)
 +6.80s  ✔ answer#1.1 completed — in=26,225 out=99 · 6.8s
 +6.80s  → answer#1.1 continue/success — …
 +6.80s  ▶ grade#1.1 started (judge)
+20.25s  ✔ grade#1.1 completed — in=52,906 out=335 · 13.4s
+20.25s  ⟲ grade#1.1 ITERATE → re-run from answer (iteration 2) — the until-predicate is unmet on iteration 1 of 3; iterating from step `answer` with feedback.
+20.25s  ▶ answer#2.1 started (codex)
+29.18s  ✔ answer#2.1 completed — in=26,494 out=123 · 8.9s
+29.18s  → answer#2.1 continue/success — …
+29.18s  ▶ grade#2.1 started (judge)
+44.73s  ✔ grade#2.1 completed — in=52,920 out=186 · 15.5s
+44.73s  → grade#2.1 continue/success — … The until-predicate was met on iteration 2.
+44.73s  ▶ distill#2.1 started (distill)
+57.04s  ✔ distill#2.1 completed — in=52,971 out=292 · 12.3s
+57.04s  → distill#2.1 continue/success — …
+57.04s  ▶ remember#2.1 started (remember)
+57.04s  ✔ remember#2.1 completed — in=0 out=0 · 0ms
+57.04s  ■ remember#2.1 stop/success — … the loop is done.
--- summary ---
status      done (2 iterations, 7 steps run)
wall        57.0s (busy 57.0s)
tokens      in=211,516 out=1,035
```

(Effects lines elided here for width — every one reads
`0 files changed (allowed)`; this loop produces values and memory records,
not files.)

The store was empty, so `recall` returned nothing; the first answer failed
the grade (the journaled verdict: *"Add a specific year and make the final
sentence exactly the required sentence."*); iteration 2 passed; and then —
only then — `distill` extracted the lesson. From the journal:

```json
{"rule":"Write a concise 3-sentence note that opens with “[subject] mattered because…”, includes one concrete date/year and specific achievement, then states broader impact, and ends with the exact sentence “Further study is encouraged.”"}
```

`remember` filed it: `{"stored":true,"id":"a01743ababe47aeb"}`.

**Run 2**, one minute later — a *different* subject (the Hubble Space
Telescope), same kind of task:

```
run       compounding-answer-20260610172732-473943
status    done
--- timeline (21 events) ---
 +0.00s  ◷ run start — compounding-answer@0.1.0 (trust=active, keys=loop-v1)
 +0.00s  ▶ recall#1.1 started (recall)
 +0.00s  ✔ recall#1.1 completed — in=0 out=0 · 0ms
 +0.00s  → recall#1.1 continue/success — …
 +0.00s  ▶ answer#1.1 started (codex)
 +9.13s  ✔ answer#1.1 completed — in=26,326 out=206 · 9.1s
 +9.13s  → answer#1.1 continue/success — …
 +9.13s  ▶ grade#1.1 started (judge)
+20.89s  ✔ grade#1.1 completed — in=52,932 out=292 · 11.8s
+20.89s  → grade#1.1 continue/success — … The until-predicate was met on iteration 1.
+20.89s  ▶ distill#1.1 started (distill)
+39.11s  ✔ distill#1.1 completed — in=53,064 out=694 · 18.2s
+39.11s  → distill#1.1 continue/success — …
+39.11s  ▶ remember#1.1 started (remember)
+39.11s  ✔ remember#1.1 completed — in=0 out=0 · 0ms
+39.11s  ■ remember#1.1 stop/success — … the loop is done.
--- summary ---
status      done (1 iteration, 5 steps run)
wall        39.1s (busy 39.1s)
tokens      in=132,322 out=1,192
```

One iteration. Why? Because this time `recall` was not empty — its
journaled output is run 1's rule, surfaced for a *related* goal (the
recall topic is derived deterministically from the goal's keywords, inside
the step's input signature):

```json
{"rules":["Write a concise 3-sentence note that opens with “[subject] mattered because…”, includes one concrete date/year and specific achievement, then states broader impact, and ends with the exact sentence “Further study is encouraged.”"]}
```

And the first answer applied it, down to the required closing sentence:

> "The Hubble Space Telescope mattered because in 1995 it captured the
> Hubble Deep Field, revealing thousands of distant galaxies in a tiny
> patch of sky. It transformed astronomy by sharpening our view of the
> universe's age, scale, and evolution. Further study is encouraged."

2 iterations → 1 iteration, 211k tokens → 132k tokens, because run 1's
verified lesson was in the store. That is compounding, and every link in
the chain — the failed verdict, the distilled rule, the store id, the
recall, the better first draft — is in the ledgers.

How recall *ranks* the store is pluggable (the Retriever seam). The
default is BM25 lexical — deterministic, dependency-free. Set
`VERNIER_RETRIEVER=embedding` (plus `npm install @huggingface/transformers`)
for the optional semantic tier: vectors computed at remember time, stored
on the record, versioned by model id, with lexical fallback for anything
un-embedded. `vernier doctor` probes whichever tier is selected. See
README "Memory & recall" for the honest determinism caveats.

---

## 8. Write your own loop

The point of v1: your loops live in **your** repo. This section builds a
complete out-of-tree setup — config, loop module, contracts, a custom
executor, CLI rebinding — and every file and command is real:
[examples/getting-started/](../examples/getting-started) in this repo is
the finished result, and `test/walkthrough.test.ts` drives it in CI so
this section cannot rot.

The loop we are building: **haiku-review**. A deterministic composer
writes a 5-7-5 haiku about your topic into the workdir; an independent
syllable counter reviews it; contracts on both steps say what "good"
means. Zero LLM, zero auth — but the full five-slot shape, with real
effects and a real verifier that really rejects.

```
compose  haiku-bot          contract: haiku-shape.v1   effects: fsScope("haiku/**")
review   syllable-counter   contract: haiku-5-7-5.v1   effects: none
```

```sh
cd examples/getting-started   # pretend this directory is your repo
```

### 8.1 The config

`vernier.config.json` — discovered by walking up from your cwd (or set
`$VERNIER_CONFIG`); relative paths resolve against the config file's
directory:

```json
{
  "loops": ["./haiku-loop.mjs"],
  "executors": ["./alt-poets.mjs"]
}
```

`loops` are modules that each default-export a Loop (or a registration —
below). `executors` are config-level executors, registered for every loop
under this config — that is how alternates arrive for rebinding.

Trust boundary, named plainly: loading a config **executes its code** with
your process's privileges, the same trust you give any npm script. Do not
point vernier at a config you would not `node` yourself.

### 8.2 Shared helpers (`lib.mjs`)

Both sides of the loop use the *same* naive syllable counter, so composer
and reviewer always agree on the rules of the game:

```js
/** Naive syllable count: vowel groups per word, minimum 1 per word. */
export function syllables(text) {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
    .reduce((n, word) => n + Math.max(1, (word.match(/[aeiouy]+/g) ?? []).length), 0)
}
```

It is wrong about English exactly as often as any naive counter —
consistency, not poetry, is what a deterministic verifier needs. `lib.mjs`
also has `composeHaiku(topic)` (topic on line 1, padded to 5-7-5 with
one-syllable season words) and `writeHaiku(workdir, topic, haiku)` (writes
`haiku/<slug>.md`, returns the workdir-relative path).

### 8.3 The loop module (`haiku-loop.mjs`)

Built up slot by slot. First the **executors** — any agent arrives like
this, an id plus `run(spec, ctx) -> StepResult`:

```js
const haikuBot = {
  id: "haiku-bot",
  async run(spec, ctx) {
    const topic = String(spec.inputs.topic)
    const haiku = composeHaiku(topic)
    const path = writeHaiku(ctx.workdir, topic, haiku)
    return {
      status: "completed",
      output: { haiku, path },
      evidence: [{ role: "haiku", path }],
      usage: zeroUsage,
    }
  },
}

const syllableCounter = {
  id: "syllable-counter",
  async run(spec) {
    const lines = String(spec.inputs.haiku).split("\n").filter((l) => l.trim().length > 0)
    const counts = lines.map((l) => syllables(l))
    return {
      status: "completed",
      output: { syllables: counts, ok: counts.length === 3 && counts[0] === 5 && counts[1] === 7 && counts[2] === 5 },
      evidence: [],
      usage: zeroUsage,
    }
  },
}
```

(The real file has one extra line in `syllable-counter` — a deterministic
crash hook behind `GETTING_STARTED_CRASH=1`, which §9 uses to practice
resume.)

Then the **contracts** — deterministic checks of the output value, with
failure details written for whoever has to act on them:

```js
const haiku575V1 = {
  id: "haiku-5-7-5.v1",
  validate(output) {
    const counts = Array.isArray(output.syllables) ? output.syllables : []
    const checks = [5, 7, 5].map((want, i) => ({
      label: `line ${i + 1} has ${want} syllables`,
      passed: counts[i] === want,
      detail: `counted ${counts[i] ?? "no line"}`,
    }))
    return { contractId: "haiku-5-7-5.v1", valid: checks.every((c) => c.passed), checks }
  },
}
```

(`haiku-shape.v1`, on the compose step, checks three non-empty lines and
that the file on disk matches the reported haiku — see the file.)

Then the **policy** — a pure Observation → Decision function. It may not
read files or call models; the engine hands it deterministic facts and it
answers:

```js
const policy = (obs) => {
  const passed = obs.stepStatus === "completed" && obs.outputValid && obs.contractValid && obs.effectsAllowed
  if (!passed) {
    return {
      kind: "escalate",
      classification: "failure",
      summary: `step \`${obs.stepId}\` failed: ${obs.contractFailedChecks.join("; ") || "see the journal"}.`,
      notes: obs.contractFailedChecks,
      improvement: "none",
    }
  }
  const last = obs.stepIndex + 1 >= obs.stepCount
  return {
    kind: last ? "stop" : "continue",
    classification: "success",
    summary: last ? "haiku verified 5-7-5; done." : `step \`${obs.stepId}\` passed; continue.`,
    notes: [],
    improvement: "none",
  }
}
```

Then the **loop** itself — signature, steps, policy, trust, ledger:

```js
const loop = {
  id: "haiku-review",
  version: "0.1.0",
  signature: {
    input: z.object({ topic: z.string() }),
    // `verdict` is the engine's one reserved output field (the final
    // decision's classification) — a loop may promise it without any
    // step producing it.
    output: z.object({ haiku: z.string(), syllables: z.array(z.number()), verdict: z.string() }),
  },
  steps: [
    {
      id: "compose",
      signature: {
        input: z.object({ topic: z.string() }),
        output: z.object({ haiku: z.string(), path: z.string() }),
      },
      executor: "haiku-bot",
      contract: "haiku-shape.v1",
      effects: { allow: ["haiku/**"] },   // fsScope("haiku/**")
    },
    {
      id: "review",
      signature: {
        input: z.object({ haiku: z.string() }),
        output: z.object({ syllables: z.array(z.number()), ok: z.boolean() }),
      },
      executor: "syllable-counter",
      contract: "haiku-5-7-5.v1",
      effects: { allow: [] },             // noEffects()
    },
  ],
  policy,
  trust: "dry-run",
  ledger: {},
}
```

Note how data flows with no plumbing code: `compose` puts `haiku` on the
data plane; `review`'s input schema picks `{ haiku }` off it; the loop's
output schema picks `haiku` and `syllables` and lets the engine fill
`verdict`.

Finally the **registration** — the default export, carrying the runtime
facts pure data cannot:

```js
export default {
  loop,
  summary: "Getting-started loop: a deterministic haiku composer, syllable-checked by an independent reviewer.",
  signature: "topic:string -> haiku:string, syllables:number[], verdict:string",
  defaultInputs: { topic: "a vernier scale" },
  executors: [haikuBot, syllableCounter],
  contracts: [haikuShapeV1, haiku575V1],
  defaultWorkdir: () => {
    const dir = join(process.cwd(), "scratch")
    mkdirSync(dir, { recursive: true })
    return dir
  },
}
```

Dependency note: this module's bare specifier (`zod`) resolves from the
config directory's own `node_modules` when one exists; when none does, the
CLI lends its own copy (see §3), so a copy of this directory runs anywhere
— against vernier's bundled zod version until you `npm install` your own.
Once vernier is published, prefer importing the helpers (`sig`, `fsScope`,
`retryPolicy`, `until`, `defineConfig`, `defineLoop`, …) from `"vernier"`
instead of hand-rolling the literal shapes as this example deliberately
does.

### 8.4 Run it

```sh
vernier loops
```

```
haiku-review@0.1.0  trust=dry-run  source=/Users/tyler/Dev/vernier/examples/getting-started/haiku-loop.mjs
  topic:string -> haiku:string, syllables:number[], verdict:string
  Getting-started loop: a deterministic haiku composer, syllable-checked by an independent reviewer.
```

(Just yours — vernier ships no built-in loops, so the registry is exactly
what your config registers.)

```sh
vernier run haiku-review
```

```
loop      haiku-review@0.1.0
run       haiku-review-20260611154515-d2d7c1
status    done
decision  stop / success — haiku verified 5-7-5; done.
output    {"haiku":"a vernier scale\nthe engine ticks on, dusk\nthe ledger recalls","syllables":[5,7,5],"verdict":"success"}
ledger    /Users/tyler/Dev/vernier/examples/getting-started/.vernier/runs/haiku-review-20260611154515-d2d7c1/journal.jsonl
--- ledger entries ---
  meta          haiku-review@0.1.0 keys=loop-v2
  step_started  compose iter=1 attempt=1
  step_result   compose iter=1 attempt=1 status=completed
  contract      compose iter=1 attempt=1 haiku-shape.v1 valid=true
  effects       compose iter=1 attempt=1 changed=[haiku/a-vernier-scale.md] allowed=true
  decision      compose iter=1 attempt=1 -> continue/success
  step_started  review iter=1 attempt=1
  step_result   review iter=1 attempt=1 status=completed
  contract      review iter=1 attempt=1 haiku-5-7-5.v1 valid=true
  effects       review iter=1 attempt=1 changed=[] allowed=true
  decision      review iter=1 attempt=1 -> stop/success
```

The artifact is on disk, inside the declared scope:

```sh
cat scratch/haiku/a-vernier-scale.md
```

```
a vernier scale
the engine ticks on, dusk
the ledger recalls
```

Your own inputs, machine output:

```sh
vernier run haiku-review --input '{"topic":"rust"}' --json
```

```json
{
  "runId": "haiku-review-20260611154523-f32212",
  "status": "done",
  "output": {
    "haiku": "rust, dusk, moon, wind, mist\nthe engine ticks on, dusk\nthe ledger recalls",
    "syllables": [5, 7, 5],
    "verdict": "success"
  }
}
```

(Abridged; the real JSON also carries loopId/loopVersion, step/iteration/
attempt counters, the decision, the journal path, and the workdir.)

### 8.5 Rebind executors at the CLI

`alt-poets.mjs` (the config-level executor module) default-exports two
alternates for the compose role. Rebind onto the well-behaved one:

```sh
vernier run haiku-review --executor compose=haiku-bot-loud
```

```
status    done
decision  stop / success — haiku verified 5-7-5; done.
output    {"haiku":"A VERNIER SCALE\nTHE ENGINE TICKS ON, DUSK\nTHE LEDGER RECALLS","syllables":[5,7,5],"verdict":"success"}
```

Same role, different agent, contracts still green. Now the one that
refuses the form — `free-verse-bot` writes a single sprawling line:

```sh
vernier run haiku-review --executor compose=free-verse-bot
```

```
status    needs_human
decision  escalate / failure — step `compose` failed: three lines — expected exactly 3 non-empty lines, got 1.
output    null
```

Exit code 1. This is the lesson of the whole section: **the contract
belongs to the step, not to the executor** — rebinding can never weaken
verification. The same goes for the verifier being real: feed the loop a
topic that cannot fit line 1 and review escalates —

```sh
vernier run haiku-review --input '{"topic":"concurrency and the kernel"}'
```

```
status    needs_human
decision  escalate / failure — step `review` failed: line 1 has 5 syllables — counted 8.
```

And because user loops register the wired providers alongside your own
executors, `--executor compose=claude` resolves too. It then fails — at
the prompt check, deterministically, before any provider process is
spawned — because an LLM-bound step needs a `prompt` template and compose
deliberately declares none (scripts read inputs, agents read prompts).
For real:

```sh
vernier run haiku-review --executor compose=claude
```

```
status    needs_human
decision  escalate / failure — step `compose` failed: three lines — expected exactly 3 non-empty lines, got 0; artifact written — expected the haiku file at `<missing path output field>`; …
```

The journaled `step_result` carries the root cause verbatim:
`{"status":"failed","output":{"error":"Step \`compose\` reached executor \`claude\` without a rendered prompt."}}`.
Add a `prompt` template to the step and the haiku role really is
any-agent.

Config-level `bindings` ({"compose": "haiku-bot-loud"} in the config) make
a rebind permanent; `--executor` is per-invocation and wins.

Doctor sees user loops through the same machinery:

```sh
vernier doctor
```

```
  …
  ok  haiku-review                 runnable (2 steps)
        compose -> haiku-bot
        review -> syllable-counter

all registered loops are runnable.
```

---

## 9. Crash, resume, leases

Runs die: laptops sleep, processes get OOM-killed, agents hang and you
^C them. The append-only journal is the recovery story, and you can
practice it deterministically — the example's `syllable-counter` carries a
crash hook that SIGKILLs the driver mid-run, *after* compose is journaled,
*before* review is:

```sh
GETTING_STARTED_CRASH=1 vernier run haiku-review
# killed: exit 137, no output — SIGKILL skips even the exit hooks
vernier runs
```

```
haiku-review-20260611154618-dfa71c  haiku-review@0.1.0  running  last=review (iteration 1, attempt 1)  started=2026-06-11T15:46:18.891Z
```

The run is non-terminal — `running`, dead driver. Its timeline is torn
exactly where the process died:

```sh
vernier show haiku-review-20260611154618-dfa71c
```

```
--- timeline (7 events) ---
+0.00s  ◷ run start — haiku-review@0.1.0 (trust=dry-run, keys=loop-v2)
+0.00s  ▶ compose#1.1 started (haiku-bot)
+0.00s  ✔ compose#1.1 completed — in=0 out=0 · 0ms
+0.00s  ✔ compose#1.1 contract haiku-shape.v1 passed
+0.00s  ± compose#1.1 effects: 1 file changed (allowed)
+0.00s  → compose#1.1 continue/success — step `compose` passed; continue.
+0.00s  ▶ review#1.1 started (syllable-counter)
--- summary ---
status      running (1 iteration, 1 step run)
```

`review started`, then nothing. The crash also orphaned the run's
**lease**:

```sh
cat .vernier/runs/haiku-review-20260611154618-dfa71c/lease.json
```

```json
{"pid":2948,"host":"Tylers-MacBook-Pro.local","acquiredAt":"2026-06-11T15:46:18.890Z","heartbeatAt":"2026-06-11T15:46:18.890Z","ttlMs":30000}
```

What the lease protects: **one driver per run**. `run`/`tick`/`resume`
all take this heartbeat lease before touching the journal. A *live* lease
(fresh heartbeat, pid alive) blocks a second driver with exit 3 — two
cron jobs, or you and your cron job, cannot interleave appends to one
journal. A *stale* lease (heartbeat older than its TTL, or a same-host pid
that no longer exists) is taken over. So a crashed driver never wedges a
run:

```sh
vernier tick haiku-review-20260611154618-dfa71c
```

```
note: took over a stale lease (pid 2948 on Tylers-MacBook-Pro.local, heartbeat 2026-06-11T15:46:18.890Z).
loop      haiku-review@0.1.0
run       haiku-review-20260611154618-dfa71c
status    done
decision  stop / success — haiku verified 5-7-5; done.
output    {"haiku":"a vernier scale\nthe engine ticks on, dusk\nthe ledger recalls","syllables":[5,7,5],"verdict":"success"}
--- ledger entries ---
  meta          haiku-review@0.1.0 keys=loop-v2
  step_started  compose iter=1 attempt=1
  step_result   compose iter=1 attempt=1 status=completed
  contract      compose iter=1 attempt=1 haiku-shape.v1 valid=true
  effects       compose iter=1 attempt=1 changed=[haiku/a-vernier-scale.md] allowed=true
  decision      compose iter=1 attempt=1 -> continue/success
  step_started  review iter=1 attempt=1
  step_started  review iter=1 attempt=1
  step_result   review iter=1 attempt=1 status=completed
  contract      review iter=1 attempt=1 haiku-5-7-5.v1 valid=true
  effects       review iter=1 attempt=1 changed=[] allowed=true
  decision      review iter=1 attempt=1 -> stop/success
```

Read the ledger closely — it tells the recovery story honestly:

- `compose` has **one** `step_started`. It completed before the crash, so
  resume *replayed* its ledgered output and never invoked `haiku-bot`
  again. That is the rule: **resume is replay of the ledger, not
  re-execution** — LLM steps are non-deterministic and side-effecting
  steps must not double-apply. The replay slot is matched by resume key,
  `hash(stepId + iteration + attempt + canonical(inputs))`.
- `review` has **two** `step_started` entries and one result: the torn
  attempt (started, never finished) plus the re-execution. A step with no
  journaled result is the one thing that must run again.

I used `vernier tick` — advance exactly ONE step — rather than `resume`
to show the inversion it buys: anything (cron, a human, another agent) can
push a run forward one step at a time, and the engine, not the caller,
knows what is next. Here the one remaining step was also the last, so the
run reached `done`. `vernier resume` does the same thing in a loop,
driving to a terminal state. On a finished run both are safe no-ops:

```sh
vernier resume haiku-review-20260611154618-dfa71c
```

```
run haiku-review-20260611154618-dfa71c is already terminal: done. Nothing to resume.
```

(Exit 0 — `done` is success. The exit classes: 0 success, 1 terminal-but-
not-success or failure, 2 usage error, 3 lease held by a live driver.)

---

## 10. Observability

`vernier show` is one run; `vernier stats` is the fleet. Real roll-up over
the pre-rename ledgers (same provenance as §5–7: 2026-06-10/11 runs on the
author's machine, rendered with `VERNIER_HOME=.looper vernier stats`):

```
runs (12)
  RUN                                             LOOP                            STATUS   ITER  STEPS  TOK-IN   TOK-OUT  WALL
  control-plane-smoke-test-20260610130907-293199  control-plane-smoke-test@0.2.0  done     1     1      0        0        1ms
  control-plane-smoke-test-20260610131107-54e217  control-plane-smoke-test@0.2.0  done     1     1      0        0        1ms
  plan-work-review-20260610-092635                plan-work-review@0.2.0          done     1     2      83,031   1,023    39.3s
  plan-work-review-20260610-095138                plan-work-review@0.2.0          done     1     2      55,143   1,015    38.5s
  verified-answer-20260610153754-6da419           verified-answer@0.1.0           done     2     4      158,574  1,474    50.9s
  verified-answer-20260610155616-760b4d           verified-answer@0.1.0           done     2     4      159,075  1,260    46.7s
  compounding-answer-20260610172136-7292cb        compounding-answer@0.1.0        done     2     7      212,722  1,477    59.0s
  compounding-answer-20260610172235-f04f56        compounding-answer@0.1.0        done     2     7      211,891  1,923    1m13s
  compounding-answer-20260610172452-5f9780        compounding-answer@0.1.0        running  2     5      158,895  840      41.6s
  compounding-answer-20260610172635-937bf6        compounding-answer@0.1.0        done     2     7      211,516  1,035    57.0s
  compounding-answer-20260610172732-473943        compounding-answer@0.1.0        done     1     5      132,322  1,192    39.1s
  control-plane-smoke-test-20260611111050-6d10d2  control-plane-smoke-test@0.2.0  done     1     1      0        0        2ms
per loop
  control-plane-smoke-test  runs=3  success=100%  mean-iter=1.0  tok-in=0  tok-out=0  wall=4ms
    step   execs  tok-in  tok-out  time
    smoke  3      0       0        1ms
  plan-work-review  runs=2  success=100%  mean-iter=1.0  tok-in=138,174  tok-out=2,038  wall=1m18s
    step       execs  tok-in   tok-out  time
    route      2      0        0        21.1s
    implement  2      138,174  2,038    56.6s
  verified-answer  runs=2  success=100%  mean-iter=2.0  tok-in=317,649  tok-out=2,734  wall=1m38s
    step    execs  tok-in   tok-out  time
    answer  4      105,399  822      36.4s
    grade   4      212,250  1,912    1m01s
  compounding-answer  runs=5  success=80%  mean-iter=1.8  tok-in=927,346  tok-out=6,467  wall=4m30s
    step      execs  tok-in   tok-out  time
    recall    5      0        0        0ms
    answer    9      237,387  1,887    1m26s
    grade     9      477,729  2,810    2m06s
    distill   4      212,230  1,770    58.4s
    remember  4      0        0        0ms
(tokens only — pass --price-in/--price-out USD per 1M tokens for computed cost)
```

The per-STEP attribution is the number an operator actually tunes on, and
it holds a real finding: in compounding-answer, **the judge out-eats the
producer roughly 2:1** — `grade` consumed 477,729 input tokens across 9
executions against `answer`'s 237,387. Verification is not free; here it
costs twice the production. (Why so high per call? The judge re-sends the
rubric and the full candidate answer in a fresh context every time —
independence has a token price.) The same ratio shows in verified-answer:
212,250 vs 105,399. If you optimize one prompt in these loops, optimize
the judge's.

Also honest in that table: the `running` row is a real abandoned run (its
driver died mid-distill on 2026-06-10 and nobody resumed it) — it counts
against compounding-answer's success rate. Stats read what the ledgers say, not
what you wish they said. `--loop <id>` and `--last <n>` filter.

**The tokens-vs-cost rule.** The ledger records tokens, not prices —
prices change, journals do not. So `stats` shows dollars ONLY when you
hand it prices, in USD per 1M tokens, both sides or neither:

```sh
VERNIER_HOME=.looper vernier stats --loop compounding-answer --last 2 --price-in 3 --price-out 15
```

```
runs (2)
  RUN                                       LOOP                      STATUS  ITER  STEPS  TOK-IN   TOK-OUT  WALL   COST
  compounding-answer-20260610172635-937bf6  compounding-answer@0.1.0  done    2     7      211,516  1,035    57.0s  $0.6501
  compounding-answer-20260610172732-473943  compounding-answer@0.1.0  done    1     5      132,322  1,192    39.1s  $0.4148
per loop
  compounding-answer  runs=2  success=100%  mean-iter=1.5  tok-in=343,838  tok-out=2,227  wall=1m36s  est-cost=$1.0649
    step      execs  tok-in   tok-out  time   est-cost
    recall    2      0        0        0ms    $0.0000
    answer    3      79,045   428      24.9s  $0.2436
    grade     3      158,758  813      40.7s  $0.4885
    distill   2      106,035  986      30.5s  $0.3329
    remember  2      0        0        0ms    $0.0000
```

(Those are example prices, not anyone's price list.) The §7 compounding
story in dollars, at these rates: the run that recalled cost $0.41; the
run that learned cost $0.65. The only other money ever shown is what an
executor itself reported. No prices, no invented dollar figures — tokens
are the honest unit.

---

## 11. Troubleshooting

The real gotchas, in the order you will hit them:

- **Stale `dist/`.** `bin/vernier.js` prefers `dist/` when it exists —
  after editing source, `npm run build` (or remove `dist/`) or you are
  running old code while the tests (which run from source) pass. This is
  the first thing to check when "my change does nothing."
- **`.ts` configs need node ≥ 22.18** (native type stripping) under the
  compiled bin. Older node 22 gets an actionable ConfigError; use a
  `.mjs`/`.js`/`.json` config instead, or run through the tsx dev path.
- **Bare specifiers in out-of-tree loop modules** resolve from the config
  directory's own `node_modules` first, then fall back to the CLI's own
  dependency tree (so bare-dir scaffolds run). `Could not load …: Cannot
  find package 'X'` therefore means X resolves from NEITHER — your loop
  repo needs its own `npm install X`.
- **opencode/pi sandbox posture, honestly:** neither provider exposes an
  enforceable sandbox, so vernier fails CLOSED on write-scoped steps (they
  refuse to run at all) and runs effect-free steps on the providers' only
  mode — OS-unconfined, with read-only *intent* observed post-hoc by
  effect attribution, never enforced up front. `cursor-agent` is the same
  for writes (fail closed; read-only steps only). Bind codex (OS sandbox
  derived from the EffectScope) or claude (permission-mode + toolset gate)
  where enforcement matters.
- **claude executor setup:** the `claude` CLI (Claude Code >= 2.0) on
  PATH, like every other provider — no SDK, no extra package;
  `vernier doctor` says whether it is found. Effect-free steps run on a
  read-only toolset (`Read,Glob,Grep`, permission asks auto-denied);
  write-scoped steps run on `acceptEdits` — edits confined to the workdir
  by Claude Code's workspace boundary, Bash and out-of-workspace writes
  denied (print mode cannot grant a prompt). Permission-bypass flags are
  never passed.
- **Exit 3 (`lease held`)** is not an error to fight: another live driver
  owns the run. If the holder is genuinely dead, its lease goes stale
  (heartbeat TTL, default 30s) and the next driver takes over — §9.
- **`vernier runs` shows nothing** when you expect history: the ledger
  root is `$VERNIER_HOME`, else `./.vernier` *relative to your cwd*. Runs
  started in another directory live under that directory's `.vernier`.

---

## 12. Going deeper

- [README](../README.md) — the reference: command surface, providers
  table, memory/recall details, provenance.
- [HANDOFF](../HANDOFF.md) — current state, conventions, the deliberately
  deferred list, known rough edges.
- [docs/orchestration-direction.md](orchestration-direction.md) — the
  design story: why loop-as-data, why the Step is the unit, why the
  executor is a seam, what was taken from omegacode/loom/Ax and what was
  deliberately left behind.
- **The test suite as executable documentation.** The fastest way to learn
  a seam is its tests: `test/tick.test.ts` (the interpreter, replay),
  `test/resume.test.ts` (the decision fold, torn ticks),
  `test/until.test.ts` (the iterate combinator), `test/cli.test.ts` (every
  exit code), `test/config.test.ts` (out-of-tree registration),
  `test/walkthrough.test.ts` (this document's §8–9, kept honest in CI).
- The four starter templates in ascending sophistication:
  [templates/](../templates) `smoke`, `coding-review`, `verified-answer`,
  `self-improving` — script, coding, verified, compounding. Each is a page
  of data; `vernier init <template>` makes any of them yours.

The dogma, one last time — it is the test for every change you might make:
the loop is data; the step is typed; the executor is fungible; the policy
is pure; the ledger is append-only.

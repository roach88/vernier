# looper — Handoff & Step 6 Candidates

_Last updated: 2026-06-10 · current HEAD: `1607f68` · remote: `roach88/looper` (private)_

This is a working handoff for the next person/agent. It captures where the project
is, the conventions that have held across five steps, and the three candidate
directions for **Step 6** with concrete first moves. The full design rationale
lives in [`docs/orchestration-direction.md`](docs/orchestration-direction.md).

---

## What this is

A generalizable agent-orchestration tool. One declarative object — the **Loop** —
with five slots, driven by a deterministic tick interpreter. The premise, proven
across four loop shapes:

> **The loop is data; the step is typed; the executor is fungible; the policy is pure; the ledger is append-only.**

```
Loop = Signature + Steps + Policy + Trust + Ledger
Step = Signature (in→out, typed) + Executor (any agent/script/human) + Contract + Effects
```

The same `tick()` engine runs a deterministic script loop, a live coding loop, a
self-improving verified loop, and a compounding memory loop — with **no domain
special-casing**. That generality is the whole point; protect it.

---

## Current state (Steps 1–5, all done & pushed)

| Step | Commit | What landed |
|---|---|---|
| 1 | `c8f7c72` | Five-slot kernel, `tick()`, append-only ledger, script executor, Pilot-0 |
| 2 | `2acb2a8` | Vendored omegacode codex worker behind the `Executor` seam, hermes router as a step, git-aware effect attribution, **live Pilot-1** (coding) |
| — | `e995e65` | Hardening: "the diff is the report" (artifact path from effect attribution, −33% tokens), retry prompts inject failed checks, composed abort |
| 3 | `dd9e080` | `until` combinator + generic loop-back (`iterate` decision + `restartAt`), independent LLM-judge executor (schema-from-zod), **live Pilot-2** (verified-answer) |
| 4 | `e56f9d8` | Memory as steps (recall/remember + store), independent distill step, **live Pilot-3** (compounding — run 2 recalls run 1's rule and passes in fewer iterations) |
| 5 | `1607f68` | `looper` CLI, resume-from-ledger, run leases |

**Health:** `npx tsc --noEmit` clean · `npm test` → 135 passed / 3 gated-live skipped (auth-free).

### Code map
- `src/kernel/` — `types.ts` (the five-slot model), `policy.ts` (`decideNextStep`, `until`), `contract.ts`, `effects.ts` (hash observer + `artifactFromEffects`), `git-effects.ts` (git-diff attribution: "what changed **and** was it allowed")
- `src/engine/` — `tick.ts` (the interpreter + replay-by-key), `resume.ts` (decision-fold reconstruction), `lease.ts` (file-based run lease)
- `src/ledger/ledger.ts` — append-only `journal.jsonl`; resume key `loop-v2` = `hash(stepId+iteration+attempt+inputs)`
- `src/memory/memory.ts` — append-only rule store; keyword/topic recall
- `src/executors/` — `script`, `codex`, `hermes`, `judge`, `memory` (recall/remember), `evidence`; `vendor/omegacode/` (MIT — see `NOTICE`)
- `src/pilot0..3/` — the four loops as data (`loop.ts`) + their standalone runners (`run.ts`)
- `src/cli/` — `main.ts` (commands), `registry.ts` (the four loops by id); `bin/looper.js` is the entrypoint
- `test/` — deterministic suites; the three `*.live.test.ts` are gated behind `LOOPER_LIVE=1`

### Run it
```bash
looper loops                              # list registered loops
looper run control-plane-smoke-test --json   # deterministic, no LLM — safe smoke
looper runs                               # list runs
looper show <runId>                       # trace + journal
looper resume <runId>                     # continue a crashed run
npm test                                  # auth-free suite
LOOPER_LIVE=1 npm run pilot3              # live two-run compounding demo (costs tokens)
```

---

## Conventions (these have held — keep them)

1. **One commit per step**, message `feat: <step> — <summary>`, ending with the Fable co-author trailer. Verify (`tsc` + auth-free `npm test` + a smoke) **before** committing.
2. **Push policy:** auto-push each step to `roach88/looper` after verify + commit.
   - ⚠️ **Auth gotcha:** the repo is private and two gh accounts are logged in (`roach88` + `tbarstow-tw`). The active account flipped to `tbarstow-tw` mid-session once, causing `git push` → "Repository not found". Fix: `gh auth switch --user roach88`, then `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main` (bypasses the keychain token cached for the wrong account). If a push 404s, check the active gh account first.
3. **The Python original is a frozen spec**, not to be edited: `/Users/tyler/Documents/Dev Workflow Workshop` (its remote is the archived `roach88/looper-legacy`). The de-risk gate (TS Pilot-1 trace vs Python) is signed off; the local Python is kept for reference, not deleted.
4. **Infrastructure is proven deterministically.** CLI/resume/leases were proven with script + fake executors — no dependence on a slow/flaky live LLM run. Reserve live runs for demonstrating *loop behavior* (Pilots 1–3), gated behind `LOOPER_LIVE=1` so `npm test` stays auth-free.
5. **Implementation is done by a Fable subagent**; the orchestrator verifies + commits + pushes. (Note: Fable subagents have repeatedly yielded mid-task waiting on a live run — finish the step yourself: verify the build, run the gated demo, then commit.)

---

## Step 6 candidates

Pick one. Each is scoped to stay small and protect the kernel's generality.

### Candidate A — Wire `claude` / `opencode` / `pi` executors
**Why:** Makes loops genuinely provider-agnostic instead of codex-only — the clearest "orchestrate agents of *any* kind" win, and the adapters are already vendored.

**State:** A `cursor-agent` executor landed in `165e9f9` (vendored worker + `src/executors/cursor.ts` + factory wiring + tests — see `docs/plans/2026-06-10-001-feat-provider-executor-adapters-plan.md`), so codex + cursor are wired. `src/executors/vendor/omegacode/{claude,opencode,pi}.ts` remain vendored but **not wired**. `opencode.ts`/`pi.ts` compile but their factory returns not-implemented; `claude.ts` is **excluded from `tsconfig.json`** because it needs `@anthropic-ai/claude-agent-sdk`, which the repo doesn't carry yet.

**First move:** Wire **one** provider (suggest `claude`, since the SDK is authed locally) behind the `Executor` seam exactly like `src/executors/codex.ts` — add the dep, remove the tsconfig exclude, map its `AgentResult → StepResult`, register it. Prove with the vendored `fake.ts` (auth-free unit test) + one gated live run of an existing pilot swapped to the new executor. Then the other two.

**Watch out for:** each provider's structured-output / sandbox semantics differ — keep the `EffectScope → sandbox` derivation and the "never `danger-full-access`" rule from `codex.ts`. Don't let provider quirks leak into the kernel.

---

### Candidate B — Trust / promotion lifecycle + `looper promote`
**Why:** `Trust` is a declared slot (`draft | dry-run | active`) but only minimally enforced today ("draft may not execute"). The Python original had real **promotion rules** worth porting — they're what make a loop library trustworthy.

**State:** Promotion criteria live in the frozen Python spec at `docs/agent-workflows/loop-library.md` (a loop needs a named gate, trust boundary, retry rule, stop rule, review surface, trace location before leaving Draft; needs ≥1 passing trace + human approval before Active). The TS ledger already records everything needed to *check* these.

**First move:** Add a `looper promote <loopId>` command that reads a loop's ledger evidence and reports which promotion criteria are met/unmet (Draft→Dry-run→Active), and have `tick()` enforce the trust level (e.g. `active` required for `auto_execute`). Keep the criteria as data, evaluated by a pure function over the ledger — mirror the pure-policy pattern.

**Watch out for:** human-approval gates shouldn't be auto-satisfiable. Promotion that reads its own evidence must not let a loop self-promote past the human step.

---

### Candidate C — Out-of-tree loop registration
**Why:** Today `src/cli/registry.ts` hard-codes the four in-tree pilots. The real "anyone can orchestrate any agent" unlock is letting a user register **their own** loops without editing looper's source.

**State:** Registry is a static map of `{ Loop (data) + runtime factory (deps) }`. Loops are plain data + a small deps factory, so they're already portable; only discovery is missing.

**First move:** Support a config file (e.g. `looper.config.{ts,js,json}` discovered from cwd / `$LOOPER_HOME`) that points at user loop modules, merged into the registry at CLI startup. A user writes a `Loop` object + a deps factory in their own repo, registers it, and runs `looper run <their-loop>`. Add one example user-loop fixture + a test that registers and runs it through the CLI.

**Watch out for:** loading user code = a trust boundary. Decide what a registered loop is allowed to do (executors it can name, effect scopes it can declare) before loading arbitrary modules. This is where the `Trust` slot and Candidate B start to matter together.

---

## Known rough edges (carried forward, none blocking)

- **Resume / torn-effects window:** a crash between the `step_result` and `effects` journal entries makes effect re-observation impossible (the before-snapshot is gone); replay assumes a clean scope rather than re-running. Documented in `replayTick`. Re-executing would be strictly worse for LLM/side-effecting steps.
- **Lease takeover race:** two drivers seeing the same stale lease can both take over; atomic-rename + re-read narrows it but doesn't close it. Fine for cron + human, not adversarial concurrency.
- **Pre-`loop-v2` journals:** resume works via the decision fold but has no torn-tick replay (old keys won't match); journals predating `meta.workdir` need `--workdir` on `tick`/`resume`.
- **`artifactFromEffects` one-file rule:** conflates "the artifact" with "all changes" — a legitimate multi-file step needs a path-pattern parameter.
- **Memory recall is keyword/topic-overlap only** — semantic/embedding retrieval is a future improvement, deliberately not built.
- **`RunState.retryHint` is in-memory** during a live drive; resume rebuilds it from the last decision entry (handled), but keep this in mind when touching resume.
- **`HermesExecutor` ignores `ctx.signal`** (its subprocess has its own timeout; no caller passes a signal yet).

---

## TL;DR for whoever picks this up
The kernel is done and the tool is operable end-to-end. Step 6 is about **breadth**
(A: more providers), **trust** (B: promotion lifecycle), or **openness**
(C: user-defined loops). A and C together are what turn this from "my four loops"
into "a tool other people orchestrate their agents with." Whatever you build, the
test is: _did the kernel stay general, or did you special-case something?_

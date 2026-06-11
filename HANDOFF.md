# looper — Handoff (post-v1)

_Last updated: 2026-06-11 · remote: `roach88/looper` (private)_

Working handoff for the next person/agent: where the project is after the
two v1 units, the conventions that have held, and what is deliberately
deferred. Full design rationale: [`docs/orchestration-direction.md`](docs/orchestration-direction.md).

---

## What this is

A generalizable agent-orchestration tool. One declarative object — the **Loop** —
with five slots, driven by a deterministic tick interpreter:

> **The loop is data; the step is typed; the executor is fungible; the policy is pure; the ledger is append-only.**

```
Loop = Signature + Steps + Policy + Trust + Ledger
Step = Signature (in→out, typed) + Executor (any agent/script/human) + Contract + Effects
```

The same `tick()` engine runs a deterministic script loop, a live coding loop, a
self-improving verified loop, and a compounding memory loop — with **no domain
special-casing**. That generality is the whole point; protect it.

---

## Current state

### Steps 1–5 (the kernel + the tool)

| Step | Commit | What landed |
|---|---|---|
| 1 | `c8f7c72` | Five-slot kernel, `tick()`, append-only ledger, script executor, Pilot-0 |
| 2 | `2acb2a8` | Vendored omegacode codex worker behind the `Executor` seam, hermes router as a step, git-aware effect attribution, live Pilot-1 |
| — | `e995e65` | Hardening: artifact from effect attribution, retry-hint threading, composed abort |
| 3 | `dd9e080` | `until` combinator + generic loop-back, independent LLM-judge executor, live Pilot-2 |
| 4 | `e56f9d8` | Memory as steps + distill, live Pilot-3 (compounding across runs) |
| 5 | `1607f68` | `looper` CLI, resume-from-ledger, run leases |
| — | `165e9f9` | cursor-agent executor adapter (read-only steps only) |

### v1 (the product unlock)

| Unit | Commit | What landed |
|---|---|---|
| 1 | `a7fb042` | Out-of-tree loops (`looper.config.{ts,js,mjs,json}`, discovery + `$LOOPER_CONFIG`), any-agent-any-role executor bindings (`--executor` > config `bindings` > loop default), multi-file artifacts (`artifactsFromEffects`) |
| 2 | this commit | Shippability: build pipeline (tsc → `dist/`, compiled bin under plain node), `@roach88/looper` package surface (root export + types, files/exports), MIT LICENSE, `looper doctor`, claude executor wired (lazy optional-peer SDK), README tutorial |

**Health:** `npx tsc --noEmit` clean · `npm test` → 191 passed / 5 gated-live
skipped (auth-free) · `npm run build` green · `npm pack` installs and runs in
a fresh consumer project without tsx or the claude SDK.

### Code map
- `src/kernel/` — `types.ts` (the five-slot model), `policy.ts` (`decideNextStep`, `retryPolicy`, `until`), `contract.ts`, `effects.ts` (hash observer + `artifactsFromEffects`), `git-effects.ts`
- `src/engine/` — `tick.ts` (the interpreter + replay-by-key), `resume.ts` (decision-fold reconstruction), `lease.ts` (file-based run lease)
- `src/ledger/ledger.ts` — append-only `journal.jsonl`; resume key `loop-v2`
- `src/memory/memory.ts` — append-only rule store; keyword/topic recall
- `src/executors/` — `script`, `codex`, `cursor` (read-only steps), `claude` (lazy SDK), `hermes`, `judge`, `memory`, `evidence`; `vendor/omegacode/` (MIT — see `NOTICE`; opencode/pi vendored-unwired)
- `src/cli/` — `main.ts` (commands), `registry.ts` (builtin pilots + user entries; `wiredProviders()` registers codex/cursor/claude in every agent-driven runtime), `config.ts` (out-of-tree registration + binding resolution), `doctor.ts` (probes + per-loop runnability)
- `src/index.ts` — the library surface (`@roach88/looper` root export, deliberately small)
- `bin/looper.js` — prefers `dist/` (plain node); falls back to tsx for unbuilt checkouts
- `src/pilot0..3/` — the four loops as data + standalone runners
- `test/` — deterministic suites; `*.live.test.ts` gated behind `LOOPER_LIVE=1` (claude additionally behind `LOOPER_LIVE_CLAUDE=1`)

### Run it
```bash
npm run build && npm link                  # compiled bin on PATH
looper doctor                              # probe executors; per-loop runnability (exit 0 iff all runnable)
looper loops                               # list registered loops (builtin + looper.config)
looper run control-plane-smoke-test --json # deterministic, no LLM — safe smoke
looper run <loop> --executor <step>=claude # any agent in any role (step needs a prompt template)
looper runs | looper show <runId> | looper resume <runId>
npm test                                   # auth-free suite
```

---

## Conventions (these have held — keep them)

1. **One commit per step/unit**, conventional message, ending with the Fable
   co-author trailer. Verify (`tsc` + auth-free `npm test` + a smoke) **before** committing.
2. **Push policy:** auto-push to `roach88/looper` after verify + commit
   *when pushing is in scope for the session*.
   - ⚠️ **Auth gotcha:** two gh accounts (`roach88` + `tbarstow-tw`); if a push 404s,
     `gh auth switch --user roach88`, then
     `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main`.
3. **The Python original is a frozen spec**: `/Users/tyler/Documents/Dev Workflow Workshop`
   (remote: archived `roach88/looper-legacy`). Reference only; do not edit.
4. **Infrastructure is proven deterministically.** Fake/scripted workers and
   PATH-shim probes; live runs are reserved for demonstrating loop behavior,
   gated behind `LOOPER_LIVE=1` so `npm test` stays auth-free.
5. The kernel stays general. Provider quirks live in executors; the engine
   never learns what kind of executor it is driving.

---

## Deferred (deliberate, in rough priority order)

- **opencode / pi wiring** — adapters vendored, factory returns
  not-implemented. Follow the claude pattern (lazy where a dep is heavy).
- **Trust / promotion lifecycle** — only "draft may not execute" is enforced.
  The Python spec's promotion criteria (ledger-evidence gates, human
  approval, `looper promote`) are the next trust step; criteria as data,
  evaluated by a pure function over the ledger.
- **npm publish** — blocked on final naming (`@roach88/looper` is a
  placeholder; `"private": true` stays until Tyler decides). The package
  surface is already verified via `npm pack` + consumer-install smoke.
- **Observability** — beyond `show`/`doctor`: run timelines, usage/cost
  roll-ups from the ledger.
- **Semantic recall** — memory retrieval is keyword/topic overlap;
  embeddings deferred until a store big enough to prove anything exists.

---

## Known rough edges (carried forward, none blocking)

- **bin prefers stale dist:** `bin/looper.js` runs `dist/` when present —
  after editing source, rebuild (or remove `dist/`) or you are running old
  code. Tests pass in both states; noted in the bin header and README.
- **claude SDK zod peer:** `@anthropic-ai/claude-agent-sdk` peers on
  `zod@^4`; looper's kernel is zod 3, so `package.json` carries an
  `overrides` entry pinning the SDK's zod to ours. The SDK bundles its own
  zod internals and imports cleanly under zod 3 (verified); the peer only
  bites consumers passing zod schemas to the SDK's `tool()` helper, which
  looper never does. Revisit when the kernel moves to zod 4.
- **.ts configs under plain node need 22.18+** (native type stripping).
  Older node 22 gets the actionable ConfigError (use .mjs/.js/.json, or the
  tsx dev bin). Verified both ways via `--no-experimental-strip-types`.
- **Bare specifiers in out-of-tree loop modules** resolve from the config
  dir's node_modules — user repos need their own `npm install zod`.
- **Resume / torn-effects window:** a crash between `step_result` and
  `effects` journal entries replays with an assumed-clean scope (the
  before-snapshot is gone). Documented in `replayTick`.
- **Lease takeover race:** two drivers seeing the same stale lease can both
  take over; fine for cron + human, not adversarial concurrency.
- **cursor-agent is read-only:** write scopes fail closed before the
  provider starts (no hard sandbox for writes in Cursor).
- **`HermesExecutor` ignores `ctx.signal`** (its subprocess has its own
  timeout; no caller passes a signal yet).
- **doctor's judge probe assumes the default worker:** `judge`/`distill`
  report against the `codex` binary; an injected non-codex worker would be
  misreported (nothing injects one outside tests today).

---

## TL;DR for whoever picks this up

The kernel is done, the tool is operable, and v1 made it *shippable*: users
register their own loops out of tree, bind any agent to any role, run the
compiled bin under plain node, and `looper doctor` tells them what their
machine can actually run. Next moves are breadth (opencode/pi), trust
(promotion lifecycle), or publish (naming). Whatever you build, the test
stays: _did the kernel stay general, or did you special-case something?_

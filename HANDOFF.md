# vernier — Handoff (post-v1)

_Last updated: 2026-06-11 · remote: `roach88/vernier` (private)_

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
| 5 | `1607f68` | `vernier` CLI, resume-from-ledger, run leases |
| — | `165e9f9` | cursor-agent executor adapter (read-only steps only) |

### v1 (the product unlock)

| Unit | Commit | What landed |
|---|---|---|
| 1 | `a7fb042` | Out-of-tree loops (`vernier.config.{ts,js,mjs,json}`, discovery + `$VERNIER_CONFIG`), any-agent-any-role executor bindings (`--executor` > config `bindings` > loop default), multi-file artifacts (`artifactsFromEffects`) |
| 2 | `9f6f1b1` | Shippability: build pipeline (tsc → `dist/`, compiled bin under plain node), `vernier` package surface (root export + types, files/exports), MIT LICENSE, `vernier doctor`, claude executor wired (lazy optional-peer SDK), README tutorial |
| 3 | `26f4c9d` | Breadth: opencode + pi executors wired (write scopes fail closed — the providers expose no enforceable sandbox; effect-free steps run on their only mode), vendored factory flipped to the real workers, doctor probes both binaries |
| B | `544e280` | Semantic recall: pluggable `Retriever` seam on Memory — BM25 lexical default (ranked, tiny-store-safe), optional embedding tier (`VERNIER_RETRIEVER=embedding`, `@huggingface/transformers` as a lazy optional peer, remember-time vectors versioned on the JSONL record, lexical fallback for un-embedded records), custom retrievers via the exported interface + Memory constructor; doctor probes the selected tier |
| C | `d6241f8` | Observability: `vernier show` renders run timelines (relative offsets, contract/effects/decision events, retry↔iterate transitions explicit, per-STEP usage attribution, closing summary) and new `vernier stats` rolls up usage per run + per loop (`--loop`/`--last` filters, cost ONLY from explicit `--price-in/--price-out` USD-per-1M-token prices — tokens are the honest unit); pure derivations over the ledger in `src/ledger/stats.ts`, legacy/torn journals degrade gracefully |
| — | `43744f0` | **Rebrand: looper → vernier** (Tyler's call; npm name `vernier` verified free). Clean break, no fallbacks: package `vernier` (`private` removed), bin `vernier`, env `VERNIER_*` (was `LOOPER_*`), config `vernier.config.{ts,js,mjs,json}`, default state dir `./.vernier`, public API `VernierConfig`/`vernierConfigSchema`. Loop ids, the `loop-v2` resume-key version, journal shapes, NOTICE, LICENSE, vendored sources, and historical docs unchanged. Old runs under `./.looper` are not listed unless `VERNIER_HOME` points there. |
| — | this commit | **claude = the Claude Code CLI on PATH** (Tyler's call: every provider is a CLI; the SDK detour is gone). `ClaudeExecutor` now wraps vernier's own `ClaudeCliWorker` (`claude -p --output-format stream-json`, prompt on stdin, real `--json-schema` structured output, posture: read-only toolset for effect-free steps / `acceptEdits` for write scopes, never a bypass flag). `@anthropic-ai/claude-agent-sdk` removed from devDeps + optional peers, the `overrides` zod pin removed with it (that rough edge is GONE), the vendored SDK worker deleted (NOTICE updated). JudgeExecutor de-privileged: the backing provider is a constructor binding (`provider: "codex" \| "claude-code"`, or any injected worker), carried on the AgentSpec and reported honestly by doctor. Docs normalized: tests are auth-free, agents are fungible, codex is a transcript default — not a requirement. |

**Health:** `npx tsc --noEmit` clean · `npm test` → 259 passed / 8 gated-live
skipped (auth-free) · `npm run build` green · `npm pack` installs and runs in
a fresh consumer project without tsx; no agent CLI or SDK is needed to
install or test.

### Code map
- `src/kernel/` — `types.ts` (the five-slot model), `policy.ts` (`decideNextStep`, `retryPolicy`, `until`), `contract.ts`, `effects.ts` (hash observer + `artifactsFromEffects`), `git-effects.ts`
- `src/engine/` — `tick.ts` (the interpreter + replay-by-key), `resume.ts` (decision-fold reconstruction), `lease.ts` (file-based run lease)
- `src/ledger/ledger.ts` — append-only `journal.jsonl`; resume key `loop-v2`; `stats.ts` — pure timeline + usage/cost roll-up derivations (`vernier show`/`stats` render these)
- `src/memory/` — `memory.ts` (append-only rule store; retriever-ranked recall), `retriever.ts` (the pluggable Retriever seam + BM25 lexical default), `embedding.ts` (optional embedding tier behind the lazy-optional-peer pattern)
- `src/executors/` — `script`, `codex`, `cursor` (read-only steps), `claude` (the Claude Code CLI: read-only toolset for effect-free steps, `acceptEdits` for write scopes), `opencode` / `pi` (effect-free steps only; writes fail closed), `hermes`, `judge` (provider-bindable; codex default), `memory`, `evidence`; `vendor/omegacode/` (MIT — see `NOTICE`)
- `src/cli/` — `main.ts` (commands), `registry.ts` (builtin pilots + user entries; `wiredProviders()` registers codex/cursor/claude/opencode/pi in every agent-driven runtime), `config.ts` (out-of-tree registration + binding resolution), `doctor.ts` (probes + per-loop runnability)
- `src/index.ts` — the library surface (`vernier` root export, deliberately small)
- `bin/vernier.js` — prefers `dist/` (plain node); falls back to tsx for unbuilt checkouts
- `src/pilot0..3/` — the four loops as data + standalone runners
- `test/` — deterministic suites; `*.live.test.ts` gated behind `VERNIER_LIVE=1` (claude/opencode/pi/embedding additionally behind `VERNIER_LIVE_CLAUDE=1` / `VERNIER_LIVE_OPENCODE=1` / `VERNIER_LIVE_PI=1` / `VERNIER_LIVE_EMBEDDING=1` — the embedding one downloads a model on first run)

### Run it
```bash
npm run build && npm link                  # compiled bin on PATH
vernier doctor                              # probe executors; per-loop runnability (exit 0 iff all runnable)
vernier loops                               # list registered loops (builtin + vernier.config)
vernier run control-plane-smoke-test --json # deterministic, no LLM — safe smoke
vernier run <loop> --executor <step>=claude # any agent in any role (step needs a prompt template)
vernier runs | vernier show <runId> | vernier resume <runId>
vernier stats --loop <id> --last <n>        # usage roll-ups; add --price-in/--price-out for cost
npm test                                   # auth-free suite
```

---

## Conventions (these have held — keep them)

1. **One commit per step/unit**, conventional message, ending with the Fable
   co-author trailer. Verify (`tsc` + auth-free `npm test` + a smoke) **before** committing.
2. **Push policy:** auto-push to `roach88/vernier` after verify + commit
   *when pushing is in scope for the session*.
   - ⚠️ **Auth gotcha:** two gh accounts (`roach88` + `tbarstow-tw`); if a push 404s,
     `gh auth switch --user roach88`, then
     `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main`.
3. **The Python original is a frozen spec**: `/Users/tyler/Documents/Dev Workflow Workshop`
   (remote: archived `roach88/looper-legacy`). Reference only; do not edit.
4. **Infrastructure is proven deterministically.** Fake/scripted workers and
   PATH-shim probes; live runs are reserved for demonstrating loop behavior,
   gated behind `VERNIER_LIVE=1` so `npm test` stays auth-free.
5. The kernel stays general. Provider quirks live in executors; the engine
   never learns what kind of executor it is driving.

---

## Deferred (deliberate, in rough priority order)

- **Trust / promotion lifecycle** — only "draft may not execute" is enforced.
  The Python spec's promotion criteria (ledger-evidence gates, human
  approval, `vernier promote`) are the next trust step; criteria as data,
  evaluated by a pure function over the ledger.
- **npm publish** — UNBLOCKED by the rebrand: the name is `vernier`
  (verified free on npm) and `"private": true` is removed; what remains is
  the `npm publish` call itself (plus the GitHub repo rename). The package
  surface is already verified via `npm pack` + consumer-install smoke.
- **Config-level retriever registration** — semantic recall itself SHIPPED
  (Retriever seam, BM25 default, optional embedding tier; see README
  "Memory & recall"); what remains deferred is a `retriever` key in
  `vernier.config` — today the tiers are selected by `VERNIER_RETRIEVER`
  (or a custom retriever via the Memory constructor in a `runtime`
  factory), which covers every current use without new config plumbing.

---

## Known rough edges (carried forward, none blocking)

- **bin prefers stale dist:** `bin/vernier.js` runs `dist/` when present —
  after editing source, rebuild (or remove `dist/`) or you are running old
  code. Tests pass in both states; noted in the bin header and README.
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
- **opencode/pi run effect-free steps unconfined:** both providers expose
  NO enforceable sandbox (opencode's permission rules leave bash
  unconfined; pi's tool allowlists are not OS confinement), so their
  vendored workers accept only `danger-full-access`. The executors fail
  closed on write scopes (cursor precedent) and run noEffects() steps on
  the providers' only mode — read-only intent is observed post-hoc by
  effect attribution, never enforced up front. Documented in both
  executor headers; bind codex (OS sandbox) or claude (permission-mode +
  toolset gate) where enforcement matters.
- **claude workspace-write rests on Claude Code's own boundary:** under
  `acceptEdits` in print mode, edits inside the workdir are auto-accepted
  and everything else that would prompt (Bash, out-of-workspace writes) is
  denied — that denial behavior is the CLI's documented non-interactive
  semantics, enforced by the provider, not by an OS sandbox vernier
  controls. Verified against claude 2.1.173; the worker preflights a 2.0
  minimum version. If a future CLI changes print-mode permission
  semantics, the posture needs re-verifying.
- **`HermesExecutor` ignores `ctx.signal`** (its subprocess has its own
  timeout; no caller passes a signal yet).
- **judge provider binding is constructor-level only:** `judge`/`distill`
  take a `provider` ("codex" | "claude-code") or any injected worker, the
  chosen provider travels on the AgentSpec, and doctor probes THAT
  provider's binary — but there is no `vernier.config` key for it yet, so
  rebinding the judge means a custom runtime. opencode/pi cannot back the
  judge by construction (their workers refuse a read-only sandbox);
  cursor needs per-run config plumbing (inject a worker if you must).
  Same caveat shape for memory: the retriever probe covers the builtin
  `Memory` + recall/remember executors only — a custom MemoryStore or
  custom store executors make no doctor claim.
- **Embedding recall is model-version sensitive:** vectors are compared
  only within one model id (stored per record); switching models silently
  demotes old records to the lexical tier until they are re-remembered.
  And the tier's default is rank-don't-filter (`minSimilarity: 0`,
  `topK: 5`) — right for today's tiny stores, but once a store grows past
  topK the floor needs raising, and no one has measured real-model cosine
  floors yet (BGE/MiniLM similarity scores run high and clustered; 0.6 on
  one model is not 0.6 on another).

---

## TL;DR for whoever picks this up

The kernel is done, the tool is operable, and v1 made it *shippable*: users
register their own loops out of tree, bind any agent to any role, run the
compiled bin under plain node, and `vernier doctor` tells them what their
machine can actually run; all five providers are wired as CLIs on PATH
(claude through vernier's own Claude Code adapter). Next
moves are trust (promotion lifecycle) or publish (the name is settled: `vernier`). Whatever you build, the test
stays: _did the kernel stay general, or did you special-case something?_

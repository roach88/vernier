---
name: evaluating-vernier-loops
description: Review a vernier loop definition for soundness before promoting or running it — contract coverage, effect-scope minimality, provider-agnostic role naming, policy termination, retry-feedback threading, trust level honesty, and skill wiring. Use when reviewing a new or changed loop, auditing loops in a repo, or deciding whether a loop is ready to run live.
license: MIT
---

# Evaluating vernier loops

A loop is data, so review it like data: every claim it makes (types,
scopes, contracts, trust) is checkable. Work through the lenses below and
report findings ranked P0 (do not run) → P3 (polish). Read the actual loop
module and its `vernier.config` — not a description of them.

## 1. Typed boundary

- Loop signature validates BOTH sides? Output promises only what steps (or
  the engine's reserved `verdict` field) actually produce?
- Each step's input zod parses from the data plane (loop inputs + prior
  outputs, by field name). A step needing a derived input should derive it
  in the signature (zod `.transform()`), not in the prompt.
- `structuredOutput: true` only where the output is genuinely
  model-emitted (verdicts, decisions). Engine-observable facts (artifact
  paths, diffs) must come from `outputFrom` — a model self-report that the
  engine could observe is a P1. Open records (`z.record`) in a
  structured-output signature are a provider-compatibility risk (strict
  schema modes reject them) — flag them.

## 2. Contracts (the spine of trust)

- Every consequential step — anything an LLM produces — has a contract.
  An LLM step with no contract and no downstream verifier is a P1.
- Contract checks are deterministic (no model calls), and each failing
  check's `detail` is actionable — those strings become the retry prompt.
- Contracts pin artifact paths to runner-expected locations rather than
  trusting reported paths.

## 3. Effects (blast radius)

- Gates/judges/routers: `noEffects()` — providers then run them read-only.
- Writers: the NARROWEST `fsScope` that admits the artifact. `**` scopes or
  scopes wider than the contract's expected paths are a P2.
- Workdir a git repo? The registration should say `observer: "git"`.

## 4. Fungibility (the point of vernier)

- Loop data names ROLE IDS (`agent`, `judge`), never providers. A provider
  name (`codex`, `claude`) inside loop data is a P2 — binding belongs in
  config (`bindings`) where it is visible and per-run overridable.
- Prompts/contracts reference the role, not the provider, so checks hold
  under any binding.
- Write-scoped steps: is the bound provider one with write support and
  post-run scope attribution (codex, claude, cursor-agent)? opencode/pi
  fail closed on write scopes — a binding that can never run is a P1
  (`vernier doctor` shows it).

## 5. Policy (termination and escalation)

- Every path reaches a terminal state: `stop` or `escalate`. Retries
  capped (`retryPolicy({ maxAttempts })`); `until` iteration has a hard
  cap as its termination guard — an uncapped iterate loop is a P0.
- Non-retryable failures (a rejected gate, a refused route) escalate
  instead of burning attempts.
- The policy is PURE — no I/O, no clock, no randomness. Anything effectful
  in a policy is a P0.

## 6. Retry feedback threading

- Prompts render `spec.retryHint` so attempt 2 sees attempt 1's exact
  failed checks; iterate loops thread the verifier's feedback the same
  way. A retrying step whose prompt ignores retryHint is a P2 (it will
  repeat the same mistake).

## 7. Skills (capability wiring)

- Skill-bearing steps have a prompt template (skills travel through the
  prompt seam) and every named skill resolves (`vernier doctor` per-step
  rows). Skill content states capability/style; hard REQUIREMENTS belong
  in the contract — a rule that matters only if the model obeys it is not
  enforced.

## 8. Honesty markers

- `trust` level truthful: anything unproven stays `dry-run`; `live: true`
  on the registration when real agent CLIs are driven.
- `loop.version` bumped on behavioral change (ledgers record it; stats
  group by it).
- `defaultInputs` runnable as-is; `summary`/`signature` strings match
  reality.

## Mechanical pass

```sh
vernier doctor --json   # every step resolvable + runnable, skills included
vernier run <loopId> --json   # then read the journal: vernier show <runId>
```

A dry `--json` run plus the journal (contract entries, effect
observations, decisions) verifies more than reading code — the ledger is
the loop's actual behavior.

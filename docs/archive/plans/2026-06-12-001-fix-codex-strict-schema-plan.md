---
title: "fix: codex strict-mode rejection of record-shaped structured-output schemas"
type: fix
status: completed
date: 2026-06-12
---

# fix: codex strict-mode rejection of record-shaped structured-output schemas

## Overview

`toCodexOutputSchema` (the vendored OpenAI strictifier) promises
"additionalProperties:false + all keys required" but only delivers it for
object nodes that carry `properties`. A record-shaped node — `{"type":
"object", "additionalProperties": {}}`, what zod's `z.record(z.unknown())`
derives to — skips the gate, keeps its schema-valued `additionalProperties`,
and OpenAI's strict mode 400s the whole turn (`invalid_json_schema`). Fix the
strictifier to honor its own documented contract on every object-typed node,
pin all shipped structured-output surfaces with an OpenAI-strict lint test,
and confirm live on codex.

## Problem Frame

Found by live testing on 2026-06-12: `vernier run plan-work-review` on codex
fails at the `route` step before the model runs — the structured-output
schema derived from the step's zod signature is rejected by the OpenAI API.
A v0.4.0 regression: the `route: z.record(z.unknown()).optional()` field
postdates the last live codex run, and no deterministic test exercises the
provider's schema dialect. Claude's `--json-schema` accepts the same schema
(verified live, same day), so the failure is codex-path-only. Full diagnosis
in `.claude/journal.md` (2026-06-12 entry); the live repro produced:

- derived: `{"type":"object","additionalProperties":{}}`
- after strictify: `{"type":["object","null"],"additionalProperties":{}}` ← still schema-valued
- API: `In context=('properties','route','type','0','additionalProperties'), schema must have a 'type' key`

## Requirements Trace

- R1. `plan-work-review` runs end-to-end on codex again (route step's
  structured output accepted by OpenAI strict mode).
- R2. `toCodexOutputSchema` enforces its documented contract —
  `additionalProperties: false` on EVERY object-typed node — including
  record-shaped nodes with no `properties`.
- R3. Every shipped structured-output surface (all template steps with
  `structuredOutput: true`, present and future) is pinned by a deterministic
  OpenAI-strict lint test, so the next dialect regression is caught without
  a live run.
- R4. The lossiness is documented honestly: OpenAI strict mode cannot express
  open maps, so record fields can only be emitted as `{}` (or `null` when
  optional) on the codex path. The claude path is untouched.
- R5. Optional structured-output fields emitted as `null` round-trip to
  ABSENT on the codex path (`stripNullOptionals`, provider parity with
  cursor) — so user loops with optional fields and no projection are not
  silently failed by `outputValid: false`.

## Scope Boundaries

- Template signature unchanged: `route: z.record(z.unknown()).optional()`
  stays — the `routeRecord` output projection synthesizes `route` from the
  decision fields when the model reports none, so a model emitting
  `null`/`{}` preserves behavior exactly. The ONE template touch (review
  decision, 2026-06-12): a single routePrompt sentence telling the model to
  leave `route` null/absent, closing the strict-mode prompt/schema gap
  (strict mode makes `route` a required key the prompt otherwise never
  mentions). Patch-bump the template's LOOP_VERSION for the prompt change.
- No kernel changes: `derivedOutputSchema` stays provider-neutral; dialect
  coercion belongs at the provider boundary (the vendor strictifier), where
  it already lives.
- Claude path untouched: `--json-schema` accepts the un-coerced schema
  (live-verified); `toClaudeOutputFormat` currently has no callers and is
  left alone.

### Deferred to Separate Tasks

- Empty-schema `items` (`z.array(z.unknown())`) and `patternProperties` under
  OpenAI strict: no shipped signature uses either (impact scan 2026-06-12);
  document as known limitations in the strictifier comment rather than
  speculatively coercing shapes nothing exercises.

## Context & Research

### Relevant Code and Patterns

- `src/executors/vendor/omegacode/schema.ts` — `toCodexOutputSchema` /
  `strictify`: the tail gates `additionalProperties = false` on
  `props !== undefined`; record nodes have no `properties` key. `makeNullable`
  may also leave the node typed `["object","null"]`, so the fix must match
  object-typed nodes whether `type` is a string or an array containing
  `"object"`.
- `src/executors/vendor/omegacode/codex.ts` (line ~188) — the single call
  site; the judge executor's verdict turn also flows through it when codex
  backs the judge.
- `templates/coding-review/coding-review-loop.mjs` — `routeOutput` (the only
  open record in any shipped structured-output signature) and `routeRecord`
  (the projection that makes the lossy coercion behavior-preserving).
- `test/templates.ts` — `templateRegistration` loads shipped loops for tests;
  `derivedOutputSchema` is exported from `src/kernel/types.ts`. Together they
  enable linting every shipped surface without duplicating zod shapes.

### Institutional Learnings

- `.claude/journal.md` 2026-06-12: full live diagnosis, including the
  verified claude acceptance of the identical schema.
- Same entry, standing lesson: verify provider-dialect claims against the
  runtime, not docs or reviewer suggestions.

## Key Technical Decisions

- **Fix at the vendor strictifier, not the template or kernel**: the
  function's own doc comment already claims this contract; the template fix
  would leave the footgun armed for every user loop and the judge path; a
  kernel fix would impose OpenAI's dialect on providers that don't share it.
- **Force `additionalProperties: false` on every object-typed node,
  replacing schema-valued/`true`/absent AP alike**: OpenAI strict requires it
  universally; preserving a schema-valued AP is wrong in this dialect, full
  stop. Recursion into a schema-valued AP becomes unnecessary on this path
  (the value is discarded) — remove or bypass it for clarity.
- **Behavior preservation argument (scoped to the route step's optional
  `route` OUTPUT field — the only coerced surface)**: with AP forced false
  the model can emit only `{}` or `null` for `route` (already nullable-ized
  by `makeNullable`). The codex result path does NOT call
  `stripNullOptionals` (that helper is cursor-only today), so the value
  reaches the engine as-is — and that is fine because the engine applies
  `outputFrom` projections BEFORE signature validation
  (`src/engine/tick.ts`: output = `{...result.output, ...step.outputFrom(...)}`,
  then `safeParse`). `routeRecord` sees `isRecord(null)` /
  empty-`{}` as no-record and synthesizes `route` from the decision fields,
  so the parsed output is identical to today's. Net: identical run
  behavior, no prompt changes. (The implement step's INPUT signature also
  carries a `z.record`, but inputs never flow through `toCodexOutputSchema`
  — only `structuredOutput` OUTPUT schemas do.)

## Open Questions

### Resolved During Planning

- Where to fix (template vs kernel vs vendor): vendor strictifier — see Key
  Technical Decisions.
- Does anything else ship an open record? No — the impact scan over
  structured-output OUTPUT schemas (the only schemas that reach
  `toCodexOutputSchema`) found exactly one: `route` in coding-review's route
  step. Judge verdicts and verified-answer outputs are closed shapes. (The
  implement step's INPUT signature also uses `z.record`, but input schemas
  never reach the strictifier — an implementer re-running the scan should
  not count it.)
- Does claude need the coercion? No — raw schema accepted live; different
  dialect, different boundary.

### Deferred to Implementation

- Whether the existing AP-recursion branch is deleted or short-circuited:
  whichever reads cleaner once edited; the lint test pins the outcome either
  way.

## Implementation Units

- [x] **Unit 1: Strictify enforces additionalProperties:false on every object-typed node; codex strips null optionals**

**Goal:** Record-shaped nodes (object-typed, no `properties`) come out of
`toCodexOutputSchema` with `additionalProperties: false`, matching the
documented contract; property-bearing behavior is unchanged; and the codex
result path gains the same `stripNullOptionals` call cursor already has, so
null-emitted optional fields round-trip to absent (R5). One template touch:
the routePrompt sentence from Scope Boundaries.

**Requirements:** R1, R2, R4, R5

**Dependencies:** None

**Files:**
- Modify: `src/executors/vendor/omegacode/schema.ts`
- Modify: `src/executors/vendor/omegacode/codex.ts`
- Modify: `templates/coding-review/coding-review-loop.mjs`
- Test: `test/codex-output-schema.test.ts` (new)

**Approach:**
- In `strictify`, after the existing properties-block, force
  `additionalProperties = false` on any node whose `type` is `"object"` or
  an array containing `"object"`, regardless of whether `properties` exists
  or what `additionalProperties` currently holds.
- In the codex worker's structured-extraction path, apply
  `stripNullOptionals` to the parsed value against the ORIGINAL
  (un-strictified) schema — mirroring the cursor worker's existing call —
  so `makeNullable`'s null-means-absent convention is honored on every
  provider that uses it (review finding, 2026-06-12).
- In `routePrompt`, add the one-line instruction to leave `route`
  null/absent; patch-bump LOOP_VERSION.
- Update the strictify doc comment: state the open-map lossiness honestly
  (records emit `{}`/`null` under this dialect; the projection seam is how
  loops keep record fields populated) and list `items: {}` /
  `patternProperties` as known un-coerced shapes with no current users.

**Patterns to follow:**
- The existing tail block's style (mutate `out`, comment the WHY); the
  vendored file's minimal-adaptation convention (NOTICE).

**Test scenarios:**
- Happy path: `{type:"object", additionalProperties:{}}` (the z.record
  derivation) → `additionalProperties: false`, type/nullability untouched.
- Happy path: property-bearing object → unchanged behavior (AP false, all
  keys required, optionals nullable-ized) — characterizes the existing path.
- Edge case: nullable record (`type:["object","null"]` post-makeNullable
  shape) → AP forced false.
- Edge case: `additionalProperties: true` and absent-AP-no-properties
  objects → both come out false.
- Edge case: nested records (record inside a property, inside `items`,
  inside `anyOf`) → all object-typed nodes coerced.
- Happy path: idempotence — strictify(strictify(s)) === strictify(s).
- Happy path (R5): `stripNullOptionals` against the route output schema
  turns `{..., route: null}` into an object with `route` ABSENT, and leaves
  required fields untouched; the codex worker applies it post-parse (pin at
  whatever seam implementation exposes cleanly — outcome over mechanism).
- Integration: the exact derived shape from the live failure
  (object with gateDecision/routeToWorker/worker/reason + optional record
  `route`) passes the Unit 2 lint after coercion.

**Verification:**
- New test file green; full suite green; `tsc` clean.

- [x] **Unit 2: OpenAI-strict lint over every shipped structured-output surface**

**Goal:** A deterministic regression net: derive + strictify the output
schema of EVERY template step that sets `structuredOutput: true` and assert
OpenAI-strict invariants, so future template or zod-derivation changes that
break the codex dialect fail in `npm test`, not live.

**Requirements:** R3

**Dependencies:** Unit 1

**Files:**
- Modify: `test/codex-output-schema.test.ts`

**Approach:**
- Load each shipped template via the existing `test/templates.ts` helpers;
  for each step with `structuredOutput: true`, run
  `derivedOutputSchema(step.signature)` through `toCodexOutputSchema`, then
  walk the result with a small lint asserting: every object-typed node has
  `additionalProperties === false`; every schema node carries a `type` (or
  `anyOf`/`enum`/`const`); every property-bearing node requires all keys.
- The lint walker must recurse into EVERY schema-bearing position — the
  values of `properties`, `items` (object or array form),
  `anyOf`/`oneOf`/`allOf` elements, and `$defs`/`definitions` values — the
  same positions `strictify` itself recurses into. A top-level-only walk
  would share the fix's blind spots instead of checking them.
- Iterate templates dynamically (whatever ships) rather than hard-coding the
  current list, so new templates are covered by construction.

**Patterns to follow:**
- `test/templates.ts` (`templateRegistration`, `TEMPLATES`) for loading;
  `test/coding-review-template.test.ts` for the load-and-assert style.

**Test scenarios:**
- Happy path: every `structuredOutput: true` step in every shipped template
  passes the lint. Coverage honesty: only coding-review's `route` exercises
  the record-node path this fix targets; the judge/distill verdict steps
  (closed `z.object` shapes) ride along as general dialect-regression
  coverage and would NOT have caught the route bug — the self-test fixture
  below is the recurrence proof, not those steps passing.
- Happy path: templates with zero `structuredOutput` steps (e.g. `smoke`)
  are asserted to have zero — an explicit, self-documenting check rather
  than a silent gap.
- Error path (lint self-test): the lint flags a known-bad fixture with
  `additionalProperties: {}` planted on an object node NESTED INSIDE an
  `anyOf` branch — proving the recursive walk catches non-top-level
  violations, not just root-level ones.
- Integration: load coding-review's `routeRecord` projection and route
  output signature; feed executor outputs with `route: null` and
  `route: {}` through projection-then-`safeParse` (the engine's order) and
  assert both parse successfully with `route` synthesized from the decision
  fields — pinning the actual behavior-preservation mechanism.

**Verification:**
- The lint visits every shipped template: ≥1 linted step for each template
  that declares `structuredOutput`, an asserted zero for those that don't;
  the nested intentionally-broken fixture is caught; the
  projection-before-validation scenarios pass; suite green.

- [x] **Unit 3: Live confirmation on codex**

**Goal:** Close R1 with reality: the same run that failed on 2026-06-12 now
completes on codex, and the prompt-delivery skill path gets its live codex
datapoint (the one missing from the 2026-06-12 test matrix).

**Requirements:** R1

**Dependencies:** Units 1–2 (and a rebuilt `dist/` — the bin prefers it)

**Files:**
- None (operational verification; results recorded in `.claude/journal.md`)

**Execution note:** Requires an authed `codex` on PATH; not part of
`npm test` (the suite stays auth-free). Scaffold `coding-review` into a
scratch dir, run `plan-work-review` on the default codex bindings.

**Test scenarios:**
- Test expectation: none — operational verification unit; the deterministic
  coverage lives in Units 1–2.

**Verification:**
- Route step completes on codex (no `invalid_json_schema`); run reaches a
  terminal state with the dry-run-note contract exercised; the implement
  step's journal entry records `skills: { delivery: "prompt" }` and the
  embedded skill body appears in the codex prompt evidence.

## System-Wide Impact

- **Interaction graph:** Single call site (`codex.ts` worker turn build);
  judge/distill verdict turns inherit the fix when codex backs them. Claude,
  cursor, opencode, pi paths untouched.
- **Error propagation:** Unchanged — schema rejections still surface as
  `AgentError` with the provider code; this fix removes the one we caused.
- **State lifecycle risks:** None — pure schema transformation at request
  build; no persisted formats change.
- **API surface parity:** `toCodexOutputSchema` keeps its signature; only
  its output tightens toward its documented contract.
- **Integration coverage:** Unit 2 is exactly the cross-layer net (zod →
  derivation → strictify → dialect rules) that was missing.
- **Unchanged invariants:** `derivedOutputSchema` stays the one source of
  truth from zod signatures; templates keep zero provider names in loop
  data; the suite stays auth-free.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Forcing AP:false changes meaning for some future loop that WANTS an open record on codex | Documented honestly in the strictifier comment: OpenAI strict cannot express open maps; the projection seam (`outputFrom`) is the supported way to populate record fields — same pattern the template already uses |
| `stripNullOptionals` on codex newly strips a null a loop EXPECTED to receive | Only fields that were OPTIONAL in the original schema are stripped (that is the function's contract, already proven on the cursor path); a loop wanting literal null declares `.nullable()`, which survives |
| Vendored-file drift from upstream omegacode | Minimal, commented diff in the established adaptation style; NOTICE already covers local adaptation |
| Live confirmation flakes for non-schema reasons (model behavior, contract strictness) | The pass/fail criterion for THIS plan is the route step clearing the API schema gate; downstream contract outcomes are reported but judged separately |

## Sources & References

- Live diagnosis: `.claude/journal.md` (2026-06-12 entries)
- Failing evidence: route `codex-final.md` with the OpenAI 400 (scratch run
  `plan-work-review-20260612184614-b92ed8`)
- Related code: `src/executors/vendor/omegacode/schema.ts`,
  `src/executors/vendor/omegacode/codex.ts`,
  `templates/coding-review/coding-review-loop.mjs`, `test/templates.ts`
- Counterpart live run (claude accepts the schema): run
  `plan-work-review-20260612184817-cfaf92`

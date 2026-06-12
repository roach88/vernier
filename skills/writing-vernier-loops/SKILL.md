---
name: writing-vernier-loops
description: Author vernier loops — the five-slot Loop model (Signature, Steps, Policy, Trust, Ledger), Step anatomy (zod signatures, executors as role ids, contracts, effect scopes, prompts, skills), policy combinators, and out-of-tree registration via vernier.config. Use when creating a new loop, adding a step, writing a contract or policy, or converting a workflow into loop-as-data.
license: MIT
---

# Writing vernier loops

The dogma: **the loop is data; the step is typed; the executor is fungible;
the policy is pure; the ledger is append-only.** A loop is a declarative
object in YOUR repo, registered through `vernier.config` — never a fork of
vernier.

## The five slots

```
Loop = Signature  (zod in -> out, both sides runtime-validated)
     + Steps      (ordered typed units of work)
     + Policy     (pure fn: Observation -> Decision)
     + Trust      ("draft" | "dry-run" | "active"; draft refuses to execute)
     + Ledger     ({ root? } — where journal.jsonl lands)
```

## Step anatomy

```js
{
  id: "implement",                       // stable identity (resume keys hash it)
  signature: sig(zIn, zOut),             // typed boundary; inputs come from the data plane
  executor: "agent",                     // a ROLE ID, not a provider — bind in config
  skills: ["house-style"],               // optional Agent Skills (rebindable like the executor)
  contract: "dry-run-note.v1",           // optional deterministic semantic validation
  effects: fsScope("docs/**"),           // what it may touch — OBSERVED via snapshot diff
  prompt: (spec) => `...`,               // pure data -> text; required for LLM executors
  outputFrom: artifactFromEffects("artifact"), // derive observable facts; never ask the model
  structuredOutput: true,                // model-emitted JSON, schema DERIVED from zOut
  timeoutMs: 600_000,
}
```

Rules that bite:
- **Name roles, not providers.** Loop data says `executor: "agent"`; the
  scaffolded config's `bindings` points the role at codex/claude/etc. Any
  provider then fills any role (`--executor implement=claude`).
- **The data plane is by field name.** Each step's input zod parses the
  accumulated values (loop inputs + every prior step's outputs). A zod
  `.transform()` can derive a step's inputs — the signature IS the derivation.
- **Observable facts come from `outputFrom`, not the model.** e.g. the
  artifact path from effect attribution — the diff is the report; the
  projection wins on collision with self-report.
- **`structuredOutput: true` derives the JSON Schema from the step's zod
  output** — one source of truth, never hand-written. Reserve it for outputs
  only the model can produce (a verdict). Caveat: open records
  (`z.record(z.unknown())`) are incompatible with some providers' strict
  structured-output modes — prefer closed object shapes.
- **`spec.retryHint`** carries the previous attempt's failed contract checks
  (or the verifier's feedback after an `iterate` loop-back). Render it in
  the prompt so attempt 2 knows exactly what to fix.
- **Effects minimal.** `noEffects()` for gates/judges (providers run them
  read-only); the narrowest `fsScope` for writers. Sandbox level is DERIVED
  from the scope; full access is unconstructible from loop data.

## Contracts

A contract deterministically validates the OUTPUT VALUE (and on-disk
artifacts) after a step:

```js
export const myContract = {
  id: "my-check.v1",
  validate(output, ctx) {        // ctx: traceId, loopId, loopVersion, workdir, runDir
    const checks = [{ label: "artifact exists", passed: ..., detail: "..." }]
    return { contractId: "my-check.v1", valid: checks.every(c => c.passed), checks }
  },
}
```

Failed check labels travel into the next attempt's `retryHint` — write
`detail` strings an agent can act on.

## Policy

A pure `Observation -> Decision`; kinds: `continue` / `retry` / `iterate`
(loop back, `restartAt`, feedback via retryHint) / `escalate` (needs_human)
/ `stop`. Build from combinators rather than hand-rolling:

```js
import { retryPolicy, until } from "vernier"
const base = retryPolicy({ maxAttempts: 2 })
// wrap it: route failures are not retryable
const policy = (obs) => {
  const d = base(obs)
  return obs.stepId === "route" && d.kind === "retry" ? { ...d, kind: "escalate" } : d
}
```

`until` adds verified-iteration: loop a sub-sequence until a grading step's
predicate passes, with a hard iteration cap as the termination guard.

## Registration

A loop module default-exports the loop plus runtime facts data cannot carry:

```js
export default {            // or defineLoop({...}) in TS
  loop,
  summary: "...", signature: "task:string -> artifact:path, verdict:string",
  live: true,               // drives real agent CLIs -> `vernier run` warns
  defaultInputs: { ... },
  executors: [myExecutor],  // executors this loop's steps name
  contracts: [myContract],
  observer: "git",          // git-aware effect attribution (workdir must be a repo)
  defaultWorkdir: () => ...,// scratch prep when --workdir is absent
}
```

Then in `vernier.config.json`: `{ "loops": ["./my-loop.mjs"] }`. Verify with
`vernier loops`, `vernier doctor`, and a `--json` run. Bump `loop.version`
on any behavioral change — ledgers record it.

## Reference implementations

The starter templates are complete worked examples: `smoke` (the whole
lifecycle, no agent), `coding-review` (LLM gate + contract-checked artifact
+ a skill-bearing step), `verified-answer` (`until` iteration), and
`self-improving` (memory compounding). Scaffold one with `vernier init
<name>` and read its loop module before writing your own.

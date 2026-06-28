# Vernier safety model

Vernier is an audit and control layer around agent-backed project work. It does not sandbox arbitrary Node configuration code, and it does not claim that every provider can prevent writes before they happen. Its current safety model is:

1. choose the least-privileged provider mode Vernier can request for the step,
2. run the step with typed inputs and typed outputs,
3. observe the workdir after the step,
4. record contracts, effects, and policy decisions in the append-only ledger,
5. fail loud when Vernier cannot prove the side-effect boundary.

## Current guarantees

- `draft` loops do not execute.
- `noEffects()` steps request read-only provider modes where the provider adapter supports one.
- `fsScope(...)` steps request workspace-write modes only for provider adapters with write support.
- After each step, Vernier attributes changed paths and checks them against the declared effect scope.
- Out-of-scope writes are journaled and escalated instead of silently accepted.
- Resume is ledger replay, not step re-execution. If a step result was journaled but its effects were not observed before a crash, Vernier records the effect state as unknown and escalates for human review.
- Runner-managed evidence is written under the run directory, not the target workdir, and evidence paths include the step id so multiple same-executor steps do not overwrite each other.

## Non-goals and limits

- Vernier config and loop modules are trusted Node code. Loading `vernier.config.*` or a referenced module executes it with the current process privileges, like an npm script.
- Effect scopes constrain steps, not config loading.
- Provider sandboxes are best-effort requests to external CLIs. Vernier's portable enforcement is the post-run effect observation and ledgered escalation.
- `dry-run` and `active` are trust labels today. They are not yet a promotion system.
- If a process crashes after a step result is journaled but before effect observation is journaled, Vernier cannot reconstruct the before-snapshot. It records `observed: false` and stops for human review rather than assuming the step was clean.

## Provider / executor matrix

| executor | pre-write confinement | post-run effect attribution | effect-free read-only enforcement | write-scope support | recommended use | caveats |
|---|---|---|---|---|---|---|
| `script` | none beyond the script's own code | yes, via Vernier observer | no provider sandbox; policy catches changes after execution | yes | deterministic local steps and tests | scripts are trusted code |
| `codex` | requests read-only or workspace-write from Codex based on effect scope | yes | read-only mode for `noEffects()` | yes | primary coding agent adapter | exact path confinement comes from Vernier's post-run diff |
| `claude` | requests read-only tools for effect-free steps and workspace edits for write-scoped steps | yes | read-only toolset for `noEffects()` | yes | coding and review loops | exact path confinement comes from Vernier's post-run diff |
| `cursor-agent` | Ask mode for read-only, Agent mode for writes | yes | Ask mode for `noEffects()` | yes | Cursor-backed workspace edits | Cursor model/binary availability is local-environment dependent |
| `opencode` | read-only only in Vernier | yes | write-scoped steps fail closed | no | read-only analysis steps | no enforceable write sandbox exposed to Vernier |
| `pi` | read-only only in Vernier | yes | write-scoped steps fail closed | no | read-only analysis steps | no enforceable write sandbox exposed to Vernier |
| `judge` / `distill` | read-only structured-output turns | yes | pinned read-only behavior by role | no | grading, judging, distillation | provider underneath is usually Codex unless configured otherwise |

## Ledger evidence to inspect

For a run under `.vernier/runs/<runId>/`:

- `journal.jsonl` is the source of truth.
- `step_started` identifies the execution slot: step id, attempt, iteration, and resume key.
- `step_result` records executor status, output, usage, and evidence references.
- `contract` records deterministic validation checks.
- `effects` records changed paths, whether the declared scope allowed them, and whether effects were observed.
- `decision` records the pure policy outcome.

Use:

```sh
vernier show <runId>
vernier stats --loop <loopId>
vernier resume <runId>
```

## Source install posture

The published package is expected to run from built `dist/` with plain Node. Source checkouts should run `npm install` and `npm run build` before `npm link`. The bin can fall back to TypeScript source in development, but the release path is built output plus package smoke verification.

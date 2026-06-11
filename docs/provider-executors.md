# Provider Executors

Vernier's kernel treats every worker as an `Executor`: scripts, coding agents, judges, and future
human gates all run one typed `StepSpec` and return one `StepResult`. Provider-specific behavior
belongs in executor and worker adapters, not in loop policy, the engine, or the CLI registry.

## Cursor Agent

`cursor-agent` is the first non-Codex provider wired behind the executor seam. In Step 6A it is
read-only only:

- `CursorExecutor` accepts `noEffects()` steps and sends a read-only `AgentSpec` to the worker.
- Any non-empty `EffectScope` fails before spawning Cursor with `code: "unsupported_sandbox"` and
  `retryable: false`.
- Evidence is still written under `StepSpec.runDir`: prompt, preflight failure when applicable,
  progress events, and final text.
- The worker never passes `--force`; structured output uses a second read-only extraction turn and
  validates the parsed JSON locally before returning `AgentResult.structured`.
- Cursor config is isolated by default through a per-run `CURSOR_CONFIG_DIR`.

The default binary is `cursor-agent`, matching the requested provider name. Tests and private
runners can pass an explicit trusted binary such as `agent` or an absolute path.

## Live Proofs

The default test suite is deterministic and does not require Cursor auth or network access. A live
Cursor smoke test exists behind both flags:

```bash
VERNIER_LIVE=1 VERNIER_LIVE_CURSOR=1 npm test -- provider-live
```

Set `VERNIER_CURSOR_BIN=agent` or an absolute path for machines that expose the Cursor CLI under a
different trusted command name.

Missing live credentials or a missing Cursor binary should not block normal development; the release
gate remains the deterministic worker and executor tests.

## Staged Providers

Claude and Pi are intentionally staged after Cursor:

- `claude-code` should be wired only after the SDK/dependency compatibility gate is resolved.
- `pi` remains guarded until there is an explicit sandbox decision; the vendored worker currently
  accepts only `danger-full-access`, which is not a normal vernier execution mode.
- `opencode` is still intentionally unwired in this step.

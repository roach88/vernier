# Provider Executors

Vernier's kernel treats every worker as an `Executor`: scripts, coding agents, judges, and future
human gates all run one typed `StepSpec` and return one `StepResult`. Provider-specific behavior
belongs in executor and worker adapters, not in loop policy, the engine, or the CLI registry.

## Cursor Agent

`cursor-agent` supports both Vernier read-only and workspace-write steps:

- `CursorExecutor` maps `noEffects()` to `AgentSpec.sandbox: "read-only"`.
- Any non-empty `EffectScope` maps to `AgentSpec.sandbox: "workspace-write"`.
- The worker invokes Cursor Ask mode for read-only turns: `--mode=ask --sandbox enabled`.
- The worker invokes Cursor Agent mode for workspace-write turns: `--mode=agent --sandbox enabled --force`.
- Structured output uses a second read-only Ask-mode extraction turn even after a write turn, and
  validates the parsed JSON locally before returning `AgentResult.structured`.
- Evidence is written under `StepSpec.runDir`: prompt, progress events, and final text.
- Cursor config is isolated by default through a per-run `CURSOR_CONFIG_DIR`.

Cursor's sandbox is the provider-level workspace containment layer. Vernier's declared
`EffectScope` is enforced after the turn by the configured effects observer and then recorded in
the ledger. The git-aware observer combines git attribution with Vernier's hash observer so ignored
files under the workdir still count; heavy internal directories such as `.git`, `.vernier`, and
`node_modules` are skipped. Out-of-scope writes are not silently accepted: policy escalates with the
unexpected paths in the journal.

The Vernier provider id remains `cursor-agent`. The Cursor CLI binary is resolved separately:
explicit constructor `bin`, then `VERNIER_CURSOR_BIN`, then `agent` on PATH, then `cursor-agent` on
PATH. Set `VERNIER_CURSOR_MODEL=composer-2.5` or another Cursor model id to
choose the model for default-wired Cursor executors.

## Live Proofs

The default test suite is deterministic and does not require Cursor auth or network access. A live
Cursor smoke test exists behind both flags:

```bash
VERNIER_LIVE=1 VERNIER_LIVE_CURSOR=1 npm test -- provider-live
```

The write proof is deliberately triple-gated:

```bash
VERNIER_LIVE=1 VERNIER_LIVE_CURSOR=1 VERNIER_LIVE_CURSOR_WRITE=1 npm test -- provider-live
```

Set `VERNIER_CURSOR_BIN=agent` or an absolute path for machines that expose the Cursor CLI under a
different trusted command name.

Missing live credentials or a missing Cursor binary should not block normal development; the release
gate remains the deterministic worker and executor tests.

## Other Providers

Provider sandbox posture is intentionally provider-specific:

- `codex` maps Vernier read-only/workspace-write onto the Codex app-server sandbox.
- `claude-code` maps read-only to `dontAsk` with read tools and workspace-write to `acceptEdits`.
- `opencode` and `pi` remain effect-free only in normal Vernier use; their workers accept only
  `danger-full-access`, so their executors fail closed on write scopes.

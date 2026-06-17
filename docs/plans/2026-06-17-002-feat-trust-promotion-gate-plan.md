---
title: "feat: Add trust promotion gate"
type: feat
status: planned
date: 2026-06-17
---

# feat: Add trust promotion gate

## Summary

Vernier currently treats `dry-run` and `active` as labels. This follow-up turns trust promotion into an explicit, ledger-backed action without weakening the hardening work in the auditability/recovery plan.

## Problem

A loop author can mark a loop `active`, but Vernier does not yet answer the operational question: "what evidence proves this loop is safe enough to promote?"

## Goals

- Add a `vernier trust status <loopId>` command that reports recent evidence for the loop.
- Add a `vernier trust promote <loopId>` command or equivalent config update workflow only after the status evidence is clean.
- Base promotion on existing ledger facts: terminal status, output validity, contract validity, effect observation, and out-of-scope changes.
- Keep promotion deterministic and explainable; no LLM judgment in the promotion gate.
- Preserve current behavior for `draft`: draft loops still refuse to execute.

## Non-goals

- No remote policy service.
- No provider-specific safety scoring.
- No automatic promotion during `run`.
- No mutation of user config without an explicit command and dry-run/confirmation mode.

## Proposed evidence gate

For a loop version to be promotable:

- at least N recent runs completed successfully,
- every required step had valid typed output,
- every configured contract passed,
- every effects entry was observed,
- no effects entry reported unexpected changes,
- no run required human escalation,
- the candidate loop id and version match the ledgers being evaluated.

Open design choice: pick N. Default proposal: 3 successful runs, configurable by flag.

## Implementation units

1. Add a ledger query helper that groups runs by loop id/version.
2. Add a pure `trustStatus(loop, runs, policy)` function with table-friendly output.
3. Add CLI read command: `vernier trust status <loopId> [--json] [--last N]`.
4. Add tests for clean, dirty, unknown-effects, contract-failed, and mixed-version histories.
5. Decide whether `trust promote` edits config, writes a suggested patch, or only prints the exact change.
6. If mutating config, implement dry-run first and require an explicit `--write` flag.
7. Document the trust workflow in README and `docs/safety.md`.

## Verification

- Unit tests for the pure promotion gate.
- CLI tests for `trust status --json` and human output.
- Fixture ledgers covering success, retry, escalation, unknown effects, and version mismatch.
- `npm run typecheck`
- `npm test`
- `npm run build`

## Open questions

- Should promotion be per loop id, loop version, or step graph hash? Initial recommendation: loop id + version for MVP; graph hash can follow if users keep version numbers stale.
- Should `trust promote` ever edit JS/TS config? Initial recommendation: no. Print a suggested change first; only JSON config can be safely machine-edited in a later slice.
- Should a single unknown-effects run permanently block promotion or only fail the current window? Initial recommendation: fail the current evidence window.

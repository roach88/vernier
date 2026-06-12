---
name: operating-vernier-runs
description: Operate and debug vernier runs — run/tick/resume semantics, leases, reading journal.jsonl entry types, evidence bundles, show/stats roll-ups, doctor diagnostics, exit codes, and structured JSON errors. Use when running loops, diagnosing a failed or stuck run, resuming after a crash, reading a run ledger, or analyzing usage and cost across runs.
license: MIT
---

# Operating vernier runs

Every fact about a run is in its ledger. Operating vernier = driving runs
with the CLI and reading journals when anything surprises you.

## Command surface

Every command takes `--json` (machine output on stdout, diagnostics on
stderr; errors emit `{ error, type, exitCode }` to stdout too). Exit codes:
`0` success · `1` terminal-but-not-success (needs_human/stopped) or failure
· `2` usage error · `3` run lease held.

```sh
vernier run <loopId> [--input '<json>'] [--workdir <dir>]
            [--executor <stepOrRole>=<executorId>]... [--skill <stepOrRole>=<names>]...
vernier tick <runId>      # advance exactly ONE step from the ledger
vernier resume <runId>    # continue to a terminal state
vernier runs              # list runs under the ledger root
vernier show <runId>      # timeline: contracts, effects, retries, per-step usage
vernier stats [--loop <id>] [--last <n>] [--price-in <usd> --price-out <usd>]
vernier doctor            # exit 0 iff every registered loop is runnable
vernier skills            # the discovered Agent Skill inventory
```

Ledger root: a loop's `ledger.root` > `$VERNIER_HOME` > `./.vernier`. A
run lives at `<root>/runs/<runId>/`.

## Resume is replay, not re-execution

`resume` folds the journal's decisions through the same state projection
the live tick used and lands on the exact (step, iteration, attempt) the
crashed driver stood at. Completed steps return their LEDGERED outputs —
LLM steps are non-deterministic and side-effecting steps must not
double-apply, so nothing re-runs. Rebinds (`--executor`, `--skill`) on
resume affect only steps that still have to execute.

**One driver per run:** `run`/`tick`/`resume` hold a heartbeat lease
(`lease.json` in the run dir). Exit 3 = a live driver holds it; a stale
lease (dead pid / old heartbeat) is taken over automatically — a crashed
driver never wedges a run.

## Reading a journal

`journal.jsonl` entry types, in tick order:

| type | what it tells you |
|---|---|
| `meta` | loop id/version, inputs, workdir, key scheme |
| `step_started` | executor id; `skills: { resolved, delivery }` when the step ran with Agent Skills |
| `step_result` | status, output, outputValid, evidence paths, tokens/cost/duration |
| `contract` | per-check pass/fail with details — the WHY behind retries |
| `effects` | what changed on disk and whether the scope allowed it |
| `decision` | the policy's verdict: continue/retry/iterate/escalate/stop + summary |

Evidence lives in the run dir, OUTSIDE the workdir: rendered prompts
(`*-prompt.md` — for prompt-delivered skills the embedded SKILL.md body is
right there), event streams (`*-events.jsonl`), final messages,
`skills-snapshot/` (prompt delivery) or `skills-plugin/` (claude native),
with `retry-N-`/`iter-N-` prefixes per attempt.

## Debugging by symptom

- **exit 2 before anything ran** — wiring: unresolved executor/skill
  binding, bad input JSON, unknown loop. The message lists what IS
  registered; `vernier doctor` shows the at-rest resolution per step.
- **status `needs_human`** — the policy escalated. Read the LAST `decision`
  entry, then the `contract` entry above it: the failed checks are the
  reason. `vernier show <runId>` renders this as a timeline.
- **step failed with provider error** — `step_result.output.error` carries
  the provider's code (e.g. schema rejections, missing binary, rate
  limits); the `*-final.md` evidence has the raw message.
- **retry loops burning attempts** — compare attempt prompts
  (`retry-2-*-prompt.md` includes the retryHint section): if the hint
  isn't rendered, the loop's prompt template ignores `spec.retryHint`.
- **exit 3** — another driver is live; or take-over happens automatically
  when it's stale. Check `lease.json` (pid/host/heartbeat).
- **wrong/empty effects** — the workdir isn't what you think (meta records
  it), or the loop needed `observer: "git"` and the workdir isn't a repo.

## Usage and cost

`show` attributes tokens/duration per STEP — the number an operator tunes
on (judges often outspend producers). `stats` rolls up the whole ledger
root per run and per loop (success rate, mean iterations, tokens).
**Dollars appear only when you pass both `--price-in` and `--price-out`**
(USD per 1M tokens) — vernier never invents prices; provider-reported cost
is surfaced separately when present.

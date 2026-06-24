---
name: setting-up-vernier
description: Set up vernier (the agent-orchestration kernel) in a new or existing project — install, create vernier.config, choose where run/eval data is stored (the ledger root), scaffold a starter loop, and verify the machine with doctor. Use when adding vernier to a project, deciding where journals and evidence live, or troubleshooting "no loops registered" / config discovery.
license: MIT
---

# Setting up vernier in a project

vernier ships **no built-in loops**: the registry is exactly what a project's
config registers. Setup is four decisions — install, config, storage, first
loop — then `vernier doctor` tells you what this machine can actually run.

## 1. Install

Not yet on npm. From a checkout:

```sh
git clone <vernier-repo> && cd vernier
npm install && npm run build   # tsc -> dist/; bin/vernier.js then runs under plain node
npm link                       # optional: global `vernier` on PATH
```

Agent providers are CLIs on PATH (`codex`, `claude`, `cursor-agent`,
`opencode`, `pi`) — none is required to install. `vernier doctor` reports
which are usable; any provider can fill any role.

## 2. Create the config

`vernier.config.{ts,js,mjs,json}` in the project root. Discovery walks up
from cwd and stops at the first config or the repo root (`.git`); `$VERNIER_CONFIG`
overrides discovery. Loading a config EXECUTES its code with full process
privileges — the same trust as any npm script.

```json
{
  "loops": ["./loops/my-loop.mjs"],
  "executors": ["./loops/my-executor.mjs"],
  "bindings": { "implement": "codex" },
  "skills": ["./skills"],
  "skillBindings": { "implement": ["house-style"] },
  "judge": { "provider": "codex" }
}
```

| key | what it registers |
|---|---|
| `loops` | modules default-exporting a Loop or `defineLoop({ loop, ... })` |
| `executors` | modules default-exporting an Executor (`{ id, run() }`) or an array |
| `bindings` | executor bindings: stepId-or-executorId → executorId |
| `skills` | Agent Skill paths: a SKILL.md, a skill dir, or a parent dir of skill dirs |
| `skillBindings` | skill bindings: stepId-or-executorId → skill name(s) |
| `judge` | backing provider for the built-in judge/distill wrapper (`codex` or `claude`) |

TS/JS configs default-export `defineConfig({...})` and may register loops
and executors as in-place objects instead of paths.

## 3. Choose where run/eval data lives (the ledger root)

Every run appends to `<ledger-root>/runs/<runId>/journal.jsonl`, alongside
the run's evidence bundle (rendered prompts, transcripts, skill snapshots,
route JSON). This is the project's eval data: `vernier show <runId>` renders
one run's timeline; `vernier stats` rolls the whole root up (success rate,
iterations, per-step tokens; dollars only when you pass `--price-in`/`--price-out`).

Resolution order: a loop's `ledger.root` > `$VERNIER_HOME` > `./.vernier`.

- **Project-local (default)** — `./.vernier`, data lives with the project.
  Add `.vernier/` to `.gitignore` unless you deliberately version run history.
- **Central** — `export VERNIER_HOME=~/path/to/vernier-data` collects every
  project's runs in one place; `vernier stats` then spans all of them.
- **Per-loop** — `ledger: { root: "..." }` in the loop data pins a specific
  loop's journals somewhere explicit.

The durable memory store (`rules.jsonl`, used by recall/remember loops)
resolves under the same root.

## 4. Scaffold a starter and verify

```sh
vernier init                 # list starter templates
vernier init smoke           # deterministic starter: no agent, no auth
vernier doctor               # probe executors, skills, per-loop runnability (exit 0 = all runnable)
vernier run control-plane-smoke-test --json
vernier loops                # what this config registers
vernier skills               # the discovered Agent Skill inventory
```

Templates (`smoke`, `coding-review`, `verified-answer`, `self-improving`)
scaffold into the current directory and never overwrite. The agent templates
name no provider in loop data — steps declare role ids and the scaffolded
config carries the binding, which you re-point at any wired provider.

## Gotchas

- "No loops are registered": there is no config above cwd, or it registers
  no loops. `vernier loops` names the config it found (or didn't).
- Scaffolds run in a bare directory with no `npm install`: the CLI lends its
  own `zod`/`vernier` to config modules when default resolution fails; the
  project's `node_modules` always wins once present.
- Every command takes `--json` (machine output on stdout, diagnostics on
  stderr; errors emit `{ error, type, exitCode }`). Exit codes: 0 ok,
  1 terminal-not-success, 2 usage, 3 run lease held.
- In a source checkout, `bin/vernier.js` prefers stale `dist/` — rebuild
  after editing source.

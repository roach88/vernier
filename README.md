# vernier

Typed agent loops for codebases.

Vernier runs project-local loops made of typed steps. A step can be a
deterministic script, a CLI coding agent, a judge, or a memory operation.
Vernier validates inputs and outputs, observes file effects, and records an
append-only `journal.jsonl` so every run can be inspected, resumed, and
audited.

[Walkthrough](docs/walkthrough.md) · [Safety model](docs/safety.md) · [Provider details](docs/provider-executors.md) · [Templates](templates) · [Examples](examples/getting-started) · [License notices](NOTICE)

## Install

Requires **Node 22+**.

Until the npm package is published, install the CLI from this checkout:

```sh
git clone https://github.com/roach88/vernier && cd vernier
npm install
npm run build
npm link
```

Then run Vernier from the codebase where you want the loop to live:

```sh
cd /path/to/your/codebase
vernier init smoke
vernier run control-plane-smoke-test --json
vernier show <runId>
```

After publication, the project-local install path is:

```sh
npm install -D vernier
npx vernier init smoke
npx vernier run control-plane-smoke-test --json
npx vernier show <runId>
```

`vernier init smoke` scaffolds a deterministic starter into the current
directory. It needs no agent credentials. Runs are written under
`./.vernier/runs/<runId>/`.

## Agent Run

For an agent-backed starter:

```sh
vernier init coding-review
vernier doctor
vernier run plan-work-review --input '{"task":"Write one scoped dry-run note artifact."}'
```

`vernier doctor` probes installed provider CLIs and checks whether the loops
registered in the current repo are runnable. Missing providers are fine until a
registered step is bound to them.

## What Vernier Gives You

- **Project-local loops**: loops are registered by `vernier.config.*`; Vernier
  ships no built-in loops.
- **Typed steps**: zod signatures validate step inputs and outputs at runtime.
- **Swappable executors**: bind the same step to `codex`, `claude`,
  `cursor-agent`, a script executor, a judge, or your own executor.
- **Observed effects**: file scopes are checked after the step runs, so
  out-of-scope writes are journaled and escalated instead of silently accepted.
- **Append-only ledgers**: `vernier show`, `vernier stats`, and
  `vernier resume` read the same `journal.jsonl` source of truth.

## Starter Templates

`vernier init` lists the templates. `vernier init <template>` copies one into
the current directory and never overwrites existing files.

| template | loop id | use it for | needs |
|---|---|---|---|
| `smoke` | `control-plane-smoke-test` | a no-auth first run that proves the loop lifecycle | nothing |
| `coding-review` | `plan-work-review` | route, implement, and verify a scoped coding artifact | any wired agent; write-scoped `implement` works on codex, claude, or cursor-agent |
| `verified-answer` | `verified-answer` | answer, judge, and iterate until verified | any wired agent for `answer`; judge defaults to codex |
| `self-improving` | `compounding-answer` | recall, answer, grade, distill, and remember reusable rules | any wired agent for `answer`; judge/distill default to codex |

Template loop data stays provider-neutral. The scaffolded `vernier.config.json`
contains the provider bindings, and you can override them per run:

```sh
vernier run plan-work-review --executor implement=cursor-agent --input '{"task":"..."}'
vernier run plan-work-review --executor agent=claude --input '{"task":"..."}'
```

## Providers

Provider CLIs are discovered from PATH unless an executor-specific environment
variable overrides the binary.

| executor | write posture | setup |
|---|---|---|
| `codex` | read-only or workspace-write, derived from the step effect scope | `codex` on PATH |
| `claude` | read-only toolset for effect-free steps; workspace edits for write-scoped steps | `claude` on PATH |
| `cursor-agent` | read-only Ask mode or workspace-write Agent mode; exact path scope is enforced by Vernier's post-run diff | Cursor `agent` or `cursor-agent` on PATH, or `VERNIER_CURSOR_BIN`; set `VERNIER_CURSOR_MODEL=composer-2.5` to select Composer 2.5 |
| `opencode` | effect-free steps only | `opencode` on PATH |
| `pi` | effect-free steps only | `pi` on PATH |
| `judge` / `distill` | pinned read-only structured-output turns | codex by default; `{"judge":{"provider":"claude"}}` for Claude-backed judging |

`opencode` and `pi` fail closed on write-scoped steps because their workers do
not expose an enforceable write sandbox.

## Effects And Trust

The detailed safety posture and provider matrix live in [docs/safety.md](docs/safety.md).

Effect scopes describe what a step may touch. `noEffects()` maps to a
read-only provider mode where the provider supports one; a non-empty
`fsScope(...)` maps to workspace-write for codex, claude, and cursor-agent.
Vernier still checks the exact changed paths after the turn and records the
result in the ledger.

Config and loop modules are trusted Node code. Loading `vernier.config.*` or
any module it names executes that code with the current process privileges,
just like running an npm script. Effect scopes constrain steps, not config
loading.

The `trust` field currently gates only `draft` loops: a draft loop refuses to
execute. `dry-run` and `active` are labels for now, not a promotion system.

## CLI

```sh
vernier init [template]                             # list templates or scaffold one
vernier loops                                       # list registered loops
vernier skills                                      # list discovered Agent Skills
vernier run <loopId> [--input '<json>'] [--workdir <dir>]
           [--executor <stepOrRole>=<executor>]...
           [--skill <stepOrRole>=<name[,name...]>]...
vernier tick <runId>                                # advance one step
vernier resume <runId>                              # continue from the ledger
vernier runs                                        # list run ledgers
vernier show <runId>                                # render a run timeline
vernier stats [--loop <id>] [--last <n>]            # usage rollups
vernier doctor                                      # provider and loop preflight
```

Every command supports `--json` for machine-readable output. The ledger root is
`$VERNIER_HOME`, otherwise `./.vernier`.

## Loop Author Notes

Loop modules usually import helpers from `vernier`: `sig`, `retryPolicy`,
`until`, `fsScope`, `noEffects`, `artifactFromEffects`, `scriptExecutor`,
`defineConfig`, and `defineLoop`.

Use zod 4 for signatures. Vernier derives structured-output schemas with
zod's native JSON Schema support, and `vernier doctor` reports schema
derivation problems before a run.

Fresh scaffolds can run in a bare directory: if the project has no
`node_modules`, the CLI lends its own `vernier` and `zod` dependencies to the
scaffolded loop. Once your project installs dependencies, the project's
`node_modules` wins.

## Docs By Goal

- First principles and a full guided tour: [docs/walkthrough.md](docs/walkthrough.md)
- Provider-specific behavior and live Cursor proof gates: [docs/provider-executors.md](docs/provider-executors.md)
- Small runnable modules: [examples/getting-started](examples/getting-started)
- Template source and template-local READMEs: [templates](templates)
- Vendored licenses and attribution: [NOTICE](NOTICE)

## Development

```sh
npm install
npm test
npm run test:chaos
npm run build
npm run typecheck
npm run vernier -- loops
```

`npm test` is deterministic and does not require agent credentials. Live tests
are opt-in through environment gates such as `VERNIER_LIVE=1`.
`npm run test:chaos` is also deterministic: it runs the fast PR-tier
subprocess lifecycle chaos checks and seeded policy property checks without
provider CLIs or credentials. To reproduce or expand a property run, set
`VERNIER_PROPERTY_SEED=<number>` and `VERNIER_PROPERTY_CASES=<number>`.

`bin/vernier.js` prefers `dist/` when it exists and falls back to running the
TypeScript source through `tsx`. After editing source, rebuild before trusting
the compiled CLI.

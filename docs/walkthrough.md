# Vernier Walkthrough

This guide is the short path from a blank project to a runnable loop. For
complete worked examples, scaffold the starter templates with `vernier init`
and read the generated loop modules.

## 1. Install

Vernier requires Node 22+.

```sh
git clone https://github.com/roach88/vernier
cd vernier
npm install
npm run build
npm link
```

After publication, use the project-local package instead:

```sh
npm install -D vernier
npx vernier init smoke
```

## 2. First Run

Create a deterministic starter in the project where you want the loop to live:

```sh
vernier init smoke
vernier loops
vernier doctor
vernier run control-plane-smoke-test --json
vernier runs
vernier show <runId>
```

`smoke` uses a script executor, so it needs no agent credentials. The run
journal lands under `./.vernier/runs/<runId>/journal.jsonl` unless a loop or
`$VERNIER_HOME` chooses another ledger root.

## 3. Templates

`vernier init` lists every starter. `vernier init <template>` copies one into
the current directory and refuses to overwrite existing files.

| template | loop id | purpose |
|---|---|---|
| `smoke` | `control-plane-smoke-test` | deterministic lifecycle check |
| `coding-review` | `plan-work-review` | route, implement, and verify a scoped artifact |
| `verified-answer` | `verified-answer` | answer, judge, and iterate until verified |
| `self-improving` | `compounding-answer` | recall, answer, grade, distill, and remember reusable rules |

Template loop data stays provider-neutral. The scaffolded `vernier.config.json`
contains bindings such as `"agent": "codex"`, and you can override them per run:

```sh
vernier run plan-work-review --executor implement=cursor-agent --input '{"task":"..."}'
vernier run plan-work-review --executor agent=claude --input '{"task":"..."}'
```

## 4. Config

Vernier ships no built-in loops. It discovers `vernier.config.{ts,js,mjs,json}`
from the current directory upward, stopping at the first config or the repo
root. `$VERNIER_CONFIG` overrides discovery.

```json
{
  "loops": ["./my-loop.mjs"],
  "bindings": { "agent": "codex" },
  "skills": ["./.agents/skills"],
  "skillBindings": { "implement": ["house-style"] },
  "judge": { "provider": "codex" }
}
```

Loading config executes trusted Node code with the current process privileges,
just like an npm script.

## 5. Loop Shape

A loop is declarative data:

```txt
Loop = Signature + Steps + Policy + Trust + Ledger
Step = Signature + Executor + Contract + Effects
```

Steps name executor roles, not providers. Bind roles in config or with
`--executor`, so the same loop can run on `codex`, `claude`, `cursor-agent`, a
script executor, a judge, or a custom executor.

Effect scopes are observed after each step. `noEffects()` maps to read-only
provider modes where supported; `fsScope(...)` maps to workspace-write for
providers that can enforce one. The ledger records whether changed paths were
allowed before policy decides what happens next.

## 6. Agent Skills

Project skills live under `.agents/skills/<name>/SKILL.md`, or any path listed
in config `skills`. User-level skills are read from `~/.agents/skills`.
Legacy `.claude/skills` directories are still scanned for one migration window,
with `.agents/skills` taking precedence and deprecation warnings for any loaded
legacy skill.

```sh
vernier skills
vernier doctor
```

Prompt-delivered skills are snapshotted into the run dir and embedded in the
step prompt. Claude-native delivery synthesizes a run-local plugin and passes it
with `--plugin-dir`.

## 7. Operating Runs

Use the ledger as the source of truth:

```sh
vernier tick <runId>      # advance exactly one step
vernier resume <runId>    # drive to terminal from the journal
vernier show <runId>      # timeline, contracts, effects, decisions, usage
vernier stats --last 10   # roll up usage across journals
```

`resume` replays completed steps from the journal instead of re-running them.
Rebinding executors or skills on resume only affects steps that have not run
yet.

## 8. Troubleshooting

- `No loops are registered`: no config was found, or the config registers no
  loops. Run `vernier init smoke` or set `$VERNIER_CONFIG`.
- `Unresolved executor binding`: the resolved executor id is not registered.
  Run `vernier doctor` to see registered executors and per-step bindings.
- `Unresolved skill binding`: the skill name is not in config `skills`,
  `.agents/skills`, `~/.agents/skills`, or the deprecated `.claude/skills`
  fallback locations.
- `needs_human`: read the last decision and the failed contract checks with
  `vernier show <runId>`.
- `lease held` / exit 3: another live driver owns the run. Stale leases are
  taken over automatically after the heartbeat TTL.
- Empty or surprising effects: check the workdir recorded in the `meta` journal
  entry and whether the loop should use `observer: "git"`.
- In a source checkout, `bin/vernier.js` prefers `dist/`; rebuild after editing
  source before trusting the compiled CLI.

## 9. Where To Read Next

- [README](../README.md) for the reference command surface.
- [Provider details](provider-executors.md) for provider-specific sandbox and
  live-test behavior.
- [templates](../templates) for complete loop modules and template-local
  READMEs.
- Tests as executable documentation: `test/tick.test.ts`,
  `test/resume.test.ts`, `test/config.test.ts`, `test/cli.test.ts`,
  `test/skills.test.ts`, and the `*-template.test.ts` suites.

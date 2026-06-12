# coding-review — gate, implement, verify

`plan-work-review`: the shape most people come for. An LLM **route** gate
approves or rejects the task; a bound agent **implements** exactly one
artifact inside a declared fs scope; deterministic contracts judge both
steps; the policy gives the worker two attempts and sends route failures
straight to a human.

```
route      an LLM gate returns route-decision JSON   contract: route-decision.v1   effects: none
implement  an agent writes ONE artifact              contract: dry-run-note.v1     effects: fsScope("docs/agent-workflows/**")
```

## What it teaches

- An "orchestrator" is just a Step: the route gate is a prompt plus a
  contract, with `structuredOutput: true` deriving the JSON Schema from the
  step's zod signature.
- The artifact is **derived from effect attribution**, not self-reported —
  the diff is the report, and the contract pins it to the expected path.
- Retry with substance: attempt 2's prompt carries attempt 1's exact failed
  contract checks (`spec.retryHint`).
- Per-step **Agent Skills** (agentskills.io): `implement` declares
  `skills: ["dry-run-note-style"]` — the skill ships under `./skills` and is
  registered by the template's `vernier.config.json`. Claude receives it
  natively (a session `--plugin-dir`); every other provider gets the
  SKILL.md body embedded in the step prompt, delimited and attributed.
  Rebind per run like the executor:

  ```sh
  vernier run plan-work-review --skill implement=dry-run-note-style …
  vernier run plan-work-review --skill implement=    # clear the step's skills
  ```

## What it needs

Any wired agent CLI. Both steps declare the executor id `agent` — a binding
target — and the shipped `vernier.config.json` points both at `codex`:

```json
"bindings": { "route": "codex", "implement": "codex" }
```

Point them anywhere instead (`vernier doctor` says what is usable):

```sh
vernier run plan-work-review --executor implement=claude --input '{"task":"…"}'
vernier run plan-work-review --executor route=opencode   --input '{"task":"…"}'
vernier run plan-work-review --executor agent=claude     --input '{"task":"…"}'   # both roles
```

Honest provider notes: `implement` writes files — bind it to a provider
with enforced write boundaries (`codex`: OS sandbox derived from the effect
scope; `claude`: acceptEdits + workspace boundary). `cursor-agent`,
`opencode`, and `pi` fail closed on write scopes, so they can fill `route`
(effect-free) but not `implement`. `hermes` also works as a route binding.

## Run it

```sh
vernier doctor    # confirms the bound providers are usable
vernier run plan-work-review --input '{"task":"Create the expected dry-run note artifact for this loop. Do not edit any other file."}'
```

The default workdir is a throwaway scratch git repo (the registration
preps it); pass `--workdir` only at a git repo — the loop uses git-aware
effect attribution.

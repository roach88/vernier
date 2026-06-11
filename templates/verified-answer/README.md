# verified-answer — iterate until verified

`verified-answer`: a non-coding loop in the same five slots. An agent
**answers** a goal; an **independent judge** grades the answer against a
rubric the producer never sees; the `until` combinator loops back — with the
judge's feedback threaded into the next answer prompt — until the verdict
passes or `maxIterations` runs out.

```
answer  an agent produces a value          effects: none
grade   an independent structured verdict  effects: none
policy  until(verdict.passed, max 3, restartAt answer, feedback threaded)
```

## What it teaches

- **Independent verification**: the rubric reaches only the judge; each
  judge invocation is a fresh provider conversation — never self-critique.
- **Feedback threading**: a failed verdict is rendered into the iterate
  decision's `retryHint`, and the next answer prompt carries the verifier's
  exact words.
- **Structured output from one source of truth**: `structuredOutput: true`
  derives the judge's JSON Schema from the step's zod signature.

## What it needs

Any wired agent CLI for the `answer` role. The step declares the executor
id `agent` — a binding target — and the shipped config points it at codex:

```json
"bindings": { "answer": "codex" }
```

The step is effect-free, so ANY wired provider qualifies:

```sh
vernier run verified-answer --executor answer=claude --input '{"goal":"…","rubric":"…"}'
vernier run verified-answer --executor answer=pi     --input '{"goal":"…","rubric":"…"}'
```

The `grade` step runs on vernier's built-in `judge` executor (codex-backed
by default). Rebinding the judge's backing provider is a constructor-level
binding today (`new JudgeExecutor({ provider: "claude-code" })` in a custom
runtime); a `vernier.config` key for it is deferred.

## Run it

```sh
vernier doctor
vernier run verified-answer --input '{
  "goal": "Write a short note explaining why the Apollo 11 mission mattered.",
  "rubric": "PASS only if the note states the year 1969 and names all three astronauts."
}'
```

Then `vernier show <runId>` — a first-iteration failure renders as an
explicit `⟲ ITERATE` transition with the verifier's feedback journaled.

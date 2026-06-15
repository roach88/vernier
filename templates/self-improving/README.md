# self-improving — loops that learn across runs

`compounding-answer`: the full self-improving agent. The loop consults a
durable memory store FIRST, answers, gets graded by an independent judge,
self-corrects on failure — and once verified, distills ONE reusable rule and
remembers it. The next run, on a *related* goal, recalls that rule and does
better. Memory is what makes the loop compound ACROSS runs instead of
merely converging within one.

```
recall    deterministic store read (runs once; loop-backs skip it)
answer    an agent; sees recalled rules + on-retry verifier feedback
grade     independent judge; holds the rubric
distill   independent LLM: verified answer -> ONE general rule
remember  deterministic store write — only reachable after a passing grade
policy    until(grade.passed, at "grade", restartAt "answer", max 3)
```

## What it teaches

- **Memory is steps, not magic**: `recall`/`remember` are deterministic
  operations over an append-only `rules.jsonl`, and the recall topic is
  derived from the goal inside the step's zod signature.
- **Verified rules only, by shape**: `remember` sits after `grade`; there
  is no path into the store that does not pass through a passing verdict.
- **Compounding**: run the loop twice with related goals and compare
  iteration counts — run 2's first answer prompt carries run 1's rule.

## What it needs

Any wired agent CLI for the `answer` role (the step declares the binding
target `agent`; the shipped config points it at codex — the step is
effect-free, so any provider qualifies):

```json
"bindings": { "answer": "codex" }
```

`grade` and `distill` both run on vernier's built-in `judge` executor —
independent, structured-output, read-only; every invocation is a fresh
provider conversation. Codex backs it by default; the config's `judge`
block rebinds the ONE wrapper instance both steps ride
(`"judge": { "provider": "claude" }` — per-step splits stay with
`--executor distill=…`). `recall`/`remember` are built in and need nothing.

The store lives under the vernier root (`$VERNIER_HOME`, else `./.vernier`)
at `memory/rules.jsonl` — shared across CLI invocations, which is the
compounding seam. How recall RANKS the store is pluggable (BM25 lexical by
default; construct `Memory` with a custom retriever only after measured
recall quality needs it).

## Run it

```sh
vernier doctor
vernier run compounding-answer --input '{
  "goal": "Write a short note on why the Apollo 11 mission mattered.",
  "rubric": "PASS only if it mentions a specific year and the final sentence is exactly: \"Further study is encouraged.\""
}'
# then a RELATED goal — watch recall surface the learned rule:
vernier run compounding-answer --input '{
  "goal": "Write a short note on why the Hubble Space Telescope mattered.",
  "rubric": "PASS only if it mentions a specific year and the final sentence is exactly: \"Further study is encouraged.\""
}'
```

`vernier show <runId>` on both runs makes the compounding visible: run 1
iterates, distills, remembers; run 2 recalls and (usually) passes first try.

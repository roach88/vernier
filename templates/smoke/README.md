# smoke — the deterministic starter

`control-plane-smoke-test`: a one-step, no-agent loop that exercises the
whole vernier lifecycle — signature validation, a typed step, a contract
(`run-trace.v1`, built in), effect-scope attribution, a pure policy, and an
append-only ledger — without an API key in sight.

## What it teaches

- The five-slot Loop shape with **nothing hidden**: every slot in
  `smoke-loop.mjs` is a hand-rolled plain object (the other templates show
  the idiomatic helpers from `"vernier"` instead).
- Contracts validate the output *value* (here: the trace file the step
  claims to have written really exists and satisfies `run-trace.v1`).
- Effects are observed, not trusted: the engine snapshots the workdir and
  attributes every changed file against the step's declared scope.

## What it needs

Nothing. No agent CLI, no auth, no network. (The module's one bare
specifier, `zod`, resolves from your project's `node_modules` — installing
`vernier` brings it in.)

## Run it

```sh
vernier loops                          # the loop is registered via vernier.config.json
vernier run control-plane-smoke-test   # exit 0, trace written, ledger appended
vernier run control-plane-smoke-test --input '{"jobName":"my-job","upstreamChanged":true}'
vernier show <runId>                   # the run as a timeline
```

The workdir defaults to `$VERNIER_HOME/work` (else `./.vernier/work`); the
trace lands under `evidence/traces/control-plane-smoke-test/` inside it —
exactly the scope the step declares.

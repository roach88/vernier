---
name: dry-run-note-style
description: House style for runner dry-run notes — tone, section order, and formatting rules for the plan-work-review artifact. Use when writing or revising a runner dry-run note.
---

# Runner dry-run note style

Write the note so a reviewer can scan it in under a minute.

## Rules

- Keep the whole note under 40 lines.
- H1 title: `Runner dry run <trace-id>` — the trace id verbatim, nothing else.
- Use exactly the required sections, in order: `## Route`, `## Bundle`,
  `## Runner Verification`, `## Improvement Candidate`.
- One fact per line; prefer `label: value` lines over prose.
- `## Route`: who approved (the route gate), the worker role, and the
  one-sentence routing reason.
- `## Bundle`: the bundle path and the artifact path, each on its own
  labeled line.
- `## Runner Verification`: state plainly that the runner validates this
  artifact and writes the trace — the worker does neither.
- `## Improvement Candidate`: exactly one candidate, phrased as an
  imperative sentence naming a concrete loop change, not a vague wish.
- No command output, no tool logs, no emoji, no trailing sign-off.

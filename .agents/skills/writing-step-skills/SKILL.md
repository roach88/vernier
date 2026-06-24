---
name: writing-step-skills
description: Author Agent Skills (agentskills.io format) for vernier steps — SKILL.md frontmatter rules, registration and discovery tiers, binding skills to steps via the executor-mirroring chain, native vs prompt delivery, and the symlink-free constraint. Use when creating a skill for a loop step, registering or binding skills in vernier.config, or debugging why a skill is not resolving or not being delivered.
license: MIT
---

# Writing Agent Skills for vernier steps

A skill dictates a CAPABILITY per step — house style, a review lens, a
procedure — the same way the step dictates an executor. vernier implements
the [Agent Skills](https://agentskills.io) open standard, so a skill you
write here works in any skills-compatible agent, and vice versa.

## The format (spec rules vernier enforces)

A skill is a directory with a `SKILL.md`: YAML frontmatter + Markdown body.

```
my-skill/
├── SKILL.md          # required
├── scripts/          # optional bundled files (regular files only)
├── references/
└── assets/
```

- `name`: 1–64 chars, lowercase `a-z0-9` and single hyphens (no leading/
  trailing/consecutive), and **must match the directory name**.
- `description`: 1–1024 chars; say WHAT it does and WHEN to use it —
  that's what activation decisions read.
- Optional: `license`, `compatibility`, `metadata`, `allowed-tools`.
- Keep the body lean (≤500 lines per spec; for vernier, prompt-delivered
  bodies are re-sent EVERY attempt — every line is tokens on retries).

**vernier constraint: the skill tree must be symlink-free.** A symlink
anywhere inside the tree is refused at delivery (it would break the
byte-for-byte snapshot and could exfiltrate out-of-tree files into a
provider plugin). The skill DIRECTORY itself may be a symlink — the
`.agents/skills` marketplace install shape — it is resolved first.

## Registering and binding

Discovery tiers (earlier wins name collisions):

1. `vernier.config` `skills` paths — a `SKILL.md`, a skill dir, or a
   parent dir of skill dirs. Duplicates within this tier are an error.
2. `<project>/.agents/skills/`
3. `~/.agents/skills/`

Binding mirrors executors exactly — keys are a step id or an executor
role id (the loop's DECLARED vocabulary):

```
--skill review=security-review   >   config skillBindings   >   the step's declared skills
--skill review=                      (clears; clearing beats accumulation)
```

`Step.skills: ["name"]` is the loop default. Repeated/comma'd `--skill`
flags for one key ACCUMULATE (a step can carry several skills);
`--executor` by contrast is last-wins. Skill-bearing steps must have a
prompt template.

```json
{ "skills": ["./.agents/skills"], "skillBindings": { "implement": ["house-style"] } }
```

## How delivery works (write for both modes)

- **Claude (native):** vernier synthesizes a session plugin under the run
  dir and passes `--plugin-dir`; the model sees name + description and
  loads the body on demand (progressive disclosure), invocable as
  `/vernier-skills:<name>`. Your `description` does the activation work —
  make it specific.
- **Every other executor (prompt):** the body is embedded in the step
  prompt, fenced `<skill name=… dir=…>`, after the skill is snapshotted
  under the run dir — the fence's `dir` names the immutable copy, so
  bundled files the agent reads cannot drift from what the ledger
  recorded.

Write the body to work BOTH ways: self-contained instructions first;
reference bundled files by relative path (`scripts/run.sh`) and only for
material that doesn't belong inline. Don't rely on tools the executor may
not have (a read-only step can't run scripts).

**Skills steer; contracts enforce.** A rule that matters only if the model
obeys it is not enforced — pair the skill's style guidance with a step
contract that checks the hard requirements deterministically. (Live
pattern that works: the skill names the exact title format and line
budget; the contract checks required sections; the policy's retryHint
carries failures back.)

## Verifying

```sh
vernier skills              # inventory: name [tier] dir — spec-invalid skills listed with the violated rule
vernier doctor              # per-step: which skills each step resolves, and what's missing
vernier run ... --json      # then check the run dir + journal
```

In the journal, every `step_started` records
`skills: { resolved: [{name, dir}], delivery: "native" | "prompt" }`.
Evidence: `skills-plugin/` (native) or `skills-snapshot/` + the embedded
body in `*-prompt.md` (prompt mode). A missing skill fails BEFORE the
first journal write, listing the discovered inventory.

## Debugging quick table

| symptom | cause |
|---|---|
| "Unresolved skill binding(s)" (exit 2) | name not discovered — register the path in config `skills` or place under `.agents/skills`; the error lists what WAS discovered |
| skill listed `!!` in `vernier skills` | spec violation — message names the rule (frontmatter missing, name/dir mismatch, length) |
| "contains a symlink" failure | a symlink inside the skill tree — ship real files instead |
| "declares skills but no prompt template" | skills travel through the prompt seam — give the step a prompt |
| skill resolved but model ignored it | prompt mode: check the embedded body in `*-prompt.md`; native: sharpen the `description` (activation reads it) and enforce hard rules in a contract |

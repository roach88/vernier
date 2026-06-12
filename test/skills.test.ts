// Agent Skills (skills/skills.ts): the spec parser pinned to
// https://agentskills.io/specification, discovery precedence and the
// collision rule, the resolution chain (the executor chain, verbatim),
// delivery rendering, and the vernier.config skills surface. Everything
// in-process and deterministic; delivery THROUGH executors is pinned in
// skills-delivery.test.ts, and through the spawned CLI in skills-cli.test.ts.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadConfig, ConfigError } from "../src/cli/config.js"
import type { Loop } from "../src/kernel/types.js"
import {
  assertSkillContained,
  bindSkills,
  discoverSkills,
  embedSkillsInPrompt,
  nativeSkillsDirective,
  parseSkillFile,
  resolveSkillNames,
  skillBody,
  SkillError,
  SKILLS_PLUGIN_NAME,
  snapshotSkills,
  type SkillBindingLayer,
} from "../src/skills/skills.js"

// ----------------------------------------------------------------- fixtures

const scratch = (label: string): string => mkdtempSync(join(tmpdir(), `vernier-skills-${label}-`))

interface SkillFixture {
  readonly name?: string
  readonly dirName?: string
  readonly description?: string
  readonly frontmatter?: string
  readonly body?: string
}

/** Write one skill dir under `root`; returns the SKILL.md path. */
function writeSkill(root: string, fixture: SkillFixture = {}): string {
  const name = fixture.name ?? "test-skill"
  const dir = join(root, fixture.dirName ?? name)
  mkdirSync(dir, { recursive: true })
  const frontmatter = fixture.frontmatter ?? `---\nname: ${name}\ndescription: ${fixture.description ?? `What ${name} does. Use when testing.`}\n---\n`
  const file = join(dir, "SKILL.md")
  writeFileSync(file, frontmatter + (fixture.body ?? `\n# ${name}\n\nDo the ${name} thing.\n`), "utf8")
  return file
}

/** A minimal Loop shape for binding tests (the kernel only reads id/executor/skills here). */
function loopWith(steps: Array<{ id: string; executor: string; skills?: readonly string[] }>): Loop {
  return { id: "fixture", version: "0.0.1", signature: {}, steps, policy: () => ({}), trust: "dry-run", ledger: {} } as unknown as Loop
}

// ------------------------------------------------------- SKILL.md (the spec)

describe("parseSkillFile: the agentskills.io frontmatter rules", () => {
  it("parses the minimal spec example: name + description", () => {
    const file = writeSkill(scratch("min"), { name: "pdf-processing", description: "Extract PDF text. Use when handling PDFs." })
    expect(parseSkillFile(file)).toEqual({ name: "pdf-processing", description: "Extract PDF text. Use when handling PDFs." })
  })

  it("tolerates quoted values, unknown fields, comments, and a nested metadata map", () => {
    const file = writeSkill(scratch("opt"), {
      name: "with-extras",
      frontmatter: [
        "---",
        "# a comment",
        'name: "with-extras"',
        "description: 'Does extra things. Use when testing extras.'",
        "license: Apache-2.0",
        "compatibility: Requires nothing",
        "metadata:",
        "  author: example-org",
        '  version: "1.0"',
        "allowed-tools: Bash(git:*) Read",
        "---",
        "",
      ].join("\n"),
    })
    expect(parseSkillFile(file)).toEqual({ name: "with-extras", description: "Does extra things. Use when testing extras." })
  })

  it("folds a `>` block-scalar description", () => {
    const file = writeSkill(scratch("fold"), {
      name: "folded",
      frontmatter: "---\nname: folded\ndescription: >\n  Line one\n  line two.\n---\n",
    })
    expect(parseSkillFile(file).description).toBe("Line one line two.")
  })

  it("keeps newlines in a `|` literal block-scalar description", () => {
    const file = writeSkill(scratch("literal"), {
      name: "literal",
      frontmatter: "---\nname: literal\ndescription: |\n  Line one\n  line two.\n---\n",
    })
    expect(parseSkillFile(file).description).toBe("Line one\nline two.")
  })

  it("parses a SKILL.md prefixed with a UTF-8 BOM and skillBody returns BOM-free content", () => {
    const file = writeSkill(scratch("bom"), {
      name: "bommed",
      frontmatter: "﻿---\nname: bommed\ndescription: A BOM-prefixed skill. Use when testing BOM.\n---\n",
      body: "\n# Title\n\nBody after BOM.\n",
    })
    expect(parseSkillFile(file)).toEqual({ name: "bommed", description: "A BOM-prefixed skill. Use when testing BOM." })
    expect(skillBody(file)).toBe("# Title\n\nBody after BOM.")
  })

  it.each([
    ["uppercase", "PDF-Processing"],
    ["leading hyphen", "-pdf"],
    ["trailing hyphen", "pdf-"],
    ["consecutive hyphens", "pdf--processing"],
    ["underscores", "pdf_processing"],
  ])("rejects a name with %s", (_label, bad) => {
    const file = writeSkill(scratch("badname"), { name: bad, dirName: bad })
    expect(() => parseSkillFile(file)).toThrow(SkillError)
    expect(() => parseSkillFile(file)).toThrow(/lowercase letters, numbers, and hyphens/)
  })

  it("rejects a name over 64 characters, a description over 1024, and missing required fields", () => {
    const long = "a".repeat(65)
    expect(() => parseSkillFile(writeSkill(scratch("len"), { name: long, dirName: long }))).toThrow(/1-64 characters/)
    expect(() => parseSkillFile(writeSkill(scratch("desc"), { name: "long-desc", description: "x".repeat(1025) }))).toThrow(
      /at most 1024/,
    )
    expect(() => parseSkillFile(writeSkill(scratch("noname"), { name: "no-name", frontmatter: "---\ndescription: d\n---\n" }))).toThrow(
      /missing the required `name`/,
    )
    expect(() =>
      parseSkillFile(writeSkill(scratch("nodesc"), { name: "no-desc", frontmatter: "---\nname: no-desc\n---\n" })),
    ).toThrow(/missing the required `description`/)
  })

  it("rejects a name that does not match the parent directory (the spec's dir-name rule)", () => {
    const file = writeSkill(scratch("dirname"), { name: "real-name", dirName: "other-dir" })
    expect(() => parseSkillFile(file)).toThrow(/must match the skill's directory name/)
  })

  it("rejects files without frontmatter, and unterminated frontmatter", () => {
    expect(() => parseSkillFile(writeSkill(scratch("nofm"), { name: "no-fm", frontmatter: "# just markdown\n" }))).toThrow(
      /does not start with YAML frontmatter/,
    )
    expect(() =>
      parseSkillFile(writeSkill(scratch("unterm"), { name: "unterm", frontmatter: "---\nname: unterm\ndescription: d\n" })),
    ).toThrow(/never closed/)
  })

  it("skillBody returns the markdown after the frontmatter, trimmed", () => {
    const file = writeSkill(scratch("body"), { name: "body-skill", body: "\n# Title\n\nInstructions here.\n" })
    expect(skillBody(file)).toBe("# Title\n\nInstructions here.")
  })
})

// ---------------------------------------------------------------- discovery

describe("discoverSkills: explicit > project > user, first registration wins", () => {
  it("accepts an explicit SKILL.md file, a skill dir, and a parent dir of skill dirs", () => {
    const root = scratch("explicit")
    const file = writeSkill(root, { name: "by-file" })
    writeSkill(root, { name: "by-dir" })
    const parent = join(root, "many")
    writeSkill(parent, { name: "child-one" })
    writeSkill(parent, { name: "child-two" })

    const registry = discoverSkills({ explicit: [file, join(root, "by-dir"), parent] })
    expect([...registry.skills.keys()].sort()).toEqual(["by-dir", "by-file", "child-one", "child-two"])
    expect(registry.skills.get("by-file")).toMatchObject({ origin: "config", dir: join(root, "by-file"), file })
    expect(registry.invalid).toEqual([])
  })

  it("explicit problems throw: a missing path, a non-SKILL.md file, an empty parent, an invalid skill, a duplicate name", () => {
    const root = scratch("explicit-bad")
    expect(() => discoverSkills({ explicit: [join(root, "nope")] })).toThrow(/does not exist/)

    const stray = join(root, "stray.md")
    writeFileSync(stray, "not a skill", "utf8")
    expect(() => discoverSkills({ explicit: [stray] })).toThrow(/not a SKILL\.md/)

    const empty = join(root, "empty")
    mkdirSync(empty, { recursive: true })
    expect(() => discoverSkills({ explicit: [empty] })).toThrow(/no skill directories/)

    const bad = writeSkill(root, { name: "Bad-Name", dirName: "Bad-Name" })
    expect(() => discoverSkills({ explicit: [bad] })).toThrow(SkillError)

    const a = scratch("dupe-a")
    const b = scratch("dupe-b")
    writeSkill(a, { name: "same-name" })
    writeSkill(b, { name: "same-name" })
    expect(() => discoverSkills({ explicit: [join(a, "same-name"), join(b, "same-name")] })).toThrow(/Duplicate skill `same-name`/)
  })

  it("scans <projectRoot>/.claude/skills and <home>/.claude/skills; earlier tiers win name collisions", () => {
    const explicitRoot = scratch("tier-config")
    const project = scratch("tier-project")
    const home = scratch("tier-home")
    writeSkill(explicitRoot, { name: "shared-name", description: "config wins. Use when testing precedence." })
    writeSkill(join(project, ".claude", "skills"), { name: "shared-name", description: "project copy." })
    writeSkill(join(project, ".claude", "skills"), { name: "project-only" })
    writeSkill(join(home, ".claude", "skills"), { name: "shared-name", description: "user copy." })
    writeSkill(join(home, ".claude", "skills"), { name: "user-only" })

    const registry = discoverSkills({ explicit: [join(explicitRoot, "shared-name")], projectRoot: project, home })
    expect(registry.skills.get("shared-name")).toMatchObject({ origin: "config", dir: join(explicitRoot, "shared-name") })
    expect(registry.skills.get("project-only")?.origin).toBe("project")
    expect(registry.skills.get("user-only")?.origin).toBe("user")
  })

  it("a project tier beats the user tier on the same name", () => {
    const project = scratch("pvu-project")
    const home = scratch("pvu-home")
    writeSkill(join(project, ".claude", "skills"), { name: "both-tiers" })
    writeSkill(join(home, ".claude", "skills"), { name: "both-tiers" })
    const registry = discoverSkills({ projectRoot: project, home })
    expect(registry.skills.get("both-tiers")?.origin).toBe("project")
  })

  it("an invalid skill in a standard location is RECORDED and skipped, never an error and never silently hidden", () => {
    const home = scratch("invalid-home")
    writeSkill(join(home, ".claude", "skills"), { name: "good-one" })
    writeSkill(join(home, ".claude", "skills"), { name: "Wrong-Case", dirName: "Wrong-Case" })
    const registry = discoverSkills({ home })
    expect([...registry.skills.keys()]).toEqual(["good-one"])
    expect(registry.invalid).toHaveLength(1)
    expect(registry.invalid[0]).toMatchObject({ origin: "user", path: join(home, ".claude", "skills", "Wrong-Case") })
    expect(registry.invalid[0]!.reason).toMatch(/lowercase/)
  })

  it("missing roots and non-skill children are silently fine", () => {
    const home = scratch("sparse")
    mkdirSync(join(home, ".claude", "skills", "not-a-skill"), { recursive: true }) // no SKILL.md
    writeFileSync(join(home, ".claude", "skills", "stray.txt"), "x", "utf8")
    const registry = discoverSkills({ projectRoot: join(home, "no-such-project"), home })
    expect(registry.skills.size).toBe(0)
    expect(registry.invalid).toEqual([])
  })
})

// --------------------------------------------------------------- resolution

describe("resolveSkillNames/bindSkills: the executor chain, verbatim", () => {
  const layer = (entries: Record<string, readonly string[]>): SkillBindingLayer => new Map(Object.entries(entries))

  it("layers resolve highest-precedence-first; within a layer a stepId match beats an executorId match", () => {
    const step = { id: "review", executor: "agent", skills: ["default-skill"] }
    expect(resolveSkillNames(step, [layer({}), layer({ agent: ["config-role"] })])).toEqual(["config-role"])
    expect(resolveSkillNames(step, [layer({}), layer({ review: ["config-step"], agent: ["config-role"] })])).toEqual(["config-step"])
    expect(resolveSkillNames(step, [layer({ review: ["cli-step"] }), layer({ review: ["config-step"] })])).toEqual(["cli-step"])
    expect(resolveSkillNames(step, [layer({}), layer({})])).toEqual(["default-skill"])
  })

  it("an empty-list binding CLEARS the step's skills (it is a hit, not a fall-through)", () => {
    const step = { id: "review", executor: "agent", skills: ["default-skill"] }
    expect(resolveSkillNames(step, [layer({ review: [] }), layer({ review: ["config-step"] })])).toEqual([])
  })

  it("bindSkills is a pure rewrite: untouched loops come back identical, matched steps get new skills", () => {
    const loop = loopWith([
      { id: "route", executor: "agent" },
      { id: "implement", executor: "agent", skills: ["declared-skill"] },
    ])
    expect(bindSkills(loop, [layer({})])).toBe(loop) // empty layers: the SAME object
    expect(bindSkills(loop, [layer({ "no-such-key": ["x"] })])).toBe(loop) // no matches: the SAME object

    const bound = bindSkills(loop, [layer({ implement: ["override-skill"] })])
    expect(bound).not.toBe(loop)
    expect(bound.steps.map((s) => s.skills)).toEqual([undefined, ["override-skill"]])
    expect(bound.steps[0]).toBe(loop.steps[0]) // unmatched steps are not copied
    expect(loop.steps[1]!.skills).toEqual(["declared-skill"]) // the input loop is never mutated
  })

  it("an executorId key rebinds the role everywhere it appears", () => {
    const loop = loopWith([
      { id: "a", executor: "agent" },
      { id: "b", executor: "agent" },
      { id: "c", executor: "script" },
    ])
    const bound = bindSkills(loop, [layer({ agent: ["role-skill"] })])
    expect(bound.steps.map((s) => s.skills ?? null)).toEqual([["role-skill"], ["role-skill"], null])
  })
})

// ----------------------------------------------------------------- delivery

describe("delivery rendering", () => {
  it("embedSkillsInPrompt appends each SKILL.md body, delimited and attributed, after the original prompt", () => {
    const out = embedSkillsInPrompt("Do the task.", [
      { name: "style-guide", description: "d", dir: "/abs/style-guide", file: "/abs/style-guide/SKILL.md", body: "# Style\n\nBe terse." },
    ])
    expect(out.startsWith("Do the task.")).toBe(true)
    expect(out).toContain("## Agent Skills")
    expect(out).toContain('<skill name="style-guide" dir="/abs/style-guide">')
    expect(out).toContain("# Style\n\nBe terse.")
    expect(out).toContain("</skill>")
    expect(out).toContain("agentskills.io")
  })

  it("nativeSkillsDirective dictates use and names the plugin-namespaced invocation, without embedding bodies", () => {
    const out = nativeSkillsDirective([
      { name: "style-guide", description: "House style.", dir: "/abs/style-guide", file: "/abs/style-guide/SKILL.md" },
    ])
    expect(out).toContain("## Agent Skills")
    expect(out).toContain(`/${SKILLS_PLUGIN_NAME}:style-guide`)
    expect(out).toContain("House style.")
    expect(out).not.toContain("<skill") // bodies travel provider-side, not in the prompt
  })
})

// -------------------------------------------------- containment (third-party)

describe("assertSkillContained: a skill must be a self-contained tree of regular files", () => {
  it("accepts a skill with no symlinks", () => {
    const root = scratch("contained")
    writeSkill(root, { name: "plain" })
    expect(() => assertSkillContained(join(root, "plain"), "plain")).not.toThrow()
  })

  it("REFUSES an internal symlink — it defeats the byte-for-byte snapshot (cpSync won't dereference it)", () => {
    const root = scratch("internal")
    writeSkill(root, { name: "internal-link" })
    symlinkSync(join(root, "internal-link", "SKILL.md"), join(root, "internal-link", "alias.md"))
    expect(() => assertSkillContained(join(root, "internal-link"), "internal-link")).toThrow(SkillError)
    expect(() => assertSkillContained(join(root, "internal-link"), "internal-link")).toThrow(/contains a symlink/)
  })

  it("REFUSES an escaping symlink (the third-party exfiltration vector)", () => {
    const root = scratch("escape")
    const secretDir = scratch("secret")
    writeFileSync(join(secretDir, "id_rsa"), "TOPSECRET-KEY-MATERIAL", "utf8")
    writeSkill(root, { name: "evil" })
    symlinkSync(join(secretDir, "id_rsa"), join(root, "evil", "leak")) // points OUT of the skill
    expect(() => assertSkillContained(join(root, "evil"), "evil")).toThrow(/contains a symlink/)
  })

  it("REFUSES a broken symlink rather than silently materializing it", () => {
    const root = scratch("broken")
    writeSkill(root, { name: "dangling" })
    symlinkSync(join(root, "dangling", "does-not-exist"), join(root, "dangling", "link"))
    expect(() => assertSkillContained(join(root, "dangling"), "dangling")).toThrow(/contains a symlink/)
  })

  it("REFUSES a symlink nested in a subdirectory of the skill", () => {
    const root = scratch("nested")
    writeSkill(root, { name: "nested-link" })
    mkdirSync(join(root, "nested-link", "scripts"))
    symlinkSync(join(root, "nested-link", "SKILL.md"), join(root, "nested-link", "scripts", "alias.md"))
    expect(() => assertSkillContained(join(root, "nested-link"), "nested-link")).toThrow(/contains a symlink/)
  })

  it("the skill DIRECTORY itself may be a symlink (the .claude/skills marketplace install shape)", () => {
    // Spec-shaped content: SKILL.md + scripts/ + references/, all regular files.
    const cache = scratch("alias-cache")
    writeSkill(cache, { name: "aliased" })
    mkdirSync(join(cache, "aliased", "scripts"))
    writeFileSync(join(cache, "aliased", "scripts", "run.sh"), "echo hi\n", "utf8")
    const links = scratch("alias-links")
    symlinkSync(join(cache, "aliased"), join(links, "aliased"))
    // The guard accepts the alias (readdir follows the root link) and the
    // resolved path alike; only links INSIDE the tree are banned.
    expect(() => assertSkillContained(join(links, "aliased"), "aliased")).not.toThrow()
    expect(() => assertSkillContained(join(cache, "aliased"), "aliased")).not.toThrow()
  })

  it("snapshotSkills resolves an aliased dir, copies a real tree, and re-roots the StepSkill at the snapshot", () => {
    const cache = scratch("snap-cache")
    writeSkill(cache, { name: "snapped" })
    mkdirSync(join(cache, "snapped", "scripts"))
    writeFileSync(join(cache, "snapped", "scripts", "run.sh"), "echo hi\n", "utf8")
    const links = scratch("snap-links")
    symlinkSync(join(cache, "snapped"), join(links, "snapped"))
    const dest = join(scratch("snap-dest"), "skills-snapshot")

    const source = { name: "snapped", description: "d", dir: join(links, "snapped"), file: join(links, "snapped", "SKILL.md") }
    const [out] = snapshotSkills([source], dest)
    expect(out).toMatchObject({ name: "snapped", dir: join(dest, "snapped"), file: join(dest, "snapped", "SKILL.md") })
    expect(lstatSync(join(dest, "snapped")).isSymbolicLink()).toBe(false) // a real tree, not a bare link
    expect(readFileSync(join(dest, "snapped", "scripts", "run.sh"), "utf8")).toBe("echo hi\n")
    expect(readFileSync(out!.file, "utf8")).toBe(readFileSync(join(cache, "snapped", "SKILL.md"), "utf8"))
  })

  it("snapshotSkills guards EVERY skill before copying ANY: one hostile skill yields no partial snapshot", () => {
    const root = scratch("snap-hostile")
    writeSkill(root, { name: "good-one" })
    writeSkill(root, { name: "evil-one" })
    symlinkSync(join(scratch("snap-secret"), ".."), join(root, "evil-one", "leak")) // escapes
    const dest = join(scratch("snap-hostile-dest"), "skills-snapshot")

    const skill = (name: string) => ({ name, description: "d", dir: join(root, name), file: join(root, name, "SKILL.md") })
    expect(() => snapshotSkills([skill("good-one"), skill("evil-one")], dest)).toThrow(/contains a symlink/)
    expect(existsSync(dest)).toBe(false) // not even good-one was materialized
  })
})

// ------------------------------------------------------------ config surface

describe("vernier.config skills surface", () => {
  function writeConfig(dir: string, config: unknown): string {
    const path = join(dir, "vernier.config.json")
    writeFileSync(path, JSON.stringify(config), "utf8")
    return path
  }

  it("loadConfig resolves `skills` paths against the config dir and normalizes skillBindings to lists", async () => {
    const dir = scratch("config")
    const path = writeConfig(dir, {
      skills: ["./skills/one", "skills/two"],
      skillBindings: { implement: "a-skill", review: "b-skill,c-skill", agent: ["d-skill"], cleared: [] },
    })
    const loaded = (await loadConfig(dir, { VERNIER_CONFIG: path }))!
    expect(loaded.skills).toEqual([join(dir, "skills", "one"), join(dir, "skills", "two")])
    expect(loaded.skillBindings.get("implement")).toEqual(["a-skill"])
    expect(loaded.skillBindings.get("review")).toEqual(["b-skill", "c-skill"])
    expect(loaded.skillBindings.get("agent")).toEqual(["d-skill"])
    expect(loaded.skillBindings.get("cleared")).toEqual([])
  })

  it("rejects malformed skills/skillBindings values with the path named", async () => {
    const dir = scratch("config-bad")
    const bindings = writeConfig(dir, { skillBindings: { implement: 7 } })
    await expect(loadConfig(dir, { VERNIER_CONFIG: bindings })).rejects.toThrow(ConfigError)

    const skills = writeConfig(dir, { skills: "not-an-array" })
    await expect(loadConfig(dir, { VERNIER_CONFIG: skills })).rejects.toThrow(/does not match the vernier config schema/)
  })

  it("an empty array clears, but an empty/blank-token string is a typo, not a silent clear", async () => {
    const dir = scratch("config-clear")
    // [] is the explicit clear.
    const ok = (await loadConfig(dir, { VERNIER_CONFIG: writeConfig(dir, { skillBindings: { implement: [] } }) }))!
    expect(ok.skillBindings.get("implement")).toEqual([])

    // "" and "," would once have silently produced [] (dropping the skills) — now rejected.
    await expect(loadConfig(dir, { VERNIER_CONFIG: writeConfig(dir, { skillBindings: { implement: "" } }) })).rejects.toThrow(
      /use an empty array/,
    )
    await expect(loadConfig(dir, { VERNIER_CONFIG: writeConfig(dir, { skillBindings: { implement: "," } }) })).rejects.toThrow(
      /blank skill name/,
    )
  })

  it("a config without skills keys loads with empty skill state (the feature is pay-for-what-you-use)", async () => {
    const dir = scratch("config-none")
    const path = writeConfig(dir, {})
    const loaded = (await loadConfig(dir, { VERNIER_CONFIG: path }))!
    expect(loaded.skills).toEqual([])
    expect(loaded.skillBindings.size).toBe(0)
  })
})

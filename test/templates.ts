// Shared helpers for the template test suites: load a template's loop
// module and its shipped config bindings the way the CLI would.
//
// Template modules import from "vernier" (the published package surface);
// vitest.config.ts aliases that to src/index.ts, so these suites run from
// source — no build, no node_modules/vernier — exactly like the rest of
// the deterministic suite.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { LoopRegistration } from "../src/cli/config.js"

export const TEMPLATES = join(import.meta.dirname, "..", "templates")

/** Each template ships exactly one loop module; find it by extension. */
export function templateModuleFile(template: string): string {
  const file = readdirSync(join(TEMPLATES, template)).find((name) => name.endsWith(".mjs"))
  if (!file) throw new Error(`template ${template} has no .mjs loop module`)
  return file
}

/** The template's default-exported registration ({ loop, contracts, ... }). */
export async function templateRegistration(template: string, module: string): Promise<LoopRegistration> {
  const mod = (await import(pathToFileURL(join(TEMPLATES, template, module)).href)) as { default: LoopRegistration }
  return mod.default
}

/** The template's full module (for named exports: contracts, helpers). */
export async function templateModule(template: string, module: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(join(TEMPLATES, template, module)).href)) as Record<string, unknown>
}

/** The executor bindings the template's shipped vernier.config.json declares. */
export function templateBindings(template: string): Map<string, string> {
  const config = JSON.parse(readFileSync(join(TEMPLATES, template, "vernier.config.json"), "utf8")) as {
    bindings?: Record<string, string>
  }
  return new Map(Object.entries(config.bindings ?? {}))
}

/** The skill registrations the template's shipped vernier.config.json declares, template-dir-resolved. */
export function templateSkills(template: string): string[] {
  const config = JSON.parse(readFileSync(join(TEMPLATES, template, "vernier.config.json"), "utf8")) as {
    skills?: string[]
  }
  return (config.skills ?? []).map((entry) => join(TEMPLATES, template, entry))
}

/**
 * A LoadedConfig equivalent to scaffolding the named templates into one
 * project: their registrations plus their shipped bindings and skill
 * registrations, merged — what loadConfig() would produce, built in-process
 * so the suites need no scaffold step (and no node_modules/vernier for the
 * spawned bin).
 */
export async function templatesAsConfig(...names: string[]): Promise<{
  path: string
  loops: Array<{ registration: LoopRegistration; source: string }>
  executors: never[]
  bindings: Map<string, string>
  skills: string[]
  skillBindings: Map<string, readonly string[]>
}> {
  const loops: Array<{ registration: LoopRegistration; source: string }> = []
  const bindings = new Map<string, string>()
  const skills: string[] = []
  for (const name of names) {
    const moduleFile = templateModuleFile(name)
    loops.push({ registration: await templateRegistration(name, moduleFile), source: join(TEMPLATES, name, moduleFile) })
    for (const [key, value] of templateBindings(name)) bindings.set(key, value)
    skills.push(...templateSkills(name))
  }
  return { path: join(TEMPLATES, "vernier.config.json"), loops, executors: [], bindings, skills, skillBindings: new Map() }
}

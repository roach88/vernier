import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

export const CURSOR_BIN_CANDIDATES = ["agent", "cursor-agent"] as const

export type CursorBinSource = "explicit" | "env" | "path" | "default"

export interface CursorBinResolution {
  readonly bin: string
  readonly requires: string
  readonly ok: boolean
  readonly source: CursorBinSource
  readonly detail: string
  readonly tried: readonly string[]
  readonly found?: string
}

export interface CursorBinResolverOpts {
  readonly explicitBin?: string
  readonly env?: NodeJS.ProcessEnv
  readonly which?: (bin: string) => string | undefined
}

export function resolveCursorBin(opts: CursorBinResolverOpts = {}): CursorBinResolution {
  const env = opts.env ?? process.env
  const which = opts.which ?? ((bin: string) => defaultWhich(bin, env))
  if (opts.explicitBin !== undefined) {
    return resolved({
      bin: opts.explicitBin,
      requires: opts.explicitBin,
      source: "explicit",
      tried: [opts.explicitBin],
      found: which(opts.explicitBin),
      missing: `explicit Cursor binary \`${opts.explicitBin}\` was not found`,
    })
  }
  const envBin = env.VERNIER_CURSOR_BIN
  if (envBin !== undefined && envBin.length > 0) {
    return resolved({
      bin: envBin,
      requires: envBin,
      source: "env",
      tried: [envBin],
      found: which(envBin),
      missing: `VERNIER_CURSOR_BIN=\`${envBin}\` was not found`,
    })
  }

  for (const candidate of CURSOR_BIN_CANDIDATES) {
    const found = which(candidate)
    if (found !== undefined) {
      return resolved({
        bin: found,
        requires: candidate,
        source: "path",
        tried: [...CURSOR_BIN_CANDIDATES],
        found,
        missing: "",
      })
    }
  }

  const tried = [...CURSOR_BIN_CANDIDATES]
  return {
    bin: CURSOR_BIN_CANDIDATES[0],
    requires: CURSOR_BIN_CANDIDATES[0],
    ok: false,
    source: "default",
    tried,
    detail: `\`${tried.join("` or `")}\` not found on PATH`,
  }
}

export function defaultWhich(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isAbsolute(bin)) return executable(bin) ? bin : undefined
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, bin)
    if (executable(candidate)) return candidate
  }
  return undefined
}

function resolved(args: {
  readonly bin: string
  readonly requires: string
  readonly source: CursorBinSource
  readonly tried: readonly string[]
  readonly found: string | undefined
  readonly missing: string
}): CursorBinResolution {
  if (args.found !== undefined) {
    return {
      bin: args.bin,
      requires: args.requires,
      ok: true,
      source: args.source,
      detail: resolvedDetail(args.source, args.requires, args.found),
      tried: args.tried,
      found: args.found,
    }
  }
  return {
    bin: args.bin,
    requires: args.requires,
    ok: false,
    source: args.source,
    detail: args.missing,
    tried: args.tried,
  }
}

function resolvedDetail(source: CursorBinSource, requires: string, found: string): string {
  switch (source) {
    case "explicit":
      return `explicit Cursor binary \`${requires}\` (${found})`
    case "env":
      return `VERNIER_CURSOR_BIN=\`${requires}\` (${found})`
    case "path":
      return `\`${requires}\` on PATH (${found})`
    case "default":
      return `\`${requires}\` (${found})`
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

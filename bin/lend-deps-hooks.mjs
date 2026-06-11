// Resolution fallback: lend the CLI's own dependencies to config modules.
//
// Registered via module.register() by cli/main.{ts,js} — the one module
// every entry path executes (compiled bin, source-checkout bin, `npm run
// vernier`) — so the hook is active in every mode BEFORE any vernier.config
// module is imported. Plain .mjs in bin/ because the hooks thread loads
// this file under plain node: no build step, no loader, same relative
// position from src/cli and dist/cli.
//
// WHY: `vernier init` scaffolds templates whose modules import bare
// specifiers — `zod`, and `"vernier"` itself. Bare ESM specifiers resolve
// by walking node_modules upward from the IMPORTING module; a bare scaffold
// directory has none, so the templates were dead on arrival until the user
// ran an install. This hook retries FAILED bare-specifier resolutions
// against vernier's own installation, so a fresh scaffold runs immediately.
//
// SCOPE: the fallback fires only after default resolution FAILS. vernier's
// own internal imports always resolve (they ship with the package), and a
// project with its own node_modules wins outright — its copy resolves first
// and this hook never engages. The retries therefore reach exactly the
// imports default resolution cannot serve: config modules (and their
// relative imports) in dependency-less directories.
//
// VERSION-SKEW HONESTY: when the fallback serves `zod`, the template runs
// against the zod version vernier bundles, not one the project chose. The
// moment the project installs its own copy, that copy wins.
//
// TRUST: config code already executes with this process's full privileges
// (see src/cli/config.ts's trust boundary); letting it resolve modules
// vernier already ships adds no new trust surface.

import { existsSync } from "node:fs"

// This file lives in bin/, one level under the package root.
const PACKAGE_ROOT = new URL("..", import.meta.url)
// Bare resolution walks up from the parent's directory; any root-level file anchors it.
const LENDER_PARENT = new URL("package.json", PACKAGE_ROOT).href

/** Bare = neither relative, nor absolute, nor a URL, nor a package-internal #import. */
function isBare(specifier) {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return false
  }
  try {
    new URL(specifier)
    return false
  } catch {
    return true
  }
}

/**
 * `"vernier"` cannot be lent by node_modules walk-up (this installation has
 * no node_modules/vernier — it IS vernier); map it onto this installation's
 * own surface: dist/index.js when built, else src/index.ts (the source-
 * checkout bin registers tsx, which loads .ts). Mirrors package.json
 * `exports`: ".", "./package.json", nothing else.
 */
function selfUrl(specifier) {
  if (specifier === "vernier/package.json") return new URL("package.json", PACKAGE_ROOT).href
  if (specifier !== "vernier") return undefined
  const dist = new URL("dist/index.js", PACKAGE_ROOT)
  return existsSync(dist) ? dist.href : new URL("src/index.ts", PACKAGE_ROOT).href
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!isBare(specifier)) throw error
    if (specifier === "vernier" || specifier.startsWith("vernier/")) {
      const url = selfUrl(specifier)
      if (url !== undefined) return { url, shortCircuit: true }
      throw error
    }
    try {
      return await nextResolve(specifier, { ...context, parentURL: LENDER_PARENT })
    } catch {
      throw error // not ours to lend either — the original error names the user's module
    }
  }
}

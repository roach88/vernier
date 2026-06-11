#!/usr/bin/env node
// The `vernier` bin. A built checkout (or an installed package) runs the
// compiled CLI under PLAIN node — no loader, no devDependencies. A source
// checkout without a build falls back to running the TypeScript through
// tsx's loader, so dev flows (tests, `npm run vernier`) never
// require a build step. NOTE: dist/ wins when present — after editing
// source, rebuild (or remove dist/) before trusting this bin.
import { existsSync } from "node:fs"

const dist = new URL("../dist/cli/main.js", import.meta.url)
if (existsSync(dist)) {
  await import(dist.href)
} else {
  const { register } = await import("tsx/esm/api")
  register()
  await import(new URL("../src/cli/main.ts", import.meta.url).href)
}

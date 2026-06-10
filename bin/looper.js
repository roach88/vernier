#!/usr/bin/env node
// The `looper` bin: run the TypeScript CLI through tsx's loader so there is
// no build step (the repo runs from source everywhere else too).
import { register } from "tsx/esm/api"
register()
await import(new URL("../src/cli/main.ts", import.meta.url).href)

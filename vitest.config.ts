import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // Template modules import from "vernier" (the published package surface).
    // In this checkout that surface is src/index.ts — alias it so the test
    // suite loads templates without requiring a build (dist/).
    alias: { vernier: fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
})

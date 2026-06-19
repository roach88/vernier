import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })
}

function runJson(command, args, options = {}) {
  const stdout = run(command, args, options)
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`expected JSON from ${command} ${args.join(" ")}: ${stdout}`, { cause: error })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const packDir = mkdtempSync(join(tmpdir(), "vernier-pack-"))
const consumerDir = mkdtempSync(join(tmpdir(), "vernier-consumer-"))
const vernierHome = mkdtempSync(join(tmpdir(), "vernier-home-"))
const realConsumerDir = realpathSync(consumerDir)
const realVernierHome = realpathSync(vernierHome)

const packJson = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir])
const pack = JSON.parse(packJson)[0]
assert(pack?.filename, "npm pack did not return a package filename")

const files = new Set(pack.files.map((file) => file.path))
for (const required of ["bin/vernier.js", "dist/index.js", "dist/cli/main.js", "templates/smoke/smoke-loop.mjs", "docs/safety.md"]) {
  assert(files.has(required), `missing ${required} from package`)
}
assert(!files.has("src/cli/main.ts"), "package unexpectedly includes CLI source; installed smoke must prove dist, not source fallback")

run("npm", ["init", "-y"], { cwd: consumerDir })
run("npm", ["install", "--ignore-scripts", "--omit=dev", join(packDir, pack.filename)], { cwd: consumerDir })

const bin = join(consumerDir, "node_modules", ".bin", "vernier")
const env = { ...process.env, VERNIER_HOME: vernierHome }
delete env.VERNIER_CONFIG

const help = run(bin, ["--help"], { cwd: consumerDir, env })
assert(help.includes("vernier run <loopId>"), "installed vernier bin did not print the expected help text")

const init = run(bin, ["init", "smoke"], { cwd: consumerDir, env })
assert(init.includes("scaffolded template `smoke`"), "installed vernier init smoke did not scaffold the smoke template")
for (const required of ["vernier.config.json", "smoke-loop.mjs", "README.md"]) {
  assert(existsSync(join(consumerDir, required)), `installed init smoke did not create ${required}`)
}

const loops = runJson(bin, ["loops", "--json"], { cwd: consumerDir, env })
assert(Array.isArray(loops), "installed vernier loops --json did not return an array")
assert(loops.map((loop) => loop.id).includes("control-plane-smoke-test"), "installed smoke config did not register control-plane-smoke-test")
const smokeLoop = loops.find((loop) => loop.id === "control-plane-smoke-test")
assert(realpathSync(String(smokeLoop.source)).startsWith(`${realConsumerDir}/`), "installed smoke loop resolved outside the temp consumer")

const outcome = runJson(bin, ["run", "control-plane-smoke-test", "--json"], { cwd: consumerDir, env })
assert(outcome.status === "done", `installed smoke run did not finish done: ${outcome.status}`)
assert(outcome.output?.ok === true, "installed smoke run did not return ok output")
assert(typeof outcome.runId === "string" && outcome.runId.length > 0, "installed smoke run did not return a runId")
assert(realpathSync(String(outcome.journal)).startsWith(`${realVernierHome}/`), "installed smoke run journal was not isolated under VERNIER_HOME")
assert(realpathSync(String(outcome.workdir)).startsWith(`${realVernierHome}/`), "installed smoke run workdir was not isolated under VERNIER_HOME")
assert(existsSync(join(vernierHome, "work", outcome.output.trace)), "installed smoke run did not write the declared trace")

const shown = runJson(bin, ["show", outcome.runId, "--json"], { cwd: consumerDir, env })
assert(shown.runId === outcome.runId, "installed show did not read the run produced by smoke run")
assert(shown.status === "done", "installed show did not report the smoke run as done")
assert(Array.isArray(shown.entries) && shown.entries.some((entry) => entry.type === "decision"), "installed show did not include the journal decision")

const stats = runJson(bin, ["stats", "--json"], { cwd: consumerDir, env })
assert(stats.runs?.some((run) => run.runId === outcome.runId), "installed stats did not include the smoke run")
assert(stats.loops?.some((loop) => loop.loopId === "control-plane-smoke-test" && loop.succeeded === 1), "installed stats did not roll up the smoke loop success")

const imported = run("node", ["--input-type=module", "-e", "import('vernier').then((m) => { if (!m.sig || !m.defineLoop) throw new Error('missing public exports') })"], {
  cwd: consumerDir,
})
void imported

console.log(`package smoke ok: ${pack.filename} ${pack.files.length} files; installed run ${outcome.runId}`)

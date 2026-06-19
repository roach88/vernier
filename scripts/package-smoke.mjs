import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })
}

const packDir = mkdtempSync(join(tmpdir(), "vernier-pack-"))
const consumerDir = mkdtempSync(join(tmpdir(), "vernier-consumer-"))

const packJson = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir])
const pack = JSON.parse(packJson)[0]
if (!pack?.filename) throw new Error("npm pack did not return a package filename")

const files = new Set(pack.files.map((file) => file.path))
for (const required of ["bin/vernier.js", "dist/index.js", "dist/cli/main.js", "docs/safety.md"]) {
  if (!files.has(required)) throw new Error(`missing ${required} from package`)
}

run("npm", ["init", "-y"], { cwd: consumerDir })
run("npm", ["install", "--ignore-scripts", "--omit=dev", join(packDir, pack.filename)], { cwd: consumerDir })

const help = run(join(consumerDir, "node_modules", ".bin", "vernier"), ["--help"], { cwd: consumerDir })
if (!help.includes("vernier run <loopId>")) throw new Error("installed vernier bin did not print the expected help text")

const imported = run("node", ["--input-type=module", "-e", "import('vernier').then((m) => { if (!m.sig || !m.defineLoop) throw new Error('missing public exports') })"], {
  cwd: consumerDir,
})
void imported

console.log(`package smoke ok: ${pack.filename} ${pack.files.length} files`)

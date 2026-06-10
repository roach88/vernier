// Run Pilot 0 end-to-end: `npm run pilot0`
// Workdir and ledger default to ./.looper (override workdir with argv[2],
// ledger root with $LOOPER_HOME).

import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { runLoop } from "../engine/tick.js"
import { defaultContractRegistry } from "../kernel/contract.js"
import { Ledger } from "../ledger/ledger.js"
import { executorRegistry } from "../executors/script.js"
import { controlPlaneSmokeExecutor, controlPlaneSmokeLoop } from "./loop.js"

const workdir = resolve(process.argv[2] ?? join(process.cwd(), ".looper", "work"))
mkdirSync(workdir, { recursive: true })

const outcome = await runLoop(
  controlPlaneSmokeLoop,
  { jobName: "watch-every-compound-engineering-upstream" },
  {
    executors: executorRegistry(controlPlaneSmokeExecutor),
    contracts: defaultContractRegistry(),
    workdir,
  },
)

const { state, decision, output } = outcome
console.log(`loop      ${controlPlaneSmokeLoop.id}@${controlPlaneSmokeLoop.version} (trust: ${controlPlaneSmokeLoop.trust})`)
console.log(`run       ${state.runId}`)
console.log(`status    ${state.status}`)
console.log(`decision  ${decision.kind} / ${decision.classification} — ${decision.summary}`)
console.log(`output    ${JSON.stringify(output)}`)

const ledgerRoot = process.env.LOOPER_HOME ?? join(process.cwd(), ".looper")
const journal = join(ledgerRoot, "runs", state.runId, "journal.jsonl")
console.log(`trace     ${join(workdir, String(output?.trace ?? ""))}`)
console.log(`ledger    ${journal}`)
console.log("--- ledger entries ---")
for (const entry of Ledger.load(journal)) {
  console.log(`  ${entry.type.padEnd(13)} ${"stepId" in entry ? `${entry.stepId} attempt=${entry.attempt}` : `${entry.loopId}@${entry.loopVersion}`}`)
}

process.exit(state.status === "done" ? 0 : 1)

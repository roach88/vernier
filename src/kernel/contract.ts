// Contracts: deterministic semantic validation of a step's output value.
// Ported from looper's agent_workflows/contracts/ (ContractCheck /
// ContractResult / registry). A `path`-valued output field whose file
// content gets validated remains the common case (run-trace.v1 below).

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

export interface ContractCheck {
  readonly label: string
  readonly passed: boolean
  readonly detail: string
}

export interface ContractResult {
  readonly contractId: string
  readonly valid: boolean
  readonly checks: readonly ContractCheck[]
}

export interface ContractContext {
  readonly traceId: string
  readonly loopId: string
  readonly loopVersion: string
  readonly workdir: string
  /** The executor that produced the output (Python looper's `worker` context field). */
  readonly executorId: string
  /** Absolute path of the run's ledger dir (Python looper's `bundle_path` context field). */
  readonly runDir: string
}

export interface Contract {
  readonly id: string
  validate(output: Record<string, unknown>, ctx: ContractContext): ContractResult
}

/** Failed checks as `label — detail` strings: exact enough to drive a retry prompt. */
export function failedCheckMessages(result: ContractResult): string[] {
  return result.checks.filter((c) => !c.passed).map((c) => `${c.label} — ${c.detail}`)
}

export class ContractRegistry {
  private readonly contracts = new Map<string, Contract>()

  register(contract: Contract): this {
    if (this.contracts.has(contract.id)) throw new Error(`Duplicate contract id \`${contract.id}\`.`)
    this.contracts.set(contract.id, contract)
    return this
  }

  lookup(id: string): Contract {
    const contract = this.contracts.get(id)
    if (!contract) throw new Error(`Unknown contract id \`${id}\`.`)
    return contract
  }
}

// ------------------------------------------------------------- run-trace.v1
// Ported from agent_workflows/contracts/run_trace.py.

export const RUN_TRACE_V1 = "run-trace.v1"

function metadataLineContains(text: string, field: string, value: string): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^.*\`${escape(field)}\`.*${escape(value)}.*$`, "m").test(text)
}

export const runTraceV1: Contract = {
  id: RUN_TRACE_V1,
  validate(output, ctx) {
    const tracePath = typeof output.trace === "string" ? output.trace : ""
    const absolute = tracePath && !isAbsolute(tracePath) ? join(ctx.workdir, tracePath) : tracePath
    const exists = Boolean(absolute) && existsSync(absolute)
    const text = exists ? readFileSync(absolute, "utf8") : ""

    const checks: ContractCheck[] = [
      { label: "trace file exists", passed: exists, detail: `expected a readable trace file at \`${tracePath || "<missing trace output field>"}\`` },
      { label: "trace heading recorded", passed: text.trimStart().startsWith("# Trace:"), detail: "expected a `# Trace:` markdown heading" },
      { label: "trace id recorded", passed: text.includes(ctx.traceId), detail: `expected trace id \`${ctx.traceId}\`` },
      { label: "loop id recorded", passed: metadataLineContains(text, "loop_id", ctx.loopId), detail: `expected loop id \`${ctx.loopId}\` in trace metadata` },
      { label: "loop version recorded", passed: metadataLineContains(text, "loop_version", ctx.loopVersion), detail: `expected loop version \`${ctx.loopVersion}\` in trace metadata` },
      { label: "result classification recorded", passed: text.includes("`result.classification`"), detail: "expected result classification metadata" },
      { label: "improvement candidate recorded", passed: text.includes("`improvement_candidate.summary`"), detail: "expected one improvement candidate summary" },
    ]
    return { contractId: RUN_TRACE_V1, valid: checks.every((c) => c.passed), checks }
  },
}

export function defaultContractRegistry(): ContractRegistry {
  return new ContractRegistry().register(runTraceV1)
}

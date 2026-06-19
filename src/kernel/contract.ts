// Contracts: deterministic semantic validation of a step's output value.
// Ported from the Python predecessor's agent_workflows/contracts/ (ContractCheck /
// ContractResult / registry). A `path`-valued output field whose file
// content gets validated remains the common case (run-trace.v1 below).

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

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
  /** The executor that produced the output (the Python predecessor's `worker` context field). */
  readonly executorId: string
  /** Absolute path of the run's ledger dir (the Python predecessor's `bundle_path` context field). */
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

const MAX_TRACE_BYTES = 1_000_000

function safeReadWorkdirRelativeTrace(tracePath: string, workdir: string): { exists: boolean; text: string; detail: string } {
  if (!tracePath) return { exists: false, text: "", detail: "expected a readable trace file at `<missing trace output field>`" }
  if (isAbsolute(tracePath)) return { exists: false, text: "", detail: `expected trace path \`${tracePath}\` to be relative to the workdir` }
  const root = resolve(workdir)
  const absolute = resolve(root, tracePath)
  const rel = relative(root, absolute)
  if (rel === "" || rel.startsWith("..") || rel.includes(":") || rel.startsWith("/")) {
    return { exists: false, text: "", detail: `expected trace path \`${tracePath}\` to stay inside the workdir` }
  }
  try {
    const realRoot = realpathSync(root)
    const realAbsolute = realpathSync(absolute)
    const realRel = relative(realRoot, realAbsolute)
    if (realRel === "" || realRel.startsWith("..") || realRel.includes(":") || realRel.startsWith("/")) {
      return { exists: false, text: "", detail: `expected trace path \`${tracePath}\` to stay inside the real workdir` }
    }
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return { exists: false, text: "", detail: `expected trace path \`${tracePath}\` to be a regular file` }
      if (stat.size > MAX_TRACE_BYTES) return { exists: false, text: "", detail: `expected trace file \`${tracePath}\` to be <= ${MAX_TRACE_BYTES} bytes` }
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_TRACE_BYTES))
      const bytes = readSync(fd, buffer, 0, buffer.length, 0)
      return { exists: true, text: buffer.subarray(0, bytes).toString("utf8"), detail: `expected a readable trace file at \`${tracePath}\`` }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { exists: false, text: "", detail: `expected a readable trace file at \`${tracePath}\`` }
  }
}

function metadataLineContains(text: string, field: string, value: string): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^.*\`${escape(field)}\`.*${escape(value)}.*$`, "m").test(text)
}

export const runTraceV1: Contract = {
  id: RUN_TRACE_V1,
  validate(output, ctx) {
    const tracePath = typeof output.trace === "string" ? output.trace : ""
    const trace = safeReadWorkdirRelativeTrace(tracePath, ctx.workdir)
    const exists = trace.exists
    const text = trace.text

    const checks: ContractCheck[] = [
      { label: "trace file exists", passed: exists, detail: trace.detail },
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

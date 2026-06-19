// Evidence file naming shared by the worker-backed executors. The Python
// predecessor labeled the second worker pass "retry-"; iterate loop-backs add an
// "iter-" prefix; the step slug prevents same-executor steps in the same pass
// from overwriting one another's evidence in the run dir.

import { createHash } from "node:crypto"
import type { StepSpec } from "../kernel/types.js"

export function safeEvidenceSlug(value: string): string {
  const windowsDevice = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(value) && !value.endsWith(".") && !windowsDevice.test(value)) return value
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8)
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 39)
  return `~${cleaned.length > 0 ? cleaned : "step"}-${hash}`
}

export function evidencePrefix(spec: StepSpec): string {
  const iter = spec.iteration > 1 ? `iter-${spec.iteration}-` : ""
  const retry = spec.attempt > 1 ? `retry-${spec.attempt}-` : ""
  const step = `${safeEvidenceSlug(spec.stepId)}-`
  return iter + retry + step
}

// Evidence file naming shared by the worker-backed executors. The Python
// predecessor labeled the second worker pass "retry-"; iterate loop-backs add an
// "iter-" prefix so no pass ever overwrites another pass's evidence in the
// run dir (the ledger must keep every attempt of every iteration).

import type { StepSpec } from "../kernel/types.js"

export function evidencePrefix(spec: StepSpec): string {
  const iter = spec.iteration > 1 ? `iter-${spec.iteration}-` : ""
  const retry = spec.attempt > 1 ? `retry-${spec.attempt}-` : ""
  return iter + retry
}

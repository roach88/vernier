export type BindingKeyStep = { readonly id: string; readonly executor: string }
export type BindingLayer<T> = ReadonlyMap<string, T>

export function bindingVocabulary(loop: { readonly steps: readonly BindingKeyStep[] }): { readonly stepIds: readonly string[]; readonly executorIds: readonly string[] } {
  return {
    stepIds: [...new Set(loop.steps.map((s) => s.id))],
    executorIds: [...new Set(loop.steps.map((s) => s.executor))],
  }
}

export function resolveLayeredBinding<T>(step: BindingKeyStep, layers: readonly BindingLayer<T>[], fallback: T): T {
  for (const layer of layers) {
    const bound = layer.get(step.id) ?? layer.get(step.executor)
    if (bound !== undefined) return bound
  }
  return fallback
}

export function bindLoopSteps<LoopT extends { readonly steps: readonly StepT[] }, StepT extends BindingKeyStep, ValueT>(
  loop: LoopT,
  layers: readonly BindingLayer<ValueT>[],
  fallback: (step: StepT) => ValueT,
  same: (a: ValueT, b: ValueT) => boolean,
  bind: (step: StepT, value: ValueT) => StepT,
): LoopT {
  if (layers.every((layer) => layer.size === 0)) return loop
  let changed = false
  const steps = loop.steps.map((step) => {
    const base = fallback(step)
    const value = resolveLayeredBinding(step, layers, base)
    if (same(value, base)) return step
    changed = true
    return bind(step, value)
  })
  return changed ? { ...loop, steps } : loop
}

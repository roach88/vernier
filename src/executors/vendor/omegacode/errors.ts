// Vendored from omegacode src/worker/errors.ts
// https://github.com/SawyerHood/omegacode — MIT License, Copyright (c) 2026 Sawyer Hood.
// See LICENSE in this directory and the repository NOTICE file.
// Local adaptation: imports of "../dsl/types.js" point at "./types.js" (vendored subset).

import { setTimeout as delayAsync } from "node:timers/promises"
import { AgentError, AgentInterrupted } from "./index.js"

export interface RetryOptions {
  attempts?: number
  baseMs?: number
  maxMs?: number
}

/** Run `fn`, retrying on retryable AgentErrors with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4
  const base = opts.baseMs ?? 1000
  const max = opts.maxMs ?? 30_000
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) throw new AgentInterrupted()
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!(err instanceof AgentError) || !err.retryable || i === attempts - 1) throw err
      const delay = Math.min(max, base * 2 ** i)
      await sleep(delay, signal)
    }
  }
  throw lastErr
}

/** Abort-aware sleep; rejects with AgentInterrupted if the signal fires (or is already aborted). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return delayAsync(ms, undefined, { signal }).catch(() => {
    throw new AgentInterrupted()
  })
}

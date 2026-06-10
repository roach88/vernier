// Vendored from omegacode src/worker/index.ts
// https://github.com/SawyerHood/omegacode — MIT License, Copyright (c) 2026 Sawyer Hood.
// See LICENSE in this directory and the repository NOTICE file.
// Local adaptations: imports of "../dsl/types.js" point at "./types.js"
// (vendored subset); optional properties widened with `| undefined` because
// looper compiles with exactOptionalPropertyTypes (omegacode does not).

import type { AgentResult, AgentSpec, AgentUsage, ProviderId } from "./types.js"

/** Conversation/progress signals a worker emits while a turn runs (drives the live chat feed). */
export type WorkerProgress =
  | { kind: "text"; text: string } // assistant message text (chunk or delta)
  | { kind: "reasoning"; text: string } // thinking / reasoning text
  | { kind: "tool"; id?: string | undefined; name: string; input?: unknown } // tool / command / file-change use
  | { kind: "tool-result"; id?: string | undefined; name?: string | undefined; output?: string | undefined; isError?: boolean | undefined }
  | { kind: "usage"; usage: Partial<AgentUsage> }

export interface WorkerContext {
  signal: AbortSignal
  onProgress: (e: WorkerProgress) => void
}

/** A provider backend: runs one agent turn to completion. */
export interface Worker {
  readonly id: ProviderId
  runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult>
  shutdown(): Promise<void>
}

/** Lazily constructs and caches one worker per provider. */
export interface WorkerFactory {
  get(id: ProviderId): Worker
  shutdownAll(): Promise<void>
}

/** A worker raised this when a turn failed for a provider reason (after retries). */
export class AgentError extends Error {
  readonly provider: ProviderId
  readonly code: string
  readonly retryable: boolean
  /** Tokens the failed turn consumed, when the provider reported them — failed turns still bill. */
  readonly usage?: AgentUsage | undefined
  constructor(args: { provider: ProviderId; code: string; message: string; retryable?: boolean; usage?: AgentUsage }) {
    super(args.message)
    this.name = "AgentError"
    this.provider = args.provider
    this.code = args.code
    this.retryable = args.retryable ?? false
    this.usage = args.usage
  }
}

/** Raised when an agent turn was interrupted (Ctrl-C, cancel, stall-abort). */
export class AgentInterrupted extends Error {
  constructor(message = "agent interrupted") {
    super(message)
    this.name = "AgentInterrupted"
  }
}

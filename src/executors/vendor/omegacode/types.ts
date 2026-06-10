// Vendored from omegacode src/dsl/types.ts (the worker-facing subset only)
// https://github.com/SawyerHood/omegacode — MIT License, Copyright (c) 2026 Sawyer Hood.
// See LICENSE in this directory and the repository NOTICE file.
// Local adaptation: omegacode's dsl/types.ts also declares the workflow DSL
// (AgentOpts, Meta, WorkflowGlobals, budget). Those belong to the node:vm
// workflow trunk this kernel deliberately rejects, so only the provider/agent
// contracts the workers compile against are kept here.

/** The closed set of backend providers. Model strings stay open — each backend is authoritative. */
export const PROVIDER_IDS = ["codex", "claude-code", "opencode", "pi"] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/** read-only: no writes; workspace-write: write within cwd; danger-full-access: unrestricted. */
export type Sandbox = "read-only" | "workspace-write" | "danger-full-access"

// Union of both providers' reasoning-effort levels. codex: none/minimal/low/medium/high/xhigh;
// claude-code: low/medium/high/xhigh/max. Each worker maps to its nearest supported value.
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export type Approval = "never" | "on-request"

/** A plain JSON Schema object (draft-07-ish). We do not constrain it further at the type level. */
export type JSONSchema = Record<string, unknown>

/** A fully-resolved request handed to a Worker (no undefined for required policy fields). */
export interface AgentSpec {
  prompt: string
  provider: ProviderId
  model?: string
  effort?: Effort
  cwd: string
  sandbox: Sandbox
  approval: Approval
  instructions?: string
  schema?: JSONSchema
  maxTurns?: number
}

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 }
}

export function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  }
}

export type AgentStatus = "completed" | "failed" | "interrupted"

/** Normalized result every Worker returns. */
export interface AgentResult {
  text: string
  /** Present only when the spec carried a schema. Already client-side validated. */
  structured?: unknown
  status: AgentStatus
  usage: AgentUsage
}

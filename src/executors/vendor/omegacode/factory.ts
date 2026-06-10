// Vendored from omegacode src/worker/factory.ts
// https://github.com/SawyerHood/omegacode — MIT License, Copyright (c) 2026 Sawyer Hood.
// See LICENSE in this directory and the repository NOTICE file.
// Local adaptations: imports of "../dsl/types.js" point at "./types.js"; the
// claude-code / opencode / pi branches return notImplemented() instead of
// constructing their workers — those adapters are vendored alongside this file
// but not yet wired into looper (claude.ts additionally needs the
// @anthropic-ai/claude-agent-sdk dependency, which looper does not carry yet).

import type { ProviderId } from "./types.js"
import { type Worker, type WorkerFactory } from "./index.js"
import { notImplemented } from "./errors.js"
import { FakeWorker } from "./fake.js"
import { CodexWorker } from "./codex.js"
import { CursorWorker } from "./cursor.js"
import type { SpawnProcess } from "./subprocess-jsonl.js"

export interface FactoryOpts {
  /** Use the in-process FakeWorker for every provider (smoke tests, --fake). */
  fake?: boolean
  codexBin?: string
  cursorBin?: string
  cursorConfigDir?: string
  cursorSpawnProcess?: SpawnProcess
  cursorStallTimeoutMs?: number
}

export class DefaultWorkerFactory implements WorkerFactory {
  private readonly cache = new Map<ProviderId, Worker>()
  constructor(private readonly opts: FactoryOpts = {}) {}

  get(id: ProviderId): Worker {
    let w = this.cache.get(id)
    if (!w) {
      w = this.create(id)
      this.cache.set(id, w)
    }
    return w
  }

  private create(id: ProviderId): Worker {
    if (this.opts.fake) return new FakeWorker()
    switch (id) {
      case "codex":
        return new CodexWorker({ bin: this.opts.codexBin })
      case "cursor-agent":
        return new CursorWorker({
          ...(this.opts.cursorBin !== undefined ? { bin: this.opts.cursorBin } : {}),
          ...(this.opts.cursorConfigDir !== undefined ? { configDir: this.opts.cursorConfigDir } : {}),
          ...(this.opts.cursorSpawnProcess !== undefined ? { spawnProcess: this.opts.cursorSpawnProcess } : {}),
          ...(this.opts.cursorStallTimeoutMs !== undefined ? { stallTimeoutMs: this.opts.cursorStallTimeoutMs } : {}),
        })
      case "claude-code":
      case "opencode":
      case "pi":
        // Vendored but not yet wired in looper — codex is the only live
        // provider this step. The adapters sit next door when their turn comes.
        return notImplemented(id)
    }
  }

  async shutdownAll(): Promise<void> {
    for (const w of this.cache.values()) {
      try {
        await w.shutdown()
      } catch {
        // best-effort
      }
    }
    this.cache.clear()
  }
}

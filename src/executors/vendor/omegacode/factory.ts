// Vendored from omegacode src/worker/factory.ts
// https://github.com/SawyerHood/omegacode — MIT License, Copyright (c) 2026 Sawyer Hood.
// See LICENSE in this directory and the repository NOTICE file.
// Local adaptations: imports of "../dsl/types.js" point at "./types.js"; the
// claude-code branch returns notImplemented() — vernier drives Claude Code
// through the CLI with its own non-vendored worker at the executor layer
// (src/executors/claude.ts, ClaudeCliWorker), so omegacode's SDK-based
// worker is not vendored (see NOTICE). codex / cursor-agent / opencode / pi
// construct their real workers.

import type { ProviderId } from "./types.js"
import { type Worker, type WorkerFactory } from "./index.js"
import { notImplemented } from "./errors.js"
import { FakeWorker } from "./fake.js"
import { CodexWorker } from "./codex.js"
import { CursorWorker } from "./cursor.js"
import { OpencodeWorker } from "./opencode.js"
import { PiWorker } from "./pi.js"
import type { SpawnProcess } from "./subprocess-jsonl.js"

export interface FactoryOpts {
  /** Use the in-process FakeWorker for every provider (smoke tests, --fake). */
  fake?: boolean
  codexBin?: string
  cursorBin?: string
  cursorConfigDir?: string
  cursorSpawnProcess?: SpawnProcess
  cursorStallTimeoutMs?: number
  opencodeBin?: string
  opencodeSpawnProcess?: SpawnProcess
  opencodeStallTimeoutMs?: number
  piBin?: string
  piSpawnProcess?: SpawnProcess
  piStallTimeoutMs?: number
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
      case "opencode":
        return new OpencodeWorker({
          ...(this.opts.opencodeBin !== undefined ? { bin: this.opts.opencodeBin } : {}),
          ...(this.opts.opencodeSpawnProcess !== undefined ? { spawnProcess: this.opts.opencodeSpawnProcess } : {}),
          ...(this.opts.opencodeStallTimeoutMs !== undefined ? { stallTimeoutMs: this.opts.opencodeStallTimeoutMs } : {}),
        })
      case "pi":
        return new PiWorker({
          ...(this.opts.piBin !== undefined ? { bin: this.opts.piBin } : {}),
          ...(this.opts.piSpawnProcess !== undefined ? { spawnProcess: this.opts.piSpawnProcess } : {}),
          ...(this.opts.piStallTimeoutMs !== undefined ? { stallTimeoutMs: this.opts.piStallTimeoutMs } : {}),
        })
      case "claude-code":
        // Wired at vernier's executor layer instead (ClaudeCliWorker in
        // src/executors/claude.ts — the CLI on PATH, no SDK).
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

// Run leases: one driver per run.
//
// The loom/omegacode heartbeat-deadman pattern as a plain file under the
// run dir — lease.json with {pid, host, acquiredAt, heartbeatAt, ttlMs} —
// no external dependency. A LIVE lease (fresh heartbeat, holder not
// verifiably dead) blocks a second driver with LeaseHeldError (the CLI maps
// it to exit code 3). A STALE lease — heartbeat older than its TTL, or a
// same-host holder whose pid no longer exists — is taken over. The holder
// heartbeats on an unref'd interval while driving and releases on terminal
// state; a process 'exit' hook releases on clean exit. A SIGKILL'd driver
// releases nothing, which is the point: its lease goes stale (instantly on
// the same host via the pid check, within ttlMs across hosts) and the next
// driver takes over.
//
// Honest limits: the takeover write is an atomic rename, but two drivers
// that BOTH observe the same stale lease can race; the post-write re-read
// narrows that window to the rename itself without closing it. Pid reuse
// can make a dead same-host holder look alive — the heartbeat TTL still
// expires it. Good enough for the actual threat (a cron tick and a human
// driving the same run), not for adversarial concurrency.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"

export const DEFAULT_TTL_MS = 30_000

export interface LeaseRecord {
  readonly pid: number
  readonly host: string
  readonly acquiredAt: string
  readonly heartbeatAt: string
  readonly ttlMs: number
}

export class LeaseHeldError extends Error {
  constructor(
    readonly holder: LeaseRecord,
    readonly path: string,
  ) {
    const age = Math.max(0, Date.now() - Date.parse(holder.heartbeatAt))
    super(
      `Run lease is held by pid ${holder.pid} on \`${holder.host}\` (heartbeat ${Math.round(age / 1000)}s ago, ttl ${Math.round(holder.ttlMs / 1000)}s): ${path}. ` +
        `Another driver is advancing this run. If that driver is dead, its lease expires ${Math.round(Math.max(0, holder.ttlMs - age) / 1000)}s from now and the next acquire takes over.`,
    )
    this.name = "LeaseHeldError"
  }
}

export function leasePath(runDir: string): string {
  return join(runDir, "lease.json")
}

function readLease(path: string): LeaseRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseRecord>
    if (typeof parsed.pid !== "number" || typeof parsed.host !== "string" || typeof parsed.heartbeatAt !== "string") return null
    return {
      pid: parsed.pid,
      host: parsed.host,
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : parsed.heartbeatAt,
      heartbeatAt: parsed.heartbeatAt,
      ttlMs: typeof parsed.ttlMs === "number" && parsed.ttlMs > 0 ? parsed.ttlMs : DEFAULT_TTL_MS,
    }
  } catch {
    return null // missing or torn lease file: treat as unheld
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = exists but not ours; ESRCH (and anything else) = gone.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Stale = heartbeat older than its TTL (deadman), or a same-host holder whose pid is gone. */
export function isStale(record: LeaseRecord, nowMs = Date.now()): boolean {
  const age = nowMs - Date.parse(record.heartbeatAt)
  if (!Number.isFinite(age) || age > record.ttlMs) return true
  if (record.host === hostname() && !pidAlive(record.pid)) return true
  return false
}

function writeAtomic(path: string, record: LeaseRecord): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record) + "\n", "utf8")
  renameSync(tmp, path)
}

export class Lease {
  private released = false
  private record: LeaseRecord
  private readonly timer: NodeJS.Timeout
  private readonly onExit = (): void => this.release()

  constructor(
    readonly path: string,
    record: LeaseRecord,
    heartbeatMs: number,
  ) {
    this.record = record
    this.timer = setInterval(() => this.heartbeat(), heartbeatMs)
    this.timer.unref() // never keep the process alive just to heartbeat
    process.on("exit", this.onExit)
  }

  /** Refresh heartbeatAt on disk. Runs on the interval; callable directly. */
  heartbeat(): void {
    if (this.released) return
    this.record = { ...this.record, heartbeatAt: new Date().toISOString() }
    writeAtomic(this.path, this.record)
  }

  /** Stop heartbeating and remove the lease file — only if it is still ours (a takeover's file is not). */
  release(): void {
    if (this.released) return
    this.released = true
    clearInterval(this.timer)
    process.removeListener("exit", this.onExit)
    const current = readLease(this.path)
    if (current && current.pid === this.record.pid && current.host === this.record.host) {
      rmSync(this.path, { force: true })
    }
  }
}

export interface AcquireOpts {
  readonly ttlMs?: number
  readonly heartbeatMs?: number
}

export interface AcquiredLease {
  readonly lease: Lease
  /** The stale record that was taken over, when there was one — drivers should say so on stderr. */
  readonly tookOver: LeaseRecord | null
}

export function acquireLease(runDir: string, opts: AcquireOpts = {}): AcquiredLease {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const path = leasePath(runDir)
  mkdirSync(runDir, { recursive: true })

  const existing = readLease(path)
  let tookOver: LeaseRecord | null = null
  if (existing && !(existing.pid === process.pid && existing.host === hostname())) {
    if (!isStale(existing)) throw new LeaseHeldError(existing, path)
    tookOver = existing
  }

  const at = new Date().toISOString()
  const record: LeaseRecord = { pid: process.pid, host: hostname(), acquiredAt: at, heartbeatAt: at, ttlMs }
  writeAtomic(path, record)
  // Last-writer-wins on the rename: re-read to confirm this acquire won any takeover race.
  const final = readLease(path)
  if (!final || final.pid !== record.pid || final.host !== record.host) {
    throw new LeaseHeldError(final ?? record, path)
  }
  const heartbeatMs = opts.heartbeatMs ?? Math.max(1_000, Math.floor(ttlMs / 3))
  return { lease: new Lease(path, record, heartbeatMs), tookOver }
}

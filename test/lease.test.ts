// Run leases: one driver per run. File-based (lease.json under the run
// dir), heartbeat-deadman semantics — a LIVE lease blocks, a STALE lease
// (old heartbeat, or a same-host pid that no longer exists) is taken over.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { acquireLease, isStale, LeaseHeldError, leasePath, type LeaseRecord } from "../src/engine/lease.js"

const runDir = (): string => mkdtempSync(join(tmpdir(), "looper-lease-"))

function writeRecord(dir: string, record: LeaseRecord): void {
  writeFileSync(leasePath(dir), JSON.stringify(record) + "\n", "utf8")
}

const readRecord = (dir: string): LeaseRecord => JSON.parse(readFileSync(leasePath(dir), "utf8")) as LeaseRecord

// pid 1 (launchd/init) always exists and is never ours -> kill(1, 0) is EPERM -> "alive".
const LIVE_FOREIGN_PID = 1
// Above every real pid space (macOS tops out near 100k) -> kill -> ESRCH -> "dead".
const DEAD_PID = 4_000_000

const fresh = (over: Partial<LeaseRecord> = {}): LeaseRecord => ({
  pid: LIVE_FOREIGN_PID,
  host: hostname(),
  acquiredAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  ttlMs: 60_000,
  ...over,
})

describe("run leases", () => {
  it("acquires a fresh lease, writes our pid/host, and releases by deleting the file", () => {
    const dir = runDir()
    const { lease, tookOver } = acquireLease(dir)
    expect(tookOver).toBeNull()
    const record = readRecord(dir)
    expect(record.pid).toBe(process.pid)
    expect(record.host).toBe(hostname())
    lease.release()
    expect(existsSync(leasePath(dir))).toBe(false)
  })

  it("a LIVE foreign lease blocks the second driver with LeaseHeldError", () => {
    const dir = runDir()
    writeRecord(dir, fresh())
    expect(() => acquireLease(dir)).toThrow(LeaseHeldError)
    try {
      acquireLease(dir)
    } catch (error) {
      expect(error).toBeInstanceOf(LeaseHeldError)
      expect((error as LeaseHeldError).holder.pid).toBe(LIVE_FOREIGN_PID)
      expect((error as LeaseHeldError).message).toContain("held by pid 1")
    }
    expect(readRecord(dir).pid).toBe(LIVE_FOREIGN_PID) // untouched
  })

  it("a STALE lease (heartbeat older than its ttl) is taken over", () => {
    const dir = runDir()
    const old = fresh({ heartbeatAt: "2000-01-01T00:00:00.000Z", acquiredAt: "2000-01-01T00:00:00.000Z" })
    writeRecord(dir, old)
    const { lease, tookOver } = acquireLease(dir)
    expect(tookOver?.pid).toBe(LIVE_FOREIGN_PID)
    expect(readRecord(dir).pid).toBe(process.pid)
    lease.release()
  })

  it("a same-host lease whose pid is GONE is stale immediately, even with a fresh heartbeat (deadman)", () => {
    const dir = runDir()
    writeRecord(dir, fresh({ pid: DEAD_PID })) // heartbeat is NOW, but the process does not exist
    const { lease, tookOver } = acquireLease(dir)
    expect(tookOver?.pid).toBe(DEAD_PID)
    expect(readRecord(dir).pid).toBe(process.pid)
    lease.release()
  })

  it("heartbeat() refreshes heartbeatAt on disk", async () => {
    const dir = runDir()
    const { lease } = acquireLease(dir)
    const before = readRecord(dir).heartbeatAt
    await new Promise((r) => setTimeout(r, 5))
    lease.heartbeat()
    expect(Date.parse(readRecord(dir).heartbeatAt)).toBeGreaterThan(Date.parse(before))
    lease.release()
  })

  it("release() does NOT delete a lease that was taken over by someone else", () => {
    const dir = runDir()
    const { lease } = acquireLease(dir)
    // Another driver takes over (simulated by overwriting the file).
    const usurper = fresh()
    writeRecord(dir, usurper)
    lease.release()
    expect(existsSync(leasePath(dir))).toBe(true) // the usurper's lease survives
    expect(readRecord(dir).pid).toBe(LIVE_FOREIGN_PID)
  })

  it("re-acquiring our own lease in the same process succeeds (idempotent driver)", () => {
    const dir = runDir()
    const first = acquireLease(dir)
    const second = acquireLease(dir) // same pid + host -> ours, not a conflict
    expect(second.tookOver).toBeNull()
    second.lease.release()
    first.lease.release()
  })

  it("a torn/garbage lease file is treated as unheld", () => {
    const dir = runDir()
    writeFileSync(leasePath(dir), "{not json", "utf8")
    const { lease, tookOver } = acquireLease(dir)
    expect(tookOver).toBeNull()
    expect(readRecord(dir).pid).toBe(process.pid)
    lease.release()
  })

  it("isStale: fresh+alive is live; old heartbeat or dead same-host pid is stale", () => {
    expect(isStale(fresh())).toBe(false)
    expect(isStale(fresh({ heartbeatAt: "2000-01-01T00:00:00.000Z" }))).toBe(true)
    expect(isStale(fresh({ pid: DEAD_PID }))).toBe(true)
    // A foreign-host record can't be pid-checked: only the heartbeat governs.
    expect(isStale(fresh({ host: "some-other-host" }))).toBe(false)
  })
})

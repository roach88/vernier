import { describe, expect, it } from "vitest"
import { safeEvidenceSlug } from "../src/executors/evidence.js"

describe("evidence file slugs", () => {
  it("keeps simple safe step ids readable", () => {
    expect(safeEvidenceSlug("implement")).toBe("implement")
  })

  it("keeps unsafe/truncated step ids in a reserved namespace so they cannot collide with safe ids", () => {
    const unsafe = safeEvidenceSlug("a/b")
    expect(unsafe).toMatch(/^~a-b-[a-f0-9]{8}$/)
    expect(safeEvidenceSlug(unsafe.slice(1))).toBe(unsafe.slice(1))
    expect(unsafe).not.toBe(safeEvidenceSlug(unsafe.slice(1)))
  })

  it("hashes portable-filesystem hazards instead of preserving them verbatim", () => {
    expect(safeEvidenceSlug("CON")).toMatch(/^~CON-[a-f0-9]{8}$/)
    expect(safeEvidenceSlug("step.")).toMatch(/^~step-[a-f0-9]{8}$/)
  })
})

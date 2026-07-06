import { describe, it, expect, vi } from "vitest"
import {
  resolveOptions,
  sanitizeOptions,
  unknownOptionKeys,
  addressable,
  classifyPs,
  parseModelRef,
  loadArgs,
  pidAlive,
  parseLockPid,
  shouldFailRequest,
  resolveBudgetBytes,
  parseModelSize,
  evictionCandidates,
  planEviction,
  isMemoryPressureError,
  type WarmOptions,
  type LmsInstance,
} from "../src/index.ts"

const MiB = 1024 * 1024

// A concrete options object for loadArgs tests (only the fields it reads matter).
function opts(over: Partial<WarmOptions> = {}): WarmOptions {
  return resolveOptions({}, over)
}

describe("resolveOptions", () => {
  it("applies defaults when nothing is provided", () => {
    const o = resolveOptions({}, undefined)
    expect(o.providers).toEqual(["lmstudio"])
    expect(o.failMode).toBe("hybrid")
    expect(o.ttlSeconds).toBe(0)
    expect(o.eager).toBe(true)
  })

  it("file options override defaults, plugin options override file", () => {
    const o = resolveOptions({ parallel: 2, ttlSeconds: 10 }, { parallel: 5 })
    expect(o.parallel).toBe(5) // plugin wins
    expect(o.ttlSeconds).toBe(10) // from file
  })

  it("plugin failMode overrides file failMode", () => {
    expect(resolveOptions({ failMode: "closed" }, { failMode: "open" }).failMode).toBe("open")
  })
})

describe("unknownOptionKeys", () => {
  it("lists keys the plugin does not know (typos are otherwise silently ignored)", () => {
    expect(unknownOptionKeys({ verifycachems: 1, failMode: "open" })).toEqual(["verifycachems"])
  })

  it("returns empty for known keys only, or an empty object", () => {
    expect(unknownOptionKeys({})).toEqual([])
    expect(unknownOptionKeys({ ttlSeconds: 5, eager: false })).toEqual([])
  })
})

describe("sanitizeOptions", () => {
  it("passes a valid config through unchanged with no warnings", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({}, { failMode: "closed", parallel: 2 }))
    expect(warnings).toEqual([])
    expect(o.failMode).toBe("closed")
    expect(o.parallel).toBe(2)
  })

  it("falls back to the default 'hybrid' on an unrecognized failMode (a typo would otherwise behave as 'open')", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ failMode: "Hybrid" as never }, null))
    expect(o.failMode).toBe("hybrid")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("failMode")
  })

  it("resets providers to the default when not a non-empty string array", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ providers: "lmstudio" as never }, null))
    expect(o.providers).toEqual(["lmstudio"])
    expect(warnings).toHaveLength(1)
  })

  it("resets negative or non-numeric numeric options to their defaults", () => {
    const { opts: o, warnings } = sanitizeOptions(
      resolveOptions({ verifyCacheMs: -5, loadTimeoutMs: "big" as never }, null),
    )
    expect(o.verifyCacheMs).toBe(30_000)
    expect(o.loadTimeoutMs).toBe(900_000)
    expect(warnings).toHaveLength(2)
  })

  it("resets wrong-typed booleans and empty strings to their defaults", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ eager: "yes" as never, lmsPath: "" }, null))
    expect(o.eager).toBe(true)
    expect(o.lmsPath).not.toBe("")
    expect(warnings).toHaveLength(2)
  })

  it("resets a non-string-array evictProtect to the default empty list", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ evictProtect: [1, "ok"] as never }, null))
    expect(o.evictProtect).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("evictProtect")
  })

  it("defaults evictMaxVictims to 8 and resets a negative value to the default", () => {
    expect(resolveOptions({}, null).evictMaxVictims).toBe(8)
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ evictMaxVictims: -3 }, null))
    expect(o.evictMaxVictims).toBe(8)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("evictMaxVictims")
  })
})

describe("addressable", () => {
  const inst = (identifier: string, modelKey = identifier): LmsInstance => ({ identifier, modelKey })

  it("true when an instance identifier equals the bare key", () => {
    expect(addressable([inst("qwen/q3"), inst("other")], "qwen/q3")).toBe(true)
  })

  it("false when only a suffixed duplicate (:2) is resident", () => {
    expect(addressable([{ identifier: "qwen/q3:2", modelKey: "qwen/q3" }], "qwen/q3")).toBe(false)
  })

  it("false on an empty instance list", () => {
    expect(addressable([], "qwen/q3")).toBe(false)
  })
})

describe("classifyPs", () => {
  const inst = (identifier: string, modelKey = identifier, extra: Partial<LmsInstance> = {}): LmsInstance => ({
    identifier,
    modelKey,
    ...extra,
  })

  it("returns unknown when ps output is unavailable (null)", () => {
    expect(classifyPs(null, "k")).toEqual({ state: "unknown" })
  })

  it("returns addressable when an instance identifier equals the key", () => {
    expect(classifyPs([inst("k"), inst("other")], "k")).toEqual({ state: "addressable" })
  })

  it("returns absent when no instance of the model exists", () => {
    expect(classifyPs([inst("other")], "k")).toEqual({ state: "absent" })
    expect(classifyPs([], "k")).toEqual({ state: "absent" })
  })

  it("returns duplicates (not busy) when only suffixed instances exist", () => {
    const dup = inst("k:2", "k")
    expect(classifyPs([dup], "k")).toEqual({ state: "duplicates", dups: [dup], busy: false })
  })

  it("marks duplicates busy when one is generating", () => {
    const dup = inst("k:2", "k", { status: "generating" })
    expect(classifyPs([dup], "k")).toEqual({ state: "duplicates", dups: [dup], busy: true })
  })

  it("marks duplicates busy when one has queued requests", () => {
    const dup = inst("k:2", "k", { queued: 3 })
    expect(classifyPs([dup], "k")).toEqual({ state: "duplicates", dups: [dup], busy: true })
  })
})

describe("parseModelRef", () => {
  it("splits on the FIRST slash, preserving a slashed key", () => {
    expect(parseModelRef("lmstudio/qwen/qwen3.6-35b")).toEqual({ providerID: "lmstudio", key: "qwen/qwen3.6-35b" })
  })

  it("handles a simple provider/key", () => {
    expect(parseModelRef("lmstudio/small")).toEqual({ providerID: "lmstudio", key: "small" })
  })

  it("returns null without a slash", () => {
    expect(parseModelRef("nomodel")).toBeNull()
  })

  it("returns null for non-strings", () => {
    expect(parseModelRef(undefined)).toBeNull()
    expect(parseModelRef(42)).toBeNull()
    expect(parseModelRef(null)).toBeNull()
  })
})

describe("loadArgs", () => {
  it("omits all optional flags when values are 0", () => {
    expect(loadArgs(opts(), "k")).toEqual(["load", "k", "-y"])
  })

  it("appends ttl/parallel/context when set at the top level", () => {
    expect(loadArgs(opts({ ttlSeconds: 30, parallel: 6, contextLength: 8192 }), "k")).toEqual([
      "load", "k", "-y", "--ttl", "30", "--parallel", "6", "--context-length", "8192",
    ])
  })

  it("per-model overrides win over top-level options", () => {
    const o = opts({ parallel: 4, perModel: { k: { parallel: 9 } } })
    expect(loadArgs(o, "k")).toEqual(["load", "k", "-y", "--parallel", "9"])
  })

  it("per-model only affects its own key", () => {
    const o = opts({ parallel: 4, perModel: { other: { parallel: 9 } } })
    expect(loadArgs(o, "k")).toEqual(["load", "k", "-y", "--parallel", "4"])
  })
})

describe("pidAlive", () => {
  it("reports the current process as alive", () => {
    expect(pidAlive(process.pid)).toBe(true)
  })

  it("treats ESRCH (no such process) as dead", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("no such process") as NodeJS.ErrnoException
      e.code = "ESRCH"
      throw e
    })
    expect(pidAlive(123456)).toBe(false)
    spy.mockRestore()
  })

  it("treats EPERM (owned by another user) as alive", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("operation not permitted") as NodeJS.ErrnoException
      e.code = "EPERM"
      throw e
    })
    expect(pidAlive(1)).toBe(true)
    spy.mockRestore()
  })
})

describe("parseLockPid", () => {
  it("parses a numeric pid, trimming whitespace", () => {
    expect(parseLockPid("1234")).toBe(1234)
    expect(parseLockPid("  12\n")).toBe(12)
  })

  it("returns null for blank, garbage, or absent content", () => {
    expect(parseLockPid("")).toBeNull()
    expect(parseLockPid("abc")).toBeNull()
    expect(parseLockPid(null)).toBeNull()
  })

  it("returns null for non-positive pids (kill(-1, 0) would probe ALL processes)", () => {
    expect(parseLockPid("-1")).toBeNull()
    expect(parseLockPid("0")).toBeNull()
  })
})

describe("shouldFailRequest", () => {
  const ok = { ok: true, confirmed: false, reason: "" }
  const confirmed = { ok: false, confirmed: true, reason: "x" }
  const ambiguous = { ok: false, confirmed: false, reason: "x" }

  it("never fails on an ok result", () => {
    expect(shouldFailRequest("closed", ok)).toBe(false)
    expect(shouldFailRequest("hybrid", ok)).toBe(false)
    expect(shouldFailRequest("open", ok)).toBe(false)
  })

  it("closed fails on any not-ok result", () => {
    expect(shouldFailRequest("closed", confirmed)).toBe(true)
    expect(shouldFailRequest("closed", ambiguous)).toBe(true)
  })

  it("hybrid fails only CONFIRMED failures", () => {
    expect(shouldFailRequest("hybrid", confirmed)).toBe(true)
    expect(shouldFailRequest("hybrid", ambiguous)).toBe(false)
  })

  it("open never fails", () => {
    expect(shouldFailRequest("open", confirmed)).toBe(false)
    expect(shouldFailRequest("open", ambiguous)).toBe(false)
  })
})

// ─── RAM-pressure eviction helpers ──────────────────────────────────────────

describe("resolveBudgetBytes", () => {
  it("uses an explicit ramBudgetMB (MiB → bytes) when > 0", () => {
    expect(resolveBudgetBytes(opts({ ramBudgetMB: 120_000 }), 137 * 1000 * MiB)).toBe(120_000 * MiB)
  })

  it("falls back to 90% of total physical memory when ramBudgetMB is 0", () => {
    expect(resolveBudgetBytes(opts({ ramBudgetMB: 0 }), 100 * MiB)).toBe(Math.floor(100 * MiB * 0.9))
  })
})

describe("parseModelSize", () => {
  const ls = [
    { modelKey: "qwen/qwen3.6-27b", sizeBytes: 16_081_685_402 },
    { modelKey: "qwen3-coder-next", sizeBytes: 64_761_608_791 },
  ]

  it("returns sizeBytes for the matching modelKey", () => {
    expect(parseModelSize(ls, "qwen3-coder-next")).toBe(64_761_608_791)
  })

  it("returns null when the key is not among downloaded models", () => {
    expect(parseModelSize(ls, "nope")).toBeNull()
  })

  it("returns null when the ls output is unavailable (null) or a size is missing", () => {
    expect(parseModelSize(null, "qwen3-coder-next")).toBeNull()
    expect(parseModelSize([{ modelKey: "x" }], "x")).toBeNull()
  })
})

describe("evictionCandidates", () => {
  const inst = (identifier: string, over: Partial<LmsInstance> = {}): LmsInstance => ({
    identifier,
    modelKey: identifier,
    status: "idle",
    queued: 0,
    lastUsedTime: 1000,
    sizeBytes: 1,
    ...over,
  })

  it("never returns the target (by identifier or by modelKey)", () => {
    const dup = inst("t:2", { modelKey: "t" })
    const got = evictionCandidates([inst("t"), dup, inst("a")], "t", [])
    expect(got.map((i) => i.identifier)).toEqual(["a"])
  })

  it("excludes busy instances (generating, or queued > 0)", () => {
    const got = evictionCandidates(
      [inst("gen", { status: "generating" }), inst("q", { queued: 2 }), inst("idle")],
      "t",
      [],
    )
    expect(got.map((i) => i.identifier)).toEqual(["idle"])
  })

  it("excludes protected keys (matched by modelKey or identifier)", () => {
    const got = evictionCandidates([inst("keep"), inst("drop")], "t", ["keep"])
    expect(got.map((i) => i.identifier)).toEqual(["drop"])
  })

  it("excludes instances without an identifier", () => {
    const got = evictionCandidates([{ modelKey: "x", status: "idle", queued: 0 }, inst("ok")], "t", [])
    expect(got.map((i) => i.identifier)).toEqual(["ok"])
  })

  it("orders least-recently-used first; a missing lastUsedTime sorts first", () => {
    const got = evictionCandidates(
      [inst("newest", { lastUsedTime: 3000 }), inst("oldest", { lastUsedTime: 1000 }), inst("never", { lastUsedTime: undefined })],
      "t",
      [],
    )
    expect(got.map((i) => i.identifier)).toEqual(["never", "oldest", "newest"])
  })
})

describe("planEviction", () => {
  const gb = (n: number) => n * 1024 * MiB
  const inst = (identifier: string, sizeGB: number, over: Partial<LmsInstance> = {}): LmsInstance => ({
    identifier,
    modelKey: identifier,
    status: "idle",
    queued: 0,
    lastUsedTime: 1000,
    sizeBytes: gb(sizeGB),
    ...over,
  })

  it("evicts nothing when the target already fits within budget", () => {
    // budget 120, used 16, need 16 + 4 headroom = 20 ≤ 104 available
    const plan = planEviction({
      instances: [inst("resident", 16)],
      targetKey: "new",
      targetSizeBytes: gb(16),
      budgetBytes: gb(120),
      headroomBytes: gb(4),
      protect: [],
    })
    expect(plan).toEqual({ victims: [], fitsAfter: true })
  })

  it("evicts the LRU idle victim to make room, and stops once it fits", () => {
    // budget 120, one idle 65GB resident + one idle 16GB; target 27 + 4 headroom = 31.
    // available = 120 - 81 = 39 ≥ 31 already? no: 39 ≥ 31 → fits without eviction.
    // Shrink budget to 100 so used 81 leaves 19 < 31 → must evict LRU (the 65GB).
    const big = inst("coder-next", 65, { lastUsedTime: 1000 })
    const small = inst("q27", 16, { lastUsedTime: 5000 })
    const plan = planEviction({
      instances: [big, small],
      targetKey: "new",
      targetSizeBytes: gb(27),
      budgetBytes: gb(100),
      headroomBytes: gb(4),
      protect: [],
    })
    expect(plan.victims.map((v) => v.identifier)).toEqual(["coder-next"])
    expect(plan.fitsAfter).toBe(true)
  })

  it("reports fitsAfter=false when even evicting every candidate is not enough", () => {
    const big = inst("coder-next", 65)
    const plan = planEviction({
      instances: [big],
      targetKey: "new",
      targetSizeBytes: gb(200),
      budgetBytes: gb(100),
      headroomBytes: gb(4),
      protect: [],
    })
    expect(plan.victims.map((v) => v.identifier)).toEqual(["coder-next"])
    expect(plan.fitsAfter).toBe(false)
  })

  it("never selects a busy or protected instance as a victim", () => {
    const busy = inst("busy", 65, { status: "generating" })
    const plan = planEviction({
      instances: [busy],
      targetKey: "new",
      targetSizeBytes: gb(27),
      budgetBytes: gb(80),
      headroomBytes: gb(4),
      protect: [],
    })
    expect(plan.victims).toEqual([])
    expect(plan.fitsAfter).toBe(false)
  })
})

describe("isMemoryPressureError", () => {
  it("matches LM Studio guardrail / out-of-memory rejections", () => {
    expect(isMemoryPressureError("Model loading was aborted by the guardrail")).toBe(true)
    expect(isMemoryPressureError("not enough memory to load model")).toBe(true)
    expect(isMemoryPressureError("insufficient VRAM available")).toBe(true)
    expect(isMemoryPressureError("Error: out of memory")).toBe(true)
  })

  it("does NOT fire on config errors that merely share a keyword (avoids evicting healthy models)", () => {
    expect(isMemoryPressureError("context length 262144 exceeds max 32768")).toBe(false)
    expect(isMemoryPressureError("insufficient disk space")).toBe(false)
    expect(isMemoryPressureError("insufficient permissions")).toBe(false)
    expect(isMemoryPressureError("model not found")).toBe(false)
    expect(isMemoryPressureError("")).toBe(false)
  })
})

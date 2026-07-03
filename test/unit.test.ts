import { describe, it, expect, vi } from "vitest"
import {
  resolveOptions,
  addressable,
  parseModelRef,
  loadArgs,
  pidAlive,
  parseLockPid,
  shouldFailRequest,
  type WarmOptions,
  type LmsInstance,
} from "../src/index.ts"

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

  it("maps legacy failClosed:true → failMode 'closed'", () => {
    expect(resolveOptions({}, { failClosed: true }).failMode).toBe("closed")
  })

  it("maps legacy failClosed:false → failMode 'open'", () => {
    expect(resolveOptions({}, { failClosed: false }).failMode).toBe("open")
  })

  it("explicit failMode wins over legacy failClosed", () => {
    expect(resolveOptions({}, { failClosed: true, failMode: "open" }).failMode).toBe("open")
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

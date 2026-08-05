/**
 * Integration suite: drives the REAL plugin closure (LMStudioWarm) against a
 * scriptable fake `lms` CLI and a live local HTTP server, so the stateful
 * machinery the unit tests cannot reach — doWarm, single-flight, the
 * cross-process lock, duplicate reconciliation, eviction, the negative
 * caches, and the chat.params gate — runs in CI without LM Studio.
 *
 * The fake lms (a small Node script written into each sandbox) keeps its
 * whole world in a state.json next to it: the resident instances (`ps`),
 * downloaded models (`ls`), and per-key load behavior (delays, scripted
 * failures, non-idempotent duplicate creation — mirroring the real CLI's
 * semantics the plugin is built around). Every invocation is appended to
 * calls.log, which the assertions read back.
 *
 * The live e2e (test/e2e/verify.sh) remains the validation of the REAL
 * LM Studio contract; this suite validates the plugin's state machine
 * against the contract as documented in src/index.ts.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"

// Isolate the module's HOME capture (config-file lookup, default lmsPath)
// from the machine running the tests BEFORE the plugin module is imported.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lmswarm-home-"))
process.env.HOME = FAKE_HOME
const { LMStudioWarm } = await import("../src/index.ts")
import type { WarmOptions, LmsInstance } from "../src/index.ts"

// Each plugin instance registers a process "exit" listener; with one instance
// per test the default max-listeners warning would fire spuriously.
process.setMaxListeners(0)

// ─── Fake lms CLI ────────────────────────────────────────────────────────────

const FAKE_LMS = `#!/usr/bin/env node
// Scriptable stand-in for the lms CLI. State lives in state.json next to this
// script; behavior mirrors the real CLI semantics the plugin depends on.
const fs = require("node:fs")
const path = require("node:path")
const stateFile = path.join(__dirname, "state.json")
const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"))
const write = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2))
const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Emit stdout in the requested encoding, prepending a BOM for UTF-16 to mirror
// what Windows lms.exe produces through PowerShell (issue #3).
const writeOut = (s, enc) => {
  if (enc === "utf16le") return process.stdout.write(Buffer.from("\\uFEFF" + s, "utf16le"))
  if (enc === "utf16be") { const b = Buffer.from("\\uFEFF" + s, "utf16le"); b.swap16(); return process.stdout.write(b) }
  process.stdout.write(s)
}
;(async () => {
  const state = read()
  const cmd = args[0]
  if (cmd === "ps") {
    if (state.psFail) { console.error("ps failed (scripted)"); process.exit(1) }
    // psRaw prints verbatim (no trailing newline) so a test can inject exact
    // bytes: a leading BOM, an object wrapper, truncated/garbage JSON.
    if (typeof state.psRaw === "string") { writeOut(state.psRaw, state.psEncoding); return }
    console.log(JSON.stringify(state.instances))
    return
  }
  if (cmd === "ls") {
    if (state.lsFail) { console.error("ls failed (scripted)"); process.exit(1) }
    if (typeof state.lsRaw === "string") { writeOut(state.lsRaw, state.lsEncoding); return }
    console.log(JSON.stringify(state.downloaded ?? []))
    return
  }
  if (cmd === "server") return // HTTP liveness is controlled by the test's real server
  if (cmd === "unload") {
    state.instances = state.instances.filter((i) => i.identifier !== args[1])
    write(state)
    return
  }
  if (cmd === "load") {
    const key = args[1]
    const b = (state.load && state.load[key]) || {}
    if (b.delayMs) await sleep(b.delayMs)
    if (b.failuresRemaining > 0) {
      b.failuresRemaining -= 1
      write(state)
      console.error(b.errorText || "load failed (scripted)")
      process.exit(1)
    }
    if (!b.noEffect) {
      // NOT idempotent, like the real CLI: a resident key gains a :2 suffix.
      const already = state.instances.filter((i) => i.modelKey === key).length
      const identifier = already === 0 ? key : key + ":" + (already + 1)
      state.instances.push({ modelKey: key, identifier, status: "idle", queued: 0 })
    }
    write(state)
    return
  }
  console.error("unknown command: " + cmd)
  process.exit(1)
})()
`

type LoadBehavior = { delayMs?: number; failuresRemaining?: number; errorText?: string; noEffect?: boolean }
type FakeState = {
  instances: LmsInstance[]
  downloaded?: Array<{ modelKey?: string; sizeBytes?: number }>
  load?: Record<string, LoadBehavior>
  psFail?: boolean
  lsFail?: boolean
  /** Verbatim stdout for `ps` / `ls`, overriding the JSON.stringify default —
   *  used to inject shape-drift (BOM, wrapper object, non-array, garbage). */
  psRaw?: string
  lsRaw?: string
  /** Encoding for psRaw/lsRaw; "utf16le"/"utf16be" prepend a BOM, mirroring
   *  Windows lms.exe through PowerShell. Default (undefined) writes UTF-8. */
  psEncoding?: "utf16le" | "utf16be"
  lsEncoding?: "utf16le" | "utf16be"
}

type Sandbox = {
  dir: string
  baseURL: string
  lmsPath: string
  lockDir: string
  setState: (s: FakeState) => void
  getState: () => FakeState
  calls: () => string[][]
  loads: (key: string) => number
  unloads: () => string[]
  plugin: (over?: Partial<WarmOptions>) => Promise<Record<string, (input: unknown) => Promise<void>>>
  chatInput: (key: string, providerID?: string) => unknown
  stopServer: () => Promise<void>
  cleanup: (() => void | Promise<void>)[]
}

let server: http.Server
let serverURL: string

beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"))
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address() as { port: number }
  serverURL = `http://127.0.0.1:${addr.port}/v1`
  return async () => {
    await new Promise((r) => server.close(r))
  }
})

const sandboxes: Sandbox[] = []
afterEach(async () => {
  for (const sb of sandboxes.splice(0)) for (const c of sb.cleanup) await c()
})

function makeSandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lmswarm-it-"))
  const lmsPath = path.join(dir, "lms.cjs")
  fs.writeFileSync(lmsPath, FAKE_LMS, { mode: 0o755 })
  const stateFile = path.join(dir, "state.json")
  const callsFile = path.join(dir, "calls.log")
  const lockDir = path.join(dir, "warm.lock")

  const sb: Sandbox = {
    dir,
    baseURL: serverURL,
    lmsPath,
    lockDir,
    setState: (s) => fs.writeFileSync(stateFile, JSON.stringify(s)),
    getState: () => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    calls: () => {
      try {
        return fs
          .readFileSync(callsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
    loads: (key) => sb.calls().filter((c) => c[0] === "load" && c[1] === key).length,
    unloads: () => sb.calls().filter((c) => c[0] === "unload").map((c) => c[1]),
    plugin: async (over = {}) => {
      const hooks = await (LMStudioWarm as unknown as (i: unknown, o: Partial<WarmOptions>) => Promise<unknown>)(
        {},
        {
          lmsPath,
          baseURL: serverURL,
          logFile: path.join(dir, "warm.log"),
          lockDir,
          eager: false,
          providers: ["lmstudio"],
          failMode: "hybrid",
          // Deterministic across platforms: on darwin the default fallback
          // would `open -ga "LM Studio"` on the runner and retry the server
          // start, doubling the `server start` call the tests count.
          launchAppFallback: false,
          loadTimeoutMs: 10_000,
          serverStartTimeoutMs: 1_500,
          lockWaitTimeoutMs: 2_000,
          ...over,
        },
      )
      return hooks as Record<string, (input: unknown) => Promise<void>>
    },
    chatInput: (key, providerID = "lmstudio") => ({
      provider: { info: { id: providerID }, options: { baseURL: serverURL } },
      model: { api: { id: key } },
    }),
    stopServer: () => Promise.resolve(),
    cleanup: [() => fs.rmSync(dir, { recursive: true, force: true })],
  }
  sb.setState({ instances: [] })
  sandboxes.push(sb)
  return sb
}

/** Poll until `cond` is true or `ms` elapses (for fire-and-forget paths). */
async function waitFor(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

// ─── The warm gate ───────────────────────────────────────────────────────────

describe("chat.params warm gate", () => {
  it("cold start: loads the model exactly once BEFORE letting the request through", async () => {
    const sb = makeSandbox()
    const hooks = await sb.plugin()
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.loads("k")).toBe(1)
    expect(sb.getState().instances.map((i) => i.identifier)).toEqual(["k"])
  })

  it("already-resident model: passes without any lms load", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [{ modelKey: "k", identifier: "k", status: "idle", queued: 0 }] })
    const hooks = await sb.plugin()
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.loads("k")).toBe(0)
  })

  it("positive verdicts are cached: a second request within verifyCacheMs runs no lms at all", async () => {
    const sb = makeSandbox()
    const hooks = await sb.plugin({ verifyCacheMs: 60_000 })
    await hooks["chat.params"](sb.chatInput("k"))
    // Even a now-broken ps must not be consulted while the cache is fresh.
    sb.setState({ ...sb.getState(), psFail: true })
    const before = sb.calls().length
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.calls().length).toBe(before)
  })

  it("single-flight: two concurrent requests for the same cold model produce ONE load", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], load: { k: { delayMs: 300 } } })
    const hooks = await sb.plugin()
    await Promise.all([hooks["chat.params"](sb.chatInput("k")), hooks["chat.params"](sb.chatInput("k"))])
    expect(sb.loads("k")).toBe(1)
    expect(sb.getState().instances).toHaveLength(1)
  })

  it("non-gated providers and contract-drift input shapes are ignored without touching lms", async () => {
    const sb = makeSandbox()
    const hooks = await sb.plugin()
    await hooks["chat.params"](sb.chatInput("k", "openai")) // other provider
    await hooks["chat.params"]({}) // no provider id (hook shape drift)
    await hooks["chat.params"]({ provider: { info: { id: "lmstudio" } } }) // no model key
    expect(sb.calls().length).toBe(0)
  })
})

// ─── Failure handling and negative caches ────────────────────────────────────

describe("failures and negative caches", () => {
  it("hybrid: a CONFIRMED load failure fails the request; the cooldown then blocks retries", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], load: { k: { failuresRemaining: 99, errorText: "model not found" } } })
    const hooks = await sb.plugin({ retryCooldownMs: 60_000 })
    await expect(hooks["chat.params"](sb.chatInput("k"))).rejects.toThrow(/cannot ensure model "k"/)
    expect(sb.loads("k")).toBe(1)
    // Second request inside the cooldown: fails fast, NO second lms load.
    await expect(hooks["chat.params"](sb.chatInput("k"))).rejects.toThrow(/cooldown/)
    expect(sb.loads("k")).toBe(1)
  })

  it("hybrid proceeds fail-open when ps is unavailable (ambiguous); closed fails the request", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], psFail: true })
    const hybrid = await sb.plugin({ failMode: "hybrid" })
    await expect(hybrid["chat.params"](sb.chatInput("k"))).resolves.toBeUndefined()
    const closed = await sb.plugin({ failMode: "closed" })
    await expect(closed["chat.params"](sb.chatInput("k"))).rejects.toThrow(/model state unknown/)
    expect(sb.loads("k")).toBe(0) // ambiguous ps must never lead to a blind load
  })

  it("open mode never fails the request, even on a confirmed load failure", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], load: { k: { failuresRemaining: 99 } } })
    const hooks = await sb.plugin({ failMode: "open" })
    await expect(hooks["chat.params"](sb.chatInput("k"))).resolves.toBeUndefined()
  })

  it("load exits 0 but the key never becomes addressable → confirmed failure", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], load: { k: { noEffect: true } } })
    const hooks = await sb.plugin()
    await expect(hooks["chat.params"](sb.chatInput("k"))).rejects.toThrow(/not addressable/)
  })

  it(
    "server down: confirmed failure, and the server negative cache prevents re-paying the bring-up stall",
    { timeout: 20_000 },
    async () => {
      const sb = makeSandbox()
      const deadURL = "http://127.0.0.1:9" // discard port — connection refused
      const hooks = await sb.plugin({ retryCooldownMs: 60_000 })
      const input = {
        provider: { info: { id: "lmstudio" }, options: { baseURL: deadURL } },
        model: { api: { id: "k" } },
      }
      await expect(hooks["chat.params"](input)).rejects.toThrow(/not reachable/)
      const serverStarts = sb.calls().filter((c) => c[0] === "server").length
      expect(serverStarts).toBe(1)
      // Within retryCooldownMs: fail fast, no second `lms server start`.
      const t0 = Date.now()
      await expect(hooks["chat.params"](input)).rejects.toThrow(/not reachable/)
      expect(Date.now() - t0).toBeLessThan(500)
      expect(sb.calls().filter((c) => c[0] === "server").length).toBe(1)
    },
  )
})

// ─── Duplicate reconciliation ────────────────────────────────────────────────

describe("duplicate reconciliation", () => {
  it("unloads idle orphaned :2 duplicates, then loads fresh so the bare key is addressable", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [{ modelKey: "k", identifier: "k:2", status: "idle", queued: 0 }] })
    const hooks = await sb.plugin()
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.unloads()).toEqual(["k:2"])
    expect(sb.loads("k")).toBe(1)
    expect(sb.getState().instances.map((i) => i.identifier)).toEqual(["k"])
  })

  it("refuses to touch a BUSY duplicate: confirmed failure instead of killing a live generation", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [{ modelKey: "k", identifier: "k:2", status: "generating", queued: 0 }] })
    const hooks = await sb.plugin()
    await expect(hooks["chat.params"](sb.chatInput("k"))).rejects.toThrow(/suffixed duplicates/)
    expect(sb.unloads()).toEqual([])
    expect(sb.loads("k")).toBe(0)
  })
})

// ─── Cross-process lock ──────────────────────────────────────────────────────

describe("cross-process lock", () => {
  function plantLock(sb: Sandbox, pid: string, ageMs = 0) {
    fs.mkdirSync(sb.lockDir, { recursive: true })
    if (pid !== "") fs.writeFileSync(path.join(sb.lockDir, "pid"), pid)
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs)
      fs.utimesSync(sb.lockDir, t, t)
    }
  }

  it(
    "live holder: waits, times out, and (hybrid) proceeds fail-open without loading",
    { timeout: 15_000 },
    async () => {
      const sb = makeSandbox()
      const holder: ChildProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" })
      sb.cleanup.push(() => holder.kill("SIGKILL"))
      plantLock(sb, String(holder.pid))
      const hooks = await sb.plugin({ lockWaitTimeoutMs: 1_500 })
      await expect(hooks["chat.params"](sb.chatInput("k"))).resolves.toBeUndefined()
      expect(sb.loads("k")).toBe(0) // never loaded — someone else plausibly is
      expect(fs.existsSync(sb.lockDir)).toBe(true) // and their lock was respected
    },
  )

  it("dead holder: breaks the stale lock and completes the load", async () => {
    const sb = makeSandbox()
    const deadPid = execFileSync(process.execPath, ["-e", "console.log(process.pid)"]).toString().trim()
    plantLock(sb, deadPid)
    const hooks = await sb.plugin()
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.loads("k")).toBe(1)
  })

  it("pid-less lock past the grace period: treated as abandoned and broken", async () => {
    const sb = makeSandbox()
    plantLock(sb, "", 10_000) // no pid file, mtime 10s ago (> 5s grace)
    const hooks = await sb.plugin()
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.loads("k")).toBe(1)
  })

  it("corrupt pid file (garbage) past the grace period: broken, not unbreakable", async () => {
    const sb = makeSandbox()
    plantLock(sb, "not-a-pid", 10_000)
    const hooks = await sb.plugin()
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.loads("k")).toBe(1)
  })

  it("releases its own lock after a successful warm", async () => {
    const sb = makeSandbox()
    const hooks = await sb.plugin()
    await hooks["chat.params"](sb.chatInput("k"))
    expect(fs.existsSync(sb.lockDir)).toBe(false)
  })
})

// ─── RAM-pressure eviction ───────────────────────────────────────────────────

const MB = 1024 * 1024

describe("eviction (evictOnPressure)", () => {
  const idle = (id: string, sizeMB: number, lastUsedTime: number): LmsInstance => ({
    modelKey: id,
    identifier: id,
    status: "idle",
    queued: 0,
    sizeBytes: sizeMB * MB,
    lastUsedTime,
  })

  it("predictive: unloads the LRU idle instance BEFORE loading when the target won't fit", async () => {
    const sb = makeSandbox()
    sb.setState({
      instances: [idle("old", 800, 1_000), idle("newer", 100, 2_000)],
      downloaded: [{ modelKey: "k", sizeBytes: 500 * MB }],
    })
    // budget 1000MB, used 900MB → available 100 < needed 500 + 1 headroom.
    const hooks = await sb.plugin({ evictOnPressure: true, ramBudgetMB: 1_000, evictHeadroomMB: 1 })
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.unloads()).toEqual(["old"]) // LRU first; freeing 800MB suffices
    expect(sb.loads("k")).toBe(1)
  })

  it("reactive backstop: a guardrail-refused load evicts the next idle instance and retries", async () => {
    const sb = makeSandbox()
    sb.setState({
      instances: [idle("old", 800, 1_000)],
      downloaded: [{ modelKey: "k", sizeBytes: 10 * MB }],
      load: { k: { failuresRemaining: 1, errorText: "model loading aborted by the guardrail" } },
    })
    // Huge budget: the predictive pass sees no pressure; only the backstop acts.
    const hooks = await sb.plugin({ evictOnPressure: true, ramBudgetMB: 1_000_000 })
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.unloads()).toEqual(["old"])
    expect(sb.loads("k")).toBe(2) // refused once, retried once
  })

  it("non-memory load errors do NOT trigger eviction", async () => {
    const sb = makeSandbox()
    sb.setState({
      instances: [idle("old", 800, 1_000)],
      downloaded: [{ modelKey: "k", sizeBytes: 10 * MB }],
      load: { k: { failuresRemaining: 99, errorText: "model not found" } },
    })
    const hooks = await sb.plugin({ evictOnPressure: true, ramBudgetMB: 1_000_000 })
    await expect(hooks["chat.params"](sb.chatInput("k"))).rejects.toThrow()
    expect(sb.unloads()).toEqual([]) // healthy idle models were left alone
    expect(sb.loads("k")).toBe(1) // and no retry storm
  })

  it("evictMaxVictims caps how many instances one warm attempt may unload", async () => {
    const sb = makeSandbox()
    sb.setState({
      instances: [idle("a", 10, 1_000), idle("b", 10, 2_000), idle("c", 10, 3_000)],
      downloaded: [{ modelKey: "k", sizeBytes: 10 * MB }],
      load: { k: { failuresRemaining: 99, errorText: "not enough memory to load model" } },
    })
    const hooks = await sb.plugin({ evictOnPressure: true, ramBudgetMB: 1_000_000, evictMaxVictims: 2 })
    await expect(hooks["chat.params"](sb.chatInput("k"))).rejects.toThrow()
    expect(sb.unloads()).toEqual(["a", "b"]) // LRU order, stopped at the cap
    expect(sb.loads("k")).toBe(3) // initial + one retry per successful eviction
  })

  it("protected instances are never evicted", async () => {
    const sb = makeSandbox()
    sb.setState({
      instances: [idle("precious", 800, 1_000), idle("expendable", 100, 2_000)],
      downloaded: [{ modelKey: "k", sizeBytes: 10 * MB }],
      load: { k: { failuresRemaining: 1, errorText: "not enough memory to load model" } },
    })
    const hooks = await sb.plugin({ evictOnPressure: true, ramBudgetMB: 1_000_000, evictProtect: ["precious"] })
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.unloads()).toEqual(["expendable"])
  })
})

// ─── Eager warm (config hook) ────────────────────────────────────────────────

describe("eager warm", () => {
  it("warms model and small_model in the background, deduplicating a shared key", async () => {
    const sb = makeSandbox()
    const hooks = await sb.plugin({ eager: true })
    await hooks["config"]({
      model: "lmstudio/k",
      small_model: "lmstudio/k", // same key → must warm once
      provider: { lmstudio: { options: { baseURL: serverURL } } },
    })
    expect(await waitFor(() => sb.loads("k") >= 1)).toBe(true)
    await waitFor(() => !fs.existsSync(sb.lockDir)) // background warm finished
    expect(sb.loads("k")).toBe(1)
  })

  it("ignores models on non-gated providers and does nothing when eager is off", async () => {
    const sb = makeSandbox()
    const eager = await sb.plugin({ eager: true })
    await eager["config"]({ model: "openai/gpt", small_model: undefined })
    const lazy = await sb.plugin({ eager: false })
    await lazy["config"]({ model: "lmstudio/k" })
    await new Promise((r) => setTimeout(r, 300))
    expect(sb.calls().length).toBe(0)
  })
})

// ─── Adversarial: lms output shape-drift (issue #3) ──────────────────────────
// The fake's psRaw/lsRaw inject exact stdout the JSON.stringify default cannot:
// a leading BOM, an object wrapper, a non-array, garbage. These drive the REAL
// psInstances → parseLmsJsonArray → classifyPs path end-to-end. (Scenario A of
// docs/superpowers/specs/2026-08-05-adversarial-integration-tests-design.md.)

describe("lms output shape-drift", () => {
  const resident = [{ modelKey: "k", identifier: "k", status: "idle", queued: 0 }]

  // failMode "closed" is the distinguisher: a recognized (addressable) model
  // passes, but an "unknown" verdict throws. So `resolves` proves the drifted
  // shape was actually parsed into the resident model \u2014 not merely tolerated as
  // unknown (which would fail-open under hybrid and pass vacuously).
  it("ps with a leading UTF-8 BOM: the resident model is recognized (closed mode passes), no load", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], psRaw: "\uFEFF" + JSON.stringify(resident) })
    const hooks = await sb.plugin({ failMode: "closed" })
    await expect(hooks["chat.params"](sb.chatInput("k"))).resolves.toBeUndefined()
    expect(sb.loads("k")).toBe(0)
  })

  it("ps as a { instances: [...] } wrapper object: unwrapped and recognized (closed mode passes), no load", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], psRaw: JSON.stringify({ instances: resident }) })
    const hooks = await sb.plugin({ failMode: "closed" })
    await expect(hooks["chat.params"](sb.chatInput("k"))).resolves.toBeUndefined()
    expect(sb.loads("k")).toBe(0)
  })

  it("ps as a non-array object, garbage, or truncated JSON: unknown → hybrid fail-open, never a blind load", async () => {
    for (const raw of ['{"foo":1}', "not json at all", '[{"identifier":"k"']) {
      const sb = makeSandbox()
      sb.setState({ instances: [], psRaw: raw })
      const hooks = await sb.plugin({ failMode: "hybrid" })
      await expect(hooks["chat.params"](sb.chatInput("k"))).resolves.toBeUndefined()
      expect(sb.loads("k")).toBe(0)
    }
  })

  it("ls as a { models: [...] } wrapper: parseModelSize still finds the target, predictive eviction runs", async () => {
    const sb = makeSandbox()
    sb.setState({
      instances: [{ modelKey: "old", identifier: "old", status: "idle", queued: 0, sizeBytes: 800 * MB, lastUsedTime: 1_000 }],
      lsRaw: JSON.stringify({ models: [{ modelKey: "k", sizeBytes: 500 * MB }] }),
    })
    // budget 1000MB, used 800 → available 200 < needed 500 + 1 headroom, so the
    // predictive pass must read the target size FROM THE WRAPPER and evict "old".
    const hooks = await sb.plugin({ evictOnPressure: true, ramBudgetMB: 1_000, evictHeadroomMB: 1 })
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.unloads()).toEqual(["old"])
    expect(sb.loads("k")).toBe(1)
  })
})

// ─── Adversarial: Windows UTF-16 lms output (issue #3 root cause) ────────────
// Windows lms.exe through PowerShell emits UTF-16LE (BOM ff fe); decoded as
// UTF-8 it is NUL-laden mojibake no JSON.parse can read. decodeProcessOutput
// must detect the BOM and decode, so the gate works on Windows — not merely
// avoid crashing. These fail against a src without that decode step.

describe("Windows UTF-16 lms output", () => {
  const resident = [{ modelKey: "k", identifier: "k", status: "idle", queued: 0 }]

  it("ps as UTF-16LE with a resident model: decoded and recognized (closed mode passes), no load", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], psRaw: JSON.stringify(resident), psEncoding: "utf16le" })
    const hooks = await sb.plugin({ failMode: "closed" })
    await expect(hooks["chat.params"](sb.chatInput("k"))).resolves.toBeUndefined()
    expect(sb.loads("k")).toBe(0)
  })

  it("ps as UTF-16LE empty []: decoded as absent → a load is attempted (not read as unknown)", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], psRaw: "[]", psEncoding: "utf16le" })
    // psRaw is a fixed override, so the post-load ps still reads [] — open mode
    // keeps that verification artifact from throwing. The point is only that the
    // empty UTF-16 output decoded as ABSENT (triggering the load), not "unknown"
    // (which returns before any load). Without the decode step, loads would be 0.
    const hooks = await sb.plugin({ failMode: "open" })
    await expect(hooks["chat.params"](sb.chatInput("k"))).resolves.toBeUndefined()
    expect(sb.loads("k")).toBe(1)
  })

  it("ps as UTF-16BE (BOM fe ff): also decoded and recognized (closed mode passes)", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], psRaw: JSON.stringify(resident), psEncoding: "utf16be" })
    const hooks = await sb.plugin({ failMode: "closed" })
    await expect(hooks["chat.params"](sb.chatInput("k"))).resolves.toBeUndefined()
    expect(sb.loads("k")).toBe(0)
  })

  it("ls as UTF-16LE under eviction: the target size is decoded, predictive eviction runs", async () => {
    const sb = makeSandbox()
    sb.setState({
      instances: [{ modelKey: "old", identifier: "old", status: "idle", queued: 0, sizeBytes: 800 * MB, lastUsedTime: 1_000 }],
      lsRaw: JSON.stringify({ models: [{ modelKey: "k", sizeBytes: 500 * MB }] }),
      lsEncoding: "utf16le",
    })
    const hooks = await sb.plugin({ evictOnPressure: true, ramBudgetMB: 1_000, evictHeadroomMB: 1 })
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.unloads()).toEqual(["old"])
    expect(sb.loads("k")).toBe(1)
  })
})

// ─── Adversarial: mid-session eviction healing (TTL) ─────────────────────────
// The headline promise — a model dropped between two requests is reloaded on the
// next one — proven through the gate. (Scenario B.)

describe("mid-session eviction healing", () => {
  it("a model unloaded between two gate calls is reloaded on the next request", async () => {
    const sb = makeSandbox()
    const hooks = await sb.plugin({ verifyCacheMs: 0 }) // re-check ps every request
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.loads("k")).toBe(1)
    expect(sb.getState().instances.map((i) => i.identifier)).toEqual(["k"])
    // Simulate LM Studio unloading it on idle TTL between requests.
    sb.setState({ ...sb.getState(), instances: [] })
    await hooks["chat.params"](sb.chatInput("k"))
    expect(sb.loads("k")).toBe(2) // healed
    expect(sb.getState().instances.map((i) => i.identifier)).toEqual(["k"])
  })
})

// ─── Adversarial: concurrency ────────────────────────────────────────────────
// (Scenario C. The cross-process lock serializes warms, so a concurrent-eviction
// case adds no coverage beyond the per-attempt evictMaxVictims cap already tested
// — omitted deliberately in favor of these two deterministic cases.)

describe("concurrency under stress", () => {
  it("N concurrent requests against a drifted (unknown) ps: all fail-open, no crash, no blind load", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], psRaw: '{"unexpected":"shape"}' })
    const hooks = await sb.plugin({ failMode: "hybrid" })
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => hooks["chat.params"](sb.chatInput("k"))),
    )
    expect(results.every((r) => r.status === "fulfilled")).toBe(true)
    expect(sb.loads("k")).toBe(0)
  })

  it("two different cold keys requested concurrently: each loads exactly once, serialized by the lock", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], load: { a: { delayMs: 100 }, b: { delayMs: 100 } } })
    const hooks = await sb.plugin()
    await Promise.all([hooks["chat.params"](sb.chatInput("a")), hooks["chat.params"](sb.chatInput("b"))])
    expect(sb.loads("a")).toBe(1)
    expect(sb.loads("b")).toBe(1)
    expect(sb.getState().instances.map((i) => i.identifier).sort()).toEqual(["a", "b"])
  })
})

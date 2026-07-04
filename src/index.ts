/**
 * lmstudio-warm — deterministic LM Studio model pre-warm gate for opencode.
 *
 * Guarantees the target model is addressable in LM Studio BEFORE any LLM
 * request leaves opencode, healing cold starts and mid-session TTL evictions
 * for every model the session uses (main model AND small_model, which shares
 * the same chat.params hook path).
 *
 * Verified against opencode v1.17.10 source:
 *  - `chat.params` is awaited before each request and fires for every stream,
 *    including small-model title/summary generation.
 *  - `model.api.id` is the exact string sent as the API `model` field.
 *  - Plugins run in-process (Bun) and may spawn child processes.
 *
 * Verified live against LM Studio (lms CLI):
 *  - `lms load <key> -y` blocks until ready, exits 0 only on success.
 *  - `lms load` is NOT idempotent: loading a resident key creates a duplicate
 *    instance suffixed `:2` — hence the ps-guard + cross-process lock below.
 *  - Omitting `--ttl` loads with ttlMs=null (resident until unloaded), and
 *    such instances are bookkept separately from JIT loads (which carry the
 *    server's JIT TTL).
 *  - `lms ps --json` lists a loading instance as status "idle" ~immediately
 *    (measured: listed at ~200ms into a 12.5s load). There is NO ps-visible
 *    "loading" state. This is benign for the gate: identifier presence means
 *    the instance is addressable and LM Studio QUEUES requests against it
 *    until weights are ready (verified live) — so a waiter passing the gate
 *    mid-load waits briefly server-side instead of erroring.
 *  - `lms ps` works even while the HTTP server is off, so the HTTP server is
 *    ensured independently (probe /models, else `lms server start`; any HTTP
 *    response — including 401 when API auth is enabled — means "listening").
 *
 * Config (all optional), merged in this order:
 *   defaults < ~/.config/opencode/lmstudio-warm.json < plugin options tuple
 *
 * The pure, per-process-stateless helpers are hoisted to module scope and
 * exported (see the "Pure helpers" block) so they can be unit-tested directly;
 * the plugin closure composes them with the live state and child processes.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

export type PerModel = { ttlSeconds?: number; parallel?: number; contextLength?: number }

export type WarmOptions = {
  /** Provider IDs to gate. Requests on other providers are ignored. */
  providers: string[]
  /** Absolute path to the lms CLI. */
  lmsPath: string
  /** Fallback base URL if the provider config doesn't carry one. */
  baseURL: string
  /** --ttl passed to lms load. 0 = omit (resident until unloaded). */
  ttlSeconds: number
  /** --parallel passed to lms load. 0 = omit (LM Studio default, currently 4).
   *  Size to expected concurrent fleet width per model; requests beyond the
   *  slot count queue server-side (latency, not failure). */
  parallel: number
  /** --context-length passed to lms load. 0 = omit (model default). */
  contextLength: number
  /** Per-model-key overrides of ttlSeconds/parallel/contextLength. */
  perModel: Record<string, PerModel>
  /** How long a positive residency verdict is trusted before re-checking. */
  verifyCacheMs: number
  /** After a CONFIRMED load failure, don't retry the same key for this long
   *  (prevents a load storm when e.g. a memory guardrail keeps refusing). */
  retryCooldownMs: number
  /** Hard cap on a single lms load (cold load of a big model can take minutes). */
  loadTimeoutMs: number
  /** Hard cap on bringing the HTTP server up. */
  serverStartTimeoutMs: number
  /** Max time a process waits for another process's in-flight load. */
  lockWaitTimeoutMs: number
  /**
   * What to do when the warm gate cannot ensure residency:
   *  - "hybrid" (default): CONFIRMED failures (server won't start, lms load
   *    failed, unreconcilable duplicates) fail the request with a clear error;
   *    ambiguous outcomes (lock contention timeout) proceed fail-open so a
   *    plausibly-in-flight load elsewhere can serve the request via queueing.
   *  - "open": never fail the request; log and proceed (JIT fallback).
   *  - "closed": any warm failure fails the request.
   */
  failMode: "open" | "closed" | "hybrid"
  /** If only suffixed duplicate instances (key:2 …) exist and none is busy,
   *  unload them and load fresh so the bare key becomes addressable again. */
  reconcileDuplicates: boolean
  /** If the server can't be started (LM Studio app closed), try `open -ga "LM Studio"` once. */
  launchAppFallback: boolean
  /** Warm cfg.model + cfg.small_model in the background at instance start. */
  eager: boolean
  logFile: string
  lockDir: string
}

const HOME = os.homedir()

const DEFAULTS: WarmOptions = {
  providers: ["lmstudio"],
  lmsPath: fs.existsSync(path.join(HOME, ".lmstudio/bin/lms")) ? path.join(HOME, ".lmstudio/bin/lms") : "lms",
  baseURL: "http://127.0.0.1:1234/v1",
  ttlSeconds: 0,
  parallel: 0,
  contextLength: 0,
  perModel: {},
  verifyCacheMs: 30_000,
  retryCooldownMs: 60_000,
  loadTimeoutMs: 900_000,
  serverStartTimeoutMs: 90_000,
  lockWaitTimeoutMs: 1_200_000,
  failMode: "hybrid",
  reconcileDuplicates: true,
  launchAppFallback: true,
  eager: true,
  logFile: path.join(HOME, ".cache/opencode/lmstudio-warm.log"),
  lockDir: path.join(HOME, ".cache/opencode/lmstudio-warm.lock"),
}

function loadFileOptions(): Partial<WarmOptions> {
  try {
    const p = path.join(HOME, ".config/opencode/lmstudio-warm.json")
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return {}
  }
}

export type LmsInstance = {
  modelKey?: string
  identifier?: string
  status?: string
  ttlMs?: number | null
  parallel?: number
  queued?: number
}

/** Warm outcome. `confirmed` marks a definitive failure (vs. ambiguity). */
export type WarmResult = { ok: boolean; confirmed: boolean; reason: string }

const OK: WarmResult = { ok: true, confirmed: false, reason: "" }

// ─── Pure helpers (module scope, exported for unit tests) ───────────────────
// No per-process state — the plugin closure below composes these with the live
// caches, child processes, and lock directory.

/** Merge config in precedence order: DEFAULTS < file options < plugin options. */
export function resolveOptions(fileOpts: Partial<WarmOptions>, pluginOpts?: Partial<WarmOptions> | null): WarmOptions {
  return { ...DEFAULTS, ...fileOpts, ...(pluginOpts ?? {}) }
}

/** Keys in a raw options object that the plugin does not know. Surfaced as
 *  warnings at startup — a typo'd key would otherwise be silently ignored. */
export function unknownOptionKeys(raw: Record<string, unknown>): string[] {
  return Object.keys(raw).filter((k) => !(k in DEFAULTS))
}

const NUMERIC_KEYS = [
  "ttlSeconds",
  "parallel",
  "contextLength",
  "verifyCacheMs",
  "retryCooldownMs",
  "loadTimeoutMs",
  "serverStartTimeoutMs",
  "lockWaitTimeoutMs",
] as const
const BOOLEAN_KEYS = ["reconcileDuplicates", "launchAppFallback", "eager"] as const
const STRING_KEYS = ["lmsPath", "baseURL", "logFile", "lockDir"] as const

/** Repair invalid option VALUES back to their defaults, collecting one
 *  warning per repair. Notably an unrecognized failMode falls back to
 *  "hybrid" (the default): the exact-match checks downstream would otherwise
 *  make a typo silently behave like "open", the least safe mode. */
export function sanitizeOptions(o: WarmOptions): { opts: WarmOptions; warnings: string[] } {
  const warnings: string[] = []
  const out: WarmOptions = { ...o }
  const fix = (key: keyof WarmOptions, why: string) => {
    warnings.push(`${key} ${why} — using default ${JSON.stringify(DEFAULTS[key])}`)
    ;(out as Record<string, unknown>)[key] = DEFAULTS[key]
  }
  if (!["open", "closed", "hybrid"].includes(out.failMode)) fix("failMode", `"${out.failMode}" is not open|closed|hybrid`)
  if (!Array.isArray(out.providers) || out.providers.length === 0 || out.providers.some((p) => typeof p !== "string"))
    fix("providers", "must be a non-empty string array")
  for (const k of NUMERIC_KEYS) if (typeof out[k] !== "number" || !Number.isFinite(out[k]) || out[k] < 0) fix(k, "must be a non-negative number")
  for (const k of BOOLEAN_KEYS) if (typeof out[k] !== "boolean") fix(k, "must be a boolean")
  for (const k of STRING_KEYS) if (typeof out[k] !== "string" || out[k] === "") fix(k, "must be a non-empty string")
  if (out.perModel === null || typeof out.perModel !== "object" || Array.isArray(out.perModel)) fix("perModel", "must be an object")
  return { opts: out, warnings }
}

/** opencode addresses models by the UNSUFFIXED key; LM Studio routes the API
 *  `model` field by instance identifier. "Addressable" means an instance whose
 *  identifier equals the key exists. NOTE (verified live): a still-loading
 *  instance already appears with status "idle" and LM Studio queues requests
 *  against it until ready — there is no ps-visible "loading" state, and none is
 *  needed for correctness. */
export function addressable(instances: LmsInstance[], key: string): boolean {
  return instances.some((i) => i.identifier === key)
}

/** Classify `lms ps` output for a key. "unknown" (ps output unavailable) is a
 *  first-class state on purpose: it is AMBIGUOUS, never "absent" — loading
 *  blind onto a possibly-resident key is how duplicate instances are made,
 *  and a failed post-load probe must not be reported as a confirmed load
 *  failure (that would negative-cache a model that may well be loaded). */
export type PsCheck =
  | { state: "unknown" }
  | { state: "addressable" }
  | { state: "absent" }
  | { state: "duplicates"; dups: LmsInstance[]; busy: boolean }

export function classifyPs(instances: LmsInstance[] | null, key: string): PsCheck {
  if (instances === null) return { state: "unknown" }
  if (addressable(instances, key)) return { state: "addressable" }
  const dups = instances.filter((i) => i.modelKey === key)
  if (dups.length === 0) return { state: "absent" }
  const busy = dups.some((i) => i.status === "generating" || (i.queued ?? 0) > 0)
  return { state: "duplicates", dups, busy }
}

/** Split an opencode model ref ("provider/key…") on the FIRST slash, so a key
 *  that itself contains slashes (e.g. "qwen/qwen3") is preserved intact. */
export function parseModelRef(ref: unknown): { providerID: string; key: string } | null {
  if (typeof ref !== "string" || !ref.includes("/")) return null
  const slash = ref.indexOf("/")
  return { providerID: ref.slice(0, slash), key: ref.slice(slash + 1) }
}

/** Build the `lms load` argv for a key, applying per-model overrides over the
 *  top-level options. A value of 0 omits the corresponding flag. */
export function loadArgs(opts: WarmOptions, key: string): string[] {
  const per = opts.perModel[key] ?? {}
  const ttl = per.ttlSeconds ?? opts.ttlSeconds
  const parallel = per.parallel ?? opts.parallel
  const ctx = per.contextLength ?? opts.contextLength
  const args = ["load", key, "-y"]
  if (ttl > 0) args.push("--ttl", String(ttl))
  if (parallel > 0) args.push("--parallel", String(parallel))
  if (ctx > 0) args.push("--context-length", String(ctx))
  return args
}

/** Is a process alive? `kill(pid, 0)` sends no signal, just probes: ESRCH ⇒
 *  no such process (dead); EPERM ⇒ exists but owned by another user (alive).
 *  Host-local only, which is fine — the lock dir is host-local too. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

/** Parse a lock pid-file's contents to a pid, or null if absent/blank/garbage
 *  or non-positive. Non-positive values are rejected because `kill(-1, 0)`
 *  probes ALL processes (always "alive") — a corrupted pid file must not make
 *  the lock unbreakable until the staleness backstop. */
export function parseLockPid(content: string | null): number | null {
  if (content == null) return null
  const n = Number.parseInt(content.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Given a warm outcome and the configured failMode, should opencode's request
 *  be failed? `closed` fails on any not-ok; `hybrid` fails only CONFIRMED
 *  failures; `open` never fails. An ok result never fails. */
export function shouldFailRequest(failMode: WarmOptions["failMode"], result: WarmResult): boolean {
  if (result.ok) return false
  return failMode === "closed" || (failMode === "hybrid" && result.confirmed)
}

export const LMStudioWarm: Plugin = async (_input, pluginOptions) => {
  const fileOpts = loadFileOptions()
  const plugOpts = (pluginOptions ?? {}) as Partial<WarmOptions>
  const { opts, warnings: configWarnings } = sanitizeOptions(resolveOptions(fileOpts, plugOpts))
  for (const k of unknownOptionKeys(fileOpts as Record<string, unknown>))
    configWarnings.push(`unknown option "${k}" in lmstudio-warm.json`)
  for (const k of unknownOptionKeys(plugOpts as Record<string, unknown>))
    configWarnings.push(`unknown option "${k}" in plugin options`)

  // ---- state (per opencode process) ----
  // Warm caches are keyed by `${baseURL}::${modelKey}` — residency and failure
  // are facts about one server+model pair, not about a model key in the
  // abstract (two gated providers may serve the same key).
  const verifiedAt = new Map<string, number>() // last confirmed-addressable timestamp
  const failedAt = new Map<string, { at: number; reason: string }>() // negative cache
  const inflight = new Map<string, Promise<WarmResult>>()
  const serverVerifiedAt = new Map<string, number>() // baseURL -> last confirmed-listening
  const serverFailedAt = new Map<string, number>() // baseURL -> last failed bring-up
  // True only while THIS process holds the mkdir lock. Used by the exit handler
  // to release a lock that a fire-and-forget eager warm may still be holding
  // when the process tears down (otherwise the async finally never runs).
  let holdingLock = false

  try {
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true })
  } catch {}

  // Rotate the log once it outgrows ~5 MB (one previous generation kept at
  // .old) so long-lived fleet hosts cannot grow it unbounded.
  try {
    if (fs.statSync(opts.logFile).size > 5 * 1024 * 1024) fs.renameSync(opts.logFile, `${opts.logFile}.old`)
  } catch {}

  function log(msg: string) {
    try {
      fs.appendFileSync(opts.logFile, `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`)
    } catch {}
  }

  const loggedOnce = new Set<string>()
  function logOnce(msg: string) {
    if (loggedOnce.has(msg)) return
    loggedOnce.add(msg)
    log(msg)
  }

  for (const w of configWarnings) log(`config warning: ${w}`)

  // The ONLY lock-release path (also used by the exit handler below). Removes
  // the lock dir only if the pid file still names this process, or is
  // absent/blank (we mkdir'd but hadn't written it yet). Another process may
  // have legitimately broken our lock (stale/dead-holder rules in acquireLock)
  // and re-acquired it — deleting THEIR lock would reopen the duplicate-load
  // race the lock exists to prevent. Synchronous on purpose: rmSync + flag
  // clear run with no await between them, so a second in-process waiter cannot
  // observe a removed dir with holdingLock still true, and it works inside the
  // sync-only "exit" handler. Never throws.
  function releaseLockIfOurs() {
    try {
      let ours = true
      try {
        const pidStr = fs.readFileSync(path.join(opts.lockDir, "pid"), "utf8").trim()
        ours = pidStr === "" || pidStr === String(process.pid)
      } catch {
        ours = true
      }
      if (ours) fs.rmSync(opts.lockDir, { recursive: true, force: true })
    } catch {}
    holdingLock = false
  }

  // Last-resort release. A one-shot `opencode run` can exit while a background
  // eager warm still holds the lock; process.on("exit") runs sync only.
  // SIGKILL is uncatchable — the dead-holder liveness check in acquireLock is
  // the backstop for that.
  process.once("exit", () => {
    if (holdingLock) releaseLockIfOurs()
  })

  function run(
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ ok: boolean; timedOut: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (err, stdout, stderr) =>
        resolve({
          ok: !err,
          timedOut: Boolean(err && (err as any).killed),
          stdout: String(stdout),
          stderr: String(stderr),
        }),
      )
    })
  }

  const lms = (args: string[], timeoutMs: number) => run(opts.lmsPath, args, timeoutMs)

  async function psInstances(): Promise<LmsInstance[] | null> {
    const res = await lms(["ps", "--json"], 15_000)
    if (!res.ok) {
      log(`lms ps failed: ${res.stderr.trim().slice(0, 300)}`)
      return null
    }
    try {
      const parsed = JSON.parse(res.stdout)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      log(`lms ps returned non-JSON: ${res.stdout.slice(0, 200)}`)
      return null
    }
  }

  // "Alive" means the server is listening — any HTTP response counts, including
  // 401/403 (LM Studio with API auth enabled rejects unauthenticated probes).
  // Only network-level failures (refused/timeout) mean the server is down.
  async function httpAlive(baseURL: string): Promise<boolean> {
    try {
      await fetch(`${baseURL.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(2_500) })
      return true
    } catch {
      return false
    }
  }

  async function pollAlive(baseURL: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await httpAlive(baseURL)) return true
      await new Promise((r) => setTimeout(r, 1_000))
    }
    return false
  }

  const serverInflight = new Map<string, Promise<boolean>>()
  function ensureServer(baseURL: string): Promise<boolean> {
    if (Date.now() - (serverVerifiedAt.get(baseURL) ?? 0) < opts.verifyCacheMs) return Promise.resolve(true)
    // Server-level negative cache: a failed bring-up (start + poll + optional
    // app launch) can take minutes — fail fast for retryCooldownMs instead of
    // re-paying that stall on every request while the server stays down.
    if (Date.now() - (serverFailedAt.get(baseURL) ?? 0) < opts.retryCooldownMs) return Promise.resolve(false)
    const existing = serverInflight.get(baseURL)
    if (existing) return existing
    const p = ensureServerImpl(baseURL)
      .then((up) => {
        if (up) serverFailedAt.delete(baseURL)
        else serverFailedAt.set(baseURL, Date.now())
        return up
      })
      .finally(() => serverInflight.delete(baseURL))
    serverInflight.set(baseURL, p)
    return p
  }

  async function ensureServerImpl(baseURL: string): Promise<boolean> {
    if (await httpAlive(baseURL)) {
      serverVerifiedAt.set(baseURL, Date.now())
      return true
    }
    log(`HTTP server not reachable at ${baseURL} — running lms server start`)
    const started = await lms(["server", "start"], 30_000)
    if (!started.ok) log(`lms server start failed: ${started.stderr.trim().slice(0, 300)}`)
    if (await pollAlive(baseURL, opts.serverStartTimeoutMs)) {
      serverVerifiedAt.set(baseURL, Date.now())
      log(`HTTP server is up at ${baseURL}`)
      return true
    }
    if (opts.launchAppFallback && process.platform === "darwin") {
      // Server still down: the LM Studio app itself may be closed.
      log(`server still down — trying: open -ga "LM Studio"`)
      await run("/usr/bin/open", ["-ga", "LM Studio"], 15_000)
      await new Promise((r) => setTimeout(r, 3_000))
      await lms(["server", "start"], 30_000)
      if (await pollAlive(baseURL, opts.serverStartTimeoutMs)) {
        serverVerifiedAt.set(baseURL, Date.now())
        log(`HTTP server is up at ${baseURL} (after app launch)`)
        return true
      }
    }
    log(`HTTP server did not come up within budget`)
    return false
  }

  function lockHolderPid(): number | null {
    try {
      return parseLockPid(fs.readFileSync(path.join(opts.lockDir, "pid"), "utf8"))
    } catch {
      return null
    }
  }

  // Cross-process mutex via atomic mkdir: parallel opencode workers must not
  // race lms load (it is not idempotent). A lock may be broken when (1) it is
  // older than staleMs — holders refresh the dir mtime before each long phase
  // (touchLock in doWarm), so age measures the CURRENT phase and no live phase
  // can outlast the load timeout, the longest hard cap; (2) its recorded
  // holder pid is dead (crash/abrupt exit before the finally released it — the
  // observed eager-warm leak); or (3) the pid file is missing AND the dir has
  // outlived a short grace (a holder that crashed between mkdir and
  // writeFile). A fresh, pid-less lock is left alone: that is a live holder
  // still mid-acquisition.
  async function acquireLock(): Promise<(() => void) | null> {
    const deadline = Date.now() + opts.lockWaitTimeoutMs
    const staleMs = opts.loadTimeoutMs + 120_000
    const pidGraceMs = 5_000
    for (;;) {
      try {
        await fsp.mkdir(opts.lockDir, { recursive: false })
        holdingLock = true
        try {
          await fsp.writeFile(path.join(opts.lockDir, "pid"), String(process.pid))
        } catch {}
        return releaseLockIfOurs
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err
        try {
          const st = await fsp.stat(opts.lockDir)
          const age = Date.now() - st.mtimeMs
          const holder = lockHolderPid()
          let reason = ""
          if (age > staleMs) reason = `stale (age ${Math.round(age / 1000)}s)`
          else if (holder !== null && holder !== process.pid && !pidAlive(holder)) reason = `dead holder pid ${holder}`
          else if (holder === null && age > pidGraceMs) reason = `abandoned (no pid, age ${Math.round(age / 1000)}s)`
          if (reason) {
            log(`breaking lock: ${reason}`)
            await fsp.rm(opts.lockDir, { recursive: true, force: true })
            continue
          }
        } catch {} // lock vanished between mkdir and stat — retry
        if (Date.now() > deadline) return null // contention timeout — ambiguous, caller decides
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }

  // The lms CLI manages only the LOCAL LM Studio: with a non-loopback baseURL
  // the gate would load models on this machine while requests go elsewhere.
  // Warn once per URL instead of failing — a LAN hostname can still be an
  // alias for this host, and generation may work regardless.
  function warnIfNonLoopback(baseURL: string) {
    try {
      const host = new URL(baseURL).hostname
      if (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1") return
      logOnce(
        `WARNING: baseURL ${baseURL} is not loopback — lms manages only the LOCAL LM Studio, so the warm gate cannot ensure models on a remote server`,
      )
    } catch {}
  }

  async function doWarm(key: string, baseURL: string): Promise<WarmResult> {
    const cacheKey = `${baseURL}::${key}`
    warnIfNonLoopback(baseURL)
    if (!(await ensureServer(baseURL))) {
      return { ok: false, confirmed: true, reason: `LM Studio HTTP server is not reachable at ${baseURL}` }
    }

    // Fast path: no lock needed if already addressable. An "unknown" ps state
    // is ambiguous — never proceed toward a load on it (see classifyPs).
    let check = classifyPs(await psInstances(), key)
    if (check.state === "unknown") {
      return { ok: false, confirmed: false, reason: "lms ps failed — model state unknown" }
    }
    if (check.state === "addressable") {
      verifiedAt.set(cacheKey, Date.now())
      return OK
    }

    const release = await acquireLock()
    if (!release) {
      // Someone else has been loading for a long time (big model, slow disk).
      // Their instance may already be addressable and queueing — ambiguous.
      log(`lock contention timeout waiting to warm ${key} — proceeding (ambiguous)`)
      return { ok: false, confirmed: false, reason: "lock contention timeout" }
    }
    // Refresh the lock dir mtime before each long phase so acquireLock's
    // age-based stale check measures the current phase, never the total hold.
    const touchLock = () => fsp.utimes(opts.lockDir, new Date(), new Date()).catch(() => {})
    try {
      // Double-checked: another process may have loaded it while we waited.
      check = classifyPs(await psInstances(), key)
      if (check.state === "unknown") {
        return { ok: false, confirmed: false, reason: "lms ps failed — model state unknown" }
      }
      if (check.state === "addressable") {
        verifiedAt.set(cacheKey, Date.now())
        return OK
      }

      // Orphaned duplicates: instances of this model exist (key:2 …) but none
      // is addressable by the bare key (e.g. the original was unloaded and a
      // stray duplicate survived). Loading again would only stack key:3 —
      // reconcile by unloading idle duplicates first, then load fresh.
      if (check.state === "duplicates") {
        if (!opts.reconcileDuplicates || check.busy) {
          const ids = check.dups.map((i) => i.identifier).join(", ")
          log(`WARNING: only non-addressable instances of ${key} exist (${ids}); busy=${check.busy} — cannot warm`)
          return { ok: false, confirmed: true, reason: `only suffixed duplicates of ${key} are resident (${ids})` }
        }
        for (const d of check.dups) {
          if (!d.identifier) continue
          await touchLock()
          log(`reconciling: unloading duplicate instance ${d.identifier}`)
          const un = await lms(["unload", d.identifier], 60_000)
          if (!un.ok) log(`unload ${d.identifier} failed: ${un.stderr.trim().slice(0, 200)}`)
        }
      }

      const args = loadArgs(opts, key)
      log(`loading ${key} (${args.join(" ")}) ...`)
      await touchLock()
      const t0 = Date.now()
      const res = await lms(args, opts.loadTimeoutMs)
      if (!res.ok) {
        const kind = res.timedOut ? "timeout" : "error"
        const detail = (res.stderr || res.stdout).trim().slice(0, 500)
        log(`lms load ${key} FAILED (${kind}) after ${Date.now() - t0}ms: ${detail}`)
        return { ok: false, confirmed: true, reason: `lms load failed (${kind}): ${detail.slice(0, 200)}` }
      }

      const after = classifyPs(await psInstances(), key)
      if (after.state === "addressable") {
        verifiedAt.set(cacheKey, Date.now())
        log(`loaded ${key} in ${Math.round((Date.now() - t0) / 1000)}s`)
        return OK
      }
      if (after.state === "unknown") {
        // The load exited 0; only the verification probe failed. Ambiguous —
        // negative-caching this as confirmed would fail requests for up to
        // retryCooldownMs against a model that is very likely loaded.
        log(`lms load ${key} exited 0 but lms ps failed — cannot verify addressability`)
        return { ok: false, confirmed: false, reason: "loaded but unverified (lms ps failed)" }
      }
      log(`lms load ${key} exited 0 but ps does not show identifier === key`)
      return { ok: false, confirmed: true, reason: `loaded but not addressable as "${key}"` }
    } finally {
      release()
    }
  }

  function warm(key: string, baseURL: string): Promise<WarmResult> {
    const cacheKey = `${baseURL}::${key}`
    if (Date.now() - (verifiedAt.get(cacheKey) ?? 0) < opts.verifyCacheMs) return Promise.resolve(OK)
    const failed = failedAt.get(cacheKey)
    if (failed && Date.now() - failed.at < opts.retryCooldownMs) {
      return Promise.resolve({ ok: false, confirmed: true, reason: `${failed.reason} (cooldown)` })
    }
    const existing = inflight.get(cacheKey)
    if (existing) return existing
    const p = doWarm(key, baseURL)
      .catch((err): WarmResult => {
        log(`warm(${key}) error: ${err instanceof Error ? err.message : String(err)}`)
        return { ok: false, confirmed: false, reason: "internal error (see log)" }
      })
      .then((r) => {
        if (r.ok) failedAt.delete(cacheKey)
        else if (r.confirmed) failedAt.set(cacheKey, { at: Date.now(), reason: r.reason })
        return r
      })
      .finally(() => inflight.delete(cacheKey))
    inflight.set(cacheKey, p)
    return p
  }

  log(
    `plugin loaded (providers=${opts.providers.join(",")} ttl=${opts.ttlSeconds || "none"} parallel=${opts.parallel || "default"} failMode=${opts.failMode})`,
  )

  return {
    // Fires once at instance start with the resolved config. Background eager
    // warm of both pinned models — NOT awaited, so startup isn't delayed; the
    // chat.params gate below remains the deterministic barrier.
    config: async (cfg: any) => {
      if (!opts.eager) return
      const warmed = new Set<string>()
      for (const ref of [cfg?.model, cfg?.small_model]) {
        const parsed = parseModelRef(ref)
        if (!parsed || !opts.providers.includes(parsed.providerID)) continue
        if (warmed.has(parsed.key)) continue // model === small_model ⇒ warm the key once
        warmed.add(parsed.key)
        const configured = cfg?.provider?.[parsed.providerID]?.options?.baseURL
        const baseURL = typeof configured === "string" && configured.startsWith("http") ? configured : opts.baseURL
        log(`eager warm queued for ${parsed.key}`)
        void warm(parsed.key, baseURL)
      }
    },

    // Awaited by opencode before EVERY LLM request (main and small model alike):
    // the deterministic pre-warm gate. Heals cold starts and TTL evictions.
    "chat.params": async (input: any) => {
      let result: WarmResult = OK
      let key: string | undefined
      try {
        // Contract-drift canaries: this plugin depends on undocumented input
        // shapes verified against opencode v1.17.10. If an upgrade changes
        // them the gate silently no-ops — these one-time log lines are the
        // only signal that would remain.
        const providerID: string | undefined = input?.provider?.info?.id ?? input?.model?.providerID
        if (!providerID) {
          logOnce("chat.params input carries no provider id — opencode hook shape may have changed; gate skipped")
          return
        }
        if (!opts.providers.includes(providerID)) return
        // model.api.id is the exact string opencode sends as the API `model`
        // field (== LM Studio model key for config-defined models).
        key = input?.model?.api?.id ?? input?.model?.id
        if (!key) {
          logOnce(`chat.params for gated provider "${providerID}" carries no model key — opencode hook shape may have changed; gate skipped`)
          return
        }
        const configured = input?.provider?.options?.baseURL
        const baseURL = typeof configured === "string" && configured.startsWith("http") ? configured : opts.baseURL
        result = await warm(key, baseURL)
      } catch (err) {
        log(`chat.params hook error: ${err instanceof Error ? err.message : String(err)}`)
        result = { ok: false, confirmed: false, reason: "hook error (see log)" }
      }
      if (result.ok) return
      if (shouldFailRequest(opts.failMode, result)) {
        throw new Error(`lmstudio-warm: cannot ensure model "${key}" is loaded — ${result.reason}. See ${opts.logFile}`)
      }
      log(`warm(${key}) not ensured (${result.reason}) — proceeding fail-open`)
    },
  }
}

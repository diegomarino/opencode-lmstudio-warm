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
  /**
   * Reactive RAM-pressure eviction (opt-in, default OFF). When a target model
   * is not addressable and must be loaded, first make room by unloading IDLE
   * instances (never busy, never the target, never protected) in LRU order so
   * the load fits under a memory guardrail instead of being refused. See the
   * eviction block in doWarm.
   */
  evictOnPressure: boolean
  /** RAM the fleet may use for LM Studio, in MB. 0 = auto (90% of total physical
   *  memory). The fit calc uses this as the denominator, NOT os.freemem() —
   *  freemem under-reports available memory on macOS (it excludes cached pages). */
  ramBudgetMB: number
  /** Flat margin (MB) added over a model's on-disk weight size when deciding if
   *  it fits. See EVICT_HEADROOM_NOTE in doWarm for why this is deliberately a
   *  flat number today rather than a context×parallel KV-cache estimate. */
  evictHeadroomMB: number
  /** Model keys (or instance identifiers) never unloaded by eviction. */
  evictProtect: string[]
  /** Max instances eviction may unload per warm attempt (predictive + reactive
   *  combined). A ceiling on lock-hold time: each eviction plus its load retry
   *  can cost up to loadTimeoutMs, so an unbounded reactive loop could hold the
   *  cross-process lock for N × loadTimeoutMs. 0 = unlimited (bounded only by the
   *  idle-instance count). See the evicted-set check in unloadIfIdle. */
  evictMaxVictims: number
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
  evictOnPressure: false,
  ramBudgetMB: 0,
  evictHeadroomMB: 4096,
  evictProtect: [],
  evictMaxVictims: 8,
  logFile: path.join(HOME, ".cache/opencode/lmstudio-warm.log"),
  lockDir: path.join(HOME, ".cache/opencode/lmstudio-warm.lock"),
}

/** Fraction of total physical memory used as the eviction budget when
 *  ramBudgetMB is 0 (auto). Leaves headroom for the OS, other apps, and the
 *  gap between weight bytes and true runtime footprint. */
const RAM_BUDGET_AUTO_FRACTION = 0.9
const BYTES_PER_MB = 1024 * 1024

function loadFileOptions(): { opts: Partial<WarmOptions>; warning: string | null } {
  const p = path.join(HOME, ".config/opencode/lmstudio-warm.json")
  let content: string | null = null
  try {
    content = fs.readFileSync(p, "utf8")
  } catch {
    return { opts: {}, warning: null } // absent — the common case
  }
  return parseFileOptions(content, p)
}

export type LmsInstance = {
  modelKey?: string
  identifier?: string
  status?: string
  ttlMs?: number | null
  parallel?: number
  queued?: number
  /** On-disk weight size (bytes) as reported by `lms ps`/`lms ls`. */
  sizeBytes?: number
  /** Epoch ms of last use — the LRU signal for eviction. */
  lastUsedTime?: number
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

/** Parse the contents of lmstudio-warm.json. Malformed JSON (or a non-object
 *  top level) yields empty options PLUS a warning: silently dropping the
 *  user's entire config file would otherwise be the one config mistake that
 *  never surfaces in the log. */
export function parseFileOptions(content: string, sourcePath: string): { opts: Partial<WarmOptions>; warning: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    return { opts: {}, warning: `${sourcePath} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — ignoring the file` }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { opts: {}, warning: `${sourcePath} must contain a JSON object — ignoring the file` }
  }
  return { opts: parsed as Partial<WarmOptions>, warning: null }
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
  "ramBudgetMB",
  "evictHeadroomMB",
  "evictMaxVictims",
] as const
const BOOLEAN_KEYS = ["reconcileDuplicates", "launchAppFallback", "eager", "evictOnPressure"] as const
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
  if (!Array.isArray(out.providers) || out.providers.length === 0 || out.providers.some((p) => typeof p !== "string" || p === ""))
    fix("providers", "must be a non-empty array of non-empty strings")
  for (const k of NUMERIC_KEYS) if (typeof out[k] !== "number" || !Number.isFinite(out[k]) || out[k] < 0) fix(k, "must be a non-negative number")
  for (const k of BOOLEAN_KEYS) if (typeof out[k] !== "boolean") fix(k, "must be a boolean")
  for (const k of STRING_KEYS) if (typeof out[k] !== "string" || out[k] === "") fix(k, "must be a non-empty string")
  if (out.perModel === null || typeof out.perModel !== "object" || Array.isArray(out.perModel)) fix("perModel", "must be an object")
  else out.perModel = sanitizePerModel(out.perModel, warnings)
  if (!Array.isArray(out.evictProtect) || out.evictProtect.some((p) => typeof p !== "string"))
    fix("evictProtect", "must be a string array")
  return { opts: out, warnings }
}

const PER_MODEL_FIELDS = ["ttlSeconds", "parallel", "contextLength"] as const

/** Validate perModel entries field by field: a non-object entry is dropped, an
 *  invalid or unknown field inside an entry is dropped, valid fields survive.
 *  Each drop gets its own warning — these values feed straight into `lms load`
 *  argv, so a typo'd or wrong-typed override must not ride along silently. */
function sanitizePerModel(perModel: Record<string, PerModel>, warnings: string[]): Record<string, PerModel> {
  const cleaned: Record<string, PerModel> = {}
  for (const [key, per] of Object.entries(perModel)) {
    if (per === null || typeof per !== "object" || Array.isArray(per)) {
      warnings.push(`perModel["${key}"] must be an object — ignoring the entry`)
      continue
    }
    const entry: PerModel = {}
    for (const [field, value] of Object.entries(per)) {
      if (!PER_MODEL_FIELDS.includes(field as (typeof PER_MODEL_FIELDS)[number])) {
        warnings.push(`perModel["${key}"] has unknown field "${field}" — ignoring it`)
        continue
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        warnings.push(`perModel["${key}"].${field} must be a non-negative number — ignoring it`)
        continue
      }
      entry[field as (typeof PER_MODEL_FIELDS)[number]] = value
    }
    cleaned[key] = entry
  }
  return cleaned
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

// ─── RAM-pressure eviction (pure) ───────────────────────────────────────────

/** The RAM budget (bytes) eviction plans against. An explicit ramBudgetMB wins;
 *  otherwise a fixed fraction of total PHYSICAL memory. Deliberately not
 *  os.freemem(): on macOS freemem excludes cached/purgeable pages and so
 *  under-reports what a load can actually use, which would over-evict. */
export function resolveBudgetBytes(opts: WarmOptions, totalmemBytes: number): number {
  if (opts.ramBudgetMB > 0) return opts.ramBudgetMB * BYTES_PER_MB
  return Math.floor(totalmemBytes * RAM_BUDGET_AUTO_FRACTION)
}

/** The target model's on-disk weight size from `lms ls --json` (all downloaded
 *  models, loaded or not), or null when unavailable — the fit calc then can't
 *  run and doWarm falls back to the reactive backstop. */
export function parseModelSize(lsArray: Array<{ modelKey?: string; sizeBytes?: number }> | null, key: string): number | null {
  if (lsArray === null) return null
  const hit = lsArray.find((m) => m.modelKey === key)
  return typeof hit?.sizeBytes === "number" ? hit.sizeBytes : null
}

/** Instances that are SAFE to unload to make room, least-recently-used first.
 *  Excludes the target itself (by identifier AND modelKey, so its duplicates
 *  are spared too), busy instances (generating or with queued work), protected
 *  keys/identifiers, and anything without an identifier to unload. A missing
 *  lastUsedTime sorts first (treated as oldest). */
export function evictionCandidates(instances: LmsInstance[], targetKey: string, protect: string[]): LmsInstance[] {
  return instances
    .filter(
      (i) =>
        typeof i.identifier === "string" &&
        i.identifier !== targetKey &&
        i.modelKey !== targetKey &&
        i.status !== "generating" &&
        (i.queued ?? 0) === 0 &&
        !protect.includes(i.identifier) &&
        !protect.includes(i.modelKey ?? ""),
    )
    .sort((a, b) => (a.lastUsedTime ?? 0) - (b.lastUsedTime ?? 0))
}

export type EvictionPlan = { victims: LmsInstance[]; fitsAfter: boolean }

/** Decide which idle instances to unload so the target fits under budget.
 *  needed = targetSize + headroom; available = budget − currentUsage. If that
 *  is already enough, no eviction. Otherwise walk candidates LRU-first,
 *  accumulating freed bytes until the target fits or candidates run out.
 *  `fitsAfter=false` means even evicting every candidate is not enough — the
 *  caller may still try to load (a partial guardrail may relent) but shouldn't
 *  expect success. */
export function planEviction(p: {
  instances: LmsInstance[]
  targetKey: string
  targetSizeBytes: number
  budgetBytes: number
  headroomBytes: number
  protect: string[]
}): EvictionPlan {
  const currentUsage = p.instances.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0)
  const needed = p.targetSizeBytes + p.headroomBytes
  let available = p.budgetBytes - currentUsage
  if (available >= needed) return { victims: [], fitsAfter: true }

  const victims: LmsInstance[] = []
  for (const c of evictionCandidates(p.instances, p.targetKey, p.protect)) {
    victims.push(c)
    available += c.sizeBytes ?? 0
    if (available >= needed) break
  }
  return { victims, fitsAfter: available >= needed }
}

/** Does an `lms load` failure look like a RAM/guardrail rejection (so the
 *  reactive backstop should free room and retry)? Strict on purpose: matching a
 *  config error (e.g. "context length … exceeds max", "insufficient disk
 *  space", "insufficient permissions") would wrongly unload healthy idle models
 *  for a load that can never succeed until the config changes. */
export function isMemoryPressureError(text: string): boolean {
  const s = text.toLowerCase()
  if (s.includes("guardrail")) return true
  if (s.includes("out of memory") || /\boom\b/.test(s)) return true
  if (/not enough|insufficient/.test(s) && /\b(memory|ram|vram)\b/.test(s)) return true
  return false
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
  const { opts: fileOpts, warning: fileWarning } = loadFileOptions()
  const plugOpts = (pluginOptions ?? {}) as Partial<WarmOptions>
  const { opts, warnings: configWarnings } = sanitizeOptions(resolveOptions(fileOpts, plugOpts))
  if (fileWarning) configWarnings.push(fileWarning)
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

  async function lmsLs(): Promise<Array<{ modelKey?: string; sizeBytes?: number }> | null> {
    const res = await lms(["ls", "--json"], 15_000)
    if (!res.ok) {
      log(`lms ls failed: ${res.stderr.trim().slice(0, 200)}`)
      return null
    }
    try {
      const parsed = JSON.parse(res.stdout)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      log(`lms ls returned non-JSON: ${res.stdout.slice(0, 200)}`)
      return null
    }
  }

  // Unload one instance ONLY if a fresh ps still shows it as an eviction
  // candidate (idle, non-target, non-protected). The re-check guards the window
  // between an eviction plan and the unload: on a shared box a model can go busy
  // from the LM Studio UI or another client, which our lock does not coordinate
  // with — unloading it then would kill a live generation. Records the id in
  // `evicted` so a single warm attempt never tries the same victim twice.
  async function unloadIfIdle(identifier: string, key: string, evicted: Set<string>, touchLock: () => Promise<void>): Promise<boolean> {
    if (evicted.has(identifier)) return false
    // Cap total unloads per warm attempt (predictive + reactive share `evicted`).
    // Bounds worst-case lock-hold: each eviction plus its load retry can cost up
    // to loadTimeoutMs, so without a ceiling a long idle fleet could hold the
    // cross-process lock for N × loadTimeoutMs and starve other workers.
    if (opts.evictMaxVictims > 0 && evicted.size >= opts.evictMaxVictims) {
      logOnce(`eviction: reached evictMaxVictims=${opts.evictMaxVictims} this attempt — not unloading further (raise evictMaxVictims, or 0 to disable the cap)`)
      return false
    }
    const fresh = await psInstances()
    if (fresh === null) return false // ambiguous ps — never unload blind
    const stillSafe = evictionCandidates(fresh, key, opts.evictProtect).some((c) => c.identifier === identifier)
    if (!stillSafe) {
      log(`eviction: skipping ${identifier} — no longer idle/evictable`)
      return false
    }
    await touchLock()
    log(`eviction: unloading idle instance ${identifier} to make room for ${key}`)
    const un = await lms(["unload", identifier], 60_000)
    evicted.add(identifier)
    if (!un.ok) {
      log(`eviction: unload ${identifier} failed: ${un.stderr.trim().slice(0, 200)}`)
      return false
    }
    return true
  }

  // Predictive pre-eviction: if the target's weight size + headroom won't fit
  // under the RAM budget, unload idle LRU instances to make room BEFORE the
  // load, so a load the memory guardrail would otherwise refuse can proceed.
  // Best-effort — the reactive backstop in doWarm's load loop covers any
  // under-prediction. Silently no-ops (relies on the backstop) whenever the
  // inputs are ambiguous: ps unavailable, or the target's size unknown.
  async function preEvict(key: string, evicted: Set<string>, touchLock: () => Promise<void>) {
    const instances = await psInstances()
    if (instances === null) return
    const targetSize = parseModelSize(await lmsLs(), key)
    if (targetSize === null) {
      log(`eviction: target ${key} size unknown (lms ls) — skipping predictive step, relying on reactive backstop`)
      return
    }
    // EVICT_HEADROOM_NOTE: headroom is deliberately a single flat number today,
    // not a context×parallel KV-cache estimate. An accurate KV size needs
    // per-architecture internals (layers, kv-heads, head-dim) that ps/ls do not
    // expose, so any formula would be a guess with a false air of precision.
    // The reactive backstop already handles under-prediction by freeing more
    // room and retrying, so a flat margin that catches the gross case (evict an
    // idle 65GB to fit a 27B) is enough. Revisit if the SDK ever exposes real
    // runtime footprint. This warning surfaces the one case flat headroom is
    // most likely to under-shoot.
    if (opts.evictHeadroomMB === DEFAULTS.evictHeadroomMB && (opts.contextLength > 8192 || opts.parallel > 1)) {
      logOnce(
        `eviction: evictHeadroomMB is at its default ${DEFAULTS.evictHeadroomMB}MB but contextLength/parallel are large — KV cache may exceed it; raise evictHeadroomMB if loads are still refused`,
      )
    }
    const budgetBytes = resolveBudgetBytes(opts, os.totalmem())
    const headroomBytes = opts.evictHeadroomMB * BYTES_PER_MB
    const plan = planEviction({ instances, targetKey: key, targetSizeBytes: targetSize, budgetBytes, headroomBytes, protect: opts.evictProtect })
    if (plan.victims.length === 0) return
    log(
      `eviction: ${key} (${Math.round(targetSize / BYTES_PER_MB)}MB) needs room under budget ${Math.round(budgetBytes / BYTES_PER_MB)}MB — unloading ${plan.victims.length} idle instance(s); fitsAfter=${plan.fitsAfter}`,
    )
    for (const v of plan.victims) {
      if (v.identifier) await unloadIfIdle(v.identifier, key, evicted, touchLock)
    }
  }

  // Reactive backstop: free the single next LRU idle instance not already
  // evicted this attempt, so the guardrail-refused load can be retried. Returns
  // the freed identifier, or null when nothing idle remains to unload.
  async function evictNextIdle(key: string, evicted: Set<string>, touchLock: () => Promise<void>): Promise<string | null> {
    const fresh = await psInstances()
    if (fresh === null) return null
    for (const c of evictionCandidates(fresh, key, opts.evictProtect)) {
      if (!c.identifier || evicted.has(c.identifier)) continue
      if (await unloadIfIdle(c.identifier, key, evicted, touchLock)) return c.identifier
    }
    return null
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

      // Make room under RAM pressure before loading (opt-in). `evicted` tracks
      // what this attempt has already unloaded so predictive and reactive passes
      // never double-unload the same instance.
      const evicted = new Set<string>()
      if (opts.evictOnPressure) await preEvict(key, evicted, touchLock)

      const args = loadArgs(opts, key)
      const t0 = Date.now()
      const res = await (async () => {
        for (;;) {
          log(`loading ${key} (${args.join(" ")}) ...`)
          await touchLock()
          const r = await lms(args, opts.loadTimeoutMs)
          if (r.ok) return r
          // Reactive backstop: a guardrail/OOM refusal means the model didn't
          // fit. Free the next LRU idle instance and retry, until it loads or no
          // idle victim remains. Timeouts and non-memory errors (bad config,
          // missing model) fall straight through — evicting for those would
          // needlessly unload healthy models for a load that can't succeed.
          const detail = (r.stderr || r.stdout).trim().slice(0, 500)
          if (opts.evictOnPressure && !r.timedOut && isMemoryPressureError(detail)) {
            const freed = await evictNextIdle(key, evicted, touchLock)
            if (freed) {
              log(`lms load ${key} refused for memory (${detail.slice(0, 120)}); evicted ${freed}, retrying`)
              continue
            }
            log(`lms load ${key} refused for memory but no idle instance remains to evict`)
          }
          return r
        }
      })()
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

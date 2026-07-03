# opencode-lmstudio-warm

Deterministic model pre-warm for **opencode + LM Studio**.

![Quick start: install the plugin, LM Studio starts cold, the first opencode run warms the model before the request leaves, and lms ps shows both models resident with no TTL](https://github.com/user-attachments/assets/f5522cb6-7967-4f47-a8c5-ca617a8d736a)

<sup>Scripted demo (`tools/quickstart/generate-cast.py`) — every output line captured verbatim from a real run; the cold-load wait is shortened, and its spinner visualizes the plugin's background `lms load` (opencode itself waits silently).</sup>

A dependency-free opencode plugin that **guarantees your LM Studio model is
loaded and addressable _before_ any request leaves opencode**.

If you point
opencode at LM Studio, it fixes three failures you have probably already met:

- **First request hangs** — the model is cold and JIT-loads while your request waits.
- **`"no model loaded"` errors** — JIT is off and nothing loads the model for you.
- **Mid-session breakage** — LM Studio's idle TTL evicted the model between two messages.

Per request, the plugin checks that the model is actually loaded and, when it
isn't, performs exactly one `lms load` (even across parallel sessions) before
letting the request through.

Verified against opencode **v1.17.10** and the local LM Studio + `lms` CLI on
macOS/Apple Silicon (see [`test/e2e/verify.sh`](./test/e2e/verify.sh), 9/9 passing).

## Quick start

**1. Install and register the plugin** — one command; opencode resolves it from
npm and adds it to your config's `plugin` array:

```bash
opencode plugin -g opencode-lmstudio-warm    # global (~/.config/opencode) — every session on the machine
# or, for a single project's opencode.json:
opencode plugin opencode-lmstudio-warm
```

**2. Point opencode at LM Studio** (skip if you already have an `lmstudio`
provider). In `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-lmstudio-warm"],
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1",
        "apiKey": "{env:LM_API_TOKEN}",
        "headerTimeout": 600000,
        "chunkTimeout": 120000
      }
    }
  }
}
```

Then set your `model` / `small_model` to your LM Studio model keys. See
[`examples/opencode.json`](./examples/opencode.json) for a fuller starting point.

**3. Adjust LM Studio once** (App Settings → Developer): disable
**JIT model auto-unload TTL** and **unload previous JIT model on load**; keep
JIT itself on as a fallback. ([Why these matter →](#how-it-works))

That's it — from your next opencode session, the model is warm before the
first token is requested.

## Install options

All three paths load the same plugin — pick the one that fits:

| Path | Best for |
|------|----------|
| [npm](#npm-recommended) (recommended) | Most users and fleets — version-pinned, one-line updates |
| [Single-file copy](#single-file-copy-offline-fleet-wide) | Offline machines |
| [Project-local](#project-local) | Hacking on the plugin itself |

### npm (recommended)

The Quick start command above is all you need. Notes:

- You don't run `npm install` / `bun add` yourself, and there's no `npx` step —
  opencode imports the module and auto-installs any plugin named in your config
  at startup, so hand-adding `"opencode-lmstudio-warm"` to the `plugin` array
  works too.
- Use `-f` to force a version bump.

**Scriptable setup** — for fleets or automation, this `jq` one-shot registers
the plugin *and* scaffolds the provider with recommended timeouts. It is
idempotent and non-destructive: keeps your existing plugins, provider, and
models, and never overwrites options you've set.

```bash
CFG=~/.config/opencode/opencode.json   # or ./opencode.json for a single project
[ -f "$CFG" ] || echo '{}' > "$CFG"
jq '
  .plugin = ((.plugin // []) - ["opencode-lmstudio-warm"] + ["opencode-lmstudio-warm"])
  | .provider.lmstudio.npm                  //= "@ai-sdk/openai-compatible"
  | .provider.lmstudio.options.baseURL      //= "http://127.0.0.1:1234/v1"
  | .provider.lmstudio.options.apiKey       //= "{env:LM_API_TOKEN}"
  | .provider.lmstudio.options.headerTimeout //= 600000
  | .provider.lmstudio.options.chunkTimeout  //= 120000
' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
```

### Single-file copy (offline, fleet-wide)

```bash
mkdir -p ~/.config/opencode/plugin
cp src/index.ts ~/.config/opencode/plugin/lmstudio-warm.ts
```

Auto-discovered by every opencode session on the machine. (opencode's docs spell
this directory `plugins`; verified as `plugin/` — singular — on v1.17.10.)

### Project-local

Scope the plugin to a single project by copying `src/index.ts` into that
project's `.opencode/plugin/lmstudio-warm.ts` — opencode auto-discovers it there
for that project only. (This repo's own E2E fixture uses exactly this mechanism;
see `test/e2e/`.)

Whichever path you pick, also apply the LM Studio GUI settings from
[Quick start](#quick-start) step 3 on every machine. The provider timeouts
(`headerTimeout` / `chunkTimeout`) are defense-in-depth and are already set by
the JSON/`jq` above.

## Configuration

The plugin works with zero configuration. Optional tuning lives in
`~/.config/opencode/lmstudio-warm.json` (or inline as
`"plugin": [["opencode-lmstudio-warm", {...}]]`): `providers`,
`ttlSeconds`, `parallel` (size ≈ concurrent fleet width; overflow queues
server-side), `contextLength`,
`perModel: { "<key>": { parallel, ttlSeconds, contextLength } }`,
`verifyCacheMs`, `retryCooldownMs`, `failMode` (`hybrid` default: confirmed
failures fail the request with a clear error; ambiguous lock contention
proceeds fail-open), `reconcileDuplicates`, `eager`, `logFile`.

Log: `~/.cache/opencode/lmstudio-warm.log`.

See `examples/lmstudio-warm.json` for a fleet-tuned starting point
(`cp examples/lmstudio-warm.json ~/.config/opencode/lmstudio-warm.json`).
`perModel` keys are LM Studio model keys — the exact string opencode sends as
the API `model` field. Sizing `parallel`: set it to the expected number of
concurrent workers hitting that model; each slot costs extra KV-cache memory,
and overflow requests queue server-side (latency, not failure), so
undersizing is safe and oversizing wastes VRAM. Titles/summaries on the small
model tolerate queueing; the main model is where fleet width matters.

## Verify

A live, self-contained E2E fixture lives in [`test/e2e/`](./test/e2e/) — set two
real LM Studio model keys and run it:

```bash
MAIN="your/main-model" SMALL="your-small-model" bun run e2e
# requires jq, lms, opencode + a running LM Studio; export LM_API_TOKEN for full E2E
```

Covers: (a) cold spawn loads before the first request; (b) mid-session
eviction healed on resume (`opencode run -c`); (c) 3 parallel cold spawns →
exactly one `lms load`, no `:2` duplicates; (d) orphaned `:2`-only state is
reconciled back to an addressable instance. See
[`test/e2e/README.md`](./test/e2e/README.md) for setup and the placeholders to edit.

> ⚠️ It mutates live LM Studio state (unloads/loads models, spawns parallel
> sessions) — run it on a dev machine, not a busy fleet.

## Uninstall / rollback

For the npm install path, remove `"opencode-lmstudio-warm"` from the `plugin`
array in `opencode.json`. For the file-copy paths:

```bash
rm ~/.config/opencode/plugin/lmstudio-warm.ts   # removes the gate everywhere
rm -f ~/.config/opencode/lmstudio-warm.json     # optional tuning file
rm -rf ~/.cache/opencode/lmstudio-warm.lock     # only if a stale lock lingers
```

Models loaded by the plugin have no TTL, so after uninstalling they stay
resident until `lms unload <key>` or an LM Studio restart. The `opencode.json`
timeout options and the LM Studio GUI settings are independent of the plugin
and can stay.

## How it works

### The three layers

1. **Plugin (primary, deterministic)** — `src/index.ts`.
   Per request: verified-cache (30 s) → `lms ps --json` addressability check →
   cross-process `mkdir` lock → double-checked re-check → orphan-duplicate
   reconciliation → `lms load <key> -y` (no `--ttl` ⇒ resident indefinitely,
   `ttlMs: null` verified) → post-load verification. Plus a background eager
   warm of `model` + `small_model` at instance start (`config` hook).
2. **LM Studio server settings (independent)** — in the GUI (App Settings →
   Developer): disable **JIT model auto-unload TTL** (`jitModelTTL`, the 1 h
   eviction that stalls long sessions) and **unload previous JIT model on load**
   (`unloadPreviousJITModelOnLoad` — otherwise a JIT load of one model can
   evict the other). Keys live in `~/.lmstudio/settings.json` under
   `developer.*` (edit only while the app is closed). Keep JIT **on** as a
   fallback; keep server autostart on.
3. **opencode timeouts (defense-in-depth)** — v1.17.10 honors undocumented
   provider options `timeout`, `headerTimeout`, `chunkTimeout`
   (`provider.ts:resolveSDK`). Default is NO timeout at all (infinite hang
   possible). `opencode.json` here sets `headerTimeout: 600000` (tolerates
   queueing behind busy parallel slots) and `chunkTimeout: 120000` (converts a
   wedged stream into a visible, bounded error).

### Why a plugin is the right layer (design decision)

Investigated against the v1.17.10 source (tag clone), not docs:

- The `chat.params` hook is **awaited** (`yield* plugin.trigger("chat.params", ...)`
  in `session/llm/request.ts`) before every request is built and sent, and it
  fires for **every** stream — including `small: true` title/summary requests.
  One hook deterministically gates BOTH pinned models, per request, which is
  what heals mid-session eviction (an orchestrator pre-warm only helps at
  spawn time).
- Plugins run in-process under Bun and can spawn `lms` (a blocking, exit-code
  deterministic load barrier).
- The `event` hook is dispatched fire-and-forget (`void hook.event?.(...)`) —
  it can NOT gate. The v2 `ctx.aisdk.sdk` custom-fetch API is **types-only** in
  v1.17.10 (nothing in core imports it) — that path from the prior verdict is
  refuted for this release.
- A plugin dropped in `~/.config/opencode/plugin/` is auto-discovered by every
  worker on the machine — one file distributes fleet-wide and also covers
  manually launched sessions.

Tradeoff vs. an orchestrator pre-warm node: the plugin costs one
`lms ps --json` (~150 ms) per model per 30 s per process at steady state; the
orchestrator node is simpler but only covers spawn time and only sessions it
spawns. Keep the orchestrator node, if you add one, as belt-and-suspenders —
it is not required.

## Known limitations / failure modes

- **30 s verified-cache window**: an external unload (GUI, crash) within 30 s
  of a positive check can slip one request through; it errors visibly and the
  next request heals. There is no error hook in v1.17.10 to invalidate the
  cache on failure.
- **`lms ps` cannot signal "loading"** (measured: a loading instance shows
  `status: "idle"` at ~200 ms into a 12.5 s load). A waiter can pass the gate
  mid-load; LM Studio queues its request until weights are ready (verified) —
  a short wait, not a failure.
- **External JIT loads race**: a non-gated client can still trigger JIT
  duplicates/evictions. Mitigated by Layer 2 settings; gate all fleet clients.
- **`unloadPreviousJITModelOnLoad` scope for explicit loads is assumed exempt**
  (evidence: explicit loads carry `ttlMs: null` vs JIT's TTL, so bookkeeping
  differs). Confirm by JIT-loading a third model via API while both pinned
  models are resident, then `lms ps`. Disabling the setting (Layer 2) makes
  this moot.
- **LM Studio app fully closed**: `lms server start` + `open -ga "LM Studio"`
  fallback is implemented but untested here (the app was running). Confirm:
  quit LM Studio → run one worker → check the log.
- **Memory guardrails**: if LM Studio's guardrail refuses a load, the plugin
  fails that request with a clear error and cools down 60 s (no load storm) —
  it cannot free VRAM for you.
- **API auth**: the plugin itself never needs `LM_API_TOKEN` (lms + probe are
  auth-independent); workers still need it for generation when auth is on.

## Running under an orchestrator (e.g. ao-lite)

No orchestrator changes are required — workers inherit the plugin from
`~/.config/opencode/plugin/` and warm themselves. Two optional touches:
export `LM_API_TOKEN` in the worker environment (the plugin itself never needs
it), and if you want spawn-time belt-and-suspenders, a pre-warm node only needs:
`lms ps --json` guard → `lms load <key> -y` — the same logic, but remember it
cannot heal mid-session evictions; the plugin does.

## Development

The plugin is a single file with **no runtime dependencies** (its only import,
`@opencode-ai/plugin`, is `import type` and erased at build time). The root
`package.json` pulls that type package and `@types/node` as devDependencies so
you can type-check locally:

```bash
bun install
bun run typecheck        # tsc --strict, 0 errors
bun run test             # vitest unit tests for the pure logic (test/)
bun run check            # typecheck + tests + shellcheck
bun run e2e              # live E2E fixture (needs LM Studio; see test/e2e/)
```

The pure, per-process-stateless logic (config merge, model-ref parsing, load-arg
building, addressability, pid liveness, fail-mode decisions) is exported from
`src/index.ts` and unit-tested under `test/`; the live system behavior is covered
by the E2E fixture under [`test/e2e/`](./test/e2e/).

Releases follow [SemVer](https://semver.org) and are cut by CI on `v*` tags
(see [`CHANGELOG.md`](./CHANGELOG.md)).

## Disclaimer

Community plugin. Not affiliated with, endorsed by, or an official product of the
OpenCode or LM Studio teams. "opencode" and "LM Studio" are used only to indicate
compatibility.

## License

[MIT](./LICENSE) © Diego Marino

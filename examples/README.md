# Examples

Reference configs for `opencode-lmstudio-warm`. Neither is enabled by copying
the repo — take the pieces you need into your own files and replace the
`your-*-model-key` placeholders with your real LM Studio model keys (the exact
strings opencode sends as the API `model` field).

## `opencode.json` — wiring the plugin

A minimal consumer config: the `plugin` array entry plus the `lmstudio` provider
block (`baseURL`, `apiKey`, and the recommended `headerTimeout` / `chunkTimeout`).
Merge it into your own `opencode.json` — the repo
[README's Install section](../README.md#install-options) has an idempotent `jq` one-liner
that does this non-destructively, or run `opencode plugin opencode-lmstudio-warm`
to register the plugin and add only the provider block by hand.

Set `model` / `small_model` to your own model keys before use.

## `lmstudio-warm.json` — tuning the plugin

A fleet-tuned starting point for the plugin's own options file. Copy it to
`~/.config/opencode/lmstudio-warm.json` (or pass the same object as plugin
options in `opencode.json`). Highlights:

- **`failMode: "hybrid"`** — confirmed failures (server down, load failed,
  unreconcilable duplicates) fail the request with a clear error; ambiguous lock
  contention proceeds fail-open so a plausibly-in-flight load can still serve it.
- **`perModel.<key>.parallel`** — size to the number of concurrent workers
  hitting that model. Each slot costs extra KV-cache memory; overflow requests
  queue server-side (latency, not failure), so undersizing is safe. The small
  model tolerates queueing; the main model is where fleet width matters.
- **timeouts** (`loadTimeoutMs`, `serverStartTimeoutMs`, `lockWaitTimeoutMs`,
  `verifyCacheMs`, `retryCooldownMs`) are tuned for a multi-worker fleet.
- **`evictOnPressure: true`** — opt-in RAM-pressure eviction (off by default in
  the plugin). On a finite-RAM host with several large models, it unloads
  **idle** instances (never busy, never the target, never a key in
  `evictProtect`) in LRU order to make room before a load the memory guardrail
  would otherwise refuse. `ramBudgetMB: 0` auto-sizes the budget to 90% of
  physical memory; raise `evictHeadroomMB` if large-context loads still fail.
  `evictMaxVictims` caps how many instances one attempt may unload (bounds
  lock-hold time). Eviction is best-effort and not atomic — concurrent LM Studio
  use from the UI or other clients is not protected; use `evictProtect` for
  models that must never be touched.

See the [README's Configuration section](../README.md#configuration) for the full
option list and defaults.

# E2E fixture

A self-contained, live end-to-end harness for the plugin. `verify.sh` `cd`s into
this directory and runs real `opencode` commands here; opencode auto-discovers
the plugin from `.opencode/plugin/lmstudio-warm.ts` (a one-line re-export of the
repo's `src/index.ts`), so it exercises the actual plugin with no build or copy.

```
test/e2e/
├── verify.sh                     # the 9-check harness
├── opencode.template.json        # fixture config template (placeholders)
├── opencode.json                 # rendered by verify.sh from the template (gitignored)
└── .opencode/plugin/
    └── lmstudio-warm.ts          # re-export of ../../../../src/index.ts
```

> ⚠️ **This mutates live LM Studio state.** It runs `lms unload`/`lms load` and
> spawns several parallel `opencode run` processes against your local LM Studio.
> Run it on a dev machine, not against a busy fleet.

## Prerequisites

- `jq`, `lms`, and `opencode` on `PATH`.
- LM Studio running, with **two models already downloaded** (a main model and a
  smaller one for titles/summaries).
- Optional: `export LM_API_TOKEN=…` if LM Studio API auth is enabled. Without it
  the runs 401 **after** the warm gate, which still proves every pre-warm
  property (the assertions only read plugin-log ordering and `lms ps` state,
  both auth-independent).

## What to edit

Nothing — just pass two real LM Studio model keys (the exact strings opencode
sends as the API `model` field — e.g. what `lms ps --json` shows as `modelKey`)
via env:

```bash
MAIN="your/real-main-model" SMALL="your-real-small-model" ./test/e2e/verify.sh
```

`verify.sh` refuses to run with the placeholder defaults, and renders
`opencode.json` (gitignored) from `opencode.template.json` with your keys, so
the whole fixture config — `model`, `small_model`, `provider.lmstudio.models` —
matches what the checks assert against.

Other overridable vars: `LMS` (path to the `lms` CLI, default
`~/.lmstudio/bin/lms`).

## How to run

From the repo root:

```bash
bun run e2e                       # = test/e2e/verify.sh
# or directly, with model overrides:
MAIN="…" SMALL="…" ./test/e2e/verify.sh
```

Exit code is the number of failed checks (0 = all passed). The plugin's own log
is at `~/.cache/opencode/lmstudio-warm.log`.

## What it checks

1. **(a) Cold spawn** — the model loads *before* the first request; exactly one
   `lms load`, a single unsuffixed instance.
2. **(b) Mid-session eviction** — a continued session (`opencode run -c`)
   re-warms an evicted model before the next request.
3. **(c) Thundering herd** — 3 parallel cold spawns produce exactly one
   `lms load` and no `:2` duplicate instances (the cross-process lock works).
4. **(d) Orphaned duplicate** — when only a `:2` instance is resident, the plugin
   reconciles it back to an addressable instance.

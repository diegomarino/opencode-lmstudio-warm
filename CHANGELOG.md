# Changelog

## [0.1.2](https://github.com/diegomarino/opencode-lmstudio-warm/compare/v0.1.1...v0.1.2) (2026-07-04)

All notable changes are documented here. From v0.1.1 onward, entries are
generated automatically by [semantic-release](https://semver.org) from
[Conventional Commits](https://www.conventionalcommits.org). While the version
is `0.x`, a MINOR bump may include breaking changes (SemVer 0.x rule).

## [0.1.1](https://github.com/diegomarino/opencode-lmstudio-warm/compare/v0.1.0...v0.1.1) (2026-07-04)

### Bug Fixes

- avoid redundant eager warm when `model` and `small_model` are identical ([0f16e8f](https://github.com/diegomarino/opencode-lmstudio-warm/commit/0f16e8f))

## 0.1.0 - 2026-07-04

Initial public release.

### Added

- `lmstudio-warm` opencode plugin (`src/index.ts`): a deterministic pre-warm
  gate on the awaited `chat.params` hook that guarantees the target LM Studio
  model is addressable before every request, healing cold JIT loads,
  "no model loaded" errors, and mid-session idle-TTL evictions.
- Background eager warm of `model` + `small_model` at instance start.
- Cross-process `mkdir` mutex with dead-holder liveness detection so parallel
  opencode workers never race `lms load` (no `:2` duplicate instances).
- Configurable via `~/.config/opencode/lmstudio-warm.json` or plugin options:
  `providers`, `ttlSeconds`, `parallel`, `contextLength`, `perModel`,
  `verifyCacheMs`, `retryCooldownMs`, `failMode`, `reconcileDuplicates`,
  `eager`, and more.
- Three install paths: npm package, single-file copy, and project-local.
- A live E2E fixture under `test/e2e/` — a 9-check harness (cold load /
  eviction heal / thundering herd / orphaned-duplicate reconcile).
- Vitest unit tests (`test/`) for the exported pure logic: config merge,
  model-ref parsing, load-arg building, addressability, pid liveness, and
  fail-mode decisions.
- Reference configs under `examples/`.

### Fixed

- Cross-process lock leak in the fire-and-forget eager-warm path: a one-shot
  `opencode run` exiting mid-load could leave the mkdir lock held by a dead pid,
  stalling the next worker up to ~18.5 min. `acquireLock` now breaks a contended
  lock immediately when its holder pid is dead (or the pid file is absent past a
  grace window), the release is synchronous, and a `process.on("exit")` handler
  is a last-resort cleanup. Verified 9/9 against a live LM Studio fleet.

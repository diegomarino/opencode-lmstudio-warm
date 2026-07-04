## [0.1.1](https://github.com/diegomarino/opencode-lmstudio-warm/compare/v0.1.0...v0.1.1) (2026-07-04)

# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, a MINOR bump may include breaking changes (per the
SemVer 0.x rule); such changes are called out explicitly below.

## [Unreleased]

## [0.1.0] - 2026-07-03

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

[Unreleased]: https://github.com/diegomarino/opencode-lmstudio-warm/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/diegomarino/opencode-lmstudio-warm/releases/tag/v0.1.0

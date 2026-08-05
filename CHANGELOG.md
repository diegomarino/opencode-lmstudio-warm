# Changelog

## [0.2.3](https://github.com/diegomarino/opencode-lmstudio-warm/compare/v0.2.2...v0.2.3) (2026-08-05)

### Bug Fixes

* decode UTF-16 lms output on Windows (issue [#3](https://github.com/diegomarino/opencode-lmstudio-warm/issues/3) root cause) ([7ec1f48](https://github.com/diegomarino/opencode-lmstudio-warm/commit/7ec1f4860ac520cbe5ea1d81c5a29d9435160278))
* harden lms JSON parsing against non-array shapes (issue [#3](https://github.com/diegomarino/opencode-lmstudio-warm/issues/3)) ([7ea4ea4](https://github.com/diegomarino/opencode-lmstudio-warm/commit/7ea4ea400bbd7837f299755c0ce75a3704b4e44e))
* harden lms JSON parsing against non-array shapes (issue [#3](https://github.com/diegomarino/opencode-lmstudio-warm/issues/3)) ([4020ae5](https://github.com/diegomarino/opencode-lmstudio-warm/commit/4020ae5a6608fa96d2c59011c77c2adb3079f4be))

### Tests

* adversarial integration coverage for lms output shape-drift ([ed3499f](https://github.com/diegomarino/opencode-lmstudio-warm/commit/ed3499f154cfb15ff80337d7959d9c7105d5649e))

## [0.2.2](https://github.com/diegomarino/opencode-lmstudio-warm/compare/v0.2.1...v0.2.2) (2026-08-05)

### Bug Fixes

* surface config mistakes that were silently ignored ([bee3cd2](https://github.com/diegomarino/opencode-lmstudio-warm/commit/bee3cd21d74224a68b39f08089463969676f4b21))

### Documentation

* document two RAM-reclaim strategies (TTL vs eviction) ([793a79a](https://github.com/diegomarino/opencode-lmstudio-warm/commit/793a79a3acc4728fa914bf3c33fa3702be7152ce))
* reconcile header bullet and Layer 2 with the two-strategy framing ([01dd1a9](https://github.com/diegomarino/opencode-lmstudio-warm/commit/01dd1a9b95c24c571c58b7f49aa6d6b843a1cd2d))

### Tests

* integration suite against a scriptable fake lms CLI ([6375962](https://github.com/diegomarino/opencode-lmstudio-warm/commit/63759623acc181232dc00db0f8ed78c40d4a4cbd))
* make the server-down test platform-deterministic; bump checkout to v6 ([e547bd1](https://github.com/diegomarino/opencode-lmstudio-warm/commit/e547bd153321a5e1e578cd7ae1d2307e7c2198dc))

### Build System

* track bun.lock and install with --frozen-lockfile ([24bcc14](https://github.com/diegomarino/opencode-lmstudio-warm/commit/24bcc1479f9e992b77dda1f57185daf24b640c00))

### Continuous Integration

* harden workflows ([3f43d4d](https://github.com/diegomarino/opencode-lmstudio-warm/commit/3f43d4d51a520694fd2055b6fd3298b52100fa6c))

## [0.2.1](https://github.com/diegomarino/opencode-lmstudio-warm/compare/v0.2.0...v0.2.1) (2026-08-01)

### Bug Fixes

* **docs:** correct README claim that eviction cannot free RAM ([2908a4b](https://github.com/diegomarino/opencode-lmstudio-warm/commit/2908a4b581dd520a02e775ad0a5c2a6aedf584f3))

### Documentation

* lead README with benefit list and fix example placeholders ([8fda089](https://github.com/diegomarino/opencode-lmstudio-warm/commit/8fda089b56175d23bb41a0754a645eb3d16fbe02))

## [0.2.0](https://github.com/diegomarino/opencode-lmstudio-warm/compare/v0.1.2...v0.2.0) (2026-07-06)

### Features

* opt-in RAM-pressure eviction to make room before load ([424d978](https://github.com/diegomarino/opencode-lmstudio-warm/commit/424d978ec1fe9171dd043037518f09932fdfad67))

### Documentation

* repair generated-empty changelog entries and anchor the intro ([8013047](https://github.com/diegomarino/opencode-lmstudio-warm/commit/8013047a2c22f8232f5e3855705570b69e4c1d79))

### Build System

* pin conventional-changelog-conventionalcommits to 8.0.0 ([6ec3dc7](https://github.com/diegomarino/opencode-lmstudio-warm/commit/6ec3dc70717de8a8dfe24cc709c8d9329488abed))

## [0.1.2](https://github.com/diegomarino/opencode-lmstudio-warm/compare/v0.1.1...v0.1.2) (2026-07-04)

### Bug Fixes

- close warm-gate races and harden failure handling ([d26fc4b](https://github.com/diegomarino/opencode-lmstudio-warm/commit/d26fc4b))
- make example and E2E configs valid for opencode's config schema ([b2b2741](https://github.com/diegomarino/opencode-lmstudio-warm/commit/b2b2741))

### Documentation

- pin LM Studio version, full option table, fix stale claims ([618ba8a](https://github.com/diegomarino/opencode-lmstudio-warm/commit/618ba8a))
- restructure changelog and pin semantic-release changelogTitle ([977bd7f](https://github.com/diegomarino/opencode-lmstudio-warm/commit/977bd7f))

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

---

All notable changes are documented here. From v0.1.1 onward, entries are
generated automatically by
[semantic-release](https://github.com/semantic-release/semantic-release) from
[Conventional Commits](https://www.conventionalcommits.org). While the version
is `0.x`, a MINOR bump may include breaking changes (SemVer 0.x rule).

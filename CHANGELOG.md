# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

pi reads this file after a package update and shows the new entries under "Extension Updates",
so version headings must keep the `## [x.y.z]` form and match `version` in `package.json`.

## [1.0.0] - 2026-11-23

First release as a pi package. Renamed from `pi-bell-on-settle` to `pi-bells`; the two bell
channels behave exactly as in 0.2.0.

### Added

- `pi` manifest (`pi.extensions`) and the `pi-package` keyword, so the project installs with
  `pi install npm:pi-bells` / `pi install git:github.com/miscellaneous-repo/pi-bells` and can be
  discovered by the pi package gallery.
- Type checking (`tsc --noEmit`) and lint/format (Biome) with `npm run check`.
- CI workflow (Node 22/24, Linux + Windows) and a prepared, opt-in release workflow.
- `CONTRIBUTING.md`, `SECURITY.md`, issue templates, `CHANGELOG.md`.
- English source comments, English `README.md`, Chinese translation `README.zh-CN.md`.

### Changed

- Package name: `pi-bells`; extension file: `pi-bells.ts` (was `bell-on-settle.ts`).
- Default log file: `%TEMP%/pi-bells.log` (was `%TEMP%/pi-bell-on-settle.log`); `PI_BELL_LOG`
  still overrides it.
- Shared cross-instance state key: `__piBells__` (was `__piBellOnSettle__`).

### Unchanged

- Environment variables: `PI_BELL_DISABLE`, `PI_BELL_MIN_INTERVAL_MS`, `PI_BELL_APPROVAL_DISABLE`,
  `PI_BELL_APPROVAL_MIN_INTERVAL_MS`, `PI_BELL_LOG`.
- All gates, throttle behaviour and log line formats.

## [0.2.0] - 2026-11-22

### Added

- Second channel — the approval bell: `pi.events.on("pi-permission-system:permission-request")`,
  ringing only while `state === "waiting"` (verified against `pi-permission-system` 0.8.0).
- Independent throttle bucket for the approval bell (`lastApprovalBell`), so it cannot swallow
  the settle bell that follows a few seconds later.
- Process-wide `ctx.mode` cache (`session_start` / `agent_settled`), because `pi.events` handlers
  receive no context.
- `PI_BELL_APPROVAL_DISABLE` and `PI_BELL_APPROVAL_MIN_INTERVAL_MS`; `approval=` field on the
  `loaded:` log line; `bell approval:` / `skip approval:` log lines.
- `test/` (17 cases) and `package.json` with `npm test`.

## [0.1.0] - 2026-11-20

### Added

- `agent_settled` → BEL, with `mode` / `aborted` / `isIdle` gates, a shared two-second throttle,
  cross-instance state on `globalThis`, and a size-capped log file.

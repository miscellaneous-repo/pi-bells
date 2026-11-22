# pi-bells

Two bells for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent):

- **settle bell** — pi stopped and is waiting for your input
- **approval bell** — a permission dialog is waiting for Allow / Reject

[![CI](https://github.com/miscellaneous-repo/pi-bells/actions/workflows/ci.yml/badge.svg)](https://github.com/miscellaneous-repo/pi-bells/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-bells.svg)](https://www.npmjs.com/package/pi-bells)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
[![pi-package](https://img.shields.io/badge/pi-package-6f42c1.svg)](https://pi.dev/packages)

pi ships no "done" bell: every `\x07` in its source is an OSC terminator (title, OSC 133 shell
marks, OSC 52 clipboard), and `TerminalSettingsSchema` has no bell option. This extension adds the
missing piece with the most standard mechanism available — it writes a single `0x07` to its own
stdout and lets the terminal decide what that sounds like.

```text
pi (TUI process) ──stdout──► Windows Terminal ──bellStyle/bellSound──► 🔊
        ▲
        ├── agent_settled                    (settle)
        └── permission-request: waiting      (approval)
```

One file, no runtime dependencies, loaded straight from TypeScript by pi's built-in type stripping.

## Contents

- [Install](#install)
- [Verify](#verify)
- [The approval bell](#the-approval-bell)
- [Tests](#tests)
- [Sound is a terminal setting](#sound-is-a-terminal-setting)
- [Configuration](#configuration)
- [Why these gates](#why-these-gates)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Known limitations](#known-limitations)
- [Appendix: why a tool cannot emit BEL](#appendix-why-a-tool-cannot-emit-bel)
- [Project layout](#project-layout)
- [License](#license)

## Install

As a pi package (recommended — pi keeps it up to date and can show its changelog):

```bash
pi install git:github.com/miscellaneous-repo/pi-bells        # works today
pi install npm:pi-bells                                      # once published to npm
```

Or copy the single file. pi discovers extensions in two places (`<CONFIG_DIR>` is `.pi`):

| Location | Scope | Trust required |
| --- | --- | --- |
| `<cwd>/.pi/extensions/` | this project only | **yes** — pi asks `Trust project folder?` on restart |
| `<agentDir>/extensions/` | global (recommended) | no — global extensions load before the trust check |

`<agentDir>` is `~/.pi` by default and can be overridden with `PI_CODING_AGENT_DIR`.

```powershell
Copy-Item .\pi-bells.ts "$env:USERPROFILE\.pi\extensions\" -Force
```

Then `/reload` for a global copy, or restart pi (not `/reload`) for a project copy so the trust
prompt can appear.

## Verify

1. `/reload`, then send any message.
2. When the answer ends you should hear one bell **from pi's own pane** — no new window.
3. Let pi run something your policy marks `ask` (for example `rm` on a scratch file); the approval
   dialog should ring as it appears.
4. Read the log:

```powershell
Get-Content "$env:TEMP\pi-bells.log" -Tail 20
```

A healthy log looks like this (every line carries a pid, so delegated sub-processes are
distinguishable):

```text
2026-11-20T17:09:28.790Z [pid 28176] loaded: instance=1 minInterval=2000ms disabled=false approval=on(2000ms) tty=true mode=(n/a)
2026-11-20T17:09:41.200Z [pid 28176] bell
2026-11-20T17:09:43.050Z [pid 28176] bell approval: tool=bash what=rm temp/scratch.txt source=tool_call
2026-11-20T17:09:46.510Z [pid 39204] skip: mode=json
```

## The approval bell

The second channel rings when pi opens a permission dialog and waits for **Allow Once / Allow
Always / Reject / Reject with Reason**.

Source: [`pi-permission-system`](https://www.npmjs.com/package/pi-permission-system) (verified with
0.8.0). When a `tool_call` matches an `ask` policy (`rm`, `rmdir`, `Remove-Item`, `rimraf`,
`-delete`, `unlink`, `shred`, `wipe` … with `yoloMode: false`), it emits an event *before* opening
`ui.select(...)`:

```ts
// pi-permission-system internals: src/index.ts
pi.events.emit("pi-permission-system:permission-request", { state: "waiting", toolName, command, path, … });
//                                                     ↑ later also "approved" / "denied"
```

This extension subscribes to that shared bus channel and rings **only on `state === "waiting"`**:

```ts
pi.events.on("pi-permission-system:permission-request", (data) => {
  if (data?.state !== "waiting") return;   // approved / denied / yolo auto-approval stay silent
  if (state.mode !== "tui") return;        // like the settle bell: json/print sub-processes are silent
  process.stdout.write("\x07");
});
```

`waiting` is emitted *before* the dialog appears, so the ring and the dialog land together.

### Why this channel instead of pi's own `ui_prompt_start`

pi 1.6 does have a native `ui_prompt_start` event (`kind: select | confirm | input | editor |
custom`) that fires for every blocking `ctx.ui.*` prompt. The trade-off:

| | `pi-permission-system:permission-request` (used here) | `ui_prompt_start` |
| --- | --- | --- |
| Coverage | approvals only — exactly the ask | every blocking prompt: plan mode, `pi-pwsh` `Request-PiConfirmation`, timed-confirm … |
| Precision | carries `toolName` / `command` / `path`; no text matching | needs `kind === "select" && title.startsWith("Permission Required")` style filtering |
| Stability | an **internal** channel of that package, undocumented by pi | native to pi, documented |
| Failure mode | goes quiet after an upgrade or removal (log simply lacks `bell approval`) | fires less often |

If you want "ring for any prompt that wants me", add a `ui_prompt_start` handler — the two
approaches coexist fine.

### Forwarded sub-agent approvals

A sub-agent spawned by `acp_delegate` has `hasUI === false`: it writes the request to a file and the
parent polls for it, so the child never opens a dialog (and could never ring anyway — `mode` gates
it out). The parent opens `Permission Required (Subagent)` and emits `waiting`, so the parent pane
rings. That is the desired behaviour.

### Two implementation details

1. **Separate throttle bucket.** The approval bell has its own counter (`lastApprovalBell`). Sharing
   one bucket would let an approval bell swallow the settle bell that follows a few seconds later.
2. **The mode is cached.** `pi.events` handlers are `(data) => void` — they get no ctx, hence no
   `ctx.mode`. The extension records the mode from `session_start` / `agent_settled` in shared state
   (`/reload` re-emits `session_start` with `reason: "reload"`, so the cache survives). An empty
   cache stays silent (`skip approval: mode=undefined`).

## Tests

```bash
npm test      # node --test test/pi-bells.test.mts
npm run check # lint + typecheck + tests (what CI runs)
```

The 17 stub cases cover both channels: triggers, every gate (`aborted` / `isIdle` / `mode`), the
independent buckets, duplicate instances after `/reload`, `approved` / `denied` silence, and all
environment variables. Tests stub `pi.on` / `pi.events.on`, patch `process.stdout.write` to swallow
only BELs, and re-import the module per scenario with a `?case=` query string because environment
variables are read at import time.

Node **>= 22.6** is required (22.6–22.17 need `--experimental-strip-types`; 22.18+ and 24 run `.ts`
directly).

Stub tests prove the *logic* — "does it ring when it should" still deserves one manual smoke test.

## Sound is a terminal setting

The extension only emits a character. Whether that makes noise, and what noise, is terminal config.

### Windows Terminal

In `settings.json`:

```jsonc
"profiles": {
  "defaults": {
    "bellStyle": ["audible", "taskbar"]     // audible = sound, taskbar = flash the taskbar
  },
  "list": [
    {
      "name": "PowerShell",
      "bellStyle": ["audible", "window", "taskbar"],
      "bellSound": [
        "C:\\Windows\\Media\\Windows Notify Email.wav",
        "C:\\Windows\\Media\\Windows Notify Calendar.wav"
      ]
    }
  ]
}
```

Notes:

- `bellSound` above is set on one profile only, so the other profiles use the system default sound.
  Move it into `profiles.defaults` to apply it everywhere.
- `bellSound` is an **array**; Windows Terminal picks one at random per BEL.
- Without `audible` in `bellStyle` it is always silent (taskbar flashing only).
- In the GUI: Settings → profile → Appearance → Bell.

### Other terminals

| Terminal | Behaviour |
| --- | --- |
| Linux / macOS terminals | usually the system beep; iTerm2 has its own bell settings |
| tmux / screen | may be forwarded or dropped — `set -g bell-action any` |
| VS Code integrated terminal | `terminal.integrated.enableBell` |
| kitty / WezTerm | support OSC 99 / OSC 777 notifications; this extension sends a bare BEL, which is unaffected |

No OSC 777/99 rich notifications here: Windows Terminal ignores them, and a bare BEL is the only
reliable channel.

## Configuration

All optional; `/reload` after changing one.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_BELL_DISABLE` | unset | `1` = loaded but never rings (both channels) |
| `PI_BELL_APPROVAL_DISABLE` | unset | `1` = silence the approval bell only |
| `PI_BELL_MIN_INTERVAL_MS` | `2000` | settle-bell throttle window; `0` disables throttling (Windows Terminal will drop bells) |
| `PI_BELL_APPROVAL_MIN_INTERVAL_MS` | same as above | approval-bell window (separate bucket) |
| `PI_BELL_LOG` | `%TEMP%\pi-bells.log` | log path; `off` disables logging |

```powershell
$env:PI_BELL_DISABLE = '1'                 # current session
setx PI_BELL_MIN_INTERVAL_MS 3000          # persistent (new terminals only)
```

One log line per bell or skip; the file is truncated in place past 256 KB. Logging failures are
swallowed and never affect the bell.

## Why these gates

1. **`ctx.mode === "tui"`** — a sub-agent from `acp_delegate` is a real pi child process and loads
   global extensions too (`buildChildArgs` never passes `--no-extensions`), but it runs
   `--mode json` / `-p` with a piped stdout: a BEL there is inaudible and corrupts the JSONL stream.
   Note that `hasUI` is also `true` under RPC, so it cannot be used for this.
2. **`aborted` stays silent** — you pressed Esc; you were already looking.
3. **`ctx.isIdle() === false` stays silent** — queued work (for example a `deliverAs: "steer"`
   delegate notification) runs immediately, so pi is not waiting for you. Only an explicit `false`
   skips; a missing function is ignored.
4. **A shared throttle window (2 s)** — the Windows Terminal audible bell plays a 1–2 s wav and
   silently drops BELs that arrive meanwhile (four BELs 600 ms apart produced two sounds).
5. **Throttle state on `globalThis`** — "a loaded extension cannot be unloaded", so `/reload`
   creates a second instance whose handlers stay on the bus. A shared `lastBell` collapses them into
   one bell. Deliberately no `installed` flag: if pi ever discards a freshly registered instance,
   a flag would silence the extension forever, while a shared window merely rings once.
6. **Approval bell only on `state === "waiting"`** — the same request also emits `approved` /
   `denied` (yolo auto-approval emits `approved` without any dialog).
7. **The approval bell ignores `aborted` / `isIdle`** — those gates are for the settle path. An
   approval happens mid-run, where `isIdle()` is always `false` and `agent_settled` never fires;
   applying them would silence the approval bell forever.

## Troubleshooting

| Log line | Meaning |
| --- | --- |
| `bell` | the settle bell fired |
| `bell approval: tool=… what=…` | an approval dialog is waiting for you |
| `loaded` but never `bell` | no events arrived (pi version, or never reloaded) |
| `bell` but never `bell approval` | approval channel inactive: package missing/renamed, or the dialog was not from `pi-permission-system` |
| nothing at all | the file was not loaded (path, or the project is not trusted) |
| `loaded: instance=2` | loaded twice (normal after `/reload`); the shared window still rings once |
| `loaded: tty=` not `true` | diagnostics: pi's stdout is not a terminal, so nothing could be heard |
| `approval=off` | `PI_BELL_APPROVAL_DISABLE` is set |
| `skip: mode=json` / `print` | a delegated sub-agent settled — correctly skipped |
| `skip: throttle gap=…` | second settle inside the window — normal |
| `skip approval: throttle gap=…` | two approval prompts within 2 s (e.g. `Reject with Reason` then an input box) — normal |
| `skip approval: mode=undefined` | approval arrived before `session_start` — conservative silence |
| `skip: aborted` | you interrupted with Esc — normal |
| `skip: not idle (work already queued)` | queued work is about to run — normal |
| `--- log rotated ---` | the log passed 256 KB and was reset — normal |

| Symptom | Check |
| --- | --- |
| `bell` in the log but no sound | `bellStyle` contains `audible`; `bellSound` on the *current* profile; system volume; try the `PowerShell` profile |
| Never any `bell` | `skip: mode=` → gated; nothing at all → not loaded (path / trust) |
| Approval silent, settle fine | the dialog was not from `pi-permission-system` (e.g. `pi-pwsh` `Request-PiConfirmation`, plan mode); package not loaded (`packages` in `settings.json`); `skip approval: PI_BELL_APPROVAL_DISABLE`; `skip approval: mode=undefined` → restart pi |
| Rings twice | an old copy without shared throttle — update the file, `/reload` |
| Approval bells too noisy | `PI_BELL_APPROVAL_DISABLE=1`, or raise `PI_BELL_APPROVAL_MIN_INTERVAL_MS` |
| Too frequent in general | raise `PI_BELL_MIN_INTERVAL_MS` |
| Want it while unfocused | `audible` keeps working in the background; if Focus Assist suppresses it, allow-list Windows Terminal |

## Uninstall

```powershell
pi remove git:github.com/miscellaneous-repo/pi-bells   # package install
Remove-Item "$env:USERPROFILE\.pi\extensions\pi-bells.ts"   # manual copy
```

Then `/reload`. An already-loaded instance cannot be unloaded inside the current process — restart
pi for a clean slate.

## Known limitations

- **TUI only.** `--mode json` / `-p` / RPC runs stay silent by design.
- **The approval bell depends on an internal event** of `pi-permission-system`
  (`pi-permission-system:permission-request`, verified with 0.8.0). If that channel is renamed or
  removed the approval bell goes quiet; the settle bell is unaffected. Symptom: `loaded: … approval=on(…)`
  with no `bell approval` ever.
- **Only `pi-permission-system` approvals ring.** Other blocking prompts do not: `pi-pwsh`
  `Request-PiConfirmation` / `Request-PiSelection` / `Request-PiInput`, plan-mode option lists,
  `timed-confirm`. Add `pi.on("ui_prompt_start", …)` on top to cover everything.
- **No success/failure distinction.** `agent_settled` is a boundary event with no result. Use
  `agent_end` message state if you need that.
- **No separate delegate bell.** Every settle rings. A dedicated sub-agent bell would need
  `pi.subagents.notifyStructured: true` and a listener for `customType:
  "billion-context:delegate-notification"` — a different implementation, not included here.
- **BEL is a terminal mechanism**, so it cannot reach the notification centre or system toasts. For
  desktop notifications see the `notify.ts` pattern (PowerShell toast / OSC 777).

## Appendix: why a tool cannot emit BEL

Trying to "preview" the bell with a shell command cannot work — two layers block it:

1. **A tool's stdout is not a TTY.** It is a pipe captured by pi (`GetConsoleWindow() = 0`; the
   process list contains only itself). `[Console]::Out.Write([char]7)`, `Write-Host`, writing to
   `CONOUT$` and `WriteConsoleW` all fail to reach your pane.
2. **Control characters are stripped.** `pi-coding-agent/dist/utils/shell.js`:

   ```js
   str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "")   // 0x07 is in range
   ```

   `[Console]::Out.Write("A" + [char]7 + "B")` renders as `AB`.

Only pi's own render path — or an extension writing `process.stdout` directly — can make a sound.
The log plus a real settle is the only faithful verification.

Also worth distinguishing:

```powershell
[Console]::Beep(800, 200)        # system beep: bypasses terminal config, ignores bellSound
[Console]::Out.Write([char]7)    # BEL to the terminal: goes through bellStyle / bellSound
```

This extension uses the latter.

## Project layout

```text
pi-bells.ts                 the extension (single file, zero runtime dependencies)
test/pi-bells.test.mts      17 stub-based behaviour tests
package.json                pi manifest + dev tooling (pi only reads the `pi` key)
tsconfig.json               type checking only (no build, no emit)
biome.json                  formatting and lint rules
CHANGELOG.md                Keep a Changelog; pi shows these entries after an update
docs pages: README.md, README.zh-CN.md, CONTRIBUTING.md, SECURITY.md, LICENSE
```

Installing by hand means copying **one** file: `pi-bells.ts`.

## License

Copyright (C) 2026 Aquilonar

GNU General Public License v3.0 or later — see [LICENSE](LICENSE). In short: use, modify and
redistribute freely; if you distribute a modified version, it must stay GPL-3.0 and keep the
copyright and warranty notices.

See [CHANGELOG.md](CHANGELOG.md) for the version history, and [README.zh-CN.md](README.zh-CN.md)
for the Chinese version of this document.

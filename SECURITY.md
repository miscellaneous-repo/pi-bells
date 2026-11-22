# Security

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | yes |
| 0.x | no (superseded by 1.0.0, same behaviour) |

## What this extension does

Worth knowing before you install it — the whole point of an extension is that it runs inside your
pi process:

- Subscribes to `agent_settled`, `session_start` and (through `pi.events`) the channel
  `pi-permission-system:permission-request`.
- Writes a single `\u0007` byte to stdout when it decides to ring.
- Appends log lines (including the pid, the tool name and a truncated command/path of a pending
  approval) to `%TEMP%\pi-bells.log`, or to `$PI_BELL_LOG`. The file is truncated past 256 KB;
  it is never uploaded anywhere.
- Reads these environment variables: `PI_BELL_DISABLE`, `PI_BELL_MIN_INTERVAL_MS`,
  `PI_BELL_APPROVAL_DISABLE`, `PI_BELL_APPROVAL_MIN_INTERVAL_MS`, `PI_BELL_LOG`, `PI_MODE`.
- Has no network access, spawns no processes, and ships no runtime dependencies.

The approval channel is an **undocumented internal channel** of the third-party
`pi-permission-system` package. It is used read-only; if that package is absent or changes the
channel name, the approval bell simply goes quiet. Nothing else depends on it.

## Reporting a vulnerability

Please use GitHub's private reporting — [Security advisories](https://github.com/miscellaneous-repo/pi-bells/security/advisories/new)
— rather than a public issue. Include the version, your terminal, and the log lines around the
event. Expect an initial reply within a week.

## Scope notes

- The extension is a terminal-level notification. It deliberately does not touch notification
  centers, system toasts or any privileged API.
- Log output can contain fragments of commands and file paths. Set `PI_BELL_LOG=off` (or redirect
  it somewhere you control) if that matters in your environment.

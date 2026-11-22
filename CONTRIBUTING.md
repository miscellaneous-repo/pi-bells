# Contributing

Thanks for taking a look. This is a small, deliberately dependency-free extension, so the bar
for adding code is "it earns its keep".

## Requirements

- Node.js **>= 22.6** (22.6–22.17 need `--experimental-strip-types`; 22.18+ and 24 run `.ts` directly)
- pi **1.6 or newer** if you want to exercise the approval bell

## Set up

```bash
git clone https://github.com/miscellaneous-repo/pi-bells.git
cd pi-bells
npm install
npm run check     # lint + typecheck + tests — this is what CI runs
```

## Try a change in a real pi session

The extension is a single file, which makes local testing cheap:

```powershell
# Load one specific file, without installing it (fastest loop)
pi -e .\pi-bells.ts

# Or copy it into the global extensions directory and /reload
Copy-Item .\pi-bells.ts "$env:USERPROFILE\.pi\extensions\" -Force
```

Watch the log while you test:

```powershell
Get-Content "$env:TEMP\pi-bells.log" -Tail 20 -Wait
```

Stub tests prove the *logic* (when it rings, when it stays silent). Whether a BEL is audible is
a terminal matter, so every change to a gate deserves one manual smoke test in a real TUI.

## Style

- `npm run format` (Biome) — tabs, double quotes, 120 columns. Do not hand-format.
- `npm run lint` and `npm run typecheck` must be clean; the config is strict on purpose
  (the extension runs inside someone else's process, so sloppy types are expensive).
- No new runtime dependencies. `dependencies` must stay empty; dev tooling only.
- Comments explain *why* a gate exists, not what the line does.

## Adding a bell channel

A channel is small, but it has to be justified — a bell that fires too often is worse than none.

1. Pick a signal that means "pi is blocked on you" (must ring) or "a long job finished" (may ring).
2. Add the handler, with its own gate list and its own throttle bucket if it can fire close to an
   existing channel.
3. Add stub tests for: rings once, stays silent in `json`/`print` mode, stays silent when
   disabled, and does not swallow the other channel.
4. Update `README.md` / `README.zh-CN.md` ("Troubleshooting" + "Known limitations") and
   `CHANGELOG.md`.

## Commits and pull requests

- Imperative subject line, e.g. `Add project-trust bell`.
- One topic per pull request; include the log lines you saw in a real session.
- Update `CHANGELOG.md` under `## [Unreleased]` (add the heading if it is missing).
- By contributing you agree your work is licensed under GPL-3.0-or-later.

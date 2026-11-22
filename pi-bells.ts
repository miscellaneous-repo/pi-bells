// pi-bells — a pi extension that writes a BEL (0x07) to the terminal when pi
// is actually waiting for you:
//
//   A. agent_settled                      — the run finished, pi is idle
//   B. pi-permission-system approval      — a dialog is waiting for Allow/Reject
//
// The extension only emits the character; the terminal decides whether and how
// it sounds (Windows Terminal: profile `bellStyle` / `bellSound`).
//
// Channel A gates (see README "Why these gates"):
//   1. ctx.mode must be "tui" — only the main TUI process owns a real terminal.
//      Delegated sub-agents load global extensions too, but run with
//      --mode json / -p and their stdout is a captured pipe: a BEL there is
//      inaudible and would corrupt the JSONL event stream.
//   2. aborted (Esc) stays silent — you were already looking at the screen.
//   3. ctx.isIdle() === false stays silent — more queued work is about to run,
//      so pi is not really waiting for you.
//   4. A shared throttle window (2s by default) — Windows Terminal plays a 1–2s
//      wav and silently drops BELs that arrive while it is playing.
//      The throttle state lives on globalThis because pi cannot unload a loaded
//      extension: /reload creates a new instance whose handlers coexist with the
//      old ones, so both must share one budget to collapse into a single bell.
//
// Channel B gates differ:
//   1. mode must be "tui" as well, but pi.events handlers receive no ctx, so the
//      mode is cached from session_start / agent_settled in shared state (mode is
//      constant per process; /reload re-emits session_start with reason "reload").
//   2. Only state === "waiting" rings — "approved" / "denied" (including yolo
//      auto-approval) stay silent.
//   3. aborted / isIdle do not apply: an approval happens mid-run, when pi is
//      never idle and agent_settled never fires.
//   4. A separate throttle bucket (lastApprovalBell) so an approval bell cannot
//      swallow the settle bell that follows a few seconds later.
//
// Environment variables (all optional):
//   PI_BELL_DISABLE=1                 load, but never ring (both channels)
//   PI_BELL_MIN_INTERVAL_MS=2000      settle-bell throttle window, 0 = no throttle
//   PI_BELL_APPROVAL_DISABLE=1        disable the approval bell only
//   PI_BELL_APPROVAL_MIN_INTERVAL_MS  approval-bell window, defaults to the above
//   PI_BELL_LOG=<path>|off            log location, default %TEMP%/pi-bells.log
//
// Logging: one line per bell or skip, with the pid (so delegated sub-processes are
// distinguishable). The file is truncated in place past 256 KB and never grows
// without bound.

import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GLOBAL_KEY = "__piBells__";
const DEFAULT_MIN_INTERVAL_MS = 2000;
const LOG_MAX_BYTES = 256 * 1024;
const BELL = "\u0007";

/** Internal event channel of pi-permission-system (undocumented by pi; see README). */
const PERMISSION_EVENT_CHANNEL = "pi-permission-system:permission-request";

/** Shared across instances: /reload creates a new instance while the old handlers stay registered. */
interface BellState {
	instances: number;
	lastBell: number;
	/** Separate throttle bucket for the approval bell. */
	lastApprovalBell: number;
	/** Process-wide mode cache (pi.events handlers get no ctx). */
	mode?: string;
}

interface ExtensionContextLike {
	mode?: string;
	isIdle?: () => boolean;
}

interface ExtensionEventLike {
	aborted?: boolean;
}

/** Payload emitted by pi-permission-system (only the fields we use). */
interface PermissionRequestEventLike {
	state?: string;
	source?: string;
	toolName?: string;
	command?: string;
	path?: string;
	target?: string;
	agentName?: string;
}

interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): (() => void) | undefined;
}

interface PiLike {
	on(event: "agent_settled", handler: (event: ExtensionEventLike, ctx: ExtensionContextLike) => void): void;
	on(event: "session_start", handler: (event: unknown, ctx: ExtensionContextLike) => void): void;
	events?: EventBusLike;
}

function envFlag(name: string): boolean {
	const value = process.env[name];
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const LOG_TARGET = process.env.PI_BELL_LOG ?? join(tmpdir(), "pi-bells.log");
const LOG_ENABLED = LOG_TARGET !== "" && !["off", "0", "false"].includes(LOG_TARGET.toLowerCase());
const MIN_INTERVAL_MS = envInt("PI_BELL_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS);
const DISABLED = envFlag("PI_BELL_DISABLE");
const APPROVAL_DISABLED = envFlag("PI_BELL_APPROVAL_DISABLE");
const APPROVAL_MIN_INTERVAL_MS = envInt("PI_BELL_APPROVAL_MIN_INTERVAL_MS", MIN_INTERVAL_MS);

let logWrites = 0;

function log(line: string): void {
	if (!LOG_ENABLED) return;
	try {
		appendFileSync(LOG_TARGET, `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`);
		// Check the size every 200 lines and reset the file when it is too big.
		if (++logWrites % 200 === 0 && statSync(LOG_TARGET).size > LOG_MAX_BYTES) {
			writeFileSync(
				LOG_TARGET,
				`${new Date().toISOString()} [pid ${process.pid}] --- log rotated (> ${LOG_MAX_BYTES} bytes) ---\n`,
			);
		}
	} catch {
		/* a logging failure must never affect the bell */
	}
}

export default function piBells(pi: PiLike): void {
	const shared = globalThis as unknown as Record<string, BellState | undefined>;
	let state = shared[GLOBAL_KEY];
	if (!state) {
		state = { instances: 0, lastBell: 0, lastApprovalBell: 0 };
		shared[GLOBAL_KEY] = state;
	}
	// An older instance may have left a state object without the newer fields.
	if (typeof state.instances !== "number") state.instances = 0;
	if (typeof state.lastBell !== "number") state.lastBell = 0;
	if (typeof state.lastApprovalBell !== "number") state.lastApprovalBell = 0;
	state.instances += 1;

	/** Mode is constant per process; cache it for the pi.events handler, which gets no ctx. */
	const rememberMode = (ctx?: ExtensionContextLike): void => {
		if (ctx?.mode) state.mode = ctx.mode;
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			rememberMode(ctx);
		} catch {
			/* never affect the bell */
		}
	});

	pi.on("agent_settled", (event, ctx) => {
		try {
			rememberMode(ctx);

			if (DISABLED) {
				log("skip: disabled");
				return;
			}

			if (ctx?.mode !== "tui") {
				log(`skip: mode=${String(ctx?.mode)}`);
				return;
			}

			if (event?.aborted) {
				log("skip: aborted");
				return;
			}

			if (ctx.isIdle?.() === false) {
				log("skip: not idle (work already queued)");
				return;
			}

			const now = Date.now();
			const gap = now - state.lastBell;
			if (state.lastBell !== 0 && gap < MIN_INTERVAL_MS) {
				log(`skip: throttle gap=${gap}ms`);
				return;
			}

			state.lastBell = now;
			process.stdout.write(BELL);
			log("bell");
		} catch (error) {
			log(`error: ${String(error)}`);
		}
	});

	// ── Approval bell: ring when pi is waiting for an Allow/Reject click ───────
	if (!pi.events?.on) {
		log("approval: pi.events unavailable (pi too old?) — approval bell off");
	} else {
		pi.events.on(PERMISSION_EVENT_CHANNEL, (data) => {
			try {
				const payload = (data ?? {}) as PermissionRequestEventLike;
				// "approved" / "denied" / auto-approval stay silent: only the moment
				// where pi is waiting for your decision rings.
				if (payload.state !== "waiting") return;

				if (DISABLED) {
					log("skip approval: disabled");
					return;
				}

				if (APPROVAL_DISABLED) {
					log("skip approval: PI_BELL_APPROVAL_DISABLE");
					return;
				}

				// pi.events handlers get no ctx: use the cached mode so json/print
				// sub-processes stay silent.
				if (state.mode !== "tui") {
					log(`skip approval: mode=${String(state.mode)}`);
					return;
				}

				const now = Date.now();
				const gap = now - state.lastApprovalBell;
				if (state.lastApprovalBell !== 0 && gap < APPROVAL_MIN_INTERVAL_MS) {
					log(`skip approval: throttle gap=${gap}ms`);
					return;
				}

				state.lastApprovalBell = now;
				process.stdout.write(BELL);
				log(`bell approval: ${describePermission(payload)}`);
			} catch (error) {
				log(`error approval: ${String(error)}`);
			}
		});
	}

	log(
		`loaded: instance=${state.instances} minInterval=${MIN_INTERVAL_MS}ms disabled=${DISABLED} ` +
			`approval=${APPROVAL_DISABLED ? "off" : `on(${APPROVAL_MIN_INTERVAL_MS}ms)`} ` +
			`tty=${String(process.stdout.isTTY)} mode=${String(process.env.PI_MODE ?? "(n/a)")}`,
	);
}

/** Describe an approval request for the log: tool name plus command/path (truncated). */
function describePermission(payload: PermissionRequestEventLike): string {
	const parts: string[] = [];
	if (payload.toolName) parts.push(`tool=${payload.toolName}`);
	const detail = payload.command ?? payload.path ?? payload.target;
	if (typeof detail === "string" && detail.trim() !== "") parts.push(`what=${truncate(detail, 100)}`);
	if (payload.agentName) parts.push(`agent=${payload.agentName}`);
	if (payload.source) parts.push(`source=${payload.source}`);
	return parts.length > 0 ? parts.join(" ") : "(no details)";
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

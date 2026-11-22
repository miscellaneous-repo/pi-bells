// Behaviour tests for pi-bells — pure stubs: no pi process, no real terminal.
//
// Run: npm test   (= node --test test/pi-bells.test.mts)
//
// How it works:
//   - A stub `pi` object (`on` / `events.on`) stands in for the event bus, so tests
//     fire agent_settled and pi-permission-system permission requests by hand.
//   - process.stdout.write is patched to swallow only BELs and forward everything
//     else, so the test runner's own report is not eaten.
//   - The extension reads its environment at import time, so each scenario reloads
//     it with a unique `?case=` query string; shared globalThis state is cleared
//     first, because instances intentionally reuse it.
//   - Skip reasons are only matched loosely (a key fragment), to keep the tests from
//     over-coupling to log wording.

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const MODULE_URL = new URL("../pi-bells.ts", import.meta.url).href;
const CHAN = "pi-permission-system:permission-request";

// ── stdout interception: swallow BELs only, forward the rest ─────────────────
const bells: string[] = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: any, ...rest: any[]) => {
	if (String(chunk) === "\u0007") {
		bells.push("\u0007");
		return true;
	}
	return (origWrite as any)(chunk, ...rest);
}) as any;
after(() => {
	process.stdout.write = origWrite as any;
});

const bellCount = () => bells.length;
const resetBells = () => {
	bells.length = 0;
};

// ── stub pi ─────────────────────────────────────────────────────────────────
interface Stub {
	pi: any;
	startSession(ctx: any): void;
	settle(ctx: any, event?: any): void;
	permission(payload: any): void;
}

function makePi(): Stub {
	const handlers = new Map<string, Array<(...a: any[]) => any>>();
	const bus = new Map<string, Array<(data: any) => any>>();
	const pi = {
		on(event: string, handler: (...a: any[]) => any) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		events: {
			on(channel: string, handler: (data: any) => any) {
				const list = bus.get(channel) ?? [];
				list.push(handler);
				bus.set(channel, list);
				return () => {};
			},
		},
	};
	const fire = (event: string, ...args: any[]) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};
	const emitBus = (channel: string, data: any) => {
		for (const handler of bus.get(channel) ?? []) handler(data);
	};
	return {
		pi,
		startSession: (ctx) => fire("session_start", { type: "session_start" }, ctx),
		settle: (ctx, event = {}) => fire("agent_settled", event, ctx),
		permission: (payload) => emitBus(CHAN, payload),
	};
}

const TUI = { mode: "tui", isIdle: () => true };
const JSON_MODE = { mode: "json", isIdle: () => true };

/** Re-evaluate the extension module for one scenario (env is read at import). */
async function load(
	tag: string,
	env: Record<string, string | undefined> = {},
): Promise<{ factory: (pi: any) => void; logPath: string; log: () => string }> {
	delete (globalThis as any).__piBells__;
	const logPath = join(tmpdir(), `pi-bells-test-${tag}-${process.pid}.log`);
	rmSync(logPath, { force: true });
	// Defaults first, so a caller can still override any of them (including PI_BELL_LOG).
	const full: Record<string, string | undefined> = {
		PI_BELL_DISABLE: undefined,
		PI_BELL_APPROVAL_DISABLE: undefined,
		PI_BELL_MIN_INTERVAL_MS: undefined,
		PI_BELL_APPROVAL_MIN_INTERVAL_MS: undefined,
		PI_BELL_LOG: logPath,
		...env,
	};
	for (const [key, value] of Object.entries(full)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const module = await import(`${MODULE_URL}?case=${tag}-${Date.now()}`);
	resetBells();
	return {
		factory: module.default,
		logPath,
		log: () => {
			try {
				return readFileSync(logPath, "utf8");
			} catch {
				return "";
			}
		},
	};
}

// ── settle bell ─────────────────────────────────────────────────────────────
test("settle: rings once in TUI mode", async () => {
	const { factory } = await load("settle");
	const pi = makePi();
	factory(pi.pi);
	assert.equal(bellCount(), 0, "loading must not ring");
	pi.startSession(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 1);
});

test("settle: a second settle inside the throttle window stays silent", async () => {
	const { factory } = await load("settle-throttle");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 1);
});

test("settle: aborted (Esc) stays silent", async () => {
	const { factory } = await load("settle-aborted");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI, { aborted: true });
	assert.equal(bellCount(), 0);
});

test("settle: queued work (isIdle=false) stays silent", async () => {
	const { factory } = await load("settle-busy");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle({ mode: "tui", isIdle: () => false });
	assert.equal(bellCount(), 0);
});

test("settle: json/print sub-process stays silent", async () => {
	const { factory, log } = await load("settle-json");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(JSON_MODE);
	pi.settle(JSON_MODE);
	assert.equal(bellCount(), 0);
	assert.match(log(), /skip: mode=json/);
});

// ── approval bell ───────────────────────────────────────────────────────────
test("approval: rings on waiting and logs tool plus command", async () => {
	const { factory, log } = await load("approval");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm -rf build", source: "tool_call" });
	assert.equal(bellCount(), 1);
	assert.match(log(), /bell approval: tool=bash what=rm -rf build source=tool_call/);
});

test("approval: approved / denied stay silent (only waiting rings)", async () => {
	const { factory } = await load("approval-states");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "approved", toolName: "bash" });
	pi.permission({ state: "denied", toolName: "bash" });
	assert.equal(bellCount(), 0);
});

test("approval: separate throttle bucket — settle just rang, approval still rings", async () => {
	const { factory } = await load("approval-bucket");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 1);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	assert.equal(bellCount(), 2, "a shared bucket would have made this 1");
});

test("approval: two requests in one window ring once (e.g. Reject with Reason input)", async () => {
	const { factory, log } = await load("approval-throttle");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm a" });
	pi.permission({ state: "waiting", toolName: "bash", command: "rm b" });
	assert.equal(bellCount(), 1);
	assert.match(log(), /skip approval: throttle gap=/);
});

test("approval: json sub-process stays silent (cached mode)", async () => {
	const { factory, log } = await load("approval-json");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(JSON_MODE);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	assert.equal(bellCount(), 0);
	assert.match(log(), /skip approval: mode=json/);
});

test("approval: no session_start yet — stays silent out of caution", async () => {
	const { factory, log } = await load("approval-nomode");
	const pi = makePi();
	factory(pi.pi);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	assert.equal(bellCount(), 0);
	assert.match(log(), /skip approval: mode=undefined/);
});

test("repeated load (/reload leaves the old instance on the bus) rings once", async () => {
	const { factory } = await load("reload");
	const first = makePi();
	const second = makePi();
	factory(first.pi);
	factory(second.pi);
	first.startSession(TUI);
	second.startSession(TUI);
	first.settle(TUI);
	second.settle(TUI);
	assert.equal(bellCount(), 1);
});

// ── environment variables ───────────────────────────────────────────────────
test("PI_BELL_APPROVAL_DISABLE=1 disables the approval bell only", async () => {
	const { factory, log } = await load("off-approval", { PI_BELL_APPROVAL_DISABLE: "1" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	assert.equal(bellCount(), 0);
	assert.match(log(), /skip approval: PI_BELL_APPROVAL_DISABLE/);
	assert.match(log(), /approval=off/);
	pi.settle(TUI);
	assert.equal(bellCount(), 1, "the settle bell must keep working");
});

test("PI_BELL_DISABLE=1 disables both channels", async () => {
	const { factory } = await load("off-all", { PI_BELL_DISABLE: "1" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	pi.settle(TUI);
	assert.equal(bellCount(), 0);
});

test("PI_BELL_MIN_INTERVAL_MS=0 disables throttling", async () => {
	const { factory } = await load("no-throttle", { PI_BELL_MIN_INTERVAL_MS: "0" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI);
	pi.settle(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 3);
});

test("PI_BELL_APPROVAL_MIN_INTERVAL_MS applies to its own bucket", async () => {
	const { factory } = await load("approval-interval", { PI_BELL_APPROVAL_MIN_INTERVAL_MS: "0" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm a" });
	pi.permission({ state: "waiting", toolName: "bash", command: "rm b" });
	assert.equal(bellCount(), 2, "a zero window should ring both");
});

test("PI_BELL_LOG=off writes no log but still rings", async () => {
	const { factory, log } = await load("log-off", { PI_BELL_LOG: "off" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 1);
	assert.equal(log(), "", "the log file must not be created");
});

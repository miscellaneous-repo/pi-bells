// bell-on-settle 的行为测试 —— 纯桩，不启动 pi、不写真实终端。
//
// 跑法：npm test   （= node --test test/bell-on-settle.test.mts）
//
// 手法：
//   - 用 stub 的 pi 对象（on / events.on）模拟事件总线，手工触发 agent_settled 与
//     pi-permission-system 的 permission-request。
//   - 拦截 process.stdout.write，只吞掉 BEL、其余照常转发，所以测试报告不受影响。
//   - 扩展在 **import 时**读取环境变量，所以按场景用 `?case=` 查询串强制重新求值；
//     共享状态挂在 globalThis 上（跨实例复用），每个场景开始前手动清掉。
//   - 不 assert "什么时候不响" 的日志细节全覆盖，只查关键行，避免测试过度耦合文案。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE_URL = new URL("../bell-on-settle.ts", import.meta.url).href;
const CHAN = "pi-permission-system:permission-request";

// ── stdout 拦截：只吞 BEL，其余原样转发（否则 test runner 的报告会被吃掉）──────
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

// ── stub pi ───────────────────────────────────────────────────────────────────
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

/** 按场景重新求值扩展模块（环境变量在 import 时读取）。 */
async function load(
	tag: string,
	env: Record<string, string | undefined> = {},
): Promise<{ factory: (pi: any) => void; logPath: string; log: () => string }> {
	delete (globalThis as any).__piBellOnSettle__;
	const logPath = join(tmpdir(), `pi-bell-test-${tag}-${process.pid}.log`);
	rmSync(logPath, { force: true });
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

// ── 收尾铃 ────────────────────────────────────────────────────────────────────
test("收尾：TUI 下响一声", async () => {
	const { factory } = await load("settle");
	const pi = makePi();
	factory(pi.pi);
	assert.equal(bellCount(), 0, "加载时不该响");
	pi.startSession(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 1);
});

test("收尾：节流窗口内的第二次不响", async () => {
	const { factory } = await load("settle-throttle");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 1);
});

test("收尾：Esc 打断（aborted）不响", async () => {
	const { factory } = await load("settle-aborted");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI, { aborted: true });
	assert.equal(bellCount(), 0);
});

test("收尾：有排队工作（isIdle=false）不响", async () => {
	const { factory } = await load("settle-busy");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle({ mode: "tui", isIdle: () => false });
	assert.equal(bellCount(), 0);
});

test("收尾：json/print 子进程不响", async () => {
	const { factory, log } = await load("settle-json");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(JSON_MODE);
	pi.settle(JSON_MODE);
	assert.equal(bellCount(), 0);
	assert.match(log(), /skip: mode=json/);
});

// ── 审批铃 ────────────────────────────────────────────────────────────────────
test("审批：waiting 时响，并在日志里记下工具和命令", async () => {
	const { factory, log } = await load("approval");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm -rf build", source: "tool_call" });
	assert.equal(bellCount(), 1);
	assert.match(log(), /bell approval: tool=bash what=rm -rf build source=tool_call/);
});

test("审批：approved / denied 静默（只有 waiting 响）", async () => {
	const { factory } = await load("approval-states");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "approved", toolName: "bash" });
	pi.permission({ state: "denied", toolName: "bash" });
	assert.equal(bellCount(), 0);
});

test("审批：独立节流桶 —— 收尾铃刚响过，审批铃照常响", async () => {
	const { factory } = await load("approval-bucket");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 1);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	assert.equal(bellCount(), 2, "共用一个桶的话这里会是 1");
});

test("审批：同一窗口内的连续审批只响一次（如 Reject with Reason 的输入框）", async () => {
	const { factory, log } = await load("approval-throttle");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm a" });
	pi.permission({ state: "waiting", toolName: "bash", command: "rm b" });
	assert.equal(bellCount(), 1);
	assert.match(log(), /skip approval: throttle gap=/);
});

test("审批：json 子进程不响（mode 缓存生效）", async () => {
	const { factory, log } = await load("approval-json");
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(JSON_MODE);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	assert.equal(bellCount(), 0);
	assert.match(log(), /skip approval: mode=json/);
});

test("审批：没收到 session_start 时保守不响", async () => {
	const { factory, log } = await load("approval-nomode");
	const pi = makePi();
	factory(pi.pi);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	assert.equal(bellCount(), 0);
	assert.match(log(), /skip approval: mode=undefined/);
});

test("重复加载（/reload 后的旧实例仍在总线上）只响一声", async () => {
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

// ── 环境变量 ──────────────────────────────────────────────────────────────────
test("PI_BELL_APPROVAL_DISABLE=1 只关审批铃", async () => {
	const { factory, log } = await load("off-approval", { PI_BELL_APPROVAL_DISABLE: "1" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	assert.equal(bellCount(), 0);
	assert.match(log(), /skip approval: PI_BELL_APPROVAL_DISABLE/);
	assert.match(log(), /approval=off/);
	pi.settle(TUI);
	assert.equal(bellCount(), 1, "收尾铃必须照常");
});

test("PI_BELL_DISABLE=1 两条通道全关", async () => {
	const { factory } = await load("off-all", { PI_BELL_DISABLE: "1" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm x" });
	pi.settle(TUI);
	assert.equal(bellCount(), 0);
});

test("PI_BELL_MIN_INTERVAL_MS=0 关掉节流", async () => {
	const { factory } = await load("no-throttle", { PI_BELL_MIN_INTERVAL_MS: "0" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI);
	pi.settle(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 3);
});

test("PI_BELL_APPROVAL_MIN_INTERVAL_MS 独立生效", async () => {
	const { factory } = await load("approval-interval", { PI_BELL_APPROVAL_MIN_INTERVAL_MS: "0" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.permission({ state: "waiting", toolName: "bash", command: "rm a" });
	pi.permission({ state: "waiting", toolName: "bash", command: "rm b" });
	assert.equal(bellCount(), 2, "窗口设为 0 就该连响");
});

test("PI_BELL_LOG=off 不写日志但照常响", async () => {
	const { factory, log } = await load("log-off", { PI_BELL_LOG: "off" });
	const pi = makePi();
	factory(pi.pi);
	pi.startSession(TUI);
	pi.settle(TUI);
	assert.equal(bellCount(), 1);
	assert.equal(log(), "", "日志文件不该被创建");
});

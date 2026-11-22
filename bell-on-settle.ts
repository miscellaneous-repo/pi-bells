// bell-on-settle.ts — pi 扩展：agent 停稳后、或需要你 approve 时，向终端写一个 BEL (0x07)
//
// 作用：pi 真正停下来等你输入时，响一声。终端决定音色（Windows Terminal 由
//       profile 的 bellSound 决定；其它终端用系统默认提示音）。
//
// 两条触发通道：
//   A. agent_settled —— 一轮跑完、真正在等你输入（门控见下）
//   B. pi-permission-system 的审批请求 —— 需要你点 Allow/Reject 时
//      （监听共享事件总线上的 "pi-permission-system:permission-request"，
//       只在 state === "waiting" 的那一瞬响；用独立节流桶，不和 A 互相压制）
//
// 门控（见 README「为什么需要这些门控」）：
//   1. ctx.mode 必须是 "tui" —— 只有主 TUI 进程的 stdout 才是真终端；
//      delegate 子进程跑在 --mode json / -p 下，stdout 是被捕获的管道，
//      写 BEL 既听不到又会污染 JSONL 事件流。
//   2. Esc 打断(aborted) 不响 —— 你刚亲手操作过。
//   3. ctx.isIdle() === false 不响 —— 说明紧接着还有排队的工作，不是真正在等你。
//   4. 共享节流窗口（默认 2s）—— WT 的 audible bell 实际在播 1~2 秒的 wav，
//      播放期间到达的 BEL 会被静默丢弃，所以不能连发。
//      节流状态挂在 globalThis 上：pi 无法卸载已加载的扩展，/reload 会再创建
//      一份实例，用进程级共享状态让重复实例自然塌缩成一声，而不是各响一次。
//
// 审批通道（B）的门控与 A 不同：
//   1. ctx.mode 必须是 "tui" —— 同上。注意 pi.events 的 handler 拿不到 ctx，
//      所以 mode 从 session_start / agent_settled 的 ctx 缓存在共享状态里
//      （进程内 mode 恒定；reload 也会以 reason:"reload" 再发一次 session_start）。
//   2. 只看 state === "waiting" —— "approved"/"denied"（含 yolo 自动批准）不响。
//   3. 不适用 aborted / isIdle —— 审批发生在 agent 运行中途，那时永远不是 idle。
//   4. 用独立节流桶（lastApprovalBell），避免审批铃把紧随其后的收尾铃压掉。
//
// 可调参数（环境变量，全部可选）：
//   PI_BELL_DISABLE=1              加载但完全不响（两条通道都关）
//   PI_BELL_MIN_INTERVAL_MS=2000   收尾铃的节流窗口，0 = 不节流
//   PI_BELL_APPROVAL_DISABLE=1     只关掉“需要 approve 时响”这一条通道
//   PI_BELL_APPROVAL_MIN_INTERVAL_MS  审批铃的独立节流窗口，默认同上
//   PI_BELL_LOG=<path>|off         日志位置，默认 %TEMP%/pi-bell-on-settle.log，off 关闭
//
// 日志：每次触发/跳过写一行（带 pid，delegate 子进程的写入也能区分），
//       超过 256KB 自动轮转，不会无限增长。

import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GLOBAL_KEY = "__piBellOnSettle__";
const DEFAULT_MIN_INTERVAL_MS = 2000;
const LOG_MAX_BYTES = 256 * 1024;
const BELL = "\u0007";

/** pi-permission-system 的内部事件通道（未在 pi 文档中公布，见 README「审批铃」）。 */
const PERMISSION_EVENT_CHANNEL = "pi-permission-system:permission-request";

/** 跨实例共享：/reload 会产生新实例，但旧实例的 handler 仍挂在事件总线上。 */
interface BellState {
	instances: number;
	lastBell: number;
	/** 审批铃的独立节流桶。 */
	lastApprovalBell: number;
	/** 进程级 mode 缓存（pi.events 的 handler 拿不到 ctx）。 */
	mode?: string;
}

interface ExtensionContextLike {
	mode?: string;
	isIdle?: () => boolean;
}

interface ExtensionEventLike {
	aborted?: boolean;
}

/** pi-permission-system emit 的 payload（只取用得到的字段）。 */
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
	on(channel: string, handler: (data: unknown) => void): (() => void) | void;
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

const LOG_TARGET = process.env.PI_BELL_LOG ?? join(tmpdir(), "pi-bell-on-settle.log");
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
		// 每 200 行检查一次体积，超限就轮转（保留文件，不删）
		if (++logWrites % 200 === 0 && statSync(LOG_TARGET).size > LOG_MAX_BYTES) {
			writeFileSync(LOG_TARGET, `${new Date().toISOString()} [pid ${process.pid}] --- log rotated (> ${LOG_MAX_BYTES} bytes) ---\n`);
		}
	} catch {
		/* 日志失败绝不影响响铃 */
	}
}

export default function bellOnSettle(pi: PiLike): void {
	const shared = globalThis as unknown as Record<string, BellState | undefined>;
	const state: BellState = (shared[GLOBAL_KEY] ??= { instances: 0, lastBell: 0, lastApprovalBell: 0 });
	// 旧实例留下的共享状态可能缺新字段，归一化一次再自增。
	if (typeof state.instances !== "number") state.instances = 0;
	if (typeof state.lastBell !== "number") state.lastBell = 0;
	if (typeof state.lastApprovalBell !== "number") state.lastApprovalBell = 0;
	state.instances += 1;

	/** 进程内 mode 恒定，缓存给拿不到 ctx 的 pi.events handler 用。 */
	const rememberMode = (ctx?: ExtensionContextLike): void => {
		if (ctx?.mode) state.mode = ctx.mode;
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			rememberMode(ctx);
		} catch {
			/* 不影响响铃 */
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

	// ── 审批铃：需要你 approve 时响一声 ────────────────────────────────────────
	if (!pi.events?.on) {
		log("approval: pi.events unavailable (pi too old?) — approval bell off");
	} else {
		pi.events.on(PERMISSION_EVENT_CHANNEL, (data) => {
			try {
				const payload = (data ?? {}) as PermissionRequestEventLike;
				// approved / denied / 自动批准 都静默：只有“正在等你决定”的那一瞬要响。
				if (payload.state !== "waiting") return;

				if (DISABLED) {
					log("skip approval: disabled");
					return;
				}

				if (APPROVAL_DISABLED) {
					log("skip approval: PI_BELL_APPROVAL_DISABLE");
					return;
				}

				// pi.events handler 没有 ctx，用缓存的 mode（json/print 子进程必须挡掉）。
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

/** 日志里描述一次审批请求：工具名 + 命令/路径（截断，避免一行过长）。 */
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

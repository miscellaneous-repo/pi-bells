# pi-bells

给 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 补一声 `BEL`：

- **收尾响**：pi 停下来等你输入时
- **审批响**：pi 弹审批对话框等你点 Allow / Reject 时（`pi-permission-system` 的 `ask` 策略）

[English README](README.md) · [![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

pi 本身没有任何「完成响铃」实现 —— 源码里所有 `\x07` 都是 OSC 转义序列的终止符（设置标题、OSC 133 提示符标记、OSC 52 剪贴板等），终端不会因此发声；`TerminalSettingsSchema` 里也没有 bell 选项。这个扩展把这最后一块补上，用最标准的机制：往自己的 stdout 写一个 `0x07`，剩下的交给终端。

```text
pi（TUI 主进程） ──stdout──► Windows Terminal ──bellStyle/bellSound──► 🔊
        ▲
        ├── agent_settled                      （收尾）
        └── permission-request: waiting        （审批）
```

单文件、零运行时依赖、由 pi 内置的类型剥离直接加载 `.ts`。

## 目录

- [安装](#安装)
- [验证](#验证)
- [审批铃：需要你-approve-时响一声](#审批铃需要你-approve-时响一声)
- [测试](#测试)
- [配置：音色由终端决定](#配置音色由终端决定)
- [可调参数（环境变量）](#可调参数环境变量)
- [为什么需要这些门控](#为什么需要这些门控)
- [排错](#排错)
- [卸载](#卸载)
- [已知限制](#已知限制)
- [附：为什么不能从工具里发 BEL](#附为什么不能从工具里发-bel)
- [文件](#文件)
- [许可](#许可)

## 安装

**作为 pi 包安装**（推荐：pi 负责更新，还能在「Extension Updates」里看到变更记录）：

```bash
pi install git:github.com/miscellaneous-repo/pi-bells        # 现在就能用
pi install npm:pi-bells                                      # 发布到 npm 之后可用
```

**或者直接拷单文件。** pi 会自动发现这两个位置的扩展（`<CONFIG_DIR>` 就是 `.pi`）：

| 位置 | 生效范围 | 是否需要 Trust |
|---|---|---|
| `<cwd>/.pi/extensions/` | 只在该项目内 | **需要**。重启 pi 后会问 `Trust project folder?`，选 Trust |
| `<agentDir>/extensions/` | 全局（推荐） | 不需要。全局扩展在 trust 检查**之前**加载 |

`<agentDir>` 默认是 `~/.pi`，可用环境变量 `PI_CODING_AGENT_DIR` 覆盖（本机是 `G:\Application\.pi`）。

```powershell
Copy-Item .\pi-bells.ts "$env:USERPROFILE\.pi\extensions\" -Force
```

然后：

- 全局目录 → 敲 **`/reload`** 即可，不用重启。
- 项目目录 → **必须重启 pi**（不是 `/reload`）才能触发 Trust 询问。

## 验证

1. `/reload`，然后随便发一句话。
2. 回答结束时应该响一声，**从 pi 自己那个窗格响**，不会弹新窗口。
3. 再让它执行一条会被判为 `ask` 的命令（例如让它 `rm` 一个临时文件），弹审批框时也应该响一声。
4. 看日志：

```powershell
Get-Content "$env:TEMP\pi-bells.log" -Tail 20
```

正常的样子（每行都带 `[pid N]`，delegate 子进程的写入也能区分开）：

```text
2026-11-20T17:09:28.790Z [pid 28176] loaded: instance=1 minInterval=2000ms disabled=false approval=on(2000ms) tty=true mode=(n/a)
2026-11-20T17:09:41.200Z [pid 28176] bell
2026-11-20T17:09:43.050Z [pid 28176] bell approval: tool=bash what=rm temp/scratch.txt source=tool_call
2026-11-20T17:09:46.510Z [pid 39204] skip: mode=json
```

完整日志行含义见[排错](#排错)。

## 审批铃：需要你 approve 时响一声

除了「收尾响」，扩展还有第二条通道：**pi 弹审批对话框等你点 Allow/Reject 时也响一声。**

来源是 [`pi-permission-system`](https://www.npmjs.com/package/pi-permission-system)（实测 v0.8.0）。它在 `tool_call` 里发现策略是 `ask` 时（`pi-permissions.jsonc` 里把 `rm` / `rmdir` / `Remove-Item` / `rimraf` / `-delete` / `unlink` / `shred` / `wipe` 这类删除命令设成 `ask`，且 `yoloMode: false`），会**先发一个事件，再弹** `ui.select(...)`（Allow Once / Allow Always / Reject / Reject with Reason）：

```ts
// pi-permission-system 内部：src/index.ts
pi.events.emit("pi-permission-system:permission-request", { state: "waiting", toolName, command, path, … });
//                                                     ↑ 后续还有 "approved" / "denied"
```

扩展订阅的就是这个共享事件总线通道，**只在 `state === "waiting"` 的那一瞬响**：

```ts
pi.events.on("pi-permission-system:permission-request", (data) => {
  if (data?.state !== "waiting") return;   // approved / denied / yolo 自动批准 都静默
  if (state.mode !== "tui") return;        // 同收尾铃：delegate 子进程必须挡掉
  process.stdout.write("\x07");
});
```

`waiting` 是在弹窗**之前**发出的，所以铃声和对话框几乎同时出现，不会滞后。

### 为什么选这个通道，而不是 pi 原生的 `ui_prompt_start`

pi 1.6 确实有个原生事件 `ui_prompt_start`（`kind: select | confirm | input | editor | custom`），所有 `ctx.ui.*` 阻塞式提示都会触发。对比：

| | `pi-permission-system:permission-request` ← 本扩展用 | `ui_prompt_start` |
|---|---|---|
| 覆盖面 | 只有审批（正好是想要的） | 所有阻塞提示：plan-mode、`pi-pwsh` 的 `Request-PiConfirmation`、timed-confirm… |
| 精确性 | 带 `toolName` / `command` / `path`，无需匹配文案 | 只能靠 `kind === "select" && title.startsWith("Permission Required")` 这种文案匹配收窄 |
| 稳定性 | 该包的**内部**通道（未在 pi 文档公布），升级可能改名 | pi 原生、有文档 |
| 失效表现 | 升级/移除后静默失效（日志少 `bell approval`），不影响收尾铃 | 减少响铃频率 |

结论：只要审批就够，选前者。如果想要「任何弹窗等我动手都响」，再加 `ui_prompt_start` 即可 —— 两套可以共存。

### 子 agent 转发审批

`acp_delegate` 派出的子进程 `hasUI` 为 `false`，它走的是「把请求写到文件 + 父进程轮询转发」那条路，**自己不会弹窗**（也就不会响，何况 `mode` 门控已经挡住子进程）。父进程弹出的是 `Permission Required (Subagent)`，`waiting` 在父进程发出 → 父窗口响一声，正是想要的。

### 两个实现细节

1. **独立节流桶**：审批铃和收尾铃各用各的计数器（`lastApprovalBell` / `lastBell`）。共用一个桶的话，你批准后 agent 几秒内跑完，收尾铃会被审批铃压掉。分开就互不干扰（WT 播放 wav 期间仍可能丢弃极近的第二声，那是终端行为，但日志里两条 `bell` 都能看到）。
2. **mode 要缓存**：`pi.events` 的 handler 签名是 `(data) => void`，**拿不到 ctx**（没有 `ctx.mode`）。所以扩展在 `session_start` / `agent_settled` 里把 `ctx.mode` 记到进程级共享状态上给审批通道用；`/reload` 会带 `reason: "reload"` 再发一次 `session_start`，缓存不会失效。缓存为空时保守不响（`skip approval: mode=undefined`）。

## 测试

```bash
npm test        # = node --test test/pi-bells.test.mts
npm run check   # lint + typecheck + 测试（CI 跑的就是这个）
```

`test/pi-bells.test.mts` 用桩替身跑完整行为矩阵，不启动 pi、不碰真实终端。17 个用例覆盖：两条通道各自的触发与门控（`aborted` / `isIdle` / `mode`）、独立节流桶、`/reload` 重复实例只响一声、`approved` / `denied` 静默、以及全部环境变量开关。

手法（想自己加用例时看）：

- `pi.on` / `pi.events.on` 被换成数组收集器，手工 `settle()` / `permission()` 触发。
- 拦截 `process.stdout.write`，只吞 `\u0007`、其余转发（否则 test runner 的报告会被吃掉）。
- 扩展在 **import 时**读环境变量，所以每个用例用 `?case=…` 查询串强制重新求值，并先清掉 `globalThis.__piBells__`。

需要 Node ≥ 22.6（22.6–22.17 要加 `--experimental-strip-types`；22.18+ 与 24 直接跑 `.ts`）。

桩测试证明的是**逻辑**（什么时候该响、什么时候不该响）；「响了有没有声音」是终端的事，仍需按上一节在真机上冒烟一次。

## 配置：音色由终端决定

**扩展只负责发字符，不负责发声。** 响不响、用什么声音，完全由终端配置决定。

### Windows Terminal

`settings.json` 里：

```jsonc
"profiles": {
  "defaults": {
    "bellStyle": ["audible", "taskbar"]     // audible=出声，taskbar=任务栏闪
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

要点：

- `bellSound` 如果只配在某个 profile 里，就只有那个 profile 用你挑的铃声，其它 profile 用系统默认音。想全局统一，就把它挪进 `profiles.defaults`。
- `bellSound` 是**数组**，WT 每次 BEL 从中随机挑一个。
- `bellStyle` 不含 `audible` 就永远静音（只剩闪任务栏）。
- GUI 里对应 **设置 → 配置文件 → 外观 → 铃声**。

### 其它终端

| 终端 | 行为 |
|---|---|
| Linux/macOS 终端 | 通常走系统提示音；iTerm2 有独立的 bell 音效设置 |
| tmux / screen | 可能被中转或吞掉，需要 `set -g bell-action any` 之类 |
| VS Code 集成终端 | 有 `terminal.integrated.enableBell` 开关 |
| kitty / WezTerm | 支持 OSC 99 / OSC 777 通知，本扩展用的是裸 BEL，不影响 |

本扩展没有做 OSC 777/99 之类的富通知 —— 在 WT 下这些都不被识别，裸 BEL 是唯一可靠的通道。

## 可调参数（环境变量）

全部可选，不设就用默认值。改完 `/reload` 生效。

| 变量 | 默认 | 作用 |
|---|---|---|
| `PI_BELL_DISABLE` | 未设 | 设为 `1` 则加载但完全不响（两条通道都关） |
| `PI_BELL_APPROVAL_DISABLE` | 未设 | 设为 `1` 只关掉「审批响」，收尾铃照常 |
| `PI_BELL_MIN_INTERVAL_MS` | `2000` | 收尾铃的节流窗口毫秒数。`0` = 不节流（WT 下会丢音，不建议） |
| `PI_BELL_APPROVAL_MIN_INTERVAL_MS` | 同上 | 审批铃自己的节流窗口（独立桶，互不压制） |
| `PI_BELL_LOG` | `%TEMP%\pi-bells.log` | 日志路径；设成 `off` 关闭日志 |

PowerShell 里设置（仅当前会话）：

```powershell
$env:PI_BELL_DISABLE = '1'
```

永久设置用 `setx PI_BELL_MIN_INTERVAL_MS 3000`（新开的终端才生效）。

日志策略：每次触发/跳过写一行，超过 256KB 自动轮转，不会无限长；写日志失败一律静默，绝不影响响铃。

## 为什么需要这些门控

1. **`ctx.mode === "tui"`**
   `acp_delegate` 派出的子 agent 是一个真实的 pi 子进程，它**也会加载全局扩展**（`buildChildArgs` 从不加 `--no-extensions`）。但它是 `--mode json` / `-p`，stdout 是管道：往里面写 `0x07` 既污染 JSONL 事件流，你也听不到。所以必须用 `ctx.mode` 门控 —— 注意**不能用 `hasUI`**，RPC 模式下 `hasUI` 也是 `true`。

2. **`aborted` 不响**
   你按 Esc 打断时，你已经盯着屏幕了，还响一声只会烦人。

3. **`ctx.isIdle() === false` 不响**
   收尾瞬间如果紧接着还有排队消息要处理（`deliverAs: "steer"` 插入的那种，比如 `acp_delegate` 的完成通知），pi 会立刻转进下一轮，此时并不真的是在等你。这里只在**明确返回 false** 时跳过，函数不存在就不管，避免误杀。

4. **共享节流窗口（默认 2 秒）**
   WT 的 audible bell 播的是 1~2 秒的 wav，**播放期间的 BEL 被静默丢弃**。实测：发 4 个间隔 600ms 的 BEL，只听到 2 声。所以高频收尾必须节流，否则你会以为扩展坏了。

5. **节流状态挂 `globalThis`（重复加载自愈）**
   pi 的注释写得很直白：「a loaded extension cannot be unloaded」。`/reload` 会创建**新的**扩展实例，而旧实例的 handler 仍然挂在事件总线上 —— 早期版本两个实例各有一个独立的 `lastBell`，于是一次收尾响两声。现在 `lastBell` 是进程级共享的，重复实例会在同一窗口内互相把对方挡掉，自然塌缩成一声。这里**刻意不用 `installed` 标志**去阻止第二次注册 —— 万一某个实例注册完就被 pi 丢弃，标志位会让它永久哑掉。

6. **审批铃只认 `state === "waiting"`**
   同一个请求后续还会发 `approved` / `denied`（包括 yolo 自动批准时直接发 `approved`，连框都不弹）。只在 `waiting` 响才不会在你点完按钮、或自动放行时再响一次。

7. **审批铃不套用 `aborted` / `isIdle`**
   这两条是为「收尾」设计的。审批发生在 agent 运行**中途**（`tool_call` 被卡住等决定），那时 `isIdle()` 永远是 `false`，`agent_settled` 也根本不会来 —— 套上去只会让审批铃永远不响。

## 排错

| 日志表现 | 含义 |
|---|---|
| `bell` | 收尾响了一声，扩展正常工作 |
| `bell approval: tool=… what=…` | 审批铃：`pi-permission-system` 正在等你 Allow/Reject |
| 有 `loaded` 但从不出现 `bell` | 事件没到（检查 pi 版本 / 是否 reload 过） |
| 有 `bell` 但没有 `bell approval` | 审批通道没生效：该包未加载/改名，或该次弹窗不是它触发的 |
| 完全没有任何行 | 文件没被加载：路径不对，或项目目录还没被 Trust |
| `loaded: instance=2` | 同一份扩展被加载了两次（正常，`/reload` 会这样）—— 共享节流会让它只响一声 |
| `loaded: tty=` 不是 `true` | 诊断信息：pi 的 stdout 不是终端，写了也不会响 |
| `approval=off` | 审批铃被 `PI_BELL_APPROVAL_DISABLE` 关了 |
| `skip: mode=json` / `print` | 是 `acp_delegate` 派出的子 agent 在收尾 —— 正常，必须跳过 |
| `skip: throttle gap=...` | 节流窗口内的第二次收尾，被挡掉 —— 正常 |
| `skip approval: throttle gap=...` | 2s 内连出两次审批请求（例如选了 `Reject with Reason` 后又弹输入框）—— 正常 |
| `skip approval: mode=undefined` | 审批事件早于 `session_start` —— 缓存没建立时保守不响 |
| `skip: aborted` | 你按 Esc 打断的 —— 正常 |
| `skip: not idle (work already queued)` | 收尾瞬间紧接着还有排队消息要处理 —— 正常 |
| `--- log rotated ---` | 日志超过 256KB 自动轮转 —— 正常 |

| 现象 | 排查 |
|---|---|
| 日志有 `bell` 但没声音 | `bellStyle` 是否含 `audible`；`bellSound` 是否配在**当前**这个 profile；系统音量；换成在「PowerShell」profile 里试 |
| 从没出现过 `bell` | 看有没有 `skip: mode=` → 被门控挡了；什么都没 → 文件没加载（路径 / Trust） |
| 审批时不响（收尾照常响） | 该弹窗不是 `pi-permission-system` 触发的；该包未加载；`skip approval: PI_BELL_APPROVAL_DISABLE`；`skip approval: mode=undefined` → 重启 pi |
| 一次响两声 | 旧版本（每个实例各有独立节流状态）。更新文件后 `/reload` |
| 某些收尾不响 | 看日志是否有 `skip: not idle` 或 `skip: throttle` |
| 审批铃太吵 | `PI_BELL_APPROVAL_DISABLE=1`，或调大 `PI_BELL_APPROVAL_MIN_INTERVAL_MS` |
| 响得太频繁 | 调大 `PI_BELL_MIN_INTERVAL_MS` |
| 想临时关掉 | 设 `PI_BELL_DISABLE=1` |

## 卸载

```powershell
pi remove git:github.com/miscellaneous-repo/pi-bells        # 包安装
Remove-Item "$env:USERPROFILE\.pi\extensions\pi-bells.ts"   # 手工拷贝
```

然后 `/reload`。注意：**已经加载的实例在本次进程内无法卸载**，需要重启 pi 才能彻底恢复。

## 已知限制

- **只在 TUI 模式响。** `--mode json` / `-p` / RPC 跑批时不响，这是刻意的。
- **审批铃依赖 `pi-permission-system` 的内部事件**（`pi-permission-system:permission-request`，实测 v0.8.0）。该包改名/移除这条通道后，审批铃会**静默失效**（收尾铃不受影响）；判断方法：日志里有 `loaded: … approval=on(...)` 却从无 `bell approval`。
- **只覆盖 `pi-permission-system` 的审批**。其它来源的阻塞式弹窗不响：`pi-pwsh` 的 `Request-PiConfirmation` / `Request-PiSelection` / `Request-PiInput`、plan-mode 的选项列表、`timed-confirm` 之类。要全覆盖请叠加 `pi.on("ui_prompt_start", …)`。
- **不区分「成功」和「失败」。** `agent_settled` 是终点边界，不带结果信息。
- **不区分 delegate 完成。** 每次收尾都响。想让 `acp_delegate` 完成时单独有声音，需要在 `billion-context` 配置里开 `pi.subagents.notifyStructured: true`，再监听 `customType: "billion-context:delegate-notification"` 的 custom 消息 —— 本项目没做。
- **BEL 是终端层机制**，管不到通知中心 / 系统 Toast。

## 附：为什么不能从工具里发 BEL

想用一条命令「试听」是行不通的，两层拦截：

1. **工具子进程的 stdout 不是 TTY** —— 是被 pi 捕获的管道。`[Console]::Out.Write([char]7)`、`Write-Host`、写 `CONOUT$`、`WriteConsoleW` 全都到不了你的窗格。
2. **控制字符会被剥掉** —— `pi-coding-agent/dist/utils/shell.js` 的 `sanitizeBinaryOutput()`：

   ```js
   str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "")   // 0x07 在区间内
   ```

   `[Console]::Out.Write("A" + [char]7 + "B")` 显示出来就是 `AB`。

所以只有**在 pi 自己的渲染路径上、或扩展直接写 `process.stdout`** 才能真正发声。上面「验证」里的日志 + 真实收尾，是唯一的验证方式。

另外注意区分两件事：

```powershell
[Console]::Beep(800, 200)        # 直接调系统蜂鸣：绕过终端配置，音色不受 bellSound 控制
[Console]::Out.Write([char]7)    # 发 BEL 给终端：走 bellStyle / bellSound
```

本扩展用的是后者。

## 文件

```text
pi-bells.ts                扩展本体（单文件、零运行时依赖）
test/pi-bells.test.mts     17 个桩测试
package.json               pi 包清单（`pi` 字段）+ 开发工具链
tsconfig.json              只做类型检查，不产出构建
biome.json                 格式化与 lint 规则
CHANGELOG.md               变更记录（pi 会读取并在更新后展示）
README.md / README.zh-CN.md, CONTRIBUTING.md, SECURITY.md, LICENSE
```

手工安装时**只拷 `pi-bells.ts` 一个文件**即可。

## 许可

Copyright (C) 2026 Aquilonar

本项目按 **GNU General Public License v3.0 or later** 发布，全文见 [LICENSE](LICENSE)。

简单说：随便用、随便改、随便传播；但如果你改了再发出去（分发二进制/托管服务也算），必须同样以 GPL-3.0 开源，并保留版权声明与「无担保」条款。

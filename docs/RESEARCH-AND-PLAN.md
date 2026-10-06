# opencode2 Goal 插件：调研与最终方案

> 日期：2026-10-06
> 目标仓库：`elegracer/opencode-goal-plugin`
> 目标宿主：OpenCode **v2**（本机 `opencode2` = `~/.opencode/bin/opencode`，v2.0.22）
> 插件 API：`@opencode/plugin` 2.0.22（Promise API 为主）

---

## 0. 结论（TL;DR）

1. 网络上确实已有多款 goal 插件，但真正 **V2 原生**（`plugins` + `Plugin.define`）的只有四款：`opencode2-goals`（wukrit）、`opencode2-goal-plugin`（gotenksIN）、`@bybrawe/opencode-goal`、`@prevalentware/opencode-goal-plugin`（V2 适配线）。其余（willytop8、@heimoshuiyu、mweinbach、devinoldenburg 等）本质是 V1 方案或 V1/V2 混合。
2. 现有实现各有明显短板：
   - 标记文本式完成判定（V1 系）依赖模型自觉，证据链弱；
   - V2 原生实现里，`opencode2-goal-plugin` 有完善的事件去重/锁/证据候选，但预算记账是 JSON 长度估算，且没有独立验证；
   - `opencode2-goals` 功能最全（预算、证据、权限沙箱、TUI、RPC），但强依赖自定义证据启发式，验证仍是本地字符串判定；
   - `@bybrawe` 有真正的子会话语义验证与队列/契约，但体量巨大、双版本兼容面广，复杂度高；
   - `@prevalentware` 的 V2 层只覆盖基础能力，很多语义（compaction、子会话恢复）仍标注为 V1-only。
3. OpenCode V2 的空前能力（相对 V1）足以把 goal 插件做“正确”：
   - `session.hook("context")` 每次主循环模型调用都能注入目标（持久化之外的稳定注入点）；
   - `session.hook("prompt")` 可以在 **admission 阶段** 识别“用户插话”与“插件自己的续跑提示”（metadata 标记），从根上解决 V1 时代“插件提示与用户消息无法区分”的竞态；
   - `session.execution.started/succeeded/failed/interrupted(reason=user/shutdown/superseded/inactivity)` 提供**可靠的回合边界与中断原因**；
   - `session.usage.updated` 提供**精确 token/cost 用量**（V1 只能估算）；
   - `tool.hook("execute.after")` 提供**带 CallID 的成功工具调用证据**；
   - `ctx.generate.text`（无会话模型调用）与 `ctx.session.create/prompt/wait`（子会话）提供**分层完成验证**的原语；
   - `ctx.storage` 提供宿主持久化，`ctx.rpc.register` + TUI `sidebar.content` 提供可选的界面呈现。
4. 最终方案（详见 §5）：**只面向 OpenCode 2.0.22+ 的单包插件**，以“目标契约 + 证据链门禁 + 事件驱动续跑 + 精确预算 + 崩溃恢复”为核心，分 P0/P1/P2 三阶段落地；P0 即达到“可长时间无人值守且不会被模型口头‘完成’骗过”的正确性标准。

---

## 1. 背景与口径

### 1.1 opencode v1 / v2 的区分

| | OpenCode 1 | OpenCode 2（opencode2） |
|---|---|---|
| 启动命令 | `opencode`（1.x） | `opencode2`（本机为包装脚本，实际是 v2.0.22 的 `opencode` 二进制） |
| 插件配置键 | `plugin`（单数，字符串数组） | `plugins`（复数，支持对象 `{package, options}`） |
| 插件入口 | `export const server: Plugin`（Hooks 对象） | 默认导出 `Plugin.define({ id, setup(ctx) })`（Promise）或 Effect 变体 |
| TUI 插件 | `tui.json` | `cli.json`（`plugins`） |
| 目录约定 | `.opencode/plugins` 等 | 同左，但加载契约不同 |

本方案 **只实现 V2**：不导出 `server()`，不兼容 V1 配置键，不做 V1 回退。

### 1.2 本机环境事实（已核对）

- 宿主：`opencode v2.0.22`（`~/.opencode/bin/opencode2` → `opencode`）。
- 本地已装插件 API：全局 `~/.config/opencode/node_modules` 里有 `@opencode/plugin` 与 `@opencode-ai/plugin`，另有若干 V1 插件。
- npm 上 `@opencode/plugin` 最新版 `2.0.24`，`latest` dist-tag；2.0.22 可用。
- V2 配置使用 `plugins`；全局配置 `~/.config/opencode/opencode.jsonc` 已在使用 `plugins` 数组；TUI 插件配置在 `~/.config/opencode/cli.json`。

### 1.3 已核对的 V2 API（基于 `@opencode/plugin@2.0.22` 类型与官方 v2 文档）

宿主能力（本方案会用到的主干）：

| 能力 | API |
|---|---|
| 插件定义 | `Plugin.define({ id, setup(ctx) })`；`setup` 返回 cleanup |
| 位置/项目 | `ctx.location`（`directory`、`workspaceID`、`project.{id,directory,canonical}`） |
| 命令 | `ctx.command.transform(e => e.add({ name, description, execute({sessionID, prompt, delivery}) }))` |
| 工具 | `ctx.tool.transform(e => e.add({ name, description, input(JSON Schema), options:{codemode:false}, execute(input, ctx) }))` |
| 工具钩子 | `ctx.tool.hook("execute.before"/"execute.after", cb)`（含 `tool`、`id(CallID)`、`status`、`result/error`） |
| 模型上下文 | `ctx.session.hook("context", cb)`：可改 `system: SystemPart[]`、`messages`、`tools`、`options` |
| 压缩 | `ctx.session.hook("compaction", cb)`（`messages` 可改，或设置 `result` 跳过模型） |
| 提示准入 | `ctx.session.hook("prompt", cb)`：可改 `prompt`、`metadata`、`delivery`；synthetic/shell/compaction/move 不触发 |
| 会话 | `session.get/create/prompt/synthetic/generate/command/compact/interrupt/wait/context/update/move/remove` |
| 用量 | 事件 `session.usage.updated`（`tokens.{input,output,reasoning,cache.read,cache.write}` + `cost`，累计值） |
| 事件 | `ctx.event.subscribe({signal})` → `session.execution.started/succeeded/failed/interrupted`、`session.idle`、`session.status`、`session.retry.scheduled`、`session.moved`、`session.compaction.*`、`session.deleted`、`session.usage.updated`、`session.created` 等 |
| 持久化 | `ctx.storage.get/set/remove/scan`（插件作用域、宿主 DB，重启保留） |
| 生成 | `ctx.generate.text({ model, prompt })`：无会话、无工具的独立模型调用 |
| 权限 | `ctx.permission.hook("evaluate", cb)`；`ctx.permission.list/get/reply` |
| RPC | `Rpc.define`（`@opencode/plugin/rpc`）+ `ctx.rpc.register(...)` + `registration.events.emit(...)`；客户端 `client.rpc(def)` + `events.on/subscribe` |
| TUI | `@opencode/plugin/tui`：`Plugin.define({ id, setup(ctx) })`，`ctx.ui.slot({ append|prepend|replace: "sidebar.content", render })`、`ctx.ui.toast.show`、`ctx.client.rpc(...)`、`ctx.data.on(...)`、`ctx.storage.memory/store` |
| 中断原因 | `session.execution.interrupted.data.reason ∈ {"user","shutdown","superseded","inactivity"}` |

关键限制（已核对 2.0.22）：

- `AgentEditor` **没有 `add`**：插件不能新增 agent（不能像 V1 那样注册 `goal-verify` 子代理）；验证子会话需用 `ctx.session.create({ parentID, agent?, title? })` + prompt 实现。
- 插件上下文 **没有 shell 执行 API**（只有 `shell.hook("create.before")`）；插件自身不能跑命令做验证，只能（a）观察工具调用证据，（b）用 `ctx.generate.text` 做语义裁决，（c）开子会话让子代理跑工具。
- 无 storage CAS / 分布式锁语义；官方建议同一 DB 只跑单 server 进程。
- `session.idle` 事件在 schema 中存在，但社区实测（opencode2-goals README）称在部分 2.0.x build 里 **不投递给插件**；可靠边界是 `session.execution.*`。本方案将 idle/status 仅作兜底并做去重。

---

## 2. 已有实现盘点（网络调研）

### 2.1 V2 原生（`Plugin.define` + `plugins` 配置）

#### A. `opencode2-goals`（wukrit）
- 版本：npm `opencode2-goals@1.0.4`；仓库 <https://github.com/wukrit/opencode2-goals>。
- 定位：OpenCode v2，durable session-scoped goal loop，证据门禁 + 预算上限 + 无人值守权限沙箱 + TUI 侧栏。
- 机制要点：
  - `/goal set|view|pause|resume|complete|block|clear|task|history`；工具 `goal_set/goal_complete/goal_block/goal_clear/goal_add_task/goal_update_task/goal_history`。
  - `session.hook("context")` 每次调用重新注入 objective；续跑由终态 `session.execution.*` 事件驱动（README 明说 `session.idle` 在它的 build 里收不到），按事件 id 去重；“续跑回合没有任何工具调用”算 stall；达到上限给 `budget_limited`（不是 complete/blocked）。
  - 完成证据至少 24 字符 + 必须有可检查锚点（路径/数字/文件扩展名/关键词），且需与最近转录文本 token 有重合（防凭空捏造）；`goal_clear` 需引用用户原文（非 assistant 文本）。
  - 状态存 `ctx.storage`（`goal/<project>/<session>`），终态和 supersede 的 active 目标归档；权限沙箱：active 目标会话内，路径在工作目录内自动 allow，越界 deny 并引导 `goal_block`；明确不覆盖配置里的显式 `deny`。
  - 提供 `goals.get` RPC + `goals.updated` 事件；TUI 侧栏（pre-compiled `dist/tui.js`，npm 安装时 JSX 不会被宿主编译的坑也处理了）。
- 优点：功能面最完整；工程细节成熟（RPC/TUI/权限/归档/事件去重）；有周度 CI 检查类型面 + 隔离宿主冒烟。
- 缺点/风险：验证仍是启发式字符串判定（README 自认）；预算影响面大（默认 10 turn/100k token 上限，需要显式 `--unbounded`）；TUI 组件需与 host 版本周期同步（Solid/JSX），维护成本高。

#### B. `opencode2-goal-plugin`（gotenksIN）
- 版本：npm `opencode2-goal-plugin@1.0.5`（仓库已到 1.0.9）；仓库 <https://github.com/gotenksIN/opencode2-goal-plugin>。
- 定位：单会话持久目标 + `/goal` + 4 个工具 + 验证式完成 + 检查点 + 自动续跑；无 TUI。
- 机制要点：
  - `ctx.tool.transform` 注册 `get_goal/create_goal/update_goal/clear_goal`；`update_goal complete` 必须携带 `{source, summary, success, toolCallID}`，`toolCallID` 必须命中 `tool.hook("execute.after")` 观察到的成功调用候选（`shell` 需 exit=0、非背景、未超时；`execute` 需 toolCalls 全部 completed）。
  - 续跑由 `session.execution.succeeded/failed/interrupted` 驱动：`failed/interrupted` → goal 暂停并记因；`succeeded` → 延迟 `continuationIntervalMs`（默认 1500ms）后 prompt 续跑；用 generation/admissionToken/inFlight/rescheduleAfterAdmission/pendingContinuations 一整套竞态防护。
  - 命令 `/goal` 不直接改状态，而是 prompt 模型去调用对应工具（保证“只有 goal 工具能改状态”）。
  - `ctx.storage` + 每目标文件锁（`~/.local/share/opencode-goal-plugin/locks`）做跨进程串行化；token 用量按 `JSON.stringify(messages).length / 4` 估算；`maxTokens/maxDurationMs/maxContinuations/noProgressTurns` 均为显式配置才启用（默认无限）。
  - 预算到达设 `usageLimited/budgetLimited`，无进展设 `paused`。
- 优点：V2 语义最扎实的“小而全”；事件竞态防护细致；证据必须引用真实调用 ID，防幻觉效果好；单测/构建（bun build）规范。
- 缺点：无独立验证（证据只证明“某个工具成功”，不证明“目标达成”）；token 估算粗糙；失败即暂停（对可重试的传输错误不友好）；无 compaction/恢复语义的显式处理；并发锁有“残留锁需人工清理”的失败模式。

#### C. `@bybrawe/opencode-goal`
- 版本：1.3.47；仓库 <https://github.com/ByBrawe/opencode-goal>。
- 定位：V2 原生 + V1 兼容；host-verified 完成、契约（criteria/constraints/checks/files/budgets）、队列与有序目标、per-unit 会话轮换、只读侧栏、安装器。
- 机制要点：shell 检查 + 文件契约 + 修改证据；独立 verifier 子会话（超时 5 分钟、超时后清理并**至多一次**新会话重试）；`lifecycle/autonomous` 双层开关；`/goal contract|audit|budget|list|doctor|add|queue|next|history|restore|clear`；工具进度走宿主 tool progress；文档详尽（土耳其语+英语）。
- 优点：验证最“真”（子会话实跑+宿主证据）；恢复/队列/多目标最完整；显式 kill-switch。
- 缺点：体量非常大、概念多（unit/queue/revision/handoff），学习与维护成本高；强绑定精确宿主版本与安装器；对只想“一个目标跑到底”的用户过重。

#### D. `@prevalentware/opencode-goal-plugin`
- 版本：0.1.30+ 起支持 V2 beta；仓库 <https://github.com/prevalentWare/opencode-goal-plugin>。
- 定位：Codex 风格 goal mode；V1 为主、V2 适配线并行。
- 机制要点：V2 支持 `/goal`、工具、持久化、idle 续跑（execution.succeeded + legacy idle/status）、plan-mode 安全、TUI 侧栏/命令面板；策略丰富（`max_turn_time` 看门狗、Task 子会话延迟续跑、prompt-failure 上限、用户取消终态）。
- 优点：V2 语义跟踪积极（`session.execution.*`、`session.retry.scheduled`、interrupted reason 的差异化处理写得很细）。
- 缺点：V2 能力被官方 README 自认有缺口（goal compaction、重启后子会话恢复仍 V1-only）；双版本代码路径使 V2 行为受 V1 包袱牵制；文档/实现线复杂。

### 2.2 V1 或 V1/V2 混合（供对照）

| 项目 | 关键做法 | 主要问题 |
|---|---|---|
| `opencode-goal-plugin`（willytop8，0.4.0） | V1 hooks；`command.execute.before` + `experimental.chat.system.transform` + `event(session.idle)`；`[goal:evidence]`/`[goal:complete]`/`[goal:blocked]` 标记门禁；ledger 崩溃恢复；多目标/ordered(sisyphus)；可选 auditor（子会话 read/glob/grep）；项目级 state.json | 全靠模型输出标记；V1 hook 不可靠（命令文本仍会进对话）；无精确用量；OpenCode 1 限定 |
| `@heimoshuiyu/opencode-goal-plugin`（1.0.0） | V1 `server()` + 用 V2 SDK client；目标存 `session.metadata.goal`；`goal` 工具 create/get/complete/resume/cancel/pause；独立 `goal-verify` 子代理完成验证；abort 用 `session.error` 事件先于 idle 的内存标记 | 单目标、无预算；靠 V1 `config` 注入 agent/command；abort 检测是 V1 时代补丁；V2 语义未用 |
| `mweinbach/opencode-goals` | V1 + TUI 插件；token 预算 + `budget_limited`；idle 续跑；compaction 注入；完成审计提示 | V1 边界；插件自认多处“近似 Codex”；api 不稳定 |
| `devinoldenburg/opencode-goal-mode` | 不是纯插件：goal agent + review 子代理 + guard 插件 + 斜杠命令 + TUI 槽位接管 | 安装式改造，替换原生 todo 区域；与“插件化 goal”定位不同 |

### 2.3 OpenCode 上游的姿态（重要）

- 上游有 3 个 draft/相关 PR：`#32743`（per-session goals in DB + autonomous pursuit）、`#32924`（workspace-local goal service）、`#33944`（`/goal stop-condition`）。均未合入主线，但说明“原生 goal”是方向。
- 影响：插件命名与命令面 `goal` 有朝一日可能与原生冲突 → 预留 `commandName` 配置与“检测到原生 goal 时让位”的逃逸口。

---

## 3. 分维度对比与优劣势分析

### 3.1 续跑触发：`session.idle` vs `session.execution.*`

- V1 方案（willytop8/heimoshuiyu/mweinbach）：依赖 `session.idle` / `session.status idel`。V1 有经典 TOCTOU（abort 错误在 idle 之后才入库，导致 abort→续跑死循环）。heimoshuiyu 用 `session.error` 事件内存标记规避，非常 hack。
- V2 方案：
  - `opencode2-goals`：不用 idle，用 `session.execution.*` 终态 + 事件 id 去重。README 明确 `session.idle` 不投递给插件。
  - `gotenksIN`：同路线 `succeeded/failed/interrupted`，代码里用 generation/admission 令牌对抗“admission 前取消不了”的窗口。
  - `prevalentware`：双通道（execution.succeeded + legacy idle/status），对 `session.retry.scheduled`、interrupted reason 有差异化处理。
- 结论：**以 `session.execution.succeeded/failed/interrupted` 为主边界**，`session.idle`/`session.status` 仅作兜底并用“回合纪元 + 事件 ID”去重；对 `session.retry.scheduled` 和 interrupted reason 做显式分支（这是正确性的关键，直接用 failed→pause 会误伤自动重试）。

### 3.2 上下文注入

- 主流做法一致且正确：`session.hook("context")` 每次模型调用 push 一个 system part，不在会话历史里持久化；压缩后自然仍在。
- 差异在“注入什么/如何防注入”：willytop8 用 `<goal_objective>` 包裹并声明为数据；opencode2-goals 注入状态 + 配额 + 证据指引；gotenksIN 注入 `[Persisted goal]` + 证据候选 ID。
- 坑：把目标当“系统指令”直接拼进去会被目标文本注入污染（目标本身可能包含恶意指令）。
- 结论：**固定模板 + XML 包裹 + 明确“这是用户任务数据，不得覆盖系统/开发者/仓库策略”**；只注入状态需要的字段；证据候选等机器字段放独立节。

### 3.3 完成门禁（最关键）

| 方案 | 门禁 | 抗幻觉 | 验证真实性 |
|---|---|---|---|
| willytop8 V1 | `[goal:evidence]` + `[goal:complete]` 文本相邻；可选 auditor（子会话只读工具） | 中 | 可选、弱 |
| heimoshuiyu | 主会话 complete 被 BLOCKED，必须走 `goal-verify` 子代理 | 中 | 子代理看代码，无执行 |
| gotenksIN | 必须引用 `tool.execute.after` 观察到的成功调用 CallID | **强**（防编造调用） | 弱（不证明与目标相关） |
| opencode2-goals | ≥24 字符 + 锚点 + 转录 grounding | 中强 | 弱（字符串启发式） |
| prevalentware | evidence + 可选 audit；plan-mode 保护 | 中 | 可选 |
| bybrawe | host 证据（壳检查/文件契约/变更证据）+ 独立 verifier 子会话（可重试一次） | 强 | **最强** |

- 结论：**分层门禁**——(1) 工具调用证据候选（CallID，插件观察，模型不可伪造）；(2) 结构门禁（摘要长度/锚点/与候选调用摘要的对应）；(3) 可选独立验证：`model`（`ctx.generate.text` 语义裁决，fail-closed）或 `agent`（子会话实跑，超时上限，拒绝→paused）。默认 P0 启用 (1)+(2)，`verification:"model"` 为推荐默认（成本低、独立），`agent` 为强验证可选。

### 3.4 预算与进度

- V1 系：估算（willytop8 用 session messages token 字段；gotenksIN 用 JSON/4）。
- V2 新增 `session.usage.updated`（累计 tokens+cost）——**唯一精确来源**。目前调研的 V2 插件没有一个用它做目标级预算（bybrawe 用的是“accounted model runtime”，prevalentware 声称 “reads step-finish usage when available”）。
- 结论：以 `session.usage.updated` 累计值 + 目标创建时基线做“目标消耗”记账；`session.hook("context")` 里做兜底估算仅用于展示/告警。限额：`maxTurns`（续跑回合）、`maxTokens`（目标消耗）、`maxDurationMs`（活跃时长，pause 不计时）、`noProgressTurns`（连续无工具调用/低输出回合）、`noToolCallTurns`。默认安全上限开启，`--unbounded` 显式解除。

### 3.5 持久化与恢复

- `ctx.storage`（宿主 DB）是 V2 的正解；自写 JSON 文件（V1 系、gotenksIN 的锁目录）会引入权限/迁移/多进程问题。opencode2-goals 明确“不写 JSON 状态文件”，gotenksIN 已迁移到 storage+锁。
- 崩溃恢复的通行范式：启动时把仍为 `active` 的目标降级为 `paused(recovered)`，绝不盲目续跑（willytop8 的“paused recovery”）。V2 没有“启动即恢复”的 hook，但 `setup()` 时可以 scan storage。
- 结论：storage 单文档/会话 + 归档环形缓冲；启动扫描本 location 的活动目标 → `paused` + recovery 备注；单 server 假设写入 README。

### 3.6 用户介入 / 中断

- V1 的痛点：无法区分“插件续跑 prompt”和“真实用户消息”，只能靠私有 metadata 或时间窗猜测。
- V2 正解：`session.hook("prompt")` 在 admission 时看到 `metadata`；插件自己发的续跑 prompt 带 `metadata:{"goal.continuation":true}`，其余视为用户介入 → 取消待续跑、按配置暂停（默认）或继续（`onUserMessage:"continue"`）。synthetic/shell/compaction 不触发该 hook，天然不误伤。
- `session.execution.interrupted` 的 reason 必须区分：`user`（用户 ESC → 暂停，可 resume）；`shutdown/superseded/inactivity`（不动目标终态，重启后 recovered→paused）。
- `session.execution.failed` 需与 `session.retry.scheduled` 配合：重试中的失败不应立即暂停；只有“无重试的终态失败”才暂停。

### 3.7 命令与工具面

- V2 `command.transform` 是**全量接管**（execute 回调决定后续行为），不存在 V1 “命令文本仍进对话”的问题；把状态变更放在插件本地、把“需要模型执行”的动作转成 prompt/工具，是干净做法。
- 只让 goal 工具改状态（gotenksIN 的纪律）能保证 `/goal` 与模型工具行为一致、可审计。
- 命令输出（`/goal status`）没有“直接写聊天流”的公开 API；可选：(a) synthetic 消息（待 Phase 0 验证是否渲染）；(b) 引导模型用 `goal_get` 工具输出；(c) RPC + TUI 侧栏/Toast。方案采用 (a) 优先，(b) 兜底，(c) 作为 P2。

### 3.8 TUI / RPC

- opencode2-goals 与 prevalentware 都做了侧栏，效果最好但维护重（Solid/JSX、宿主槽位、npm 下 `.tsx` 不被编译的坑）。
- 结论：P2 再做，独立 `./tui` 导出 + `./rpc` 契约；P0/P1 不阻塞核心正确性。

### 3.9 权限沙箱

- opencode2-goals 的 `permission.hook("evaluate")` 沙箱（工作目录内 allow、越界 deny + 引导 block）是无人值守的安全亮点；但“自动放行”改变用户既有预期，必须显式开启、且永不放宽配置中的 deny。
- 结论：P2 可选（`sandbox: true`），实现照抄“路径前缀包含 + glob 剥离 + 非路径资源不决策 + deny 不动”的保守规则。

### 3.10 工程与测试

- 现有 V2 实现普遍有：纯函数状态机单测 + 事件流 harness + 真实宿主冒烟。opencode2-goals 有隔离宿主 CI；gotenksIN 有全套竞态防护测试。
- 结论：单测（状态/证据/命令解析/选项）+ 假 Context harness（事件流回放）+ Phase 0 probe 插件实测宿主行为 + 真实 `opencode2` 冒烟脚本 + CI 类型面检查（2.0.22 / latest）。

---

## 4. 从现有实现提炼的“正确性清单”

必须做到（P0）：

1. 续跑边界用 `session.execution.*`，不信 idle；每回合至少一次但至多一次续跑（回合纪元 + 事件 ID 去重 + in-flight 门）。
2. 用户插话可识别（prompt hook + metadata 标记）；用户中断（reason=user）→ 暂停，不自动续。
3. 自动重试（retry.scheduled）与终态失败区分；重试中不消耗、不暂停。
4. 上下文注入用 `session.hook("context")`，压缩安全；目标文本按不可信数据处理。
5. 完成必须过证据门禁：真实 CallID 候选 + 结构校验；可选独立验证；拒绝→paused（可 resume），绝不静默完成。
6. 预算用 `session.usage.updated` 精确记账；默认有安全上限；到限状态单列（budget_limited/usage_limited）。
7. 持久化只用 `ctx.storage`；重启把 active 降级为 recovered-paused；status/history 可审计。
8. 仅根会话驱动续跑；子会话不驱动；子会话上下文可注入父目标（委托工作不跑偏）。
9. 状态变更单点化：只有 `goal_*` 工具与 `/goal` 命令走同一控制器；所有变更写 history。
10. 单 server 假设与 location 作用域写清楚；跨 location 的会话不属于本插件实例。

不要做（或显式可选）：

- 不写模型可伪造的纯文本完成标记（V1 `[goal:complete]` 模式）；
- 不默认无限预算；
- 不自动放宽用户在配置里的 deny 权限；
- 不为了 V1 兼容把 V2 代码路径复杂化（本仓库定位 V2-only）。

---

## 5. 最终方案

### 5.1 目标与非目标

**目标**
- 只面向 OpenCode 2.0.22+（`plugins` + `Plugin.define`），单 npm 包交付。
- “完整 goal 功能”：创建/查看/暂停/恢复/编辑/清除/历史/归档；自动续跑；预算与停损；证据门禁与可选独立验证；压缩安全；崩溃恢复；任务清单（可选项）；RPC/TUI 可选。
- 正确性优先：可长期无人值守、不会被模型口头“完成”骗过、不会在用户插话后继续自说自话。

**非目标（本仓库）**
- 不支持 V1（不导出 `server()`、不读 `plugin` 键）。
- 不做安装器改写用户配置（README 指导手工加 `plugins` 条目）。
- P0 不做 TUI、权限沙箱、多目标队列（P1/P2 迭代）。

### 5.2 包与配置

```jsonc
// package.json（要点）
{
  "name": "@elegracer/opencode-goal",      // willytop8 已占用 opencode-goal-plugin 名称
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".":       { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./rpc":   { "import": "./dist/rpc.js",   "types": "./dist/rpc.d.ts" },   // P2
    "./tui":   { "import": "./dist/tui.js" }                                   // P2
  },
  "files": ["dist"],
  "dependencies": { "@opencode/plugin": "2.0.22" },
  "peerDependencies": { "solid-js": ">=1.9", "@opentui/solid": ">=0.5.14", "@opentui/core": ">=0.5.14" },
  "peerDependenciesMeta": { "solid-js": {"optional": true}, "@opentui/solid": {"optional": true}, "@opentui/core": {"optional": true} },
  "engines": { "opencode": ">=2.0.22" },
  "scripts": { "build": "bun build src/index.ts --outdir dist --target bun --format esm --external @opencode/plugin ...", "test": "bun test", "typecheck": "tsc --noEmit" }
}
```

```jsonc
// 用户配置（opencode.jsonc）
{
  "plugins": [
    { "package": "@elegracer/opencode-goal", "options": { } }
  ]
}
```

- 依赖版本策略：`@opencode/plugin` 精确钉住与宿主同版本（`2.0.22`），README 给兼容矩阵；CI 增加 `latest` 类型检查。
- 开发期可用目录安装：`{ "package": "/home/<user>/codes/opencode-goal-plugin", "options": {...} }`（宿主会加载 TS 源码；发布用 bun 编译产物）。

### 5.3 架构与模块

```
src/
  index.ts        # Plugin.define({ id:"opencode.goal", setup }) 纯组装/生命周期
  options.ts      # 选项解析、校验、默认值、有效限额（纯函数，可测）
  types.ts        # GoalRecord/Status/Evidence/Candidate/Config 类型（纯）
  state.ts        # 状态机与迁移（create/pause/resume/block/complete/limit/supersede/archive）纯函数
  store.ts        # ctx.storage 读写：键、版本迁移、读改写队列、归档、启动扫描
  evidence.ts     # 证据候选注册（tool.execute.after）+ 结构门禁 + clear 的“用户原话”门禁（纯）
  verify.ts       # 验证层：evidence | model(ctx.generate.text) | agent(子会话)，统一裁决接口
  loop.ts         # 续跑调度状态机：busy/pending/epoch/cooldown/stall/clamps
  context.ts      # session.hook("context"/"compaction") 注入与用量记账
  prompts.ts      # system 注入模板、续跑提示、验证提示、命令帮助（纯）
  tools.ts        # goal_get/goal_set/goal_update/goal_clear/goal_history(/goal_task)
  commands.ts     # /goal 解析与本地处理/状态格式化（纯解析，可测）
  controller.ts   # 编排：连接以上模块与 ctx，唯一写入口
  rpc.ts          # P2：Rpc.define("goals") + events
  tui.tsx         # P2：sidebar.content 小组件（预编译 dist/tui.js）
tests/
  state.test.ts evidence.test.ts command.test.ts options.test.ts store.test.ts verify.test.ts
  loop.test.ts    # 假事件流回放（竞态用例）
  harness.ts      # FakeCtx：内存 storage + 可注入事件流 + fake session/tool
scripts/
  probe.ts        # Phase 0 宿主行为探针（开发期）
  smoke.sh        # 真实 opencode2 冒烟
```

原则：`state/evidence/commands/options/prompts` 纯函数；`loop` 只依赖抽象时钟与 prompt 回调；`controller` 是唯一触碰真实 ctx 的编排层 → 可测试性最大化。

### 5.4 状态机与数据模型

```ts
type GoalStatus =
  | "active" | "paused" | "blocked" | "complete" | "cancelled"
  | "budget_limited" | "usage_limited" | "stalled";

interface GoalRecord {
  v: 1;
  goalID: string;               // 每次 set 生成；历史/证据按此归组
  sessionID: string;
  projectID: string;
  location: { directory: string; workspaceID?: string };
  objective: string;
  criteria?: string;            // 成功标准（可选）
  constraints?: string;         // 约束/非目标（可选）
  status: GoalStatus;
  stopReason?: string;          // paused/blocked/limited 的原因（人类可读）
  recovered?: boolean;          // 重启恢复标记
  createdAt: string; updatedAt: string;
  activeSince?: string; activeMs: number;   // 活跃时长（pause 停表）
  budget: { maxTurns?: number; maxTokens?: number; maxDurationMs?: number; unbounded: boolean };
  usageBase?: UsageSnapshot;    // 目标创建时基线
  used: { turns: number; tokens: number; cost: number };
  stall: { noToolTurns: number; noProgressTurns: number };
  evidence: EvidenceRecord[];   // 已接受证据（完成时）
  checkpoints: Checkpoint[];    // 最近成功工具调用摘要（环形，≤50）
  history: HistoryEntry[];      // 迁移轨迹（环形，≤100）
  archive: GoalRecord[];        // 本会话被 clear/supersede 的旧目标（≤20，只留头部字段+history 摘要）
}
```

迁移规则（要点）：
- `set`：已有非终态目标 → 先归档为 `cancelled(superseded)`；新目标 `active`，重置预算窗口与证据候选。
- `pause`（用户/插话/无进展）：停表；`resume`：重新开表，默认 **不重置** 预算（`--reset-budget` 可显式重置）。
- `blocked`（模型）：必须有具体 blocker 文本；`resume` 清 blocker。
- `complete`：只经证据门禁；写 evidence + history + 归档。
- `budget_limited/usage_limited/stalled`：与 paused 区分，便于 UI/审计与恢复；`resume` 可继续。
- 所有迁移写 `history{at, action, from, to, detail}`。

存储键（`ctx.storage` 已按插件作用域隔离，键内部再带 project/location）：

```
goal/v1/<projectID>/<locationKey>/<sessionID>          -> GoalRecord（含 archive）
goal/v1/<projectID>/<locationKey>/<sessionID>/cand     -> EvidenceCandidate[]（可选持久化，防重启丢候选）
```

- `locationKey = sha1(directory + "\0" + (workspaceID ?? ""))` 前 16 位。
- `setup()` 时 `scan({prefix:"goal/v1/<projectID>/<locationKey>/"})`：`active` → 降级 `paused(recovered)`；`archive` 保持不变。
- 单进程内按 session 串行读改写（promise 队列）；单 server 假设写入 README（不做跨进程文件锁，避免 gotenksIN 的残留锁失败模式）。

### 5.5 V2 API 映射（hook-by-hook）

| 需求 | API | 备注 |
|---|---|---|
| 插件装配 | `Plugin.define({id:"opencode.goal", setup(ctx)})` | setup 内注册所有 transform/hook/事件循环；返回 cleanup（abort 事件流、清定时器） |
| `/goal` 命令 | `ctx.command.transform(e => e.add({name, description, execute}))` | execute 内本地解析并处理；需要模型动作时 `ctx.session.prompt` |
| goal 工具 | `ctx.tool.transform(e => e.add(...))` | `input` 用 JSON Schema；`options:{codemode:false}`；`execute(input, toolCtx)` 用 `toolCtx.sessionID/agent` |
| 证据候选 | `ctx.tool.hook("execute.after", ...)` | `status==="completed"` 时记录 `{callID:id, tool, summary, at, messageID}`；排除 goal_* 自身 |
| 目标注入 | `ctx.session.hook("context", ...)` | `event.system.push({type:"text", text: block})`；按 status 决定“可继续/只读” |
| 压缩保护 | `ctx.session.hook("compaction", ...)` | 向 `event.messages` 追加一行目标快照（可选）；绝不设置 `result` |
| 用户插话 | `ctx.session.hook("prompt", ...)` | `metadata["opencode.goal.continuation"]` 存在 → 忽略；否则按 `onUserMessage` 处理 |
| 回合边界 | `ctx.event.subscribe`：`session.execution.*`、`session.idle`（兜底）、`session.retry.scheduled`、`session.moved`、`session.compaction.started/ended`、`session.usage.updated`、`session.deleted` | 过滤“本 location 的根会话”；子会话只用于跟踪 |
| 续跑 | `ctx.session.prompt({sessionID, text, metadata:{...continuation:true}})` | 不用 synthetic（要触发模型回合）；`delivery` 默认 steer |
| 状态输出 | `ctx.session.synthetic({sessionID, text, description})`（Phase 0 验证可见性）→ 否则引导模型调 `goal_get` | /goal status/pause 等的回执 |
| 用量 | `session.usage.updated` 累计值 | 目标级 delta |
| 验证-model | `ctx.generate.text({model, prompt})` | 严格输出 `APPROVE/REJECT + reason`；任何异常 fail-closed |
| 验证-agent | `ctx.session.create({parentID, title, agent?})` + `prompt` + `wait` | 子会话执行工具；超时 `verifierTimeoutMs`（默认 300s），至多 1 次重试；完成后 `session.remove` |
| 权限沙箱（P2） | `ctx.permission.hook("evaluate", ...)` | 默认关；in-scope allow、越界 deny+引导 block；deny 永不改 |
| RPC/TUI（P2） | `Rpc.define` + `ctx.rpc.register`；TUI `ui.slot({append:"sidebar.content"})` | 服务端事件 `goals.updated`；TUI 用 `client.rpc(Goals).events.on(...)` |

### 5.6 续跑循环（loop.ts）设计

每个（根）会话维护内存 LoopState：

```ts
interface LoopState {
  epoch: number;              // execution.started 递增；终态事件须匹配
  busy: boolean;              // started→true；succeeded/failed/interrupted→false
  compacting: boolean;        // compaction.started/ended
  retrying: boolean;          // retry.scheduled
  pending?: { kind:"timer"|"admitted"; epoch:number; at:number };
  cooldownTimer?: Timeout;
  turnHadToolCall: boolean;   // 本回合是否有工具调用（stall 判定）
  lastBoundaryEventID: string;
}
```

时序（成功回合）：

```
session.execution.succeeded(sessionID, eventID)
  ├─ 事件去重（eventID == lastBoundaryEventID 或 epoch 不匹配 → 忽略）
  ├─ 结算回合：turns++；noToolCall stall 判定；用量快照
  └─ schedule(): 条件全真才排程（目标 active、同 location 根会话、非 busy/compacting/retrying、
       无 pending、非用户暂停、未到限额、距上次续跑 ≥ continuationIntervalMs）
        → setTimeout(interval) → fire():
            重新读取目标与 LoopState（防 TOCTOU）
            pending = admitted
            ctx.session.prompt({...延续提示, metadata:{goal.continuation:true}})
```

去重与竞态：
- 主边界只用 `execution.succeeded`；`session.idle`/`session.status(idle)` 若到达且 3s 内无 succeeded，作为兜底触发同一 schedule()（靠 epoch + pending 去重，不会双发）。
- `execution.failed`：若 `retrying` 或 2s 内出现 `retry.scheduled` → 忽略（宿主在重试）；否则 `paused("execution failed: …")`。
- `execution.interrupted(reason)`：`user` → `paused("user interrupt")`；其余 reason → 仅取消 pending，保留 active（shutdown 后重启走 recovered）。
- 用户 prompt（prompt hook 非续跑标记）→ 取消 pending；默认 `paused("user message")`，选项 `onUserMessage:"continue"` 时保留 active。
- `session.moved`/`session.deleted` → 清 LoopState，取消定时器。
- 取消语义：定时器可清；已 admitted 的 prompt 无法撤回 → 文档明示“取消仅对未 admitted 生效”（gotenksIN 的真实约束），并由 prompt hook 的 metadata 在准入层二次拦截（如果取消发生在准入前）。

停损判定（每次 boundary 结算）：
- `turns+1 > maxTurns` → `budget_limited`；
- `used.tokens+Δ > maxTokens` → `usage_limited`；
- `activeMs > maxDurationMs` → `budget_limited`；
- 连续 `noToolTurns ≥ noToolCallTurns` → `stalled`；
- 连续低输出（usage output delta < threshold，P1）→ `stalled`；
- 到限时发一条“收尾提示”（总结已完成/剩余/下一步），然后停（willytop8 的 wrap-up 思路）。

### 5.7 完成门禁（evidence.ts + verify.ts）

流程：

```
模型（或 /goal complete）→ goal_update{action:"complete", evidence:{candidateID, summary, criteria?}}
 1. 目标存在且 active（允许 paused？不允许——要求先 resume 或直接 active）
 2. candidateID 必须命中本会话、当前 goalID 之后记录的成功工具调用候选（排除 goal_*）
 3. summary ≥ 24 字符且含可检查锚点（路径/数字/命令输出片段/关键词），并与候选摘要有词面关联
 4. verification 层：
    - "evidence"（默认 P0）：1-3 通过即接受
    - "model"（推荐）：ctx.generate.text 让独立模型对 {objective, criteria, evidence, 最近检查点} 裁决
      APPROVE/REJECT；解析失败/超时 → REJECT（fail-closed）
    - "agent"（强）：创建验证子会话（parentID=本会话），提示词要求实际检查工作区并输出
      VERDICT: APPROVED|REJECTED；限制时限与轮次；超时至多重试 1 次；子会话结束即 remove
 5. 通过 → status=complete + evidence 落库 + history + 归档；失败 → status=paused(reason="verification rejected: …")
```

- 证据候选来源纪律：`shell/execute` 类工具只在明确成功（exit=0、非后台、未超时）时入候选；编辑类工具（edit/write/patch）入候选并标记 `progress`；所有候选带 `messageID` 以便追溯。
- 防重复：同一 CallID 只记一次；goal 更新/重置后清空候选（旧证据不能用于新目标）。
- `/goal clear` 门禁（借鉴 opencode2-goals）：命令路径由用户直接发起 → 允许；模型工具 `goal_clear` 需要引用用户原话且转录 grounding，否则拒绝（防止模型自行清除目标）。P0 可直接禁用工具的 clear（仅 get/update-complete/block），命令 clear 可用。

### 5.8 命令与工具面

`/goal`（`commandName` 可配）：

| 命令 | 行为 |
|---|---|
| `/goal` / `/goal status` | 本地渲染状态（objective/status/budget/用量/检查点/证据受理情况），synthetic 回执 |
| `/goal <objective>` / `/goal set <objective>` | 本地创建（解析 `--turns/--tokens/--minutes/--unbounded/--criteria/--constraints/--verify`），synthetic 回执 + prompt 启动 |
| `/goal pause` / `/goal resume` | 状态迁移（resume 清 blocker/recovered，开新表） |
| `/goal edit <objective>` | 修改目标文本（保留预算/历史） |
| `/goal block <reason>` | 记 blocker，paused/blocked |
| `/goal done <evidence>` | 走完成门禁（与工具同路径） |
| `/goal clear` / `/goal stop` | 归档并清除 |
| `/goal history` | 当前 + 归档历史（最近 N 条） |
| `/goal task add/done/doing <title/ref>`（P1） | 任务清单（状态注入 + TUI 展示） |

工具（`goal_*`，模型用）：

| 工具 | 说明 | 门禁 |
|---|---|---|
| `goal_get` | 返回目标状态 + 有效证据候选 ID + 预算 + 检查点 | 无 |
| `goal_set` | 仅当用户明确要求时创建；参数 objective/criteria/constraints/limits | 已有活动目标时拒绝（防模型偷换目标） |
| `goal_update` | action: pause/resume/block/complete；block 需 blocker；complete 需 evidence | 完成门禁；resume/block 无需额外门禁 |
| `goal_clear` | P0 禁用（提示用户用 `/goal clear`） | — |
| `goal_history` | 读取历史/归档 | 无 |

### 5.9 配置项与默认值（plugins 对象 options）

```jsonc
{
  "package": "@elegracer/opencode-goal",
  "options": {
    "autoContinue": true,
    "continuationIntervalMs": 1500,
    "maxTurnsDefault": 10,          // 0 表示默认无限？→ 用 unbounded 更明确
    "maxTokensDefault": 100000,     // 目标消耗 tokens
    "maxDurationMsDefault": 1800000,
    "noToolCallTurns": 2,
    "noProgressTurns": 2,
    "noProgressOutputTokens": 50,
    "verification": "model",        // "evidence" | "model" | "agent"
    "verifierModel": null,          // null=当前会话模型；可指定 provider/model
    "verifierTimeoutMs": 300000,
    "onUserMessage": "pause",       // "pause" | "continue"
    "wrapUpOnLimit": true,
    "commandName": "goal",
    "contextInjectionMaxChars": 4000,
    "persistCandidates": false,
    "sandbox": false                // P2
  }
}
```

有效限额解析优先级：`/goal` 命令 flags > 工具参数 > options 默认 > 内置默认；`--unbounded` 显式解除数字上限（仍保留 stall 判定）。

### 5.10 边界与错误处理

- **子会话**：不驱动续跑；`goal_get` 可读父目标；context 注入父目标（标注 `[delegated]`）；验证子会话用 metadata 显式标记，允许其“汇报裁定”。子会话用量不计入（P1 可聚合）。
- **compaction**：`compaction.started/ended` 标记；`compaction` hook 追加目标快照行；不设置 `result`；压缩期间的 boundary 不续跑，结束后正常。
- **重启**：`setup()` scan → active→paused(recovered)；不自动续跑；`/goal status` 显示 “recovered, run /goal resume”。
- **多 location**：只处理 `session.projectID === ctx.location.project.id && session.location.workspaceID === ctx.location.workspaceID`（在 session.get 失败/不匹配时跳过）。worktree 场景自然隔离。
- **事件流断开**：cleanup 里 abort；重连由宿主进程生命周期决定；`setup` 期间的事件丢失由 storage 状态兜底（例如 goal 可能停在 active——下次用户操作即可）。
- **模型不调工具**：续跑提示中始终附“本轮结束前至少调用一个工具或在回复中报告 blocker”；连续无工具 → stalled 暂停。
- **命令名冲突**（上游原生 goal）：检测 `ctx.command.list()` 是否已存在同名非本插件命令；如冲突且非本插件 → warn 并建议配置 `commandName`。

### 5.11 测试策略

Phase 0（探针，开发期一次性，代码进 `scripts/probe.ts`）验证宿主事实：
1. `session.idle` 是否投递给插件；`execution.succeeded` 与 idle 的先后。
2. 插件 `ctx.session.prompt` 是否触发 prompt hook、metadata 是否原样可见。
3. `session.synthetic` 消息在 TUI 是否可见。
4. 用户 ESC 时事件序列（interrupted reason / failed / status）。
5. 传输错误时 `retry.scheduled` 与 `execution.failed` 的时序。
6. `tool.execute.after` 的 `id` 与模型可见 tool call id 的一致性。
7. `ctx.storage` 的隔离范围与持久性。
8. `command.transform` execute 是否完全接管（原始文本不再进模型）。

单元/集成测试（bun test，CI 常态）：
- 纯函数：state/evidence/command 解析/options 校验/prompts 渲染。
- Harness：FakeCtx + 脚本化事件流，覆盖：
  - set→succeeded→续跑→工具→succeeded→complete（happy path）；
  - 重复 boundary 事件/乱序事件只续跑一次；
  - 用户插话暂停；resume 后继续；
  - user 中断 vs shutdown 中断差异；
  - failed+retry 不暂停，failed 无重试暂停；
  - 预算到限的三类状态与 wrap-up；
  - 证据候选伪造拒绝；model 验证 REJECT→paused；agent 验证超时→fail-closed；
  - 重启恢复 active→paused(recovered)；
  - 子会话不驱动、父目标注入。
- 宿主兼容：`tsc --noEmit` 对 `@opencode/plugin@2.0.22`；CI 另跑 `@latest` 类型检查（允许非阻塞告警）。
- 真实冒烟：`scripts/smoke.sh` 在临时目录用真实 `opencode2` 执行 `/goal status`、设目标、人为中断、resume、clear；核对 storage 状态与 TUI 表现。

### 5.12 里程碑

- **P0（正确性核心，1 个 PR 量级）**：options/types/state/store/controller；`/goal` 命令；`goal_get/set/update` 工具；context 注入；loop 续跑；用量预算；证据候选 + `verification:"model"`；重启恢复；单测 + harness。
- **P1（完整度）**：`verification:"agent"` 子会话验证；`goal_history`/归档；stall 的低输出判定；compaction 快照；任务清单；`/goal edit|block|history|task`；wrap-up 提示；探针脚本转成 CI 诊断。
- **P2（体验与安全）**：RPC + TUI 侧栏（`goal.*` 事件）；权限沙箱；多目标队列/ordered；跨会话 `goal list`；兼容矩阵 CI + 发布。

### 5.13 风险与缓解

| 风险 | 缓解 |
|---|---|
| 宿主 2.0.x 插件 API 漂移（beta 期） | 钉住 2.0.22；集中适配层（`ctx` 访问集中在 controller/adapter）；CI 跑 latest 类型面；README 兼容矩阵 |
| `session.idle` 投递不确定 | 以 execution.* 为准，idle 仅兜底 + 去重；Phase 0 实测后固化 |
| 模型伪造成果 | CallID 候选 + 结构锚点 + 独立 model/agent 验证，全程 fail-closed |
| 续跑重复/失控 | epoch+eventID 去重、pending/in-flight、冷却、默认上限、stall 检测、清理干净 |
| storage 无 CAS、多 server 竞写 | 单 server 假设文档化 + 进程内串行队列；不做易残留的文件锁 |
| TUI 组件编译/版本坑 | P2 独立导出、预编译 dist、CI 冒烟；不阻塞 P0/P1 |
| 与上游原生 goal 冲突 | `commandName` 配置、启动检测提示、工具名 `goal_*` 保持可让位 |

---

## 6. 差异化定位（为什么还要重写一个）

- `opencode2-goals` 最接近本方案，但（a）证据是纯启发式、没有独立模型/子会话验证；（b）默认预算策略与 UI/RPC 耦合较重（TUI 依赖 Solid 工具链）。
- `gotenksIN` 事件与证据候选做得好，但缺少独立验证、精确用量、恢复/压缩语义。
- `@bybrawe` 验证最强但过重；`@prevalentware` V2 路径不完整。
- 本方案的目标组合：**V2-only + 精确用量 + 工具证据链 + P0 即带独立模型验证（可选子会话强验证）+ 干净的重启/中断语义 + 可测试性优先的模块化**；不背 V1 包袱、不默认过度耦合 UI。

---

## 附录 A：主要参考

- OpenCode V2 插件文档：<https://opencode.ai/v2/docs/build/plugins>；RPC：<https://opencode.ai/v2/docs/build/plugins/rpc>；配置：<https://opencode.ai/v2/docs/plugins/>
- 本机核对包：`@opencode/plugin@2.0.22`、`@opencode/client@2.0.22`、`@opencode/schema@2.0.22`
- `opencode2-goals`：<https://github.com/wukrit/opencode2-goals>
- `opencode2-goal-plugin`：<https://github.com/gotenksIN/opencode2-goal-plugin>
- `@bybrawe/opencode-goal`：<https://github.com/ByBrawe/opencode-goal>
- `@prevalentware/opencode-goal-plugin`：<https://github.com/prevalentWare/opencode-goal-plugin>
- `opencode-goal-plugin`（V1）：<https://github.com/willytop8/OpenCode-goal-plugin>
- `@heimoshuiyu/opencode-goal-plugin`：npm
- `mweinbach/opencode-goals`：<https://github.com/mweinbach/opencode-goals>
- `devinoldenburg/opencode-goal-mode`：<https://github.com/devinoldenburg/opencode-goal-mode>
- 上游 PR：#32743、#32924、#33944

## 附录 B：待确认点（进入实现前需你拍板）

1. **包名**：建议 `@elegracer/opencode-goal`（npm 上 `opencode-goal-plugin` 已被占用）。
2. **默认验证档位**：建议 P0 默认 `verification:"model"`（每次完成多一次无工具模型调用，成本低）；`"agent"` 作为可选强验证。是否接受？
3. **默认上限**：建议默认 `10 turns / 100k tokens / 30 分钟`，`--unbounded` 显式解除。是否接受？
4. **用户插话语义**：建议默认暂停（`onUserMessage:"pause"`），可配继续。
5. **P0 是否需要 TUI 侧栏**：建议 P2；若你希望第一版就带，需要提前锁定 `@opentui` 版本与预编译方案。

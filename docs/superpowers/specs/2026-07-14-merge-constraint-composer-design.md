# Design: 合并追加约束输入框到主 Composer

## Summary

当前 Agent 运行时，界面会额外弹出一个「追加约束或修正当前计划」的输入框（`AgentRunControls` 中的 textarea），与底部主输入框（`ChatComposer`）并存，造成用户困惑和操作冗余。

本方案将两者合并：
- **主输入框在 Agent 运行时仍然可用**，作为追加约束/纠正的入口。
- **停止运行使用独立的停止按钮**，不与发送按钮共享位置，避免误操作。
- **Agent 未运行** → 行为保持现状，作为普通对话输入框。

为支持「过程中追加约束能尽快影响当前输出」，agent-bridge 在两层响应 steering：
1. **Loop boundary 消费（第一阶段）**：每次 model loop 结束后拉取 unconsumed steering，注入 context 后继续 loop。
2. **Mid-stream 中断（第二阶段）**：当 Agent 正在 LLM 流式生成时收到 steering，poller 检测并 abort 当前 stream，用更新后的 context 重新进入 model loop。

> **诚实声明**：当前 pi-runtime 是单循环结构，steering 只能在生成/工具边界被消费。即使加入 mid-stream 中断，也仍然要等当前生成段结束（秒级），无法做到逐 token 实时影响。本次实现先保证 loop boundary 可靠消费，再通过 poller 实现秒级 mid-stream 中断。

## Current State Analysis

### 前端现状

| 文件 | 关键职责 |
|---|---|
| `frontend/src/components/project/agent/ChatComposer.tsx` | 底部主输入框。当前支持 `isStreaming` + `onStop`，按钮在 streaming 时变成「停止」，不感知 run 状态。 |
| `frontend/src/components/project/agent/AgentRunControls.tsx` | 当前运行面板，内含独立 textarea +「追加约束」「调整计划」按钮，通过 `sendSteering` 发送 steering。 |
| `frontend/src/components/project/agent-sidebar.tsx` | 组合 ChatComposer 与 AgentRunControls；管理 `draft`、`submitMessage`、`onStopStreaming` 等状态与回调。 |
| `frontend/src/lib/useAgentConversationStream.ts` | `stop()` 仅 abort 当前 SSE 请求并 `streamCancel()`，**不会**通知 sidecar/backend 取消 run。 |
| `frontend/src/lib/api.ts` | 提供 `sendSteering(runId, type, content, clientId, metadata?)` 和 `cancelRun(runId, reason?)`。 |

### 运行时现状

| 文件 | 关键职责 |
|---|---|
| `agent-bridge/src/server/routes/steering.ts` | 处理 `POST /runs/:runId/steering`；`cancel` 类型调用 backend cancel，其余转发给 backend `appendSteering`。 |
| `agent-bridge/src/server/routes/cancel-run.ts` | `POST /runs/:runId/cancel` 仅修改 sidecar sessionStore 状态，**不会**调用 backend `/internal/agent-runs/:runId/cancel`。 |
| `agent-bridge/src/server/routes/start-run-stream.ts` | 启动 run，调用 `executeRun()`；初始 `pendingSteering` 为空。 |
| `agent-bridge/src/server/routes/resume-run.ts` | resume 时从 FastAPI snapshot 读取 `unconsumed_steering` 并传入 `executeRun()`。 |
| `agent-bridge/src/runtime/pi-runtime.ts` | 仅在 `executeRun()` 的 post-loop checkpoint 后消费 `input.pendingSteering`；**运行过程中不会主动拉取新的 steering**。 |
| `backend/app/services/agent_runtime_service.py::append_steering` | 将 steering 写入 `steering.queued` 事件，等待 run 消费。 |
| `backend/app/api/routes_agent_runtime.py::cancel_agent_run` | 将 backend run 状态改为 `cancelling`，sidecar 应检测并停止。 |

### 关键问题

1. **当前「停止」是假的**：前端 `stop()` 只 abort HTTP stream，backend/sidecar run 可能继续跑完。
2. **当前 steering 不会立即生效**：运行中发送的 steering 只是被 backend 排队，当前 run 不会中途读取它。
3. **输入框割裂**：同一个「追加约束」动作被放在两个不同的输入框里，违反单一路径原则。
4. **没有 mid-stream 中断机制**：即使发送 steering，也要等当前 LLM 调用或 tool 执行完才能被消费。

## Proposed Changes

### Phase 1: 前端合并 + 取消链路修复 + Loop Boundary Steering

#### 1. 前端：ChatComposer 支持运行时双模式

**文件**：`frontend/src/components/project/agent/ChatComposer.tsx`

**What**
- 新增 props：
  - `isRunning?: boolean` — 表示当前是否有未结束的 Agent run（而不仅是 streaming）。
  - `onSendSteering?: (content: string) => void | Promise<void>` — 在运行中发送追加约束。
  - `onCancelRun?: () => void | Promise<void>` — 真正取消当前 run。
- 保留现有 `onSubmit`、`onSlashSubmit`、`onStop`、`isStreaming` 等 props 以兼容非运行中场景。
- 运行时按钮逻辑：
  - `isRunning` 时，输入框右侧始终显示**独立的停止按钮**（`onCancelRun`）。
  - 同时显示发送按钮，仅在 `value.trim()` 非空且 `disabled` 为 false 时可用；点击调用 `onSendSteering(value)`。
  - `!isRunning` 时，保持现有行为（发送对话消息）。
- placeholder 在 `isRunning` 时变为 `追加约束或纠正当前运行...`。
- 运行中时禁用斜杠命令菜单（用户输入 `/` 按普通文本处理，不弹出菜单）。
- 发送 steering 成功后清空输入框。

**Why**
- 把「追加约束」合并到用户最熟悉的主输入框，减少认知负担。
- 停止按钮独立存在，避免与发送按钮共享位置导致的误操作。
- 用 `isRunning` 替代纯 `isStreaming` 作为运行时判定，避免 stream 断开但 run 仍在后台跑时按钮提前变回「发送」。

#### 2. 前端：AgentSidebar 组合新能力

**文件**：`frontend/src/components/project/agent-sidebar.tsx`

**What**
- 向 `ChatComposer` 传递 `isRunning={activeRunId != null && !runIsTerminal}`。
- 提供 `onSendSteering` 实现：
  - 调用 `sendSteering(activeRunId, "constraint", content, crypto.randomUUID())`。
  - ChatComposer 在 `onSendSteering` resolve 后内部清空输入框；AgentSidebar 不主动清空 `draft`。
  - 错误时显示 `conversationError`。
- 提供 `onCancelRun` 实现：
  - 调用 `cancelRun(activeRunId, "用户取消")`。
  - **必须等待 backend cancel 成功**后再调用 `onStopStreaming()` 清理前端 stream 状态。
  - 错误时显示 `conversationError`，**不清理 stream 状态**（避免前后端不一致）。
- 保留 `onStopStreaming` 给非运行时/兼容性场景。
- **Run 开始时清空 draft**：当 `isRunning` 从 false 变为 true 时，如果 `draft` 非空，自动清空。

#### 3. 前端：精简 AgentRunControls 并展示 steering 历史

**文件**：`frontend/src/components/project/agent/AgentRunControls.tsx`

**What**
- 删除约束输入 textarea 和「追加约束 / 调整计划」按钮组。
- 保留：
  - 当前运行状态展示。
  - 「恢复运行」按钮（断线场景）。
  - 审批面板 `awaitingApproval`（与主输入框无关，保留）。
  - 状态/错误提示。
- 新增「已追加约束」列表：从 backend run snapshot 的 `unconsumed_steering` / `consumed_steering` 中读取当前 run 的 steering 记录，以时间顺序展示在面板中。

#### 4. Agent Bridge：运行时 steering 消费与 loop boundary

**文件**：`agent-bridge/src/runtime/pi-runtime.ts`

**What**
- 每次 model loop 结束后、verifier 之前，调用 `fastapiClient.getRunSnapshot(runId)` 拉取 unconsumed steering。
- 发现 steering 时：
  - 过滤掉已消费 seq。
  - 遇到 `cancel` 类型立即 terminal。
  - 其他类型注入 context，重新进入一次 model loop。
- 最大 steering loop 次数：`MAX_STEERING_LOOPS = 5`。

#### 5. Agent Bridge：将 steering 注入 prompt context

**文件**：`agent-bridge/src/runtime/context-builder.ts`

**What**
- `ContextBuildInput` 新增可选字段 `pendingSteering?: PendingSteeringEvent[]`。
- 在 context builder 中把 steering 作为独立 `required` block 注入，避免被 compaction 丢弃。
- 对 `clarification_answer` 类型的 steering，转换为 `<user_answer>` 块。
- 注入前对内容做 XML 转义，防止指令注入。

#### 6. Agent Bridge：真正取消运行链路

**文件**：`agent-bridge/src/server/routes/cancel-run.ts`

**What**
- 在修改 sessionStore 状态后，**同步调用** `ctx.fastapiClient.cancelRun(runId, reason)`。
- backend cancel 失败时返回 5xx 错误，不假装成功。

### Phase 2: Mid-stream Steering 中断

#### 7. Agent Bridge：SteeringPoller

**文件**：`agent-bridge/src/runtime/steering-poller.ts`

**What**
- 轻量 poller，在 run 处于 `model_streaming` 阶段时启动。
- 定期（1500ms）调用 `getRunSnapshot` 检查 unconsumed steering。
- 发现新 steering 时：
  - 调用 `sessionStore.markSteeringAvailable(runId)`。
  - 调用 `sessionStore.abort(runId, "steering_available")` 中断当前 stream。
- 连续失败 3 次后停止 poller，降级为 loop boundary 消费。

#### 8. Agent Bridge：session-store 扩展

**文件**：`agent-bridge/src/runtime/session-store.ts`

**What**
- `abort(runId, reason?)` 支持可选 reason。
- 新增 `markSteeringAvailable` / `consumeSteeringAvailable`。

#### 9. Agent Bridge：pi-runtime 重入循环

**文件**：`agent-bridge/src/runtime/pi-runtime.ts`

**What**
- `executeRun` 启动 poller，在 terminal/catch 中停止。
- 捕获 abort 时区分 reason：
  - `"steering_available"` → 不 terminal，进入 steering 消费循环。
  - `"user_cancelled"` 或外部取消 → terminal cancelled。
- 消费 steering 后重新 `buildContext` 并调用 `runAgentLoop`。

## UI/UX Details

### 按钮状态与视觉反馈

| 场景 | placeholder | 主按钮 | 停止按钮 |
|---|---|---|---|
| 未运行 | `告诉 Agent 你想推进什么...` | 发送（绿色） | 无 |
| 运行中，空输入 | `追加约束或纠正当前运行...` | 禁用 | 停止（红色） |
| 运行中，有文字 | `追加约束或纠正当前运行...` | 发送（绿色） | 停止（红色） |

- 停止按钮始终独立显示在运行中状态，不与发送按钮共享位置。
- 发送 steering 期间按钮显示 loading spinner，禁止重复发送。

### Steering 历史展示

- 位置：`AgentRunControls` 面板内，状态文字下方。
- 内容：仅展示当前 run 的 steering，按时间顺序。
- 样式：小型卡片，显示内容前 50 字 + 相对时间（如「3 秒前」）。
- 更新时机：轮询 snapshot 时刷新。

### 状态提示

- 发送 steering 后：输入框上方显示「约束已加入当前运行」，2 秒后淡出。
- 达到 MAX_STEERING_LOOPS 时：显示「已收到多条约束，Agent 在本次回复中综合处理」。
- 取消运行时：显示「已停止运行」，然后隐藏。

## Assumptions & Decisions

1. **统一 steering 类型**：运行中主输入框发送的 steering 统一使用 `steering_type = "constraint"`，不区分 `plan_change` / `clarification_answer`。由 Agent 根据内容自行理解。
2. **运行中禁用斜杠命令菜单**：避免用户误把 `/plan` 等命令当约束发送。
3. **isRunning 判定**：以 `activeRunId != null` 且 run 未 terminal 为准，而不是 `isStreaming`。
4. **取消必须同步 backend**：`onCancelRun` 必须等待 backend cancel 成功后再清理前端状态；失败时提示用户。
5. **Steering 消费上限**：最多连续消费 5 轮 steering。
6. **不持久化 steering 到对话历史**：steering 走 run 事件，不写入 `AgentMessage`。
7. **AgentRunControls 保留审批**：`awaitingApproval` 的审批按钮独立存在。
8. **Mid-stream 中断仅针对 LLM 流式生成阶段**：tool 执行期间不中断。
9. **Run 开始时清空前端 draft**：避免旧草稿被误当约束。
10. **Steering poller 是辅助机制**：poller 失败不阻塞主 run，降级为 loop boundary 消费。

## Adversarial Review

### 问题 1：用户需求「尽量立刻影响当前输出」与架构现实的差距

**风险**：当前 pi-runtime 是单循环结构，steering 只能在生成/工具边界被消费。

**结论**：明确这是「秒级中断」而非「token 级实时影响」。Phase 1 先保证 loop boundary 可靠消费，Phase 2 再用 poller 优化。

### 问题 2：Mid-stream 中断是否安全

**风险**：abort 当前 stream 后，已部分生成并持久化的事件不会回滚。

**缓解**：
- Pi `runAgentLoop` 支持 AbortSignal 中断。
- 重新 loop 时从 durable snapshot 恢复上下文，不依赖未完成的 stream 输出。
- 测试验证重新生成内容完整、不重复。

### 问题 3：Tool 执行期间无法中断

**风险**：Agent 调用 tool 时用户发送 steering 必须等 tool 完成。

**缓解**：
- UI 显示「Agent 正在执行工具，约束将在工具完成后生效」。
- Tool 执行不可中断是正确设计选择。

### 问题 4：按钮状态切换可能导致误触

**风险**：原本方案把停止和发送放在同一按钮，依赖输入框是否有文字切换。

**决策**：改为**独立停止按钮 + 发送按钮**。停止按钮始终可见，发送按钮仅在输入非空时可用。

### 问题 5：isRunning 判定不准确

**风险**：`activeRunId` 来自 stream status，stream 完成或断开后可能被清空，但 backend run 还在跑。

**缓解**：
- `isRunning` 同时考虑 `activeRunId` 和 `AgentRunControls` 轮询到的 snapshot status。
- snapshot 显示 run 为 `completed/cancelled/failed` 时才认为运行结束。

### 问题 6：当前「停止」链路不完整

**风险**：`useAgentConversationStream.stop()` 只 abort 前端 stream。

**缓解**：
- `onCancelRun` 调用 `/runs/:runId/cancel`。
- sidecar `cancel-run.ts` 同步调用 backend cancel，失败时返回错误。

### 问题 7：Cancel 与 in-flight steering 的竞态

**风险**：用户发送 steering 后立即点击停止。

**决策**：cancel 具有最高优先级。backend `append_steering` 必须拒绝 terminal/cancelling 状态的 run；sidecar 消费 steering 前检查 run 状态。

### 问题 8：MAX_STEERING_LOOPS 溢出行为

**风险**：第 6 条及以后的 steering 会被静默丢失。

**决策**：达到上限后不再消费新 steering，但 backend 仍会接收排队。当前 run 结束后这些 steering 保留在 snapshot 中，可在 resume 或下次 run 时消费。UI 提示用户。

### 问题 9：Context token 预算爆炸

**风险**：每次重新 loop 都会把 steering 加入 prompt。

**缓解**：
- steering 作为独立 required block 注入，受 context budget 管理。
- 只保留最近 5 条 steering。
- 超过最大 loop 次数后不再追加新 steering。

### 问题 10：Poller 增加网络开销

**风险**：高频轮询增加 backend 负载。

**缓解**：
- poller 间隔 1500ms。
- 使用 3s 超时，失败时不阻塞主 run。
- 连续失败 3 次后停止 poller。

## Verification Steps

### 前端

1. `ChatComposer` 测试：
   - 运行时 + 空输入 → 停止按钮可见，发送按钮禁用。
   - 运行时 + 有文字 → 停止按钮和发送按钮都可见，点击发送触发 `onSendSteering`。
   - 非运行时 → 保持原有发送对话消息行为。
   - 运行时输入 `/` 不弹出斜杠菜单。
   - placeholder 随 `isRunning` 切换。
2. `AgentSidebar` 测试：
   - 运行时发送 steering 调用 `sendSteering`。
   - 取消调用 `cancelRun` 成功后才调用 `onStopStreaming`。
3. `AgentRunControls` 测试：
   - 删除约束相关用例后仍通过。
   - 审批面板仍存在。
   - steering 历史展示正确。
4. `npm run test`、`npm run lint`、`npm run build` 通过。

### Agent Bridge

1. `pi-runtime.test.ts` 新增测试：
   - loop boundary 消费 steering 后继续执行。
   - 收到 `cancel` steering 立即终止。
   - 超过最大 steering loop 次数后强制 terminal。
2. `context-builder.test.ts` 新增测试：
   - steering 事件正确注入 prompt。
   - 内容中的 `<`、`>` 被转义。
3. `cancel-run` 路由测试：
   - 调用 backend cancel API。
   - backend 失败时返回错误。
4. `steering-poller.test.ts` 测试：
   - 发现新 steering 时 abort session。
   - 连续失败后停止。
5. `npm run test`（agent-bridge）通过。

### 集成

1. 启动前后端，触发一次 Agent run：
   - Agent 正在生成文字时输入约束并发送，观察生成中断并重新生成（Phase 2）。
   - Agent 正在执行 tool 时发送约束，观察 tool 完成后 loop boundary 消费 steering（Phase 1）。
   - 运行时点击停止，观察 backend run 状态变为 `cancelled`。
2. 检查浏览器网络面板：
   - 追加约束请求发送到 `/runs/:runId/steering`。
   - 停止请求发送到 `/runs/:runId/cancel`。
3. 检查 steering 历史是否正确展示。

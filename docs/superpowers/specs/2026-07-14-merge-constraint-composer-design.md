# Design: 合并追加约束输入框到主 Composer

## Summary

当前 Agent 运行时，界面会额外弹出一个「追加约束或修正当前计划」的输入框（`AgentRunControls` 中的 textarea），与底部主输入框（`ChatComposer`）并存，造成用户困惑和操作冗余。

本方案将两者合并：
- **主输入框在 Agent 运行时仍然可用**，根据输入框内容在「发送」与「停止」之间切换角色。
- **输入框为空 + run 进行中** → 按钮为「停止」，点击后真正取消整个 Agent run（而不是仅 abort SSE）。
- **输入框有文字 + run 进行中** → 按钮为「发送」，点击后将文字作为 steering 事件追加给当前 run。
- **Agent 未运行** → 行为保持现状，作为普通对话输入框。

为支持「过程中追加约束能尽快影响当前输出」，agent-bridge 需要在两个层面响应 steering：
1. **Mid-stream 中断**：当 Agent 正在 LLM 流式生成时收到 steering，立即 abort 当前 stream，用更新后的 context 重新进入 model loop。
2. **Loop boundary 兜底**：当 Agent 处于 tool 执行、checkpoint 等非流式阶段时，在 loop boundary 拉取 unconsumed steering 并继续 loop。

> **诚实声明**：由于当前 pi-runtime 是单循环结构， steering 只能在生成/工具边界被消费，无法做到「逐 token 实时影响」。Mid-stream 中断可以让约束在「下一个生成片段」生效，但仍需等待当前生成段结束（通常秒级），这与 ChatGPT/Claude 等成熟产品一致。

## Current State Analysis

### 前端现状

| 文件 | 关键职责 |
|---|---|
| `frontend/src/components/project/agent/ChatComposer.tsx` | 底部主输入框。已支持 `isStreaming` + `onStop`，按钮在 streaming 时变成「停止」，但当前不感知输入框是否有草稿。 |
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

### 1. 前端：ChatComposer 支持运行时双模式

**文件**：`frontend/src/components/project/agent/ChatComposer.tsx`

**What**
- 新增 props：
  - `isRunning?: boolean` — 表示当前是否有未结束的 Agent run（而不仅是 streaming）。
  - `onSendSteering?: (content: string) => void | Promise<void>` — 在运行中发送追加约束。
  - `onCancelRun?: () => void | Promise<void>` — 真正取消当前 run。
- 保留现有 `onSubmit`、`onSlashSubmit`、`onStop`、`isStreaming` 等 props 以兼容非运行中场景。
- 运行时按钮逻辑：
  - `isRunning && !value.trim()` → 显示「停止」按钮，点击 `onCancelRun`。
  - `isRunning && value.trim()` → 显示「发送」按钮，点击 `onSendSteering(value)`。
  - `!isRunning` → 保持现有行为（发送对话消息）。
- placeholder 在 `isRunning` 时变为 `追加约束或纠正当前运行...`。
- 运行中时禁用斜杠命令菜单（用户输入 `/` 按普通文本处理，不弹出菜单）。
- 发送 steering 成功后清空输入框。

**Why**
- 把「追加约束」与「停止运行」合并到用户最熟悉的主输入框，减少认知负担。
- 用 `isRunning` 替代纯 `isStreaming` 作为运行时判定，避免 stream 断开但 run 仍在后台跑时按钮提前变回「发送」。

**How**
- 在 `handleSubmit` 中增加分支：
  ```ts
  if (isRunning) {
    if (value.trim()) {
      await onSendSteering?.(value.trim());
      onChange("");
    }
    return;
  }
  ```
- 在渲染按钮处分三种状态渲染。
- 新增/更新单元测试覆盖：空输入停止、有输入发送、placeholder 切换、斜杠菜单禁用。

### 2. 前端：AgentSidebar 组合新能力

**文件**：`frontend/src/components/project/agent-sidebar.tsx`

**What**
- 向 `ChatComposer` 传递 `isRunning={activeRunId != null && !runIsTerminal}`（terminal 状态从 AgentRunControls 轮询的 snapshot 或 streamTurn 状态推导）。
- 提供 `onSendSteering` 实现：
  - 调用 `sendSteering(activeRunId, "constraint", content, crypto.randomUUID())`。
  - ChatComposer 在 `onSendSteering` resolve 后内部清空输入框；AgentSidebar 不主动清空 `draft`。
  - 错误时显示 `conversationError` 或临时 toast。
- 提供 `onCancelRun` 实现：
  - 调用 `cancelRun(activeRunId, "用户取消")`。
  - 成功后调用现有 `onStopStreaming()` 以清理前端 stream 状态。
  - 错误时回退到 `onStopStreaming()` 并提示用户。
- 保留 `onStopStreaming` 给非运行时/兼容性场景。
- **Run 开始时清空 draft**：当 `isRunning` 从 false 变为 true 时，如果 `draft` 非空，自动清空（避免用户把上一轮对话的草稿误当约束发送）。

**Why**
- `AgentSidebar` 是唯一知道 `activeRunId` 和当前用户身份的地方，适合作为 orchestrator。
- 真正取消需要调用 backend cancel API，而不是仅 abort 前端 stream。
- 清空 draft 避免「停止/发送」按钮状态因旧草稿而错误切换。

**How**
- 新增局部状态 `runStatus`（从 `AgentRunControls` 的 snapshot 同步上来，或复用 `streamStatus`）。
- 把 `onSendSteering` 和 `onCancelRun` 作为回调传给 `ChatComposer`。
- 用 `useEffect` 监听 `isRunning` 变化，true 时清空 `draft`。

### 3. 前端：精简 AgentRunControls 并展示 steering 历史

**文件**：`frontend/src/components/project/agent/AgentRunControls.tsx`

**What**
- 删除约束输入 textarea 和「追加约束 / 调整计划」按钮组。
- 保留：
  - 当前运行状态展示。
  - 「恢复运行」按钮（断线场景）。
  - 审批面板 `awaitingApproval`（与主输入框无关，保留）。
  - 状态/错误提示。
- 新增「已追加约束」列表：从 backend run snapshot 的 `unconsumed_steering` / `consumed_steering` 中读取当前 run 的 steering 记录，以时间顺序展示在面板中。
- 「停止运行」按钮可移除或改为只读指示，因为 ChatComposer 已承担停止入口。

**Why**
- 避免两个输入框并存，消除用户困惑。
- 审批面板是独立交互，不受本次合并影响。
- 用户需要看到自己发送过的约束，否则会有「发完就消失」的不安全感。

**How**
- 删除 `draft`、`busy`、`steer` 中关于 constraint/plan_change 的分支。
- 新增 `SteeringHistory` 子组件，展示 steering 类型、内容、时间。
- 更新测试：删除追加约束相关用例，保留恢复/审批用例，新增 steering 历史展示用例。

### 4. Agent Bridge：运行时 steering 消费与 mid-stream 中断

**文件**：`agent-bridge/src/runtime/pi-runtime.ts`、`agent-bridge/src/server/routes/steering.ts`、`agent-bridge/src/runtime/session-store.ts`

**What**
- 为每个执行中的 run 启动一个轻量 steering poller，定期（如每 500ms）调用 `fastapiClient.getRunSnapshot(runId)` 检查 `unconsumed_steering`。
- Poller 发现新的非 cancel steering 时：
  - 调用 `sessionStore.markSteeringAvailable(runId)`。
  - 调用 `sessionStore.abort(runId, "steering_available")` 中断当前 stream。
- `executeRun()` 在 model loop 中捕获 abort，如果 abort reason 是 `"steering_available"`：
  - 不 terminal，进入 steering 消费函数。
  - 拉取 unconsumed steering，注入 context，重新进入 model loop。
- 如果 abort reason 是 `"user_cancelled"` 或 signal 被外部取消：
  - 进入 terminal 流程，状态为 `cancelled`。
- Loop boundary 兜底：每次 model loop 结束后、verifier 之前，再拉取一次 unconsumed steering；如有则继续 loop，无则 verifier。
- 最大 steering loop 次数：`MAX_STEERING_LOOPS = 5`。超过后：
  - 不再拉取/消费新的 steering。
  - 当前已收集的 steering 会作为最后一批注入 context。
  - 进入 verifier 并 terminal。
  - 前端通过 snapshot 提示用户：「已收到多条约束，Agent 在本次回复中综合处理」。

**Why**
- Mid-stream 中断是实现「尽量立刻影响当前输出」的关键。
- Loop boundary 兜底覆盖 tool 执行、checkpoint 等非流式阶段。
- 最大 loop 次数防止恶意刷屏和预算失控。

**How**
- 新增 `SteeringPoller` 类：
  ```ts
  class SteeringPoller {
    async start(runId: string, intervalMs = 500) {
      // 轮询 getRunSnapshot，发现新 steering 则 abort
    }
    stop() { /* 清理 timer */ }
  }
  ```
- 在 `executeRun` 开头启动 poller，在 terminal/catch 块中停止。
- 修改 `runAgentLoop` 的 catch 逻辑：
  ```ts
  if (abortReason === "steering_available") {
    // 消费 steering 并 continue main loop
  } else if (abortReason === "user_cancelled" || externalSignal) {
    // terminal cancelled
  }
  ```
- 新增/更新 pi-runtime 单元测试：mid-stream steering 中断、loop boundary 消费、最大次数、cancel 立即生效、poller 超时失败降级。

### 5. Agent Bridge：将 steering 注入 prompt context

**文件**：`agent-bridge/src/runtime/context-builder.ts`

**What**
- `ContextBuildInput` 新增可选字段 `pendingSteering?: PendingSteeringEvent[]`。
- 在组装 user/system prompt 时，如果存在 steering 事件（非 cancel），以中文列表形式加入：
  ```
  <user_steering>
  用户追加约束：
  1. 不要修改截止日期
  2. 优先保留 MVP 任务
  </user_steering>
  ```
- 对 `clarification_answer` 类型的 steering，转换为：
  ```
  <user_answer>
  用户回答：...
  </user_answer>
  ```
- 注入前对内容做 `html.escape()` 转义，防止指令注入。

**Why**
- 没有注入，steering 就只是数据库里的记录，Agent 看不到。
- 用明确的 XML 标签隔离用户数据，防止指令注入。

**How**
- 在 `buildContext` 中新增 `formatSteeringEvents` helper。
- 将 steering 文本经转义后插入 prompt。
- 更新 `context-builder.test.ts` 验证 steering 注入格式和转义。

### 6. Agent Bridge：真正取消运行链路

**文件**：`agent-bridge/src/server/routes/cancel-run.ts`、`agent-bridge/src/server/routes/steering.ts`

**What**
- `cancel-run.ts` 在修改 sessionStore 状态后，**同时调用** `ctx.fastapiClient.cancelRun(runId, reason)`，让 backend run 也进入 `cancelling`。
- `cancel-run.ts` 调用 `sessionStore.abort(runId, "user_cancelled")` 时带上 reason，便于 pi-runtime 区分是 steering 还是用户取消。
- `steering.ts` 中 `steering_type === "cancel"` 的分支保持调用 backend cancel（当前已实现），并额外 abort sidecar session。

**Why**
- 当前「停止」只是前端 abort，backend run 状态不一致，会导致 steering 还能继续写入、resume 状态混乱。
- 真正取消必须让 backend 状态机参与进来。
- 区分 abort reason 是 mid-stream steering 中断 vs 用户取消的前提。

**How**
- 在 `cancel-run.ts` 的 `ctx.sessionStore.abort(runId)` 之后调用 `ctx.fastapiClient.cancelRun(runId, reason ?? "user_cancelled")`。
- 添加错误处理：backend cancel 失败时仍返回 200，但记录日志。
- 修改 `sessionStore.abort` 支持可选 reason 参数。

### 7. Agent Bridge：Poller 超时与失败降级

**文件**：`agent-bridge/src/runtime/pi-runtime.ts`、`agent-bridge/src/tools/fastapi-client.ts`

**What**
- `getRunSnapshot()` 在 poller 内部设置较短超时（如 3s），失败时视为「无 steering」，不阻塞当前 run。
- 连续失败 3 次后停止 poller，避免反复请求失败的 backend。
- Loop boundary 的 `getRunSnapshot()` 同样设置超时，失败时进入 verifier/terminal。

**Why**
- 避免 backend 慢或网络抖动时拖垮 Agent 运行。
- Poller 是辅助机制，不能因为轮询失败而中断主任务。

**How**
- 在 `fastapiClient.getRunSnapshot` 增加 `timeoutMs` 参数，默认 10s，poller 传 3s。
- Poller 内部 catch 错误，记录 warning，不抛出。

### 8. 后端：保持现状即可

**文件**：无需改动 `backend/app/services/agent_runtime_service.py` 或 `backend/app/api/routes_agent_runtime.py`

- `append_steering` 已经正确排队。
- `cancel_agent_run` 已经正确将状态改为 `cancelling`。
- 本次改动主要集中在前端和 agent-bridge。

## UI/UX Details

### 按钮状态与视觉反馈

| 场景 | placeholder | 按钮 | 颜色 |
|---|---|---|---|
| 未运行 | `告诉 Agent 你想推进什么...` | 发送 | 绿色/苔藓色 |
| 运行中，空输入 | `追加约束或纠正当前运行...` | 停止 | 红色/珊瑚色 |
| 运行中，有文字 | `追加约束或纠正当前运行...` | 发送 | 绿色/苔藓色 |

- 按钮图标：停止用 `Square` 或 `Pause`，发送用 `Send`。
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
2. **运行中禁用斜杠命令菜单**：避免用户误把 `/plan` 等命令当约束发送。若未来需要支持运行时 slash 命令，可单独扩展。
3. **isRunning 判定**：以 `activeRunId != null` 且 run 未 terminal 为准，而不是 `isStreaming`。
4. **取消必须同步 backend**：`onCancelRun` 优先调用 backend cancel API；失败时回退到前端 abort。
5. **Steering 消费上限**：最多连续消费 5 轮 steering，第 6 轮起不再消费，已收集的 steering 作为最后一批注入 context，并在 UI 提示用户。
6. **不持久化 steering 到对话历史**：steering 走 run 事件，不写入 `AgentMessage`，避免污染会话上下文。
7. **AgentRunControls 保留审批**：`awaitingApproval` 的审批按钮独立存在，不由主输入框替代。
8. **Mid-stream 中断仅针对 LLM 流式生成阶段**：tool 执行期间不中断，避免副作用残留。
9. **Run 开始时清空前端 draft**：避免旧草稿被误当约束。
10. **Steering poller 是辅助机制**：poller 失败不阻塞主 run，仅降级为 loop boundary 消费。

## Verification Steps

### 前端

1. `ChatComposer` 新增/更新测试：
   - 运行时 + 空输入 → 停止按钮可见，点击触发 `onCancelRun`。
   - 运行时 + 有文字 → 发送按钮可见，点击触发 `onSendSteering` 并清空输入框。
   - 非运行时 → 保持原有发送对话消息行为。
   - 运行时输入 `/` 不弹出斜杠菜单。
   - placeholder 随 `isRunning` 切换。
   - run 开始时清空 draft。
2. `AgentSidebar` 测试：
   - 运行时发送 steering 调用 `sendSteering`。
   - 取消调用 `cancelRun` 后再调用 `onStopStreaming`。
3. `AgentRunControls` 测试：
   - 删除约束相关用例后仍通过。
   - 审批面板仍存在。
   - steering 历史展示正确。
4. `npm run test`、`npm run lint`、`npm run build` 通过。

### Agent Bridge

1. `pi-runtime.test.ts` 新增测试：
   - mid-stream steering 触发 abort 并重入 loop。
   - loop boundary 消费 steering 后继续执行。
   - 收到 `cancel` steering 立即终止。
   - 超过最大 steering loop 次数后强制 terminal。
   - poller 超时失败不阻塞 run。
2. `context-builder.test.ts` 新增测试：
   - steering 事件正确注入 prompt。
   - 内容中的 `<`、`>` 被转义。
3. `cancel-run` 路由测试：
   - 调用 backend cancel API。
   - abort reason 正确传递。
4. `steering` 路由测试：
   - 非 cancel steering 触发 poller/abort 路径。
5. `npm run test`（agent-bridge）通过。

### 集成

1. 启动前后端，触发一次 Agent run：
   - Agent 正在生成文字时输入约束并发送，观察生成中断并重新生成。
   - Agent 正在执行 tool 时发送约束，观察 tool 完成后 loop boundary 消费 steering。
   - 运行时点击停止，观察 backend run 状态变为 `cancelled`。
2. 检查浏览器网络面板：
   - 追加约束请求发送到 `/runs/:runId/steering`。
   - 停止请求发送到 `/runs/:runId/cancel`。
3. 检查 steering 历史是否正确展示。

## Adversarial Review

以下从第一性原理出发，对方案进行自我挑战和缺陷扫描。

### 问题 1：用户需求「尽量立刻影响当前输出」与架构现实的差距

**风险**：当前 pi-runtime 是单循环结构， steering 只能在生成/工具边界被消费。即使加入 mid-stream 中断，也仍然要等当前生成段结束（秒级），无法做到逐 token 实时影响。

**结论**：在方案中明确说明这是「秒级中断」而非「token 级实时影响」，与 ChatGPT/Claude 主流体验一致。如果用户期望真正的逐 token 影响，需要重构 runtime 为 streaming-native 架构，这超出本次范围。

**缓解**：
- UI 上提示「约束已加入，Agent 将在下一秒生成中考虑」。
- 第一阶段实现 mid-stream 中断；后续如需要更细粒度，再评估 streaming-native 重构。

### 问题 2：Mid-stream 中断是否安全

**风险**：abort 当前 stream 后，Pi runtime 内部状态（如已部分写入的 assistant message）可能不一致，重新 loop 时可能重复或丢失内容。

**缓解**：
- 在 abort 前确保当前 turn 的 assistant message 不被持久化到 conversation。
- 重新 loop 时从 checkpoint 恢复，不依赖未完成的 stream 输出。
- 测试验证：abort 后重新生成的内容完整、不重复。

### 问题 3：Tool 执行期间无法中断

**风险**：如果 Agent 正在调用 tool（如创建 risk/task），用户发送 steering 后必须等 tool 完成。如果 tool 是耗时操作，用户会觉得约束没有生效。

**缓解**：
- UI 上显示「Agent 正在执行工具，约束将在工具完成后生效」。
- Tool 执行本身不可中断，这是正确的设计选择（避免数据库/文件系统不一致）。

### 问题 4：按钮状态切换可能导致误触

**风险**：用户想停止运行，但输入框里还有上次没清掉的草稿，导致按钮是「发送」而不是「停止」，点击后发了不期望的约束。

**缓解**：
- run 开始时自动清空 `draft`。
- 运行时 placeholder 明确提示「追加约束或纠正当前运行...」。
- 停止按钮使用红色/珊瑚色，发送按钮保持绿色/苔藓色，视觉区分明确。

### 问题 5：isRunning 判定不准确

**风险**：`activeRunId` 来自 stream status，stream 完成或断开后 `activeRunId` 可能被清空，但 backend run 还在跑。此时按钮提前变回「发送」，用户可能发起新的对话消息，导致状态混乱。

**缓解**：
- `isRunning` 同时考虑 `activeRunId` 和 `AgentRunControls` 轮询到的 snapshot status。
- 在 `AgentSidebar` 中维护 `runStatus`，snapshot 显示 run 为 `completed/cancelled/failed` 时才认为运行结束。
- 即使 `activeRunId` 丢失，snapshot 显示 run 仍在运行时按钮保持「停止」。

### 问题 6：当前「停止」链路不完整

**风险**：现在 `useAgentConversationStream.stop()` 只 abort 前端 stream。如果用户点击 ChatComposer 的「停止」，backend/sidecar run 继续执行，可能产生副作用（如创建 proposal）。

**缓解**：
- `onCancelRun` 调用 `/runs/:runId/cancel`。
- sidecar `cancel-run.ts` 同时调用 backend cancel，确保 backend 状态同步。
- pi-runtime 检测 abort reason，用户取消时优雅 terminal。

### 问题 7：Cancel 与 in-flight steering 的竞态

**风险**：用户发送 steering 后立即点击停止。steering 已在网络中或已排队，cancel 随后到达。结果是 steering 被消费还是丢弃？

**决策**：cancel 具有最高优先级。一旦 cancel 请求发出，后续 steering 不再被消费。已在 backend 排队的 steering 由 loop boundary 拉取时检查 run 状态：如果 run 已 cancelling/cancelled，则忽略 unconsumed steering。

**缓解**：
- frontend 发送 cancel 后立即禁用输入框，阻止新的 steering 发送。
- backend `append_steering` 检查 run 状态，如已 terminal 则拒绝写入并返回错误。
- pi-runtime 消费 steering 前检查 run 状态。

### 问题 8：MAX_STEERING_LOOPS 溢出行为

**风险**：第 6 条及以后的 steering 会被静默丢失，用户不知道。

**决策**：
- 达到上限后，pi-runtime 不再主动拉取/消费新的 steering。
- 但 backend 仍会接收并排队 steering（前端发送成功）。
- 当前 run 结束后，这些 steering 保留在 snapshot 中，可在 resume 或下一次 run 时消费。
- UI 提示用户：「已收到多条约束，Agent 在本次回复中综合处理；后续约束将在下次运行时继续考虑」。

### 问题 9：Context token 预算爆炸

**风险**：每次重新 loop 都会把 steering 加入 prompt，多次循环后 prompt 越来越长。

**缓解**：
- 复用现有 context compaction 机制。
- steering 块标记为 `must` 保留，但只保留最近 5 条。
- 超过最大 loop 次数后不再追加新 steering。

### 问题 10：Poller 增加网络开销与失败风险

**风险**：每 500ms 调用一次 `getRunSnapshot`，增加 backend 负载；如果 backend 慢，可能阻塞 run。

**缓解**：
- poller 使用 3s 超时，失败时不阻塞主 run。
- 连续失败 3 次后停止 poller，降级为 loop boundary 消费。
- 仅在 run 处于 model_streaming 阶段时启动高频 poller；其他阶段降低频率或暂停。

### 问题 11：Steering 消息在 UI 中没有可见归属

**风险**：删除 AgentRunControls textarea 后，用户不知道自己发过的约束在哪里。

**缓解**：
- 在 `AgentRunControls` 中新增「已追加约束」列表。
- 发送 steering 后显示短暂 toast：「约束已发送」。

### 问题 12：并发 steering 写入顺序

**风险**：用户快速连按 Enter 发送多条约束，由于网络异步，后发送的可能先到达 backend。

**缓解**：
- 前端发送 steering 期间禁用发送按钮（显示 loading）。
- backend 按 `event_seq` 排序消费，不按到达顺序。
- UI 上以本地发送时间顺序展示。

### 问题 13：Resume 兼容性

**风险**：修改 pi-runtime 的循环结构后，resume 路径可能出错。

**缓解**：
- resume 仍通过 `resumeContext.pendingSteering` 传入 steering，与循环结构解耦。
- 循环开始时先消费 resumeContext 中的 steering，再启动 poller 进入拉取循环。
- 为 resume + steering 场景增加专门测试。

### 问题 14：Placeholder 和文案歧义

**风险**：用户不确定运行时输入框是发消息还是发约束。

**缓解**：
- placeholder 明确写「追加约束或纠正当前运行...」。
- 运行时输入框上方显示 microcopy：「Agent 正在运行，可在此追加约束」。
- 发送 steering 后显示短暂提示：「约束已发送」。

### 问题 15：Mid-stream 中断的测试困难

**风险**：Mid-stream 中断涉及时间、网络、异步 abort，单元测试难以稳定复现。

**缓解**：
- 用 mock timer 和 mock Pi stream 控制时间。
- 测试覆盖「poller 在 stream 期间触发 abort」和「abort reason 正确识别」两个关键点。
- 集成测试在真实 SSE 场景下验证中断效果。

### 问题 16：与现有「恢复运行」流程的冲突

**风险**：如果用户断线后恢复运行，resume 会带入 unconsumed steering。此时 poller 也会启动，可能重复消费。

**缓解**：
- `executeRun` 开始时先消费 `resumeContext.pendingSteering`，并记录已消费 seq。
- poller 拉取时过滤掉已消费 seq。
- backend 的 steering 事件消费后从 unconsumed 列表移除（确认当前行为）。

### 问题 17：Draft 状态转换点

**风险**：用户先输入文字发送消息（Agent 开始运行），然后输入更多文字——第二次输入会被当作 steering。如果第一次的 draft 没清空，用户可能混淆。

**缓解**：
- run 开始时自动清空 draft。
- 运行时输入框 placeholder 明确提示当前是约束模式。

## Open Questions

1. **Poller 频率**：500ms 是否合适？是否需要根据模型响应速度动态调整？
   - **建议**：先固定 500ms，后续根据生产 canary 数据调整。
2. **Steering 历史展示**：是否需要展示已消费的 steering，还是只展示未消费的？
   - **建议**：展示当前 run 的全部 steering（已消费 + 未消费），用不同图标区分状态。
3. **取消后是否允许重试**：用户取消 run 后，输入框是否保留最后一条未发送的 steering？
   - **建议**：保留，让用户可以重新组织后再次发起 run。
4. **是否需要在后端限制单个 run 的 steering 数量**：
   - **建议**：本次不在 backend 限制，由 agent-bridge 的 MAX_STEERING_LOOPS 控制；后续如需要可在 backend 加保护。

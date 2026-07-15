# Agent 对话体验与 Codex 对齐设计

> 日期：2026-07-16  
> 状态：待实现  
> 交付对象：Gemini 或后续 Coding Agent  
> 范围：产品信息架构、前端交互、Agent SSE 活动协议、会话展示与验收标准  
> 非目标：本设计不直接实现代码，不改变 Proposal-Confirm、会话隐私或 ProjectMemory 边界

## 1. 结论

ProjectFlow 应把 Agent 体验拆成两个共用同一会话状态的展示面：

1. **Agent 专属对话页**：左侧项目导航中的第一项，位于“项目总览”上方。进入后隐藏右侧 Agent 栏，让主内容区成为完整对话工作台。
2. **其他项目页面的 Agent 侧栏**：继续存在，但改为紧凑伴随模式，并提供“打开完整对话”按钮。按钮跳转到同一个 conversation，不创建新会话、不丢失流式状态。

两种展示面必须复用同一套 Conversation Timeline、Run Activity、Composer 和会话控制器。禁止维护两套消息渲染逻辑。

目标不是复刻 Codex 的颜色和尺寸，而是对齐它最重要的交互模型：

- Agent 的阶段性说明、Skill/工具调用和最终回答按真实时间顺序出现。
- 每个 Skill 和工具都有可回看的真实状态；运行期间发生的调用展示开始、完成、失败或阻止生命周期。
- 执行过程流式输出时保持展开；过程流结束后立即收敛为“已处理 54s”，随后才开始流式输出正式回答。
- 最终回答是正文主角，过程信息退居第二层。
- Composer 永远可用且不随消息滚走。
- 用户向上阅读时不被强制拉回底部；新内容到达时提供“回到最新”。
- 运行中允许追加约束或停止，且反馈明确。

## 2. 设计依据

### 2.1 用户提供的 Codex 录屏参考

本节以用户在 2026-07-16 提供的 16.98 秒本地录屏为事实源；此前误发的单张截图不再作为结构依据。录屏完整展示了一个已完成任务从收起执行过程、展开执行过程、向下滚动到最终回答及回答后产物的状态。

录屏表现出以下稳定模式：

- 顶部用“正在处理 / 已处理 + 耗时”概括一次运行。
- 收起时，标题下方直接显示最终回答；点击标题后，完整执行过程插入在标题与最终回答之间，最终回答被向下推移但不进入折叠内容。
- 执行过程由 Agent 阶段性文字和工具状态共同组成，不是一个孤立 spinner。
- 工具完成后出现单独、低噪音的状态行，例如“编辑了文件”。
- 展开态是一段从上到下的运行转录：Agent 先说明当前判断或下一步，随后显示对应工具状态，再继续下一段说明。它不是“说明正文在上、工具清单统一放在下方”。
- Agent 说明使用正常正文层级；工具行使用更小、更灰的辅助层级和扳手等状态图标。两者通过字号、颜色和间距区分，不使用卡片边框或连接线。
- 工具行的动词直接表达状态，例如“正在读取 ……”和“已加载工具运行了多个命令”，用户不需要展开 JSON 才能知道发生了什么。
- skill、命令和短技术名可以使用克制的 inline code chip，帮助扫读，但不能把整段过程做成终端日志。
- 最终回答位于运行转录之后，并且不属于折叠内容；收起执行过程不能隐藏最终回答。
- 最终回答之后可以继续出现记忆引用、文件或其他可操作产物；这些使用独立的折叠行或列表卡片，与执行过程严格分层，不能误当成 tool activity。
- 完成态默认折叠过程，保留完整最终回答。
- Composer 固定在视口底部，页面滚动不影响输入。
- 用户滚离底部后，内容列中央、Composer 上方出现圆形向下按钮，用于回到最新；按钮不遮挡正文或 Composer 控件。
- 运行时 Composer 仍承担追加信息和停止任务的控制面。

录屏里的右侧“环境信息”和文件打开方式属于 Codex 的代码工作区能力，不是 ProjectFlow 需要复制的界面。ProjectFlow 只对齐运行转录、折叠层级、滚动和产物分层。

#### 2.1.1 用户确认的实时输出顺序

录屏展示的是已完成后的回看状态；实时运行必须补齐以下严格顺序：

```text
用户发送消息
→ 执行过程开始，过程说明按 token 流式输出，默认展开
→ 如发生 Skill 或工具调用，在当前时间位置插入对应状态行
→ 继续流式输出后续过程说明与调用状态
→ 收到明确的 process_completed 边界
→ 立即折叠刚才的完整执行过程
→ 正式回答从空内容开始流式输出
→ 回答结束，整轮运行完成
```

这是两个连续但不同的可见通道：`process` 负责可公开的进度说明、Skill 和工具活动，`answer` 负责正式交付内容。禁止一边继续追加执行过程，一边提前流式输出正式回答；也禁止等正式回答全部生成后才折叠过程。

### 2.2 Codex 官方行为边界

Codex 官方文档确认了本设计需要保留的几个行为：

- 用户可以在运行中发送 follow-up；消息可以 **Steer** 当前运行，或 **Queue** 到下一轮。  
  参考：[Prompting: Steering and queuing](https://learn.chatgpt.com/docs/prompting#steering-and-queuing)
- 长任务应保留可见进度，并允许暂停、恢复、追加约束或询问状态。  
  参考：[Long-running work](https://learn.chatgpt.com/docs/long-running-work)
- 项目负责共享上下文，不同任务或对话应保留各自 transcript。  
  参考：[Projects, chats, and tasks](https://learn.chatgpt.com/docs/projects)

ProjectFlow 不需要复制 Codex 的代码工作区、权限控制或 worktree 概念；只借鉴对话、运行和工具活动的呈现模型。

### 2.3 2026-07-16 本地实测

在本地演示项目中发送多轮消息并查看运行状态后，确认以下问题：

1. `ChatMessage` 和 `AgentStepIndicator` 会在运行中同时渲染“执行过程”，同一次运行出现两份步骤列表。
2. 展开后的工具标签过于泛化：
   - 4 步示例：`获取工作区状态`、`执行项目操作`、`执行项目操作`、`创建风险记录`。
   - 6 步示例：`获取工作区状态`、`执行项目操作`、`创建风险记录` × 4。
3. 工具只保留状态和 label，没有开始时间、耗时、完成摘要或安全的结果说明。
4. 模型正文会自己描述“让我读取”“已经创建”，但工具活动不与这些文字交错，用户无法判断真实顺序。
5. 运行完成后，模型可能写出与真实工具活动矛盾的总结。审计事实不能依赖模型自述。
6. 窄侧栏直接渲染大型 Markdown 表格和长报告，阅读密度过高。
7. `#agent-sidebar-content` 是唯一 `overflow-y:auto` 容器，Composer 位于其中且 `position: static`。实测滚动区高度为 664px、内容高度为 4204px、Composer 顶部位于 4092px；滚到旧消息时输入框必然离开视口。
8. “新对话”点击后存在没有切换为新草稿、URL conversation 仍保留的现象，需纳入回归测试。
9. 当前完整会话、历史、运行状态、产物、建议回复和 Composer 全部耦合在 `agent-sidebar.tsx`，难以安全复用到完整页面。

## 3. 目标与非目标

### 3.1 目标

- 新增项目级 Agent 专属对话 view。
- 让完整页与侧栏共享同一会话和同一运行。
- 让 Skill 与工具活动成为确定性、可回放、可持久化的时间线。
- 建立正确的自动滚动和固定 Composer 行为。
- 提升长回答、Markdown 表格、工具密集型运行的可读性。
- 保留 T45 私人多会话、URL conversation 选择、消息分页和 viewer 校验。
- 保留当前模型选择、思考深度、斜杠命令、停止运行和 steering 能力。
- 覆盖 loading、empty、streaming、completed、failed、blocked、cancelled、disconnected 状态。

### 3.2 非目标

- 不把 Agent 变成代码执行器。
- 不扩大 LLM-callable tools 的写入权限。
- 不跳过 Proposal-Confirm。
- 不改变私人会话和团队会话的读取边界。
- 不把对话或运行日志自动写入 ProjectMemory。
- 不增加会话删除、分享、重命名、全文搜索或后台并行会话。
- 不展示原始 Chain-of-Thought；只展示明确的进度说明、工具活动和可公开的处理摘要。

## 4. 方案比较

### 方案 A：只修现有右侧栏

做法：固定 Composer，优化执行步骤，保留当前三栏布局。

优点：改动最小。  
缺点：无法承载长回答和复杂工具过程；Markdown 表格仍被挤压；不能满足用户明确提出的完整 Agent 页面。  
结论：不采用。

### 方案 B：新增独立路由 `/projects/{id}/agent`

做法：为 Agent 创建新的 App Router 页面，与现有 workspace 页面并列。

优点：隔离清晰，页面布局自由。  
缺点：违反当前“`/workspaces/[workspaceId]` 是唯一动态入口”的仓库约定；项目状态、身份、conversation URL 和流式清理边界会重复实现。  
结论：不采用。

### 方案 C：在现有 workspace shell 中新增 `view=agent`

做法：扩展 `ProjectView`，主内容区条件渲染完整 Agent 页；其他 view 保留紧凑右栏。

优点：复用现有 project、viewer、conversation 和 URL 状态；符合当前导航架构；从侧栏切换到完整页时可保持同一运行。  
代价：需要抽离目前集中在 `agent-sidebar.tsx` 和 workspace page 中的会话控制逻辑。  
结论：**采用此方案**。

## 5. 信息架构

### 5.1 路由与 URL

继续使用唯一动态路由：

```text
/workspaces/{workspaceId}?project={projectId}&view=agent&conversation={conversationId}
```

规则：

- `view=agent` 表示完整 Agent 对话页。
- `conversation` 继续是当前会话的唯一 URL 身份。
- 切换 view 不清理 conversation，不中断当前 stream。
- 切换 project 时按现有规则验证或清理 conversation。
- 新草稿在首条消息之前不要求 URL 中有 conversation；创建成功后再写入。

### 5.2 左侧项目导航

`MENU_ITEMS` 第一项新增：

```text
Agent 对话
项目总览
方向卡
阶段计划
...
```

建议图标使用 `Bot` 或 `MessageSquareMore`，标签统一为“Agent 对话”。

### 5.3 完整 Agent 页

完整页保留现有项目左栏，隐藏右侧 AgentSidebar。

```text
┌────────────项目导航────────────┬──────────────────────── Agent 对话 ────────────────────────┐
│ Agent 对话                      │ [会话标题]  [私人]             [新对话] [历史会话]          │
│ 项目总览                        ├───────────────────────────────────────────────────────────┤
│ 方向卡                          │                                                           │
│ ...                             │  用户消息                                                  │
│                                 │                                                           │
│                                 │  已处理 54s  ▾                                            │
│                                 │  Agent 最终回答（正文宽度 68–75ch）                        │
│                                 │                                                           │
│                                 │                       [↓ 回到最新]                         │
│                                 ├───────────────────────────────────────────────────────────┤
│                                 │  固定 Composer：输入 / model / thinking / send-or-stop     │
└─────────────────────────────────┴───────────────────────────────────────────────────────────┘
```

历史会话不再常驻为第二条左侧栏。原因是 ProjectFlow 已有项目导航，永久增加会话栏会形成三层导航。历史入口在页头打开 320–360px Sheet；桌面宽屏可以从右侧覆盖，移动端全屏显示。

### 5.4 其他 view 的紧凑 Agent 侧栏

侧栏职责缩减为：

- 顶部：Agent、运行状态、新对话、历史、打开完整对话、折叠。
- 中部：当前 conversation timeline。
- 底部：固定 Composer。

当前阶段的大块 context card 改为单行 context strip，例如：

```text
核心实现 · 7 个开放风险 · 2 条待确认
```

用户点击后可跳到相应项目 view；禁止继续占据大块首屏空间。

## 6. 运行时间线设计

### 6.1 统一运行转录，而不是“正文 + 另一个步骤框”

每个 assistant turn 由“有序运行转录 + 最终回答”构成。运行转录中的 Agent 说明和工具活动共享一个 sequence，不允许分别存进两个区域后再各自渲染：

```ts
type RunActivityItem =
  | ProgressActivity
  | SkillActivity
  | ToolActivity
  | ApprovalActivity
  | SteeringActivity;

type BaseActivity = {
  id: string;
  sequence: number;
  created_at: string;
};

type ProgressActivity = BaseActivity & {
  kind: "progress";
  content: string;
  phase?: "planning" | "exploring" | "executing" | "verifying" | "summarizing";
};

type SkillActivity = BaseActivity & {
  kind: "skill";
  skill_name: string;
  status: "loading" | "loaded" | "failed" | "blocked";
  label: string;
  completed_label?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
};

type ToolActivity = BaseActivity & {
  kind: "tool";
  tool_call_id: string;
  tool_name: string;
  status: "running" | "completed" | "failed" | "blocked";
  label: string;
  completed_label?: string;
  summary?: string;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
};

type ApprovalActivity = BaseActivity & {
  kind: "approval";
  status: "waiting" | "approved" | "rejected";
  label: string;
};

type SteeringActivity = BaseActivity & {
  kind: "steering";
  content: string;
  status: "accepted" | "queued" | "applied";
};
```

最终回答不塞进 activity 数组，作为 assistant turn 的 `answer` 独立渲染。这样 process 结束后可以立即折叠过程，再独立流式输出并持续保留正式回答。

单个 assistant turn 的稳定结构必须是：

```text
RunSummary（已处理 35m 11s，可展开）
└── RunActivity[]（仅展开时存在于布局流中）
Answer（阶段 A 不渲染；阶段 B 从空内容开始并持续存在）
MemoryReferences?（可选）
Artifacts?（可选）
```

`MemoryReferences` 和 `Artifacts` 不是 `RunActivityItem`。它们属于回答的引用与产物区，即使由工具生成，也不能重复显示成展开过程中的第二套结果卡片。

目标顺序示例：

```text
[progress] 我先核对现有实现和交互边界，再给出可确认方案。
[skill]    已读取界面审查技能
[tool]     已加载工具运行了多个命令
[progress] 现有侧栏把会话状态和渲染耦合在一起，下一步检查浏览器中的实际滚动行为。
[skill]    正在读取 Browser 技能
[tool]     已读取本地 Agent 侧栏结构
[progress] 已确认输入框位于消息滚动容器内部，接下来整理方案。

[answer]   最终设计结论……
```

禁止的顺序：

```text
[全部 progress 正文]
[执行过程 · N 步]
  [全部 tool 列表]
[最终回答]
```

第二种结构正是当前 ProjectFlow 的主要问题：用户只能看到工具发生过，却看不出每次工具调用与哪一段判断相关。

### 6.2 过程内容边界

可展示：

- Agent 主动发出的用户可读进度说明。
- Skill 选择、读取、组合完成或加载失败；只显示安全 display name，不显示 SKILL.md 正文和绝对路径。
- 工具开始、完成、失败、阻止。
- 等待确认、用户批准或拒绝。
- 用户在运行中追加的约束及其处理状态。

不可展示：

- 原始内部推理 token。
- 原始工具参数 JSON。
- 原始工具结果 JSON。
- 用户 ID、任务 ID、run ID、tool_call_id 等内部标识。
- secret、token、文件绝对路径或不必要的调试信息。

当前 `thinking_content` 不能直接当 Codex 式进度说明。协议应新增 `progress` / `commentary` 语义；如果第一阶段暂时没有该事件，则只渲染确定性 status、Skill 和 Tool Activity，不把完整 thinking token 展开给用户。

### 6.3 Skill 与工具文案

工具 manifest 或独立 display map 必须提供状态文案：

```ts
type ToolDisplayMetadata = {
  running: string;
  completed: string;
  failed: string;
  blocked: string;
};
```

示例：

| Tool | Running | Completed |
|---|---|---|
| `get_project_state` | 正在读取项目状态 | 已读取项目状态 |
| `get_workspace_state` | 正在读取工作区状态 | 已读取工作区状态 |
| `timeline_slice` | 正在查看最近进展 | 已查看最近进展 |
| `create_risk` | 正在创建风险记录 | 已创建风险记录 |
| `generate_replan_proposal` | 正在生成重排草案 | 已生成重排草案，等待确认 |

禁止使用“执行项目操作”作为正常 fallback。未知工具的 fallback 应是：

```text
正在执行 {safe tool display name}
已完成 {safe tool display name}
```

Skill 使用同一文案原则，例如“正在读取风险分析技能”→“已读取风险分析技能”。显式斜杠命令与自动路由选择都可以显示 Skill Activity，但不能暴露 Skill 文件路径、完整 prompt 或 effect ceiling 内部结构。

### 6.4 展开与收起

阶段 A，执行过程流式输出：

- 默认展开运行转录。
- 顶部主标签显示“正在处理 54s”或等价实时耗时。
- `progress` 的文本增量直接追加到当前过程段落；Skill 和工具事件按 `sequence` 插入当前位置，完成事件更新原状态行，然后后续 progress 继续向下输出。
- activity 数量不是主信息，不默认拼成“正在处理 · N 步”；只有在 runtime 确实维护正式 RunPlan 时，才可在次级位置展示可信进度。
- 当前 Skill 或工具有 spinner，完成项有 check，失败为 error，blocked 为 shield。
- 不显示 `1 / 6`，除非 runtime 确实知道总步骤数。禁止伪造分母。
- 此阶段不创建 Answer 容器，不显示“正在生成回答”占位，也不把 process token 同步复制到正式回答。

阶段边界，`process_completed`：

- runtime 必须先发送明确的 `process_completed`，再发送任何 `answer` token；前端不得用静默时间、是否出现工具或自然语言句号猜测边界。
- reducer 收到边界后在同一次状态更新中结束 process streaming、自动收起运行转录，并把主标题切换为“已处理 54s”。
- 这里的 `54s` 是 `processing_duration_ms`，在边界处冻结；整轮直到 answer 完成的总耗时可以进入 telemetry，但不继续改动该标签。
- 自动折叠不等待整轮 `run_completed`，也不等待正式回答生成完毕。
- 不设置人为延迟。`answer_start` 紧随边界到达；浏览器必须先提交折叠状态，再渲染第一个 Answer delta，避免过程和回答同时展开流式输出。

阶段 B，正式回答流式输出：

- Answer 从空内容开始，在已收起的 RunSummary 下方按 token 流式增长。
- RunSummary 保持“已处理 54s”并显示箭头按钮；不默认附加“6 步”。
- 折叠控件的 accessible name 可包含工具数量，例如“展开执行过程，共 6 个工具活动”，但视觉主标签保持克制。
- 用户可以在 Answer 仍在流式输出时点击箭头回看过程；展开内容作为正常文档流插入标题和正式回答之间，不使用覆盖层、Sheet 或独立滚动区，也不暂停 Answer stream。
- 自动折叠只执行一次。用户在阶段 B 手动展开后，系统不得因为新的 Answer token 再次强制收起。
- 展开后最终回答、记忆引用和产物整体向下移动，但其内容、状态与交互不变；再次收起只移除过程占据的布局高度。
- 每个 Skill 和工具仍保留一行；重复调用不能合并丢失，只允许在折叠标题中汇总。
- 收起只影响运行转录，最终回答始终可见。
- 展开或收起时，焦点保留在摘要按钮；若一次收起会移除大段位于当前视口上方的内容，浏览器应锚定摘要按钮或最终回答，避免用户被抛到无意义的滚动位置。

整轮完成，`run_completed`：

- 停止 Answer stream，持久化完整 Answer、RunSummary 与 activities。
- 保持用户当前的手动展开/收起状态；历史消息重新载入时默认收起。
- 如果本轮没有任何可展示的 process activity，则不渲染空 RunSummary，直接流式输出 Answer。

失败、停止或断线：

- process 阶段失败时保持过程展开，标题为“处理失败”，不创建空 Answer，并提供重试。
- answer 阶段失败时保留已折叠过程和部分 Answer，在 Answer 末尾显示“回答中断”和重试。
- 用户停止或连接中断时保留已接收的过程与回答，标题分别为“已停止”“连接中断”。
- 已完成 Skill/工具步骤保留；失败步骤显示原因摘要和恢复动作。

### 6.5 审计事实来源

Skill 与工具活动由 runtime event 生成，是执行事实源。模型最终回答中的“已读取”“已创建”“没有执行工具”等文字不具备审计权威。

如果模型文字与活动日志矛盾：

- UI 继续展示真实 activity。
- 可在完成态显示轻量提示：“回答描述与执行记录不一致，请以执行记录为准。”
- 记录可观察性事件，供后续 prompt/eval 修复。

## 7. SSE 与持久化协议

### 7.1 当前缺口

当前 `StreamContentEvent` 有 `message_seq`，但 `StreamToolEvent` 没有统一 sequence；前端分别保存 content blocks 和 execution steps，因此无法可靠交错渲染。

当前 `prepareRunRequest()` 会在 SSE 建立前完成 Skill 路由与加载。因此首批 Skill 不能伪装成连接建立后才“正在读取”：P0 应在 `process_started` 后按真实结果补发一条 `loaded` Skill Activity；只有未来把 Skill 加载真实移入 SSE 生命周期时，才展示 `loading → loaded/failed` 动态变化。

当前 persisted `ExecutionStep` 只有：

```ts
{ tool_name, tool_call_id?, status, label }
```

页面刷新后无法恢复耗时、完成文案、摘要和准确顺序。

### 7.2 目标协议

协议必须显式表达两个流式阶段及其边界，不能只靠前端观察 content 类型：

```ts
type StreamRunEvent =
  | { event: "process_started"; stream_sequence: number; started_at: string }
  | { event: "process_delta"; stream_sequence: number; activity_id: string; content: string }
  | { event: "activity"; stream_sequence: number; data: RunActivityItem }
  | { event: "process_completed"; stream_sequence: number; completed_at: string; processing_duration_ms: number }
  | { event: "answer_started"; stream_sequence: number; started_at: string }
  | { event: "answer_delta"; stream_sequence: number; content: string }
  | { event: "run_completed"; stream_sequence: number; completed_at: string };
```

所有事件共享一次 run 内单调递增的 `stream_sequence` 和服务器时间。activity 自身保留稳定 `sequence`，用于持久化后的过程排序：

```ts
type StreamActivityEvent = {
  event: "activity";
  data: RunActivityItem;
};
```

兼容迁移期间可以继续发送旧 `tool` event，但前端优先消费 `activity`。

`done` 中持久化：

```ts
structured_payload: {
  run_summary: {
    started_at: string;
    process_completed_at?: string;
    completed_at: string;
    processing_duration_ms?: number;
    duration_ms: number;
    status: "completed" | "failed" | "cancelled" | "disconnected";
    activity_count: number;
  };
  activities: RunActivityItem[];
  thinking_content?: string; // 保留兼容，但不作为默认用户可见过程
}
```

要求：

- `sequence` 在一次 run 内唯一且稳定。
- 连续 `process_delta` 通过同一 `activity_id` 追加到一个 ProgressActivity；一旦插入 Skill/Tool Activity，该 progress block 结束，后续过程文字必须使用新的 `activity_id`，保证回放顺序不会跨调用穿插。
- 每个成功进入 Answer streaming 的 run 必须恰好出现一次 `process_completed`，并且它的 `stream_sequence` 小于 `answer_started` 和所有 `answer_delta`；process 阶段失败或取消的 run 不得伪造该边界。
- 前端将 `process_completed` 作为唯一的自动折叠触发器；`run_completed` 只负责结束整轮与持久化，不能再次触发折叠。
- 如果 runtime 没有用户可见 process 内容，可以省略 process 容器，但仍应保持 answer 事件顺序合法。
- SSE 建立前已经完成的 Skill 以单条 `loaded` activity 出现在过程开头，时间戳使用真实 preflight 时间；不得在客户端播放伪造的 loading 动画。
- 运行期间真实发生的 Skill loading/loaded 根据 activity `id` 更新同一行；Skill 组合按真实选择顺序分别显示。
- tool started/completed 根据 `tool_call_id` 合并为同一个 activity item。
- completed/failed event 必须保留 started 时的 label，不再用 tool_name 反向猜测。
- duration 由 sidecar/runtime 计算，不能由浏览器时钟作为最终事实。
- `summary` 必须由确定性 normalizer 生成，不能直接透传工具原始 result。
- 历史消息和实时消息使用同一 view model，刷新前后视觉一致。
- `thinking_start/end`、`text_start/end` 或 `turn_start` 只能作为 runtime adapter 的输入，不能直接成为 UI 阶段边界；adapter 必须归一化成上述 process/answer 协议。

## 8. 消息与视觉层级

### 8.1 完整页

- 内容列最大宽度建议 820–900px。
- 普通正文控制在 68–75ch。
- 用户消息使用轻量右对齐气泡，最大宽度 70%。
- Agent 回答使用无外层卡片的文档式正文；不要再包浅灰大圆角卡。
- 整段运行转录不使用外层卡片、背景块、竖向连接线或步骤编号；它与 Codex 一样表现为正文流中的可折叠片段。
- `progress` 使用与回答接近的正文排版，但颜色和字重可以略低一级；建议 15–16px、`line-height: 1.65–1.8`。
- `skill` 和 `tool` 使用低噪音单行，建议 13–14px、muted foreground、20–24px 行高；图标与文字基线对齐。
- Skill/Tool Activity 不使用 emoji 作为状态图标。使用 Lucide 的 book-open、wrench、loader、check、triangle、shield 等同一套线性图标。
- progress 与紧随其后的 tool 行间距建议 16–20px；不同工作阶段之间建议 24–32px，形成可扫读节奏。
- skill、命令、模型名等短技术词可使用中性灰 inline code chip；chip 不使用高饱和底色，不抢正文层级。
- Answer、MemoryReferences 与 Artifacts 按顺序分层：正文结束后先显示轻量引用折叠行，再显示可操作产物。
- Artifact 可以使用卡片，因为它确实是可操作实体；产物卡片不得插进 `RunActivity[]`，也禁止把整个回答再包进 artifact card。
- 多个同类产物使用单个列表容器：首屏显示 3 个，其余用“显示另外 N 个”渐进展开；每行只保留名称、类型/摘要和主操作，避免多层嵌套卡片。
- Markdown 表格在窄宽度下放入水平滚动容器；侧栏中优先转换为 definition list 或可横向滚动表格。

### 8.2 侧栏

- 侧栏继续显示完整 conversation，但正文排版更紧凑。
- 超宽表格不压缩列到不可读；允许局部水平滚动。
- 长 artifact 默认显示摘要，点击“查看详情”进入完整 Agent 页并定位到对应 turn。
- “打开完整对话”按钮必须一直可达，建议放在 header。

### 8.3 动效

- 新 activity 淡入 120–180ms。
- 用户手动展开/收起 activity 使用 180–220ms ease-out；`process_completed` 的自动折叠控制在 120–160ms，且不得用动画计时器延迟 `answer_started` 的状态处理。
- 不动画高度较大的 Markdown 正文。
- `prefers-reduced-motion` 下取消位移，只保留瞬时或淡入状态切换。

## 9. 固定 Composer 与滚动算法

### 9.1 布局结构

完整页和侧栏统一采用三行 shell：

```css
.agent-surface {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100%;
  overflow: hidden;
}

.agent-timeline {
  min-height: 0;
  overflow-y: auto;
}

.agent-composer-region {
  position: relative;
  border-top: 1px solid var(--border);
  background: var(--background);
  padding-bottom: env(safe-area-inset-bottom);
}
```

Composer 必须是 timeline 的 sibling，不能继续放在 `#agent-sidebar-content` 内部。

### 9.2 自动跟随

维护 `isNearBottom`：

```text
distanceToBottom = scrollHeight - scrollTop - clientHeight
isNearBottom = distanceToBottom <= 80px
```

规则：

- 用户发送消息后滚到底部。
- `isNearBottom=true` 时，新 token/activity 自动跟随。
- 用户向上滚动超过阈值后暂停自动跟随。
- 暂停期间显示悬浮“↓ 回到最新”，可带未读 activity 数。
- 完整页中按钮水平居中放在内容列，位于 Composer 上缘上方 12–16px；侧栏可居中或靠右，但必须与发送/停止按钮保持至少 12px 间距。
- 点击后平滑滚到底部并恢复跟随；reduced-motion 使用 instant。
- streaming 不得每个 token 都调用 `scrollIntoView`；在 animation frame 中批量更新。
- 切换 conversation 时恢复该 conversation 的内存滚动位置；重新进入时默认定位最新消息。

### 9.3 Composer 状态

Idle：

- placeholder：“告诉 Agent 你想推进什么…”。
- Enter 发送，Shift+Enter 换行。
- model 与 thinking level 保留。

Running：

- placeholder：“追加约束或纠正当前运行…”。
- Enter 默认 Steer 当前运行。
- 提供明确的“停止”按钮。
- 如果未来加入 Queue，queued messages 显示在 Composer 上方，可编辑或移除。

Error：

- 草稿保留。
- 显示“重新发送”与简短恢复说明。

## 10. 会话控制

### 10.1 新对话

- 点击后立即进入本地 draft 状态，清空当前 timeline 展示，不创建数据库记录。
- 首条消息提交前创建 conversation，成功后更新 URL。
- 创建失败时恢复 draft 和输入，不返回旧会话造成错觉。
- stream 运行中禁用新建；用户先停止后再切换。

### 10.2 历史会话

- 继续使用 T45 summary list 和 cursor pagination。
- Sheet 中显示 title、private/team、更新时间、消息数、preview。
- 当前会话有明确 selected 状态。
- 切换失败时保留当前会话，并显示可重试错误。
- 私人会话仍只有 creator 可读；完整 Agent 页不能放宽权限。

### 10.3 从侧栏跳转完整页

跳转只修改 `view=agent`：

```ts
nextParams.set("view", "agent");
// 保留 project 和 conversation
```

如果正在 streaming：

- 不 abort。
- 不 reset stream reducer。
- 完整页接管同一个 controller/context 并继续显示。

## 11. 前端组件边界

建议结构：

```text
components/project/agent/
├── AgentConversationSurface.tsx   # full/sidebar 两种布局壳
├── AgentConversationPage.tsx      # 完整页装配
├── AgentCompactSidebar.tsx        # 侧栏装配
├── AgentThreadHeader.tsx           # 标题、会话、跳转控制
├── ConversationTimeline.tsx        # 消息列表、分页、滚动控制
├── ConversationTurn.tsx            # 单轮 user + assistant
├── RunActivity.tsx                  # 运行摘要与折叠过程
├── SkillActivityItem.tsx            # 单个 Skill 加载生命周期
├── ToolActivityItem.tsx             # 单个工具生命周期
├── ProgressActivityItem.tsx         # 用户可读进度说明
├── JumpToLatestButton.tsx           # 回到底部
├── StickyChatComposer.tsx           # Composer 区域
└── AgentArtifactCard.tsx            # 复用现有产物卡
```

状态层：

- 从 workspace page 抽出 `AgentConversationProvider` 或等价 controller。
- provider 持有当前 conversation、draft、history、stream turn、active run、composer draft 和 actions。
- `AgentConversationPage` 与 `AgentCompactSidebar` 只消费 provider，不各自创建 hook。
- `useAgentConversationStream` 保持唯一实例，view 切换不能触发 unmount cleanup。

`agent-sidebar.tsx` 最终只保留兼容导出或改为 `AgentCompactSidebar` 包装器，不继续承载全部状态和渲染。

## 12. 预计文件范围

### 前端

- `frontend/src/components/project/project-sidebar.tsx`
  - `ProjectView` 增加 `agent`。
  - `MENU_ITEMS` 在 overview 前加入 Agent 对话。
- `frontend/src/components/project/workspace-layout.tsx`
  - `view=agent` 时渲染完整页并隐藏右栏。
  - provider 放在两种展示面的共同祖先。
- `frontend/src/components/project/project-content.tsx`
  - 不建议把 Agent 页塞进通用业务 `ViewRenderer`；可以由 workspace layout 特判，避免给 ProjectContent 传入大量 conversation props。
- `frontend/src/components/project/agent-sidebar.tsx`
  - 拆分为共享组件和紧凑壳。
- `frontend/src/components/project/agent/ChatMessage.tsx`
  - 移除独立 execution steps 渲染，改用统一 `RunActivity`。
- `frontend/src/components/project/agent/AgentStepIndicator.tsx`
  - 删除或降级为兼容适配，禁止与 turn 内过程同时出现。
- `frontend/src/components/project/agent/ChatComposer.tsx`
  - 变成纯输入组件，由 StickyChatComposer 负责固定区域。
- `frontend/src/lib/types.ts`
  - 新增 process/answer 双阶段、Skill/Tool activity union、run summary 与 sequence/timing 字段。
- `frontend/src/lib/use-agent-stream-turn.ts`
  - reducer 改为 `process_streaming → answer_streaming → completed`，并维护有序 activity timeline。
- `frontend/src/lib/useAgentConversationStream.ts`
  - 消费新 activity event；保留旧 tool event 兼容路径。
- `frontend/src/lib/use-conversation-history.ts`
  - 回归新草稿、切换、URL 与分页。
- `frontend/src/styles/globals.css`
  - 仅补充共享布局和 reduced-motion 所需样式，不创建独立视觉系统。

### Agent bridge

- `agent-bridge/src/server/routes/start-run-stream.ts`
  - 为 process delta、Skill/Tool activity、阶段边界和 answer delta 生成统一 stream sequence。
  - 计算 duration，并输出安全 completed label/summary。
- `agent-bridge/src/types/stream-content.ts`
  - 新增显式 `process_started/process_completed/answer_started` 与 `StreamActivityEvent`。
- `agent-bridge/src/tools/*`
  - 为 tool manifest 增加 display metadata 或集中 display map。
- `agent-bridge/src/runtime/pi-runtime.ts`
  - 暴露用户可读 progress/commentary 事件时必须与 thinking 分离，并把 Pi 的 turn/content 事件归一化成明确的 process/answer 边界。
- `agent-bridge/src/events/event-mapper.ts`
  - 映射 process/answer 边界以及 Skill/Tool started/progress/completed/failed/blocked。

### Backend

- `backend/app/schemas/agent_conversation.py`
  - 扩展 done execution/activity schema。
- `backend/app/api/routes_agent_conversations.py`
  - 更新 SSE schema 转发和兼容。
- 持久化 assistant message 的 service
  - 保存 `run_summary` 与 ordered `activities`。

## 13. 状态与错误设计

| 状态 | 页面行为 |
|---|---|
| Loading conversation | timeline skeleton，Composer 暂时 disabled |
| Empty draft | 简短 Starter Prompts，Composer 聚焦 |
| Connecting | 用户消息立即出现，显示“正在连接 Agent” |
| Process streaming | process 按顺序流式输出且 activity 展开，Composer 切换为 Steer，停止按钮可用 |
| Answer streaming | `process_completed` 已触发一次自动折叠，Answer 独立流式输出，箭头可随时回看过程 |
| Completed | Answer 完整，保留用户当前折叠状态；历史重新载入默认收起 |
| Failed | 保留完成步骤，显示失败摘要、重试 |
| Blocked | 显示被策略阻止及用户下一步，不暴露内部策略 JSON |
| Cancelled | 保留部分输出，显示“已停止”与继续提问入口 |
| Disconnected | 保留已接收内容，显示重连或重试 |
| History error | 保留当前会话，Sheet 内显示重试 |
| Conversation forbidden/not found | 清理无效 URL conversation，回到新草稿并说明原因 |

## 14. 响应式与可访问性

- `>= 1280px`：项目左栏 + 完整 Agent 主区，其他 view 为三栏。
- `768–1279px`：项目左栏可折叠，Agent 完整页占剩余区域；其他 view 的 Agent 侧栏默认收起或 overlay。
- `< 768px`：Agent 对话作为单一主页面；项目导航和历史会话使用 Sheet；Composer 固定底部并处理 safe area。
- 所有 icon button 有中文 accessible name。
- activity 折叠使用 button + `aria-expanded` + `aria-controls`。
- tool status 不能只靠颜色，必须有图标和文字。
- 完成、失败和 blocked 使用 `aria-live="polite"`，token 流本身不放进 live region。
- 键盘焦点在打开/关闭历史 Sheet 后正确返回触发按钮。

## 15. 测试与验收标准

### 15.1 导航

- 左侧“Agent 对话”位于“项目总览”上方。
- `view=agent` 隐藏右侧栏并展示完整页。
- 从任意项目 view 点击“打开完整对话”后，project 和 conversation 参数不变。
- 流式运行中切换完整页/侧栏不会 abort、重置或重复请求。

### 15.2 运行过程

- 用户发送后首先进入 Process streaming，过程文字按 delta 连续增长，默认展开。
- Skill/Tool Activity 出现在其真实调用位置；调用完成后更新同一行，后续过程文字继续在其下方输出。
- `process_completed` 之前不得出现任何 Answer token。
- 收到 `process_completed` 后立即自动折叠一次，并在 `answer_started` 后从空 Answer 开始流式输出正式回答；不得等 `run_completed` 才折叠。
- Answer streaming 期间点击 RunSummary 箭头可以展开或收起历史过程，且不会暂停、重置或重复 Answer stream。
- 用户手动展开后，后续 Answer token 不得再次强制收起过程。
- Skill 调用与工具调用都可以回看；不得只保存工具而丢失 Skill 活动。
- 每个 Skill load 恰好渲染一个 activity item。
- 每个 tool call 恰好渲染一个 activity item。
- started → completed/failed/blocked 更新同一 item，不新增重复行。
- 同名工具连续调用通过 tool_call_id 分开显示。
- 运行中只出现一个过程区域。
- Agent progress 与 tool activity 必须按照统一 sequence 真实交错，不能把工具统一堆到说明文字下方。
- 展开态不出现包裹整个过程的卡片、步骤编号或竖向时间轴。
- 展开态严格位于 RunSummary 与 Answer 之间；收起后 Answer 回到 RunSummary 下方，内容和交互状态不变。
- process 完成后主标题包含真实 `processing_duration_ms`，默认不显示 activity 数量。
- 收起执行过程后，最终回答仍完整可见。
- 记忆引用和 Artifact 位于 Answer 之后，不进入执行过程折叠区，也不因收起过程而消失。
- 刷新页面后步骤顺序、状态、duration 与完成前一致。
- 工具 label 不再出现无信息量的“执行项目操作”。
- 用户看不到工具原始 JSON、内部 ID 或敏感字段。

### 15.3 Composer 与滚动

- 无论 timeline 滚动到何处，Composer 都保持可见。
- 用户在底部时，stream 自动跟随。
- 用户向上滚动后，stream 不抢滚动位置。
- 暂停跟随时出现“回到最新”，点击后恢复。
- 完整页的“回到最新”按钮位于 Composer 上方且不遮挡正文、模型选择、发送或停止按钮。
- 长 Markdown、表格和 20+ 工具步骤不会让 Composer 离开视口。
- reduced-motion 下滚动和折叠仍可用。

### 15.4 会话

- 点击“新对话”立即展示空 draft，不残留旧消息。
- 首条发送成功后创建 conversation 并更新 URL。
- 新建失败不丢草稿、不错误回显旧会话。
- 私人会话不能被其他成员读取。
- team conversation 仍只注入 team-visible ProjectMemory。
- 历史切换失败时当前 conversation 保持不变。

### 15.5 运行中追加与停止

- Running 时输入框明确表示“追加约束”。
- Steer 成功后出现一条 `steering` activity，显示已接收/已应用。
- 如果 run 已在边界前完成，消息明确变成下一轮，而不是悄悄改变语义。
- 点击停止后状态变为 cancelled，部分内容和完成工具步骤保留。

### 15.6 回归验证

- frontend：Agent sidebar、ChatMessage、Composer、history、stream hook、navigation 全部单测通过。
- agent-bridge：双阶段 SSE 顺序、process/answer 边界、Skill/Tool lifecycle、duration、done persistence、blocked/failed 映射测试通过。
- backend：conversation schema、私有会话权限、message pagination、SSE public scenario 通过。
- frontend lint/build、agent-bridge typecheck/build、backend ruff 通过。
- 浏览器场景至少覆盖：空对话、2 轮普通对话、Skill + 6 个以上工具调用、process 自动折叠后 Answer 流式输出、Answer streaming 中展开回看、运行中 steer、停止、向上滚动、刷新恢复、侧栏到完整页跳转。

## 16. 建议实施顺序

### Slice 1：共享布局与完整 Agent view

- 添加 `view=agent`。
- 抽出 provider 和共享 surface。
- 完整页/侧栏共用同一 conversation。
- Composer 移出 scroller。

### Slice 2：统一 Run Activity 前端模型

- 消除 ChatMessage 与 AgentStepIndicator 重复。
- 先用现有 tool event 适配 activity UI。
- 建立 process/answer 两阶段 reducer；process 边界自动折叠一次，Answer streaming 中允许手动回看。
- 完成回到最新与长内容适配。

### Slice 3：SSE activity 协议与持久化

- 全局 stream sequence、显式 process/answer 边界、timestamps、processing duration、completed labels、safe summary。
- Skill 与 Tool lifecycle 使用同一有序 activity 协议。
- progress/commentary 与 thinking 分离。
- 刷新恢复一致性。

### Slice 4：会话与运行边界加固

- 修复新对话草稿与 URL。
- 明确 Steer 与下一轮边界。
- 失败、blocked、cancelled、disconnected 完整状态。

### Slice 5：浏览器验收与视觉收尾

- Codex 对齐场景回放。
- responsive、a11y、reduced motion、表格和长消息。
- 扫描重复 execution UI、泛化工具 label 和 stale composer 布局。

## 17. 实施约束

- 不得通过复制 `AgentSidebar` 生成完整页。
- 不得新增 `/projects/*` 独立路由。
- 不得把 Composer 做成 viewport `position: fixed` 并覆盖全局页面；应固定在各 Agent surface 的第三行。
- 不得根据模型自然语言推断工具是否成功。
- 不得将 raw thinking 重新包装成“Codex 执行过程”。
- 不得因为 UI 对齐扩大 tool effect ceiling 或 Proposal-Confirm 范围。
- 不得在完整页绕过 viewer 校验或 conversation visibility。
- 所有用户可见工具文案为中文，且使用 display name/title，不使用原始 ID。

## 18. 完成定义

只有同时满足以下结果，才算完成：

1. 用户能从左侧进入完整 Agent 对话页，并从任何项目页侧栏无损跳转过去。
2. 用户在完整页和侧栏看到同一个 conversation、同一个正在运行的 turn。
3. 每个真实 Skill/工具调用都以一条可读、可追踪、可持久化的 activity 呈现。
4. 过程和正式回答严格分成两个连续流：过程默认展开，过程结束立即折叠，随后正式回答才开始流式输出；箭头可随时回看过程。
5. Composer 始终可见，滚动行为符合阅读预期。
6. 新对话、历史、steering、停止、错误和刷新恢复都通过浏览器场景测试。
7. 现有 Proposal-Confirm、T45 会话隐私和 ProjectMemory 可见性没有回归。

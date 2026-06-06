# Agent 右侧栏 Chat-first 体验优化设计

## 目标

把项目页右侧 Agent 栏从“功能按钮集合”改为成熟 AI 产品常见的对话式推进体验。用户不需要先判断该点哪个 Agent 能力，而是通过自然语言或建议回复表达意图；Agent 读取当前项目状态后解释判断、生成结果，并把可确认的产物直接放回对话中。

设计优先级是体验成熟度和流程完整性，不以响应速度为第一目标。前端不做 intent router，不把建议按钮映射成固定模块调用；建议按钮只是轻量快捷回复，等同于发送一条 user instruction。真实判断、模块选择和输出结构由后端 LLM Agent 完成。

## 已确认方向

- 交互形态：**C. 对话 + 下一步建议流**
- 建议按钮语义：**轻量快捷回复**
- 右侧栏定位：用户和 Agent 的主要协作入口，不再是高级操作菜单
- 产物呈现：Agent 生成的提案、风险分析、行动卡必须优先在对话里可见
- 主页面关系：主页面继续承载项目总览和提案列表，但不能成为用户发现产物的唯一入口

## 当前问题

1. 右侧栏仍保留明显的功能面板思路，用户需要自己判断该点哪个操作。
2. 对话消息只显示文本，生成提案后用户不知道产物在哪里。
3. 建议按钮像快捷操作，但缺少成熟 AI 产品的“已发送、处理中、产物生成、可继续追问”连续反馈。
4. 最近活动、高级操作和重置演示数据占据注意力，削弱了对话主线。
5. 当前失败或空输出会让用户看到兜底文案，而不是可恢复的对话状态。

## 体验原则

### 1. 用户表达意图，不选择功能

右侧栏的默认交互是“告诉 Agent 你想推进什么”。建议回复只是降低输入成本，例如：

- 根据签到调整计划
- 分析当前风险
- 解释为什么现在要做这一步

点击建议回复后，前端插入一条用户消息，并把原始文本作为 `user_instruction` 发送给后端。前端不根据这句话决定调用 planning、risk、active_push 或其他模块。

### 2. Agent 每一步都要有可感知反馈

用户发出指令后，界面必须立即进入可理解的处理状态：

1. 立即插入用户消息。
2. 显示 Agent 运行状态。
3. 用短步骤说明正在做什么，例如“读取项目状态”“判断计划影响”“整理可确认草案”。
4. 完成后把 Agent 回复和产物卡直接插入对话。
5. 如果失败，保留用户消息并给出重试、换一种说法、查看问题的入口。

运行步骤不需要暴露技术细节，也不需要假装逐 token 流式输出。第一阶段可以用确定性的 pending steps 承载流畅感，后续再升级到 SSE 或流式响应。

### 3. 产物必须跟着对话出现

当 Agent 生成以下内容时，右侧对话中必须出现对应的 artifact card：

- 计划调整提案
- 风险分析
- 下一步行动卡
- 分工建议
- 方向澄清结果
- 需要确认的项目变更

artifact card 至少包含：

- 标题
- 摘要
- 为什么生成
- 会影响什么
- 当前状态：草案、待确认、已确认、已忽略、已过期
- 操作入口：确认应用、继续修改、查看影响

主页面的 `Agent 提案` 面板和右侧对话中的 artifact card 应指向同一个后端产物记录。用户在任一位置确认后，另一处同步状态。

## 信息架构

右侧 Agent 栏从上到下分为四层：

### 1. Compact Header

固定在顶部，占用尽量少的高度。

内容：

- Agent 标题
- 当前是否处理中
- 待确认数量 badge
- 折叠按钮

不再在顶部放大块说明卡。当前焦点进入对话流中的第一条 context card。

### 2. Conversation Stream

主区域，承载完整对话和产物。

消息类型：

- `user_message`：用户自然语言输入或建议回复
- `agent_message`：Agent 普通回复
- `context_card`：当前焦点、项目阶段、推荐下一步
- `run_status`：处理中状态和短步骤
- `artifact_card`：提案、风险分析、行动卡等可操作产物
- `error_card`：失败、不可用、需要重试

交互要求：

- 保留完整会话滚动，不只显示最后 6 条。
- 新消息自动滚到底部，但用户手动向上阅读时不强制抢滚动。
- 处理中时 composer 可以输入但发送按钮 disabled，避免重复提交。
- 每轮 Agent 完成后自动生成下一组建议回复。

### 3. Suggestion Row

建议回复显示在最近一条 Agent 消息或 artifact card 后面。

规则：

- 每轮最多 3 个。
- 一个主建议高亮，其余为次要建议。
- 文案必须像自然语言回复，不像功能名。
- 点击后等同于发送文本消息。
- 如果当前有待确认 artifact，建议应优先围绕“确认、修改、解释影响”。

示例：

- 主建议：根据签到调整计划
- 次建议：先解释风险来源
- 次建议：只生成行动卡，不改计划

### 4. Composer

固定在底部。

功能：

- 多行输入
- `Enter` 发送，`Shift+Enter` 换行
- 发送 loading 状态
- 错误后保留草稿

不在 composer 周围堆叠高级操作。高级操作收进折叠菜单，只保留调试、重置演示数据等低频入口。

## 核心流程

### 流程 A：点击建议回复

1. Agent 显示建议：“根据签到调整计划”。
2. 用户点击建议。
3. 前端立即插入 user message：“根据签到调整计划”。
4. 前端调用对话接口，payload 包含 `user_instruction`、`workspace_id`、`project_id` 和当前会话上下文标识。
5. 对话流显示 run status：
   - 已读取最近签到和任务状态
   - 正在判断对计划的影响
   - 正在整理可确认草案
6. 后端 LLM Agent 根据项目状态决定生成计划调整提案。
7. 前端插入 agent message 和 `proposal_artifact_card`。
8. 用户可在卡片中确认、继续修改或查看影响。

### 流程 B：自由输入

1. 用户输入“我还是看不到你说的待确认提案”。
2. 后端 Agent 必须结合项目状态和最近产物判断问题，而不是只回复泛泛说明。
3. 如果确实有待确认提案，对话中直接返回 artifact card，并给出“跳到主面板”的入口。
4. 如果没有提案，Agent 说明没有找到，并建议重新生成。

### 流程 C：确认产物

1. 用户点击 artifact card 的“确认应用”。
2. 前端调用确认接口，或发送明确 user instruction：“确认应用这条计划调整提案”。
3. 界面立即把卡片状态改为确认中。
4. 后端应用提案并刷新项目状态。
5. 对话插入确认结果：“已应用，这次调整影响 3 个任务。”
6. 下一组建议围绕新的项目状态生成，例如“生成下一步行动卡”“分析调整后的风险”。

## 后端设计

### 对话接口

保留真实 Agent 决策链路。推荐对话接口接受：

```ts
type AgentConversationRequest = {
  workspace_id: string;
  project_id: string;
  user_instruction: string;
  conversation_id?: string;
};
```

后端返回结构化 turn：

```ts
type AgentConversationTurn = {
  conversation_id: string;
  user_message: AgentConversationMessage;
  agent_message: AgentConversationMessage;
  run: AgentRunSummary;
  artifacts: AgentArtifact[];
  suggestions: AgentSuggestion[];
};
```

### Agent 决策

后端 LLM Agent 负责：

- 读取项目状态、阶段、任务、签到、风险、成员信息和最近会话。
- 判断用户意图对应的项目推进动作。
- 决定是否需要生成 artifact。
- 输出简短解释、结构化 artifact、下一轮建议。

前端只根据返回的 `artifacts` 和 `suggestions` 渲染，不解析自然语言来决定业务动作。

### Suggestions

建议回复由后端生成，前端只渲染：

```ts
type AgentSuggestion = {
  id: string;
  label: string;
  user_instruction: string;
  priority: "primary" | "secondary";
};
```

`label` 是按钮文案，`user_instruction` 是点击后发送给对话接口的真实文本。两者可以相同，但后端可以给 `user_instruction` 补充必要上下文。

### Artifacts

统一 artifact 模型，避免每个模块各自塞字段：

```ts
type AgentArtifact = {
  id: string;
  type: "proposal" | "risk_analysis" | "action_card" | "assignment" | "direction" | "plan";
  status: "draft" | "pending_confirmation" | "confirmed" | "dismissed" | "expired";
  title: string;
  summary: string;
  rationale: string;
  impact: string[];
  linked_entity_ids: string[];
};
```

第一阶段可以在前端用适配函数把已有 proposal、risk、action card 数据转换成 artifact view model，不要求一次性重构全部数据库模型。

## 前端设计

### 组件拆分

建议把当前 `AgentSidebar` 拆成以下边界：

- `AgentSidebarShell`：宽度、折叠、头部、整体布局。
- `AgentConversationStream`：消息列表、滚动、自动定位。
- `AgentMessageBubble`：用户和 Agent 文本消息。
- `AgentContextCard`：当前焦点。
- `AgentRunStatusCard`：处理中步骤。
- `AgentArtifactCard`：提案、风险、行动卡等产物。
- `AgentSuggestionRow`：建议回复。
- `AgentComposer`：输入、发送、快捷键。
- `AgentAdvancedMenu`：低频操作。

### 状态模型

前端需要区分：

- `idle`
- `submitting`
- `running`
- `success`
- `error`

`submitting` 是用户消息已提交但后端还未返回；`running` 是已创建 run 或正在等待 Agent 输出。当前如果接口仍是非流式，可以把两者合并为一个 pending UI，但代码层要留出边界，方便后续升级。

### 视觉和交互

- 右侧栏宽度可以维持当前尺寸，但对话内容要占据主高度。
- 顶部 context card 压缩，不做大面积说明卡。
- 建议回复靠近最近 Agent 回复，不固定在 composer 上方。
- artifact card 的主操作必须可见，不能藏在高级菜单。
- 最近活动默认折叠到下方，不进入第一屏主视线。
- 错误状态用对话内 error card，而不是页面底部红条。

## 错误处理

### 后端 LLM 输出不可用

界面展示：

- “这次没有生成可用结果，我保留了你的请求。”
- 操作：重试、换一种说法、查看当前项目状态。

不展示“Planner 输出不可用”这类内部模块名。

### 网络失败

保留用户消息，显示 error card：

- 失败原因：网络或服务不可用
- 操作：重新发送
- 草稿不丢失

### Artifact 同步失败

如果 Agent 说生成了提案，但主页面没有显示，右侧 artifact card 必须仍然可见，并显示同步状态。用户可以点击“重新同步”或“查看详情”。这能避免再次出现“你说有，但我看不到”的体验断点。

## 测试策略

### 前端单元测试

- 点击建议回复会调用 `onSendMessage`，发送 `user_instruction` 文本。
- pending 时插入用户消息和运行状态。
- artifact card 能渲染 proposal、risk analysis、action card。
- artifact 状态变化后主操作按钮更新。
- error card 保留重试入口。
- conversation stream 不再只截取最后 6 条。

### 后端测试

- 自由输入和建议回复都进入同一对话接口。
- LLM 输出包含 `suggestions` 时能被解析并返回。
- 生成 proposal artifact 后可在对话 turn 中拿到 artifact id。
- 低质量 LLM 输出不会泄露内部错误文案给用户。
- 确认 artifact 后项目状态刷新。

### 集成验证

- 点击“根据签到调整计划”后，对话内能看到计划调整卡。
- 用户不需要离开右侧栏就能确认或修改提案。
- 主页面 `Agent 提案` 与右侧 artifact 状态一致。
- 刷新页面后，对话历史和待确认 artifact 仍可恢复。
- 服务失败时，界面可重试且不会丢失用户输入。

## 分阶段实施

### Phase 1：对话体验闭环

- 重构右侧栏为 Chat-first 布局。
- 建议回复改为 user instruction。
- 添加 run status、error card、artifact card。
- 对话中展示 proposal artifact。
- 修复“生成后看不到待确认提案”的体验断点。

### Phase 2：后端结构化输出增强

- 统一返回 `suggestions` 和 `artifacts`。
- 强化 LLM 输出解析和兜底。
- 把 risk analysis、action card、replan proposal 都映射为 artifact。

### Phase 3：成熟体验打磨

- 自动滚动策略。
- 处理中微交互。
- 消息重试。
- artifact 状态同步。
- 可选升级为 SSE 或流式响应。

## 非目标

- 不做前端 intent router。
- 不把建议按钮变回固定功能按钮。
- 不为了速度牺牲真实 LLM 判断。
- 不在第一阶段重构所有数据库模型。
- 不把右侧栏扩展成独立全屏 Agent 工作台。

## 验收标准

- 用户可以只通过右侧栏完成“根据签到调整计划”这类流程。
- 点击建议后立即看到用户消息和 Agent 处理中状态。
- Agent 生成的提案直接显示在对话内。
- 提案卡能说明原因、影响和当前状态。
- 用户能在对话内确认、修改或查看影响。
- 主页面提案面板与对话 artifact 状态一致。
- 最近活动和高级操作不再干扰主对话。
- 出错时没有内部模块名泄露，用户有明确恢复路径。

# ProjectFlow CodeWiki

> 自动生成于 2026-06-02，基于代码库全量扫描。Phase 40 更新于 2026-06-07。

---

## 1. 项目概览

**ProjectFlow** 是面向大学生项目小队的**主动推进型 AI Agent**。核心价值不是"记录任务"，而是持续回答：项目该往哪走？下一步做什么？谁适合做什么？哪些有风险？计划是否需要调整？

**技术栈**：Next.js 16 (React 18 + TypeScript) + FastAPI (Python 3.11+) + SQLite + 单 Coordinator Agent + 确定性状态机

**架构关键词**：Web 优先、本地演示优先、单 workspace、单项目、单 Agent、状态机控制主流程、AI 只负责判断与生成、确定性代码负责状态与落库

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    Next.js Frontend                      │
│  App Router · Tailwind CSS · shadcn/ui · Framer Motion   │
│  api.ts → types.ts → 领域组件 → 页面                      │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP (localhost:3000 → 8000/api)
┌──────────────────────────▼──────────────────────────────┐
│                    FastAPI Backend                        │
│  Route → Service → Model (SQLite)                        │
│  Agent: Coordinator → Module → Workflow → LLM Client     │
│  Proposal 确认后才持久化                                    │
└─────────────────────────────────────────────────────────┘
```

### 核心架构原则

| 原则 | 含义 |
|------|------|
| Single Coordinator Agent | MVP 不做多 Agent，避免调试复杂和成本上升 |
| Workspace-aware Agent | Agent 读取 workspace 完整状态快照 |
| Workflow First | 主流程由确定性状态机控制，Agent 只在指定节点生成建议 |
| Human-in-the-loop | 方向卡、阶段计划、分工、重排建议必须人工确认后生效 |
| AI Suggestions, Deterministic Commit | AI 生成 proposal，后端 service 负责落库和状态迁移 |
| Structured Output Only | Agent 输出必须符合 Pydantic schema，不依赖自然语言解析 |
| Explainability Required | 分工、风险、重排、推进建议都必须给 reason |

---

## 3. 目录结构

```
ProjectFlow/
├── AGENTS.md                  # AI Coding Agent 规范
├── CLAUDE.md                  # 与 AGENTS.md 同步
├── docs/                      # PRD、技术设计、API 契约、演示脚本
├── agent-bridge/              # T41 TypeScript Agent Runtime Sidecar
│   ├── src/
│   │   ├── runtime/           # pi-runtime.ts, context-builder.ts, model-router.ts
│   │   ├── server/            # HTTP server + routes
│   │   ├── tools/             # registry.ts, fastapi-client.ts, projectflow-tools.ts, register-defaults.ts, mock-tools.ts, result-normalizer.ts
│   │   ├── policy/            # policy-engine.ts, budget.ts, boundaries
│   │   ├── events/            # event-mapper.ts, stream.ts, trace-envelope.ts
│   │   ├── skills/            # skill-index.ts, skill-loader.ts, skill-selector.ts
│   │   ├── types/             # run-state.ts, tool-manifest.ts, tool-result.ts, wire.ts, runtime-event.ts
│   │   └── utils/             # 工具函数
│   ├── skills/                # 6 SKILL.md files
│   └── tests/unit/            # 18 test files, 540 tests
├── frontend/
│   ├── src/
│   │   ├── app/               # Next.js 页面路由（不写业务逻辑）
│   │   ├── components/        # 按业务领域拆分的 UI 组件
│   │   │   ├── ui/            # 通用 UI 基础组件（shadcn/ui）
│   │   │   ├── agent/         # Agent 面板：行动卡、时间线、提案、方向卡、导出
│   │   │   ├── assignment/    # 分工流程面板
│   │   │   ├── checkin/       # 签到表单
│   │   │   ├── member/        # 成员管理弹窗
│   │   │   ├── onboarding/    # 账号创建 + 成员资料向导
│   │   │   ├── project/       # 三栏布局(project-layout/sidebar/content/agent-sidebar) + 仪表盘 + 创建 + 资源 + 方向决策
│   │   │   ├── risk/          # 风险卡 + 风险面板 + 重排对比
│   │   │   ├── stage/         # 阶段计划看板
│   │   │   ├── task/          # 任务拆解看板 + 状态更新
│   │   │   └── workspace/     # 工作区创建 + 邀请成员 + workspace 内容视图
│   │   ├── lib/
│   │   │   ├── api.ts         # 所有 fetch 统一入口（35 个 API 函数）
│   │   │   ├── types.ts       # 前端类型（25 个领域类型）
│   │   │   ├── constants.ts   # 示例数据常量
│   │   │   └── utils.ts       # cn() 工具函数
│   │   └── styles/
│   │       └── globals.css    # Tailwind + 蓝金视觉体系(Instrument Serif + Inter 字体)
│   └── package.json
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI 入口，21 个 router
│   │   ├── core/              # config, database, db_utils, security
│   │   ├── models/            # 数据库模型（15 个实体 + 16 个 Enum）
│   │   ├── schemas/           # API / Agent schema（22 个文件）
│   │   ├── api/               # HTTP route（22 个路由文件）
│   │   ├── services/          # 确定性业务逻辑（19 个 service）
│   │   ├── agent/             # Agent 编排和 LLM 调用
│   │   │   ├── coordinator.py # Agent 入口，9 个公开方法
│   │   │   ├── workflow.py    # 执行引擎：调 LLM → 解析 → 校验 → 重试 → fallback
│   │   │   ├── prompts.py     # Prompt 构建 + 输出格式契约
│   │   │   ├── llm_client.py  # LLM 客户端抽象（Mock/OpenAI 兼容）
│   │   │   ├── output_schemas.py # Agent 输出 Pydantic 校验模型
│   │   │   └── modules/       # 9 个能力模块
│   │   ├── seed/              # Demo 种子数据
│   │   └── tests/             # pytest 测试（17 个 test_*.py 文件）
│   └── pyproject.toml
└── .agents/                   # Skills 和 Plugins 配置
```

### 目录职责硬规则

| 目录 | 职责 | 硬规则 |
|------|------|--------|
| `frontend/src/app` | 页面路由和页面组合 | 不写复杂业务逻辑 |
| `frontend/src/components` | UI 组件 | 按业务领域拆分，不混写 API |
| `frontend/src/lib/api.ts` | 前端请求封装 | 所有 fetch 统一从这里走 |
| `frontend/src/lib/types.ts` | 前端类型 | 与后端 schema 保持同步 |
| `backend/app/api` | HTTP route | 只处理请求/响应，不写业务逻辑 |
| `backend/app/services` | 确定性业务逻辑 | 落库、状态迁移、校验都在这里 |
| `backend/app/agent` | Agent 编排和 LLM 调用 | 不直接处理 HTTP，不直接写 DB |
| `backend/app/models` | 数据库模型 | 只定义持久化结构 |
| `backend/app/schemas` | API / Agent schema | 所有接口必须走 schema |
| `backend/app/seed` | Demo 种子数据 | 不混入正式服务逻辑 |

---

## 4. Agent 状态机

Agent 工作流由确定性状态机驱动，9 个模块对应 9 个能力节点：

```
AccountSetup → WorkspaceSetup → MemberProfiles → ProjectIntake
    → Clarification → StagePlanning → TaskBreakdown
    → AssignmentRecommendation → AssignmentConfirmation → ActivePush
    → Execution → CheckIn → RiskAnalysis → Replanning → ActivePush

AssignmentConfirmation ↔ AssignmentNegotiation（成员拒绝后协调交换）
Stage 完成后 → 下一阶段 → 重新触发阶段性分工推荐
```

### Agent 模块对照表

| 模块 | 输入 | 输出 | 是否需要确认 |
|------|------|------|------------|
| Clarification | 项目想法、资源、成员、当前时间 | 方向卡（问题/用户/价值/交付物/边界/风险/依据摘要/假设/未知项/MVP 边界/决策点） | ✅ 需确认后写入 Project.direction_card |
| Planning | 方向卡、截止日期、交付物 | 阶段计划（3-5 个 Stage） | ✅ 需确认后创建 Stage |
| Breakdown | 阶段、交付物、资源 | 任务列表（含优先级/依赖/可砍标记，任务有 `id` 字段用于 dependency_ids 自引用） | ✅ 需确认后创建 Task |
| Assignment Recommendation | 任务、成员画像 | 分工提案（owner + backup + reason + 匹配度） | 需 finalize |
| Assignment Negotiation | 拒绝信息、期望任务 | 交换协调建议 | AgentEvent timeline-only；不进入通用 AgentProposal |
| Active Push | 项目状态、阶段、分工 | 行动卡（7 种类型） | 直接持久化 |
| Check-in Analysis | 签到响应 | 状态摘要 + 可能风险 | 直接持久化 |
| Risk Analysis | 任务、签到、截止日期、分工 | 风险卡（有 blocker 时必须产出风险项） | 直接持久化 |
| Replanning | 风险、项目状态 | 重排提案（必须包含结构性变更 + action_card 格式规范） | ✅ 进入 AgentProposal，确认后才改任务/阶段/行动卡 |

### Agent 稳定性规则

1. 不直接写数据库，所有写入通过 service 层
2. 不直接修改 finalized assignment
3. 不直接修改 task owner，必须通过 confirm endpoint
4. 不输出无法解析的自然语言作为核心数据
5. 不凭空发明不存在的用户、任务、阶段
6. 所有建议必须包含 reason
7. 高影响变更必须等待人工确认
8. 输出失败必须 fallback（JSON 修复 → retry → 模板化 fallback → timeline 记录）
9. Prompt 中用户数据必须用 XML 标签隔离，防止指令注入
10. Fallback payload 不能包含 None 值
11. Prompt 必须注入当前日期/时间/时区，避免周期和截止日期误判
12. clarify/plan/breakdown 必须带项目资源摘要，不能只看项目 idea
13. AgentProposal 只覆盖 clarify/plan/breakdown/replan；negotiate 保持 timeline-only
14. **Global Scope Rule**: 所有输出字段禁止提及外部系统（教务系统、移动端 App、GitHub 等），使用通用替代词
15. **Before Output Self-Check**: 输出前自检日期格式（YYYY-MM-DD）、禁止术语、成员/任务引用是否合法、requires_confirmation 是否设置

---

## 5. 后端模块详解

### 5.1 入口与基础设施

#### [main.py](backend/app/main.py)

FastAPI 应用组装：lifespan 初始化 DB → CORS 中间件（localhost:3000/3001）→ 全局异常处理器 → 挂载 21 个 router（prefix=/api）

#### [core/config.py](backend/app/core/config.py)

`Settings` 类从 `.env` 加载全局配置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `APP_ENV` | `development` | 环境 |
| `DATABASE_URL` | `sqlite:///./data/projectflow.sqlite` | 数据库 |
| `LLM_PROVIDER` | `mock` | mock / openai / openai-compatible |
| `LLM_API_KEY` | `SecretStr` | API Key（不暴露） |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | LLM 基础 URL |
| `LLM_MODEL` | `gpt-4o-mini` | 模型名 |
| `LLM_TIMEOUT_SECONDS` | `30.0` | 诊断超时 |
| `LLM_AGENT_TIMEOUT_SECONDS` | `120.0` | Agent 生成超时 |
| `DEMO_ADMIN_TOKEN` | 可选 | 非 development 环境保护 seed/reset |
| `INTERNAL_SERVICE_TOKEN` | 可选配置，internal endpoints 必需 | sidecar service-to-service Bearer token |

#### [core/database.py](backend/app/core/database.py)

创建 SQLModel/SQLite 引擎，注册所有模型，提供 `get_session()` 依赖注入

#### [core/db_utils.py](backend/app/core/db_utils.py)

`require_row(session, Model, id, label)` — 按 ID 查行，不存在则抛 ValueError

#### [core/security.py](backend/app/core/security.py)

`require_demo_admin_access()` — 保护破坏性 demo 端点：开发环境放行，其他环境需 admin token

### 5.2 数据模型层

#### 枚举体系（[enums.py](backend/app/models/enums.py)）

16 个 Enum 类覆盖全系统：

| 枚举 | 值 |
|------|-----|
| `WorkspaceRole` | owner / member |
| `InvitationStatus` | pending / accepted / expired |
| `ProjectStatus` | draft / active / at_risk / completed |
| `ResourceType` | text_note / file_stub / link |
| `StageStatus` | pending / active / completed / at_risk |
| `TaskPriority` | P0 / P1 / P2 |
| `TaskStatus` | not_started / in_progress / done / blocked / cancelled |
| `AssignmentProposalStatus` | proposed / owner_confirmed / owner_rejected / negotiating / finalized |
| `AssignmentResponseType` | accept / reject |
| `NegotiationStatus` | pending / accepted / declined / resolved |
| `CheckInCycleStatus` | active / paused / completed |
| `MoodOrConfidence` | low / medium / high |
| `RiskType` | deadline / dependency / workload / scope / review / assignment / checkin |
| `RiskSeverity` | low / medium / high |
| `RiskStatus` | open / accepted / ignored / resolved |
| `ActionCardType` | personal_task / team_next_step / reminder / risk_action / kickoff_tip / checkin_prompt / assignment_request / suggestion |
| `ActionCardStatus` | active / done / dismissed |
| `AgentEventType` | clarify / plan / breakdown / assign / negotiate / push / checkin / risk / replan / export |
| `AgentEventStatus` | success / repaired / fallback / failed |
| `AgentProposalStatus` | pending / confirmed / rejected |

#### 核心实体关系

```
User ──1:N──> MemberProfile (绑定 workspace)
User ──1:N──> WorkspaceMembership
Workspace ──1:N──> Invitation
Workspace ──1:N──> Project
Project ──1:N──> ProjectResource
Project ──1:N──> Stage ──1:N──> Task
Project ──1:N──> AgentProposal
Task ──1:N──> AssignmentProposal ──1:N──> AssignmentResponse
Project ──1:N──> AssignmentNegotiation
Project ──1:N──> CheckInCycle ──1:N──> CheckInResponse
Task ──1:N──> TaskStatusUpdate
Project ──1:N──> Risk
Project ──1:N──> ActionCard
Project ──1:N──> AgentEvent
```

#### 模型详情

| 模型 | 关键字段 | 说明 |
|------|---------|------|
| `User` | id, display_name, email, avatar_url | 轻量账号，MVP 不做密码 |
| `Workspace` | name, owner_user_id, description, team_size, use_case | 团队空间，MVP 单 workspace |
| `WorkspaceMembership` | workspace_id, user_id, role | 成员关系 |
| `Invitation` | workspace_id, invited_name, token, status | 邀请链接 |
| `MemberProfile` | user_id, workspace_id, skills(JSON), available_hours_per_week, role_preference, interests, constraints | 成员能力画像 |
| `Project` | workspace_id, name, idea, deadline, deliverables, status, direction_card(JSON), created_by | 项目核心实体 |
| `ProjectResource` | project_id, type, title, content_text, url, file_name | 项目资源 |
| `Stage` | project_id, name, goal, start/end_date, deliverable, done_criteria(JSON), status, order_index | 项目阶段 |
| `Task` | project_id, stage_id, title, priority, status, owner/backup_user_id, due_date, estimated_hours, dependency_ids(JSON), acceptance_criteria(JSON), can_cut, order_index | 任务（含排序字段） |
| `TaskStatusUpdate` | task_id, user_id, status, progress_note, blocker | 任务状态变更记录 |
| `AssignmentProposal` | task_id, recommended/backup_owner, reason, skill/availability/preference/constraint_match, risk_note, status | 分工提案 |
| `AssignmentResponse` | proposal_id, user_id, response, preferred_task_id, reason | 分工响应 |
| `AssignmentNegotiation` | from_user_id, desired_task_id, current_owner, status, agent_message | 分工协商 |
| `CheckInCycle` | project_id, stage_id, cadence_days, next_due_date, status | 签到周期 |
| `CheckInResponse` | cycle_id, user_id, what_done, blocker, available_hours_next_cycle, mood_or_confidence | 签到响应 |
| `Risk` | project_id, stage/task_id, type, severity, title, description, evidence(JSON), recommendation, status | 风险条目 |
| `ActionCard` | project_id, stage/task/user_id, type, title, content, reason, goal, start_suggestion, completion_standard, due_date, status | 行动卡 |
| `AgentProposal` | project_id, workspace_id, proposal_type, status, payload(JSON), confirmed_by, rejection_reason | Agent 提案（clarify/plan/breakdown/replan；确认前不写入项目状态；reject 时记录原因） |
| `AgentEvent` | project_id, workspace_id, event_type, status, input/output_snapshot, reasoning_summary, user_confirmed | Agent 决策日志 |

### 5.3 Schema 层

22 个 schema 文件，每个对应一个领域。关键通用工具：

- [common.py](backend/app/schemas/common.py)：`NonEmptyStr`、`EmailText`、`reject_past_date()`、`reject_inverted_date_range()`
- [workspace_state.py](backend/app/schemas/workspace_state.py)：`WorkspaceStateResponse` — Agent 输入上下文，聚合 workspace 下成员+项目+阶段+任务+项目资源+当前日期/时间/时区的完整快照

### 5.4 Agent 层

#### 执行引擎（[workflow.py](backend/app/agent/workflow.py)）

```
generate_structured_output()
  → 调 LLM
  → 解析 JSON（含 _repair_json_text 修复）
  → validate_agent_output() Pydantic 校验
  → _validate_references() 引用完整性检查（确保 AI 不捏造 ID）
  → 最多重试 2 次
  → 失败走 fallback
  → _log_agent_event() 记录 AgentEvent
```

#### LLM 客户端（[llm_client.py](backend/app/agent/llm_client.py)）

- `LLMClient`（Protocol 接口）
- `MockLLMClient` — mock 实现，返回预设 JSON
- `OpenAICompatibleLLMClient` — 用 httpx（连接池复用）调 HTTP，兼容 OpenAI API 格式
- 异常层级：`LLMError` > `LLMConfigurationError` / `LLMAuthError` / `LLMTimeoutError` / `LLMConnectionError` / `LLMResponseError`
- 工厂函数：`build_llm_client()`（诊断用 30s 超时）、`build_agent_llm_client()`（Agent 用 120s 超时）

#### Prompt 构建（[prompts.py](backend/app/agent/prompts.py)）

- `AGENT_SYSTEM_PROMPT` — 全局系统提示（含 **Global Scope Rule** 禁止提及外部系统 + **Before Output Self-Check** 自检日期格式/禁止术语/引用合法性）
- `OUTPUT_CONTRACT_BY_EVENT_TYPE` — 按 event_type 裁剪的输出格式契约
- `build_prompt_messages()` — 组装：系统提示 + workspace_state JSON（XML 标签隔离）+ 输出格式契约
- `_compact_workspace_state_json()` — 紧凑序列化 workspace 状态

#### 输出校验（[output_schemas.py](backend/app/agent/output_schemas.py)）

10 个 Pydantic 校验模型（关键 schema 变更：`TaskBreakdownItem` 带 `id` 字段，空值时自动生成 `task-{n}`；`ActionCardProposal.content` 可选；`_validate_references` 接受 breakdown 输出中的新任务 ID 作为合法 dependency_ids）：

| Schema | 对应模块 |
|--------|---------|
| `DirectionCardOutput` | Clarification |
| `StagePlanOutput` | Planning |
| `TaskBreakdownOutput` | Breakdown |
| `AssignmentRecommendationOutput` | Assignment Recommendation |
| `AssignmentNegotiationOutput` | Assignment Negotiation |
| `ActivePushOutput` | Active Push |
| `CheckInAnalysisOutput` | Check-in Analysis |
| `RiskAnalysisOutput` | Risk Analysis |
| `ReplanOutput` | Replanning |

#### 协调器（[coordinator.py](backend/app/agent/coordinator.py)）

`CoordinatorAgent` 是 Agent 入口类，9 个公开方法对应 9 种能力，每个方法组装 module request 后委托给 `generate_structured_output`

#### 能力模块（[modules/](backend/app/agent/modules/)）

每个模块暴露 `build_request()` 函数，构建该模块所需的 `AgentModuleRequest`：

| 模块 | 文件 | 职责 |
|------|------|------|
| Clarification | clarification.py | 构建澄清请求 → 生成方向卡 |
| Planning | planning.py | 构建阶段规划请求 → 生成阶段计划 |
| Breakdown | breakdown.py | 构建任务拆解请求 → 生成任务列表 |
| Assignment Recommendation | assignment_recommendation.py | 构建分配推荐请求 → 匹配成员到任务 |
| Assignment Negotiation | assignment_negotiation.py | 构建分配协商请求 → 成员拒绝后替代方案 |
| Active Push | active_push.py | 构建主动推送请求 → 生成行动卡 |
| Check-in Analysis | checkin_analysis.py | 构建签到分析请求 → 分析进度/阻碍/风险 |
| Risk Analysis | risk_analysis.py | 构建风险分析请求 → 返回风险项 |
| Replanning | replanning.py | 构建重计划请求 → 最小化调整提案 |

公共结构（[common.py](backend/app/agent/modules/common.py)）：`AgentModuleRequest` + 辅助函数（`project_deadline_or_today`、`project_name_or_default`、`project_idea_or_default`、`first_stage_name_or_default`、`stage_windows`、`first_stage_id`、`first_task_id`、`first_member_id`）

### 5.5 Service 层

19 个 service 文件，核心业务逻辑：

| Service | 关键函数 | 核心职责 |
|---------|---------|---------|
| [user_service.py](backend/app/services/user_service.py) | create/get/list | 用户 CRUD |
| [workspace_service.py](backend/app/services/workspace_service.py) | create/get/list, add/remove_member | 工作空间 CRUD + 成员管理 |
| [project_service.py](backend/app/services/project_service.py) | create/get/list/update, normalize_direction_card | 项目 CRUD + direction_card 规范化 |
| [stage_service.py](backend/app/services/stage_service.py) | create/get/list/update, try_advance_stage | 阶段 CRUD + 阶段自动推进 |
| [task_service.py](backend/app/services/task_service.py) | create/get/list/update, create_status_update | 任务 CRUD + 状态更新（支持 auto_commit）+ 阶段自动推进钩子 |
| [assignment_service.py](backend/app/services/assignment_service.py) | create_proposal/response, finalize, create_negotiation | 分配全流程：提案→响应→确认→写入 Task.owner |
| [member_profile_service.py](backend/app/services/member_profile_service.py) | create/get/update/list/delete | 成员画像 CRUD |
| [checkin_service.py](backend/app/services/checkin_service.py) | create_cycle/list, create_response/list | 签到周期与响应 |
| [risk_service.py](backend/app/services/risk_service.py) | create/list/update_status | 风险 CRUD（支持 auto_commit） |
| [resource_service.py](backend/app/services/resource_service.py) | create/list/delete | 资源 CRUD + 上传文件删除 |
| [invitation_service.py](backend/app/services/invitation_service.py) | create/accept | 邀请创建与接受（自动创建 User + Membership） |
| [action_card_service.py](backend/app/services/action_card_service.py) | create/list/update_status | 行动卡 CRUD |
| [agent_flow_service.py](backend/app/services/agent_flow_service.py) | run_agent_flow, _persist_agent_output | Agent 执行编排：获取状态→调 coordinator→按类型持久化 |
| [agent_proposal_service.py](backend/app/services/agent_proposal_service.py) | create/confirm/reject, _persist_clarification/plan/breakdown | Agent 提案生命周期 |
| [replan_service.py](backend/app/services/replan_service.py) | confirm_replan | 重计划确认（保护 finalized assignment 不被覆盖） |
| [export_service.py](backend/app/services/export_service.py) | generate_review_summary | 聚合全量数据生成 Markdown 评审摘要 |
| [llm_service.py](backend/app/services/llm_service.py) | run_diagnostic | LLM 连通性诊断 |
| [timeline_service.py](backend/app/services/timeline_service.py) | list_timeline_by_project | Agent 时间线查询 |
| [workspace_state_service.py](backend/app/services/workspace_state_service.py) | get_workspace_state | 聚合 workspace 完整状态快照 |

### 5.6 API 路由层

22 个路由文件，所有端点前缀 `/api`：

| 路由文件 | 端点数 | 关键端点 |
|---------|--------|---------|
| routes_health | 1 | GET /health |
| routes_users | 3 | POST/GET /users, GET /users/{id} |
| routes_workspaces | 5 | POST/GET /workspaces, POST/DELETE members |
| routes_invitations | 2 | POST /invitations, POST /invitations/accept |
| routes_member_profiles | 4 | POST/GET/PATCH profiles |
| routes_projects | 5 | POST/GET/PATCH/DELETE projects |
| routes_resources | 3 | POST/GET/DELETE resources |
| routes_uploads | 1 | POST /uploads (multipart file upload) |
| routes_stages | 4 | POST/GET/PATCH stages |
| routes_tasks | 6 | POST/GET/PATCH tasks, POST status-updates |
| routes_assignments | 9 | proposals + responses + negotiations + finalize |
| routes_checkins | 4 | cycles + responses |
| routes_risks | 3 | POST/GET/PATCH risks |
| routes_action_cards | 3 | POST/GET/PATCH action-cards |
| routes_agent | 8 | POST /agent/{clarify,plan,breakdown,assign,active-push,check-in-analysis,risk-analysis,replan} |
| routes_agent_proposals | 4 | GET/POST proposals (confirm/reject) |
| routes_replans | 1 | POST /replans/confirm |
| routes_timeline | 1 | GET /projects/{id}/timeline |
| routes_workspace_state | 1 | GET /workspaces/{id}/state |
| routes_export | 1 | POST /projects/{id}/export/review-summary |
| routes_demo | 1 | POST /demo/reset |
| routes_seed | 2 | POST /seed/demo, POST /seed/reset |
| routes_llm | 2 | GET/POST /llm/diagnostic |

---

## 6. 前端模块详解

### 6.1 页面路由

| 路由 | 页面组件 | 职责 |
|------|---------|------|
| `/` | HomePage | 渲染 `<ProjectFlowHome />`，有缓存 workspaceId 时自动跳转工作台 |
| `/onboarding` | OnboardingPage | 账号设置引导，渲染 `<AccountSetupForm />` |
| `/onboarding/profile` | ProfilePage | 成员资料填写，渲染 `<MemberProfileWizard />` |
| `/workspaces/new` | NewWorkspacePage | 新建工作区 |
| `/workspaces/[workspaceId]` | WorkspaceDashboardPage | **唯一动态路由入口**，三栏布局。有项目时默认加载第一个项目，无项目时显示工作台首页。项目切换通过 `?project={id}`，视图切换通过 `?view={view}` |
| ~~`/projects/new`~~ | ~~已删除~~ | ~~合并到 `/workspaces/[workspaceId]` 内通过弹窗创建~~ |
| ~~`/projects/[projectId]`~~ | ~~已删除~~ | ~~合并到 `/workspaces/[workspaceId]?project={id}`~~ |

### 6.2 核心组件

#### 顶层组件

| 组件 | 职责 |
|------|------|
| `AppShell` | 全局外壳：全高布局、导航栏（桌面/移动端）、身份切换下拉框、workspaceId 缓存 |
| `ProjectFlowHome` | 首页 Hero：智能跳转或展示入口 |
| `ProjectDashboard` | **项目仪表盘主组件**：Agent 操作面板(4 阶段 8 action) + 方向卡 + 阶段计划 + 任务拆解 + 分工流程 + Tab 面板 |

#### 三栏布局组件（Phase 28 新增，Phase 32 合并路由）

| 组件 | 职责 |
|------|------|
| `WorkspaceLayout` | 三栏布局容器：左 sidebar + 中 content + 右 agent sidebar。管理 `showWorkspace` / `selectedProjectId` 状态切换 |
| `ProjectSidebar` | 左侧 workspace/project 导航树。支持项目选择回调（不跳转）、workspace 首页切换、视图导航 |
| `ProjectContent` | 中间内容区：渲染当前选中的项目视图（overview/stages/tasks 等） |
| `WorkspaceContent` | 中间内容区：workspace 概览（成员统计、项目列表、新建项目弹窗入口） |
| `AgentSidebar` | 右侧 Agent 操作面板。无项目时显示空状态 |
| `NewProjectDialog` | 弹窗式新建项目 |
| `NewWorkspaceDialog` | 弹窗式新建工作区 |
| `CompactStat` | 紧凑统计展示组件 |
| `DirectionDecisionView` | 方向卡决策视图 |

#### Agent 面板组件

| 组件 | 职责 |
|------|------|
| `PendingProposalBanner` | 专业视图（方向/阶段）中的待确认提案提示条，含"去确认"按钮跳转总览 |
| `AgentProposalPanel` | 方向卡/阶段/任务 Agent 提案面板，按类型渲染不同 payload，展示生成状态（成功/已修复/基础建议/失败），支持确认/拒绝；集中展示于总览视图 |
| `DirectionCardPanel` | 方向卡展示 + 运行澄清按钮 + 待确认状态提示 |
| `ActionCardItem` / `ActionCardsList` | 单张/列表行动卡渲染 |
| `TeamActionsPanel` | 团队类型行动卡筛选 |
| `AgentTimeline` | Agent 时间线（按日期分组，10 种事件类型各有图标） |
| `ExportPanel` | 导出评审摘要（Markdown 预览 + 复制） |

#### 业务领域组件

| 组件 | 职责 |
|------|------|
| `AssignmentFlowPanel` | 分工全流程：推荐→接受/拒绝→协商→确认 |
| `CheckInForm` | 签到表单（关联任务+完成内容+阻塞+可用时间+信心） |
| `MemberManagementDialog` | 成员管理弹窗（列表/添加/编辑/删除）；添加/编辑表单含姓名、邮箱、角色偏好、专业、年级、可用时间（自定义 stepper）、偏好工作时段（必填）、技能、过往项目、兴趣方向、限制条件 |
| `AccountSetupForm` | 账号创建 + 演示用户选择 |
| `MemberProfileWizard` | 三步向导：基本信息（姓名/角色偏好/专业/年级）→技能经验（技能/等级/热门技能填入输入框/过往项目）→可用时间（自定义 stepper/偏好工作时段必填/兴趣方向/限制条件） |
| `ProjectIntakeForm` | 新建项目表单（含资源输入面板） |
| `ResourceInputPanel` | 资源输入（文本/链接/文件引用） |
| `StagePlanBoard` | 阶段计划看板（总进度+时间线布局+待确认阶段预览） |
| `TaskBreakdownBoard` | 任务拆解看板（按阶段分组、order_index 排序、progress 圆标、空阶段占位） |
| `TaskStatusUpdate` | 任务状态更新表单 |
| `RiskCard` / `RiskPanel` | 风险卡/风险面板（筛选器+高危计数） |
| `ReplanDiff` | 重排对比（before/after diff） |
| `WorkspaceCreateForm` | 两步创建工作区（基本信息 + 团队上下文） |
| `InviteMemberPanel` | 邀请成员面板 |

### 6.3 数据层

#### [api.ts](frontend/src/lib/api.ts) — 35 个 API 函数

基础设施：
- `request<T>(path, options)` — 通用 HTTP 请求，120s 超时，自动 JSON 解析
- `apiGet<T>(path)` — GET 快捷方法
- `normalizeUser/normalizeWorkspace/normalizeInvitation/normalizeRisk` — 后端字段名适配

| 领域 | 函数 |
|------|------|
| Users | createUser, listUsers, selectDemoUser |
| Workspaces | createWorkspace, getWorkspace, getWorkspaceState |
| Invitations | createInvitation, acceptInvitation |
| Member Profile | upsertMemberProfile, listMemberProfilesByWorkspace |
| Projects | createProject, getProject, getProjectState, listProjectsByWorkspace |
| Resources | addResource, listResourcesByProject |
| Stages | listStagesByProject |
| Tasks | listTasksByProject, updateTaskStatus |
| Agent | runClarification, runPlanning, runBreakdown, runAssignment, runAgentNegotiate, runActivePush, runCheckinAnalysis, runRiskAnalysis, runReplan |
| Agent Proposals | listAgentProposalsByProject, confirmAgentProposal, rejectAgentProposal |
| Assignments | listAssignmentProposalsByProject, listAssignmentResponsesByProject, listAssignmentNegotiationsByProject, respondToAssignment, startNegotiation, resolveNegotiation, finalizeAssignments |
| Check-in | createCheckinCycle, submitCheckinResponse, listCheckinCyclesByProject |
| Risks | listRisksByProject, updateRiskStatus |
| Action Cards | listActionCardsByProject, updateActionCardStatus |
| Timeline | listTimelineByProject |
| Members | addWorkspaceMember, removeMember |
| Seed/Reset | loadDemoSeed, resetDemoData, resetDemo |
| Export | exportReviewSummary |

#### [types.ts](frontend/src/lib/types.ts) — 25 个领域类型

聚合类型：
- `WorkspaceState` — workspace + users + memberships + profiles + projects
- `ProjectState` — workspace + project + resources + members + profiles + stages + tasks + agent_proposals + assignment_* + checkins + risks + action_cards + timeline

### 6.4 前端状态管理

无全局状态库，依赖：
- React 本地 state + props 传递
- localStorage（workspaceId / userId / members 缓存）
- `useSyncExternalStore` 避免 hydration mismatch

关键约定：
- `setLastWorkspaceId()` 在 workspace/project 页面调用
- `setCurrentUserId()` / `useCurrentUserId()` 管理当前用户身份
- 项目仪表盘 `currentUserId` 优先取 localStorage，fallback 到 `project.created_by`
- 首页 (`/`) 在跳转前会先验证 localStorage 中的 workspace 是否仍存在于后端；若不存在则自动清除记录，避免"加载工作台失败"
- `/workspaces/[workspaceId]` 为跳转路由：有项目→第一个项目，无项目→新建项目页
- 项目页采用三栏布局：`ProjectSidebar`(workspace/project 导航) + `ProjectContent`(内容) + `AgentSidebar`(Agent 操作)

---

## 7. API 契约速查

Base URL: `http://localhost:8000/api`

### 核心 CRUD

| 领域 | 方法 | 端点 |
|------|------|------|
| 用户 | POST | /users |
| 用户 | GET | /users, /users/{id} |
| 工作区 | POST | /workspaces?owner_user_id=... |
| 工作区 | GET | /workspaces, /workspaces/{id} |
| 工作区成员 | POST/DELETE | /workspaces/{id}/members, /workspaces/{id}/members/{uid} |
| 邀请 | POST | /invitations, /invitations/accept |
| 成员画像 | POST/GET/PATCH | /member-profiles, /workspaces/{id}/profiles |
| 项目 | POST/GET/PATCH | /projects, /workspaces/{id}/projects |
| 资源 | POST/GET/DELETE | /resources, /projects/{id}/resources |
| 文件上传 | POST (multipart) | /uploads |
| 阶段 | POST/GET/PATCH | /stages, /projects/{id}/stages |
| 任务 | POST/GET/PATCH | /tasks, /stages/{id}/tasks, /projects/{id}/tasks |
| 任务状态 | POST | /tasks/{id}/status-updates |

### Agent 端点

所有 Agent 端点接受 `{ workspace_id: "uuid", project_id?: "uuid" }`，返回：

```json
{
  "event_type": "clarify",
  "status": "success | repaired | fallback | failed",
  "attempts": 1,
  "used_fallback": false,
  "output": {},
  "created_ids": ["uuid"],
  "proposal_id": "uuid | null"
}
```

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | /agent/clarify | 澄清方向 → AgentProposal(clarify) |
| POST | /agent/plan | 阶段规划 → AgentProposal(plan) |
| POST | /agent/breakdown | 任务拆解 → AgentProposal(breakdown) |
| POST | /agent/assign | 分工推荐 → AssignmentProposal |
| POST | /agent/negotiate | 协商建议 → AgentEvent timeline-only |
| POST | /agent/active-push | 主动推送 → ActionCard |
| POST | /agent/check-in-analysis | 签到分析 → Risk + inferred task changes as AgentProposal(replan) |
| POST | /agent/risk-analysis | 风险分析 → Risk |
| POST | /agent/replan | 重排建议 → AgentProposal(replan)，需确认 |

### T41 Internal Agent Tools

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | /internal/agent-tools/workspace-state | read-only WorkspaceState 工具 |
| POST | /internal/agent-tools/conversation | read-only Agent conversation 工具 |
| POST | /internal/agent-tools/pending-proposals | read-only pending proposal 工具 |
| POST | /internal/agent-tools/timeline-slice | read-only timeline slice 工具 |
| POST | /internal/agent-tools/direction-card-proposal | draft-only `generate_direction_card_proposal`，创建 pending clarify proposal |
| POST | /internal/agent-tools/stage-plan-proposal | draft-only `generate_stage_plan_proposal`，创建 pending plan proposal |
| POST | /internal/agent-tools/task-breakdown-proposal | draft-only `generate_task_breakdown_proposal`，创建 pending breakdown proposal |
| POST | /internal/agent-tools/assignment-recommendation | draft-only `recommend_assignment`，创建 typed AssignmentProposal |
| POST | /internal/agent-tools/checkins-and-risks-analysis | advisory-write `analyze_checkins_and_risks`，创建 Risk/ActionCard advisory records |
| POST | /internal/agent-tools/create-risk | advisory-write `create_risk`，直接创建 Risk advisory record |
| POST | /internal/agent-tools/create-checkin | advisory-write `create_checkin`，直接创建 CheckInCycle + CheckInResponse |
| POST | /internal/agent-tools/replan-proposal | draft-only `generate_replan_proposal`，创建 pending replan proposal；重复 pending replan 时返回 blocked |

这些 internal tool endpoints 必须带 `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`；未知工具返回 `blocked/TOOL_NOT_FOUND`，feature flag 禁用返回 `blocked/POLICY_DENIED`，未处理 crash 返回 `failed/unknown`。Proposal confirm/reject 仍走公开 proposal API，不作为 internal agent tool。

### 提案确认

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | /agent-proposals?project_id=...&proposal_type=... | 列出提案 |
| GET | /agent-proposals/{id} | 获取提案 |
| POST | /agent-proposals/{id}/confirm | 确认（持久化到项目状态） |
| POST | /agent-proposals/{id}/reject | 拒绝 |

### 分工流程

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | /assignment-proposals | 创建分工提案 |
| POST | /assignment-proposals/{id}/responses | 响应（accept/reject） |
| POST | /assignment-proposals/{id}/finalize | 确认最终分工 |
| POST | /stages/{id}/assignments/finalize | 按阶段批量确认 |
| POST | /assignment-negotiations | 发起协商 |

### 其他

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | /checkin-cycles | 创建签到周期 |
| POST | /checkin-cycles/{id}/responses | 提交签到 |
| POST | /replans/confirm | 确认重排 |
| GET | /projects/{id}/timeline | Agent 时间线 |
| POST | /projects/{id}/export/review-summary | 导出评审摘要 |
| GET/POST | /llm/diagnostic | LLM 连通性诊断 |
| POST | /seed/demo | 加载演示种子 |
| POST | /seed/reset | 清空数据 |
| POST | /demo/reset | 前端重置按钮兼容端点 |

---

## 8. 数据流

### Agent 执行流

```
前端点击 Agent 按钮
  → api.ts runXxx(workspace_id)
  → POST /api/agent/xxx
  → routes_agent.py
  → agent_flow_service.run_agent_flow()
    → workspace_state_service.get_workspace_state()  // 获取完整状态
    → CoordinatorAgent.xxx(state)                     // 组装 module request
    → workflow.generate_structured_output()            // 调 LLM
      → llm_client.chat_completion()                  // HTTP 请求 LLM
      → _parse_or_repair_json()                       // 解析/修复 JSON
      → validate_agent_output()                       // Pydantic 校验
      → _validate_references()                        // 引用完整性
      → 失败重试 → fallback
    → _log_agent_event()                              // 记录 AgentEvent
    → _persist_agent_output()                         // 按 output 类型持久化
  → 返回 AgentFlowRead（含 proposal_id）
```

### Agent 提案确认流

```
前端确认提案
  → api.ts confirmAgentProposal(proposal_id)
  → POST /api/agent-proposals/{id}/confirm
  → agent_proposal_service.confirm_proposal()
    → 按 proposal_type 持久化：
      clarify → Project.direction_card
      plan → 创建 Stage 记录
      breakdown → 创建 Task 记录
      replan → confirm_replan() 应用阶段/任务/行动卡变化
    → 标记 AgentEvent.user_confirmed = True
    → 记录确认 timeline 事件
```

### 前端数据流

```
页面组件
  → api.ts getXxxState()     // 拉取聚合状态
  → React state              // 存储状态
  → props 向下传递            // 给各领域面板
  → 用户操作回调              → api.ts writeXxx()
  → 重新拉取状态              → 触发重渲染
```

---

## 9. 测试

### 后端测试（重点文件；当前共 26 个 `test_*.py`）

| 文件 | 覆盖范围 |
|------|---------|
| test_api_smoke.py | 关键接口可调用 |
| test_agent_endpoints.py | Agent 端点集成 |
| test_agent_modules.py | Agent 模块单元 |
| test_agent_workflow.py | Agent 执行引擎 |
| test_agent_output_schemas.py | Agent 输出 schema 校验 |
| test_agent_proposal_confirm.py | 提案确认流程 |
| test_agent_tools_api.py | T41 internal agent tool envelope、read-only tools、replan proposal idempotency/blocked |
| test_api_workspace_project.py | Workspace/Project API |
| test_assignment_flow.py | 分工全流程 |
| test_checkin_replan_migration.py | S9 check-in inferred task updates → replan proposal，不直接改 Task.status |
| test_checkin_risk_replan_flow.py | 签到→风险→重排 |
| test_demo_export_flow.py | Demo 重置+导出 |
| test_issue4_smoke.py | Issue 4 回归 |
| test_llm_provider.py | LLM Provider |
| test_models.py | 模型基础 |
| test_replan_proposal_flow.py | Replan 提案持久化、确认/拒绝、导出回归 |
| test_request_validation.py | 请求校验 |
| test_seed_reset_export.py | 种子/重置/导出 |
| test_usability_pass_20.py | 可用性验证 |

### 前端测试

- vitest + @testing-library/react
- 覆盖：api.ts、app-shell、projectflow-home、action-card、agent-proposal-panel、project-dashboard、task-status-update、error-boundaries

### 验证基线（2026-07-06）

- 后端 pytest：385 passing
- agent-bridge：540 tests passing, typecheck passing, build passing
- 前端：46 tests passing, lint passing, build passing

---

## 10. 开发命令

### 后端

```bash
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1          # Windows
python -m pip install -e ".[dev]"
# includes python-multipart for file upload support
python -m uvicorn app.main:app --reload --port 8000
python -m pytest app/tests/ -v      # 跑测试
```

### 前端

```bash
cd frontend
npm install
npm run dev                         # 开发服务器
npm run test                        # vitest
npm run lint                        # ESLint
npm run build                       # 生产构建
npm audit --omit=dev                # 安全审计
```

### 访问地址

- 前端：http://localhost:3000
- 后端 API：http://localhost:8000/api
- API 文档：http://localhost:8000/docs

---

## 11. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `APP_ENV` | `development` | 环境 |
| `DATABASE_URL` | `sqlite:///./data/projectflow.sqlite` | 数据库 |
| `LLM_PROVIDER` | `mock` | mock / openai / openai-compatible |
| `LLM_API_KEY` | — | API Key（必须放 .env） |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | LLM 基础 URL |
| `LLM_MODEL` | `gpt-4o-mini` | 模型名 |
| `LLM_TIMEOUT_SECONDS` | `30.0` | 诊断超时 |
| `LLM_AGENT_TIMEOUT_SECONDS` | `120.0` | Agent 生成超时 |
| `DEMO_ADMIN_TOKEN` | 可选 | 非 development 环境保护 seed/reset |
| `INTERNAL_SERVICE_TOKEN` | — | FastAPI internal agent-tools / agent-runs Bearer token |
| `SERVICE_TOKEN` | — | agent-bridge 旧别名；`INTERNAL_SERVICE_TOKEN` 优先 |
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:8000/api` | 前端 API 地址 |

---

## 12. 开发阶段历史

| Phase | 范围 | 状态 |
|-------|------|------|
| 0 | Guardrails & Setup | ✅ 2026-05-28 |
| 1 | Account / Workspace / Member Profile | ✅ 2026-05-29 |
| 2 | Project Intake + Resources + Core APIs | ✅ 2026-05-29 |
| 3 | Frontend Shell, Onboarding, Workspace, and Intake | ✅ 2026-05-29 |
| 4 | Agent Core Flow | ✅ 2026-05-29 |
| 5 | Assignment Flow | ✅ 2026-05-29 |
| 6 | Active Push + Check-in | ✅ 2026-05-29 |
| 7 | Risk + Replan + Timeline | ✅ 2026-05-29 |
| 8 | Demo Polish | ✅ 2026-05-29 |
| 9 | Verification, Tests, and Demo Stability | ✅ 2026-05-29 |
| 10 | UI Structural Fix | ✅ 2026-05-29 |
| 11 | Prompt and Schema Quality Hardening | ✅ 2026-05-29 |
| 12 | Assignment, Push, Risk, and Replan Usability | ✅ 2026-05-29 |
| 13 | Real LLM Provider Readiness | ✅ 2026-05-29 |
| 14 | Agent Output Persistence and Confirmation | ✅ 2026-05-29 |
| 15 | Frontend Agent Status and Review UX | ✅ 2026-05-30 |
| 16 | Real-Provider Verification and MVP Usable Runbook | ✅ 2026-05-30 |
| 17 | Code Review Hardening | ✅ 2026-05-30 |
| 18 | Frontend Bugfix | ✅ 2026-05-30 |
| 19 | Agent Prompt 重构 | ✅ 2026-05-31 |
| 20 | 工作台成员管理 | ✅ 2026-05-31 |
| 21 | 测试分工文档 + 用户切换器 | ✅ 2026-05-31 |
| 22 | T23.A 反馈修复 | ✅ 2026-06-02 |
| 23 | Code Review Hardening | ✅ 2026-06-02 |
| 24 | Agent Output Quality + Bug Fixes | ✅ 2026-06-03 |
| 25 | T23.D 反馈修复 | ✅ 2026-06-03 |
| 26 | T23.B 二轮修复 | ✅ 2026-06-03 |
| 27 | Code Review Hardening | ✅ 2026-06-03 |
| 28 | Frontend Redesign Migration | ✅ 2026-06-04 |
| 29 | UI Critique Fixes (project sidebar + 8 views) | ✅ 2026-06-04 |
| 30 | Workspace Page Critique Fixes | ✅ 2026-06-04 |
| 31 | Onboarding Flow Critique Fixes | ✅ 2026-06-04 |
| 32 | Route Unification & Workspace Navigation Fixes | ✅ 2026-06-05 |
| 33 | Stage Plan Timeline Redesign | ✅ 2026-06-05 |
| 34 | Agent Output Quality & Reliability Hardening | ✅ 2026-06-05 |
| 35 | Onboarding & Member Form Improvements | ✅ 2026-06-05 |
| 36 | File Upload, Resource Management & Project Deletion | ✅ 2026-06-06 |
| 37 | Workspace Creation UX & Landing Page Redesign | ✅ 2026-06-06 |
| 38 | My Tasks View Enhancements | ✅ 2026-06-06 |
| 39 | Agent UX Integration & Stage Auto-Advance | ✅ 2026-06-07 |
| 40 | Agent Sidebar UI Polish & Planner Reliability | ✅ 2026-06-07 |
| 41 | Security Review & Performance Optimization | ✅ 2026-06-08 |
| T41 | Agent Runtime Architecture Docs + Sidecar/runtime tools (S3/S5/S6/S7/S8/S9/S14/S16) | ✅ 2026-07-05 |

---

## 13. 关键设计决策

| 决策 | 理由 |
|------|------|
| SQLite 而非 PostgreSQL | 本地演示优先，零配置，比赛 Demo 稳定 |
| 单 Coordinator Agent | 避免多 Agent 调试复杂、成本上升、演示不稳定 |
| AgentProposal 确认机制 | 高影响 AI 输出（方向卡/阶段/任务/重规划）必须人工确认后才持久化 |
| LLM Provider Adapter | 便于切换 Deepseek/华为云/国产模型 |
| 前端无全局状态库 | MVP 规模不需要，React state + localStorage 足够 |
| httpx 连接池复用 | 避免引入 openai SDK 的依赖链，保持轻量，连接池复用提升性能 |
| Prompt XML 标签隔离 | 防止用户数据中的指令注入 |
| Fallback 模板化 | Agent 输出失败时仍能给出可用建议，不会完全卡住 |
| CORS 严格限制 | 只允许 localhost:3000/3001，不开放通配 |

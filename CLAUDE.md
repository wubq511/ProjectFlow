This file provides guidance to Coding Agent (claudecode, codex...) when working with code in this repository.

> **注意：`AGENTS.md` 是指向本文件的软链接（`AGENTS.md -> CLAUDE.md`）。** 修改 Agent 指导内容时只编辑 `CLAUDE.md`，不要单独编辑 `AGENTS.md`，也不要用 `cp`/`cat >` 等方式覆盖 `AGENTS.md`，否则会破坏软链接导致两文件不同步。

## Project Overview

ProjectFlow 是面向大学生项目小队的**主动推进型 AI Agent**。核心价值不是"记录任务"，而是持续回答：项目该往哪走？下一步做什么？谁适合做什么？哪些有风险？计划是否需要调整？

MVP 状态：初步闭环已跑通（Phase 0-41），演示 Demo 可用，安全加固、性能优化和前端体验打磨已完成。

Agent Runtime 重构状态：T41 总方案、底座设计、Tools & Skills 设计、ADR 和研究文档已确认并提交（2026-07-04，commit `aecbb6c`）。Sidecar 骨架（S3）、Read-only Tools（S5）、Stage Plan Proposal Tool（S6）、Advisory Risk/ActionCard Tool（S7）、AssignmentProposalTool（S8）、Check-in/replan migration（S9）、Event bridge + trace envelope（S10）、S11 Frontend Integration、Legacy Coordinator parity + cutover safety net（S12）、Direction Card + Task Breakdown Proposal Tools（S13）、Advisory Write Tools（create_risk/create_checkin）、Skills 系统（S14）、Unit/Eval/Privacy 测试（S15）、Debug 模式（S16）已实现并进入同一 runtime/tool registry；`generate_stage_plan_proposal`、`analyze_checkins_and_risks`、`recommend_assignment`、`generate_replan_proposal`、`generate_direction_card_proposal`、`generate_task_breakdown_proposal`、`create_risk`、`create_checkin` 均通过 `/internal/agent-tools/*` contract 接入。Proposal 确认/拒绝仍走公开 API，不作为 internal agent tool 暴露。T42 ProjectMemory V1 方向卡 tracer bullet、proposal rejection memory、assignment memory with subject-and-owner privacy、replan memory tracer 已实现（2026-07-06）；`direction_card_confirmed` + `proposal_rejected` + `assignment_confirmed` + `replan_confirmed` + `replan_rejected` 确定性 extractor + 幂等写入 + supersede + viewer 验证 + Markdown 导出；proposal rejection 强制 reason 才写 memory；assignment finalization 生成 team-visible assignment 记忆 + 可选 subject_and_owner member_constraint；replan confirm 生成 plan + 可选 tradeoff/boundary 记忆，replan reject 在非空 reason 时生成 rejection 记忆；T42 ProjectMemory 默认检索与 Agent 上下文注入已实现（2026-07-06，issue #75）：FTS5 + jieba 分词检索返回 memory ID，sqlite_field fallback，memory_backend=none 兜底；candidate 从 ProjectMemory 重载并按 project/workspace/active/valid_until/visibility 过滤；JSON list、Markdown export、Agent 上下文注入复用同一 `can_view_memory`；Agent run 创建显式要求 `viewer_user_id`（缺失/格式错误 400，非 workspace 成员 404）；注入记忆受 token budget 与硬数量上限限制；AgentEvent `output_snapshot` 记录 `_memory.used/_memory.backend/_memory.used_memory_ids` 等元数据；T41 `AgentRunV2` 的 `side_effects` 不记录 memory 使用；sidecar 仅通过 FastAPI 构建的 run input/context 接收记忆，不读 DB。T42 ProjectMemory 检索评估 harness 已实现（2026-07-07，issue #76）：固定中文 fixture（13条，覆盖全部 V1 memory_type）+ 标注查询集（10条），`retrieval_eval.py` 通过 `retrieve_memory_ids` service seam 评估，recall@10 ≥ 90%（当前 100%），延迟 < 500ms，visibility-sensitive fixtures 防 can_view_memory 绕过；`test_retrieval_eval.py` 11 tests，无 torch/sentence-transformers/sqlite-vec 等外部依赖。T42 ProjectMemory V1 可选向量检索 extra 与依赖护栏已实现（2026-07-07，issue #77）：`memory-vector` optional extra（sentence-transformers + sqlite-vec）；默认安装不安装 torch/向量依赖；`vector_retriever.py` 全部 lazy import；`python -m app.memory.warmup` 无 extra 时跳过并 exit 0，有 extra 时初始化模型；向量初始化/运行失败时降级到 FTS5→sqlite_field→none；`MemoryBackend` 枚举新增 `vector`；`prefer_vector` 参数贯穿 retrieve_memory_ids/build_memory_context/retrieve_visible_memory_ids；`memory_backend` 反映实际后端而非安装状态；`test_memory_vector_guardrails.py` 13 tests 在默认环境通过；`test_memory_vector.py` 仅在 vector-enabled 环境运行。当前验收基线：497 backend tests pass，559 agent-bridge tests pass（18 files），46 frontend tests pass，agent-bridge typecheck/build pass。后续 Agent 底座工作必须先读 T41 文档，不要把旧 Coordinator 当成目标架构。

> 需要详细MVP功能边界、产品信息时读取 [`docs/PRD-ProjectFlow-MVP.md`](docs/PRD-ProjectFlow-MVP.md) 和[`.claude/prds/projectflow-mvp-usable-ready.md`](.claude/prds/projectflow-mvp-usable-ready.md)

## Architecture

当前已实现 MVP：

**Next.js Frontend + FastAPI Backend + SQLite + legacy single `CoordinatorAgent` + Lightweight State Machine**

- 前端 Next.js (React + TypeScript + Tailwind CSS + shadcn/ui + Framer Motion)
- 后端 FastAPI (Python + SQLModel + Pydantic)
- 数据库 SQLite（本地演示优先，零配置）
- 当前代码仍是 legacy single `CoordinatorAgent`
- 主流程由确定性状态机控制，Agent 只在指定节点生成建议

T41 目标 Agent Runtime：

**TypeScript Agent Bridge Sidecar + Pi component runtime + ProjectFlow Tool Contract + durable AgentRunState + Proposal-Confirm Commit**

- sidecar 管 runtime loop、provider routing、tool registry、policy gate、event bridge、trace envelope。
- FastAPI/DB 继续是 Project/Stage/Task/Risk/Proposal/Timeline 的事实源。
- 旧 `CoordinatorAgent` 只作为迁移资产：schema、validation、fallback、AgentEvent、proposal persistence 可以复用，但最终 runtime 不继续扩展旧门面。
- OpenAI Agents SDK、LangGraph、MCP、完整 Pi coding-agent 只作为参考或 adapter 方向，不是当前主 runtime。
- 需要详细 T41 目标架构时读取：
  - [`docs/T41/ProjectFlow_Agent_Runtime_Team_TDD.md`](docs/T41/ProjectFlow_Agent_Runtime_Team_TDD.md)
  - [`docs/T41/ProjectFlow_Agent_Runtime_Foundation_Design.md`](docs/T41/ProjectFlow_Agent_Runtime_Foundation_Design.md)
  - [`docs/T41/ProjectFlow_Agent_Tools_Skills_Design.md`](docs/T41/ProjectFlow_Agent_Tools_Skills_Design.md)
  - [`CONTEXT.md`](CONTEXT.md)
  - [`docs/adr/`](docs/adr/)

> 需要详细技术内容时读取 [`docs/TECH-DESIGN.md`](docs/TECH-DESIGN.md) 

## Directory Structure

> 需要详细代码情况时读取 [`docs/code-wiki.md`](docs/code-wiki.md)

```
projectflow/
├── docs/                    # PRD、技术设计、API 契约、演示脚本
│   ├── T41/                 # Agent Runtime 重构总方案、底座设计、Tools & Skills 设计、research
│   └── adr/                 # Agent Runtime 架构决策记录
├── CONTEXT.md               # ProjectFlow Agent Runtime 领域词汇
├── agent-bridge/            # T41 TypeScript Agent Runtime Sidecar (S3/S5/S6/S7/S8/S9/S10/S11/S12/S13/S14/S15/S16 runtime/tool work 已完成)
│   ├── src/
│   │   ├── runtime/         # pi-runtime.ts, context-builder.ts, model-router.ts, session-store.ts
│   │   ├── server/          # HTTP server (app.ts, config.ts, routes/)
│   │   ├── tools/           # registry.ts, fastapi-client.ts, projectflow-tools.ts, register-defaults.ts, mock-tools.ts, result-normalizer.ts
│   │   ├── policy/          # policy-engine.ts, budget.ts, proposal-boundary.ts, advisory-boundary.ts
│   │   ├── events/          # event-mapper.ts, stream.ts, trace-envelope.ts, debug-payload-store.ts
│   │   ├── skills/          # skill-index.ts, skill-loader.ts, skill-selector.ts
│   │   ├── types/           # run-state.ts, tool-manifest.ts, tool-result.ts, wire.ts, runtime-event.ts
│   │   └── utils/           # 工具函数
│   ├── skills/              # 6 SKILL.md files (project-intake/planning/task-breakdown/assignment/risk-replan/status)
│   └── tests/unit/          # 18 test files, 559 tests
├── frontend/
│   ├── src/
│   │   ├── app/             # Next.js 页面路由（不写业务逻辑）
│   │   ├── components/      # 按业务领域拆分：ui/ onboarding/ workspace/ project/ member/ agent/ stage/ task/ assignment/ checkin/ risk/；项目页采用三栏布局(project-layout + project-sidebar + project-content + agent-sidebar)
│   │   ├── lib/
│   │   │   ├── api.ts       # 所有 fetch 统一从这里走
│   │   │   ├── types.ts     # 前端类型，与后端 schema 保持同步
│   │   │   ├── constants.ts
│   │   │   └── utils.ts
│   │   └── styles/
│   └── public/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── core/            # config, database, db_utils, errors, security
│   │   ├── models/          # 数据库模型（只定义持久化结构）
│   │   ├── schemas/         # API / Agent schema（所有接口必须走 schema）
│   │   ├── api/             # HTTP route（只处理请求/响应，不写业务逻辑）
│   │   ├── services/        # 确定性业务逻辑（落库、状态迁移、校验）
│   │   ├── memory_service.py  # T42 ProjectMemory: extract_from_event, visibility, Markdown export, retrieval entry point
│   ├── memory/              # T42 ProjectMemory warmup: python -m app.memory.warmup
│   │   ├── agent/           # Agent 编排和 LLM 调用
│   │   │   ├── coordinator.py
│   │   │   ├── workflow.py
│   │   │   ├── prompts.py
│   │   │   ├── llm_client.py
│   │   │   ├── output_schemas.py
│   │   │   └── modules/    # clarification, planning, breakdown, assignment_recommendation, assignment_negotiation, active_push, checkin_analysis, risk_analysis, replanning
│   │   ├── memory/     # T42 ProjectMemory: extractor, display_resolver, retriever (FTS5/jieba), context_builder, vector_retriever (lazy)
│   │   ├── seed/            # Demo 种子数据（不混入正式服务逻辑）
│   │   └── tests/
│   └── data/                # SQLite 数据文件
```

## Commands

### Backend
```bash
cd backend
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
python -m pip install -e ".[dev]"
python -m uvicorn app.main:app --reload --port 8000
```

### Frontend
```bash
cd frontend
../scripts/npm install
../scripts/npm run dev
```

### Testing
```bash
# Backend tests
cd backend
.venv\Scripts\python -m pytest app/tests/ -v

# Single test file
.venv\Scripts\python -m pytest app/tests/test_api_smoke.py -v

# Frontend
cd frontend
../scripts/npm run test
../scripts/npm run lint
../scripts/npm run build
../scripts/npm audit --omit=dev
```

### Access
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000/api
- API Docs: http://localhost:8000/docs

## Frontend Navigation & UX Conventions

- 导航栏包含：首页、工作台（自动检测当前 workspace ID）、用户切换下拉
- 首页（`/`）智能重定向：有 workspace 记录则先验证该 workspace 是否仍存在于后端，存在则跳转工作台，不存在则自动清除 localStorage 记录并展示欢迎页
- `/workspaces/[workspaceId]` 是唯一动态路由入口：三栏布局，左侧导航 + 中间内容 + 右侧 Agent
  - 有项目时默认加载第一个项目，无项目时显示工作台首页
  - 项目切换通过 `?project={id}` 参数，视图切换通过 `?view={view}` 参数，不跳转新页面
  - 点击左侧"工作区"可返回工作台首页（项目列表、成员统计）
- 已删除独立的 `/projects/new` 和 `/projects/[projectId]` 路由，所有项目操作统一在 `/workspaces/[workspaceId]` 内完成
- 项目页采用三栏布局：左侧 workspace/project 导航(ProjectSidebar)、中间内容区(ProjectContent/WorkspaceContent)、右侧 Agent 面板(AgentSidebar)
- 项目仪表盘 Agent 操作按状态机 4 阶段分组：规划 / 分工 / 执行 / 监控
- 当前阶段高亮，自动推荐下一步操作
- UI 语言统一中文
- localStorage 读取必须用 `useSyncExternalStore` 避免 hydration mismatch
- `setLastWorkspaceId()` 在 workspace/project 页面调用以持久化导航上下文
- `setCurrentUserId()` / `useCurrentUserId()` 管理当前用户身份，`setWorkspaceMembers()` 写入成员列表供导航栏切换器使用
- 项目仪表盘 `currentUserId` 优先取 localStorage（用户切换），fallback 到 `project.created_by`

## Coding Rules

### Frontend
- 页面只负责组合组件和处理 UI 状态，不写业务逻辑
- API 调用统一写在 `frontend/src/lib/api.ts`
- 类型统一写在 `frontend/src/lib/types.ts`，与后端 schema 保持同步
- 组件按领域放置，不混写 API
- Assignment、Check-in、Risk、Action Cards 必须独立组件化
- 每个 UI 必须包含 loading、empty、error、success 状态
- 表单组件统一使用 shadcn/ui（Input、Select、Textarea），不使用原生 HTML 表单元素

### Backend
- API route 只处理请求和响应，业务逻辑写在 service
- Agent 编排写在 `backend/app/agent`，不直接处理 HTTP，不直接写 DB
- 数据库模型写在 `models`，请求/响应 schema 写在 `schemas`
- 所有 Agent 输出必须过 Pydantic 校验（结构化输出，不依赖自然语言解析）
- 多步数据库操作必须在单一事务中完成：子 service 函数支持 `auto_commit=False`，调用方统一 `session.commit()`
- 行查询统一使用 `require_row(session, Model, id, label)`（来自 `core/db_utils`），不内联 `_require`
- 敏感配置使用 Pydantic `SecretStr`（如 `llm_api_key`），数值约束使用 `PositiveFloat` 等类型

### Agent
- Agent 读取 WorkspaceState，生成 proposal，不直接 finalize
- T41 runtime 中，Agent 通过 narrow typed ProjectFlow tools 读状态、生成 proposal、创建 advisory records；sidecar 不直接读写 DB。
- `/internal/agent-tools/*` 与 `/internal/agent-runs/*` 必须使用 service-to-service Bearer token；后端读取 `INTERNAL_SERVICE_TOKEN`，sidecar 发送同值（优先 `INTERNAL_SERVICE_TOKEN`，兼容旧 `SERVICE_TOKEN`）。
- LLM-callable tools 不允许 commit Primary Project State（Project direction/status/current stage、Stage plan/status、Task scope/status/owner/dates、finalized assignment ownership）。
- Proposal Confirmation 是当前人类确认边界；`ToolExecutionApproval` 只是未来扩展，不进入当前 runtime state machine。
- Risk 任意 severity 都可以作为 Advisory Project Record 直接创建；只有会修改 Task/Stage/Project/owner/date 的 mitigation 必须走 replan proposal confirmation。
- Agent 推断的 task status/date/owner/stage/mitigation 变化必须进入现有 `replan` proposal，不新增 `TaskStatusChangeProposal`。
- `AssignmentProposal` 是 typed Reviewable Draft Record：Agent 可以创建，final owner 只能由 owner response/finalize 等人类或领域确认路径写入。
- Read-only state view 必须纯读：`get_project_state`、`get_workspace_state`、timeline slice 和 read-only tools 不得修复或推进 Stage/Project；stale state 通过显式 State Repair Command / maintenance job 处理。
- WorkspaceState 必须向 Agent 暴露当前日期/时间/时区，以及项目 resources 摘要；clarify/plan/breakdown prompt 必须使用这些上下文
- DirectionCardOutput 可包含 source_summary、assumptions、unknowns、mvp_boundary、decision_points，用于提升方向澄清质量
- 所有建议必须包含 reason（可解释性）
- 不能编造成员、任务、阶段
- 失败必须 fallback（JSON 修复 → retry → 模板化 fallback → timeline 记录）
- 高影响主事实变更必须等待 proposal confirmation；high-severity Risk row 本身不是 commit effect
- 不直接修改 finalized assignment 或 task owner
- Prompt 中用户数据必须用 XML 标签隔离（如 `<workspace_state>...</workspace_state>`），防止指令注入；注入 XML 标签的 JSON 内容必须经 `html.escape()` 转义
- 文件上传必须校验类型白名单和大小限制（当前白名单见 `routes_uploads.py` 的 `ALLOWED_EXTENSIONS`，上限 10MB）
- 资源 `file_name` 字段禁止包含路径分隔符或父目录引用（`..`），`_read_resource_file` 仅在 `UPLOAD_DIR` 内查找
- AgentEvent input_snapshot 只存储轻量摘要（workspace_summary），不存储完整 workspace_state
- LLM 客户端使用 httpx（连接池复用），不再使用 urllib
- 所有数据库模型的外键和状态字段必须设置 `index=True`
- Fallback payload 不能包含 None 值，必须确保所有必填字段有合法默认值
- 所有用户可见文本（title, content, reason, summary, description, evidence 等）必须为中文
- 用户可见文本中禁止使用原始 ID（user_id, task_id），必须使用成员 display_name（如"小林"）和任务 title（如"后端 API 与数据模型"）
- LLM max_tokens 为推理模型预留空间（checkin 4000, plan/breakdown/replan 4000, push/risk/clarify/assign 3000, negotiate 2000, retrospective 5000）
- AgentProposal 只用于 clarify/plan/breakdown/replan；negotiate 使用分工协商流程和 timeline，不创建通用 AgentProposal
- **Global Scope Rule**: 所有输出字段禁止提及外部系统（教务系统、移动端 App、GitHub 等），使用通用替代词
- **Before Output Self-Check**: 输出前自检日期格式（YYYY-MM-DD）、禁止术语、成员/任务引用合法性、requires_confirmation 是否设置
- **Runtime Event Consistency**: 同一 AgentRun 不得同时产生 `agent.completed` 和 `agent.failed` 事件；event-mapper 必须根据 Pi stopReason 精确映射（`"error"`/`"aborted"` → `agent.failed`，`"end_turn"`/`"tool_use"` → `agent.completed`），runtime loop 不得在 agent_end 已映射为 failed 后再追加 completed
- **Tool Result Integrity**: Tool execution 的 result metadata（tool_use_id、is_error 等）必须在 runtime loop 各步骤间完整保留，不得被后续步骤覆盖或丢弃
- **Proposal Uniqueness**: 同一 project 不得存在多条 pending 状态的 replan proposal；创建前必须检查并拒绝重复
- **State Transition Validation**: AgentRunState 转换必须合法（running→completed/failed/cancelled；不得从 completed 跳回 failed 或反之）；ToolManifest 注册时必须校验 name 唯一且 schema 合法

## Agent Workflow (State Machine)

```
AccountSetup → WorkspaceSetup → MemberProfiles → ProjectIntake → Clarification → StagePlanning → TaskBreakdown → AssignmentRecommendation → AssignmentConfirmation → ActivePush → Execution → CheckIn → RiskAnalysis → Replanning → ActivePush
```

AssignmentConfirmation 可进入 AssignmentNegotiation（成员拒绝后协调交换），再回到 AssignmentConfirmation。

Stage 完成后进入下一阶段，重新触发阶段性分工推荐。

阶段自动推进：人类明确提交任务状态为 done 时，`try_advance_stage()` 可在同一 command transaction 内检测该阶段所有任务是否完成，全部完成则自动标记阶段 completed 并激活下一个 pending 阶段。无更多阶段时项目标记为 completed。读取 ProjectState/WorkspaceState 时不得顺手推进或修复阶段状态。

Agent API 需传 `project_id`（修复多项目 workspace 下 Agent 总作用于最近创建项目的 bug）。

## Key Domain Models

核心实体关系：User → Workspace → Project → Stage → Task → AssignmentProposal → AssignmentResponse → AssignmentNegotiation

- **Workspace**: 团队空间，MVP 单 workspace
- **MemberProfile**: 技能、可用时间、意向、限制（绑定 workspace）
- **Project**: 项目想法、截止日期、交付物、方向卡
- **Stage**: 阶段目标、时间范围、交付物、完成标准
- **Task**: 优先级 P0/P1/P2、状态 not_started/in_progress/done/blocked/cancelled、可砍标记、order_index 排序
- **AssignmentProposal**: Agent 推荐分工（owner + backup owner + reason），需人工确认
- **AgentProposal**: Agent 高影响输出暂存（clarify/plan/breakdown/replan），确认后才持久化到项目状态；reject 时记录 rejection_reason
- **Risk**: 类型 deadline/dependency/workload/scope/review/assignment/checkin，必须有 evidence
- **ActionCard**: 任务卡、下一步行动、提醒、启动建议
- **AgentEvent**: Agent 决策日志（输入快照、输出快照、status、reasoning_summary）
- **ProjectMemory**: 治理上下文记录（memory_type、content、rationale、source_type/source_id/source_hash、status、visibility、valid_until）；从 Memory Source Event 确定性抽取，幂等写入，supersede 旧记忆；V1 不调用 LLM
- **ProjectMemorySync**: 索引同步元数据（backend、sync_status、last_error）

## Environment Variables

```bash
APP_ENV=development
DATABASE_URL=sqlite:///./data/projectflow.sqlite
LLM_PROVIDER=mock          # mock / openai / openai-compatible
LLM_API_KEY=xxx            # 真实 LLM 接入后需要
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_TIMEOUT_SECONDS=30.0          # 诊断超时
LLM_AGENT_TIMEOUT_SECONDS=120.0   # Agent 生成超时
INTERNAL_SERVICE_TOKEN=change-me  # sidecar 调 FastAPI internal endpoints 的 Bearer token
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api
MEMORY_VECTOR_ENABLED=false   # 是否优先使用向量检索（需要 memory-vector extra）
MEMORY_VECTOR_MODEL=shibing624/text2vec-base-chinese  # 中文 embedding 模型
MEMORY_VECTOR_MODEL_DIR=      # 空=自动 data/memory-models/
```

API key 和 internal service token 必须放 `.env`，不能提交 Git。前端不能直接调用 LLM API 或 internal endpoints。`LLM_PROVIDER` 默认 `mock`，真实 LLM 用 `openai` 或 `openai-compatible`。`LLM_TIMEOUT_SECONDS` 默认 `30.0`（诊断用），`LLM_AGENT_TIMEOUT_SECONDS` 默认 `120.0`（Agent 生成用）。`INTERNAL_SERVICE_TOKEN` 用于 `/internal/agent-tools/*` 和 `/internal/agent-runs/*`；sidecar 需发送同值 Bearer token。`NEXT_PUBLIC_API_BASE_URL` 是前端可选变量，不配置时默认 `http://localhost:8000/api`。

## Git Ignore

必须忽略：`.env`, `.env.*`, `*.sqlite`, `*.sqlite3`, `backend/data/*.sqlite`, `node_modules/`, `.venv/`, `__pycache__/`, `frontend/.next/`, `frontend/out/`, `frontend/dist/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`

注意：`backend/data/uploads/` 目录本身需保留（文件上传目标），但其中的文件不提交 Git。

## Development Phases

Phase 0-39 全部已完成（2026-05-28 ~ 2026-06-07）。Phase 40（2026-06-07）为 Agent sidebar UI 打磨阶段。Phase 41（2026-06-08）为全面安全审查与性能优化。T41 Agent Runtime 架构方案已在 2026-07-04 确认并提交，下一步是将其转为 PRD 和 vertical-slice issues。

> 当前阶段：安全加固（S2/S3/S5/S7/S8）+ 性能优化（P1-P16）+ 前端性能优化（F1-F18）已完成。详见 docs/handoff.md。

## Product Quality Standards

- 不接受只有静态页面没有完整流程
- 不接受只有任务列表没有主动推进
- 不接受只有 AI 文案生成没有状态变化后的判断
- 不接受风险判断没有理由
- 不接受分工推荐没有依据
- 不允许为了省事把 demo 做成纯静态假页面

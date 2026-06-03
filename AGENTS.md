This file provides guidance to Coding Agent (claudecode, codex...) when working with code in this repository.

## Project Overview

ProjectFlow 是面向大学生项目小队的**主动推进型 AI Agent**。核心价值不是"记录任务"，而是持续回答：项目该往哪走？下一步做什么？谁适合做什么？哪些有风险？计划是否需要调整？

MVP 目标：2026-06-01 前跑通初步闭环，2026-06-07 前稳定可演示 Demo。

## Architecture

**Next.js Frontend + FastAPI Backend + SQLite + Single Coordinator Agent + Lightweight State Machine**

- 前端 Next.js (React + TypeScript + Tailwind CSS + shadcn/ui + Framer Motion)
- 后端 FastAPI (Python + SQLModel + Pydantic)
- 数据库 SQLite（本地演示优先，零配置）
- Agent 单 Coordinator Agent，不做多 Agent
- 主流程由确定性状态机控制，Agent 只在指定节点生成建议

## Directory Structure

> 需要详细代码情况时读取 [`docs/code-wiki.md`](docs/code-wiki.md)

```
projectflow/
├── docs/                    # PRD、技术设计、API 契约、演示脚本
├── frontend/
│   ├── src/
│   │   ├── app/             # Next.js 页面路由（不写业务逻辑）
│   │   ├── components/      # 按业务领域拆分：ui/ onboarding/ workspace/ project/ member/ agent/ stage/ task/ assignment/ checkin/ risk/
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
│   │   ├── agent/           # Agent 编排和 LLM 调用
│   │   │   ├── coordinator.py
│   │   │   ├── workflow.py
│   │   │   ├── prompts.py
│   │   │   ├── llm_client.py
│   │   │   ├── output_schemas.py
│   │   │   └── modules/    # clarification, planning, breakdown, assignment_recommendation, assignment_negotiation, active_push, checkin_analysis, risk_analysis, replanning
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
npm install
npm run dev
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
npm run test
npm run lint
npm run build
npm audit --omit=dev
```

### Access
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000/api
- API Docs: http://localhost:8000/docs

## Frontend Navigation & UX Conventions

- 导航栏包含：首页、工作台（自动检测当前 workspace ID）、新建项目、用户切换下拉
- 首页（`/`）智能重定向：有 workspace 记录则先验证该 workspace 是否仍存在于后端，存在则跳转工作台，不存在则自动清除 localStorage 记录并展示欢迎页
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
- 所有建议必须包含 reason（可解释性）
- 不能编造成员、任务、阶段
- 失败必须 fallback（JSON 修复 → retry → 模板化 fallback → timeline 记录）
- 高风险建议必须等待人工确认
- 不直接修改 finalized assignment 或 task owner
- Prompt 中用户数据必须用 XML 标签隔离（如 `<workspace_state>...</workspace_state>`），防止指令注入
- Fallback payload 不能包含 None 值，必须确保所有必填字段有合法默认值

## Agent Workflow (State Machine)

```
AccountSetup → WorkspaceSetup → MemberProfiles → ProjectIntake → Clarification → StagePlanning → TaskBreakdown → AssignmentRecommendation → AssignmentConfirmation → ActivePush → Execution → CheckIn → RiskAnalysis → Replanning → ActivePush
```

AssignmentConfirmation 可进入 AssignmentNegotiation（成员拒绝后协调交换），再回到 AssignmentConfirmation。

Stage 完成后进入下一阶段，重新触发阶段性分工推荐。

## Key Domain Models

核心实体关系：User → Workspace → Project → Stage → Task → AssignmentProposal → AssignmentResponse → AssignmentNegotiation

- **Workspace**: 团队空间，MVP 单 workspace
- **MemberProfile**: 技能、可用时间、意向、限制（绑定 workspace）
- **Project**: 项目想法、截止日期、交付物、方向卡
- **Stage**: 阶段目标、时间范围、交付物、完成标准
- **Task**: 优先级 P0/P1/P2、状态 not_started/in_progress/done/blocked、可砍标记
- **AssignmentProposal**: Agent 推荐分工（owner + backup owner + reason），需人工确认
- **AgentProposal**: Agent 高影响输出暂存（clarify/plan/breakdown/replan），确认后才持久化到项目状态；reject 时记录 rejection_reason
- **Risk**: 类型 deadline/dependency/workload/scope/review/assignment/checkin，必须有 evidence
- **ActionCard**: 任务卡、下一步行动、提醒、启动建议
- **AgentEvent**: Agent 决策日志（输入快照、输出快照、status、reasoning_summary）

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
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api
```

API key 必须放 `.env`，不能提交 Git。前端不能直接调用 LLM API。`LLM_PROVIDER` 默认 `mock`，真实 LLM 用 `openai` 或 `openai-compatible`。`LLM_TIMEOUT_SECONDS` 默认 `30.0`（诊断用），`LLM_AGENT_TIMEOUT_SECONDS` 默认 `120.0`（Agent 生成用）。`NEXT_PUBLIC_API_BASE_URL` 是前端可选变量，不配置时默认 `http://localhost:8000/api`。

## Git Ignore

必须忽略：`.env`, `.env.*`, `*.sqlite`, `*.sqlite3`, `backend/data/`, `node_modules/`, `.venv/`, `__pycache__/`, `frontend/.next/`, `frontend/out/`, `frontend/dist/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`

## Development Phases

| Phase | Scope | Target |
|-------|-------|--------|
| 0 | Guardrails & Setup: AGENTS.md, monorepo 初始化, 前后端可启动, SQLite 初始化 | 已完成：2026-05-28 / GitHub #2 |
| 1 | Account / Workspace / Member Profile | 已完成：2026-05-29 / GitHub #3 |
| 2 | Project Intake + Resources + Core APIs | 已完成：2026-05-29 / GitHub #4 |
| 3 | Frontend Shell, Onboarding, Workspace, and Intake | 已完成：2026-05-29 / GitHub #6 |
| 4 | Agent Core Flow: LLM client, Coordinator, Clarification, Planning, Breakdown | 已完成：2026-05-29 / GitHub #5 |
| 5 | Assignment Flow: Proposal, Response, Negotiation | 已完成：2026-05-29 / GitHub #8 |
| 6 | Active Push + Check-in | 已完成：2026-05-29 / GitHub #8 |
| 7 | Risk + Replan + Timeline | 已完成：2026-05-29 / GitHub #8 |
| 8 | Demo Polish: seed data, reset, 动画, Agent loading, export | 已完成：2026-05-29 / GitHub #10 |
| 9 | Verification, Tests, and Demo Stability Hardening | 已完成：2026-05-29 / GitHub #11 |
| 10 | UI Structural Fix: 导航重构, 仪表盘层次化, 首页智能重定向, 中文统一, 表单组件统一 | 已完成：2026-05-29 |
| 11 | MVP Usable #18: Prompt and Schema Quality Hardening | 已完成：2026-05-29 / GitHub #18 |
| 12 | MVP Usable #20: Assignment, Push, Risk, and Replan Usability Pass | 已完成：2026-05-29 / GitHub #20 |
| 13 | MVP Usable #16: Real LLM Provider Readiness and Diagnostics | 已完成：2026-05-29 / GitHub #16 |
| 14 | MVP Usable #17: Agent Output Persistence and Confirmation | 已完成：2026-05-29 / GitHub #17 |
| 15 | MVP Usable #19: Frontend Agent Status and Review UX | 已完成：2026-05-30 / GitHub #19 |
| 16 | MVP Usable #21: Real-Provider Verification and MVP Usable Runbook | 已完成：2026-05-30 / GitHub #21 |
| 17 | Code Review Hardening: 事务原子性, 双重序列化修复, SecretStr, Prompt 注入防护, Fallback 安全, Schema 类型收紧, CORS 收紧, 前端超时保护 | 已完成：2026-05-30 |
| 18 | Frontend Bugfix: DirectionCard 字段名对齐后端, Agent 提案确认后页面崩溃修复, 防御性渲染, 前端超时 120s, 测试基线 5→7 | 已完成：2026-05-30 |
| 19 | Agent Prompt 重构: 集中式 OUTPUT_CONTRACT, 紧凑 WorkspaceState 序列化, Agent 专用超时, LLM 错误层次化, 方向卡字段迁移 | 已完成：2026-05-31 |
| 20 | 工作台成员管理: 列表查看、添加、编辑、删除成员 | 已完成：2026-05-31 |
| 21 | 测试分工文档 + 用户切换器: T23 纵向测试文档(A/B/C/D), 导航栏用户身份切换, currentUserId localStorage 持久化 | 已完成：2026-05-31 |
| 22 | T23.A 反馈修复: 项目资源面板, 阶段确认自动激活, 拒绝提案空 body 兼容, 创建页不暴露原始 UUID, favicon, 导航 workspace 同步, Agent fallback 中文, Agent 模块公共函数扩展 | 已完成：2026-06-02 / GitHub #28 |
| 23 | Code Review Hardening: rejection_reason 持久化, confirmed_by 用户校验, 首页 isValidating 修复, AbortSignal 传递, 资源面板错误处理/aria-label, skill badge key 唯一性, useEffect cleanup, 阶段重复激活防护测试, README 断链修复, metadata 中文化 | 已完成：2026-06-02 |
| 24 | Agent Output Quality + Bug Fixes: T23.C blocker 动态 fallback, 任务状态同步, raw ID/中英文混用修复, 行动卡归属修复 | 已完成：2026-06-03 |
| 25 | T23.D 反馈修复: replan AgentProposal 持久化/确认/拒绝, replan fallback 最小可执行建议, 风险 evidence 中文展示, Agent status 透明度, 导出 enum/raw JSON 清理 | 已完成：2026-06-03 |
| 26 | T23.B 二轮修复: 技能名中文化映射(SKILL_NAME_CN_MAP), JSON 严格性(temperature 0.05+prompt 强化), 协商 Agent 端点暴露, 非 active 阶段分工 stage_id override, 协商模块注入拒绝/协商上下文, stage_id 贯穿验证层 | 已完成：2026-06-03 |

## Product Quality Standards

- 不接受只有静态页面没有完整流程
- 不接受只有任务列表没有主动推进
- 不接受只有 AI 文案生成没有状态变化后的判断
- 不接受风险判断没有理由
- 不接受分工推荐没有依据
- 不允许为了省事把 demo 做成纯静态假页面

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
│   │   ├── core/            # config, database, errors, security
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

## Coding Rules

### Frontend
- 页面只负责组合组件和处理 UI 状态，不写业务逻辑
- API 调用统一写在 `frontend/src/lib/api.ts`
- 类型统一写在 `frontend/src/lib/types.ts`，与后端 schema 保持同步
- 组件按领域放置，不混写 API
- Assignment、Check-in、Risk、Action Cards 必须独立组件化
- 每个 UI 必须包含 loading、empty、error、success 状态

### Backend
- API route 只处理请求和响应，业务逻辑写在 service
- Agent 编排写在 `backend/app/agent`，不直接处理 HTTP，不直接写 DB
- 数据库模型写在 `models`，请求/响应 schema 写在 `schemas`
- 所有 Agent 输出必须过 Pydantic 校验（结构化输出，不依赖自然语言解析）

### Agent
- Agent 读取 WorkspaceState，生成 proposal，不直接 finalize
- 所有建议必须包含 reason（可解释性）
- 不能编造成员、任务、阶段
- 失败必须 fallback（JSON 修复 → retry → 模板化 fallback → timeline 记录）
- 高风险建议必须等待人工确认
- 不直接修改 finalized assignment 或 task owner

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
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api
```

API key 必须放 `.env`，不能提交 Git。前端不能直接调用 LLM API。`LLM_PROVIDER` 默认 `mock`，真实 LLM 用 `openai` 或 `openai-compatible`。`NEXT_PUBLIC_API_BASE_URL` 是前端可选变量，不配置时默认 `http://localhost:8000/api`。

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
| 5 | Assignment Flow: Proposal, Response, Negotiation | 后端已完成：2026-05-29 / GitHub #8；前端接线待完成 |
| 6 | Active Push + Check-in | 后端已完成：2026-05-29 / GitHub #8；前端接线待完成 |
| 7 | Risk + Replan + Timeline | 后端已完成：2026-05-29 / GitHub #8；前端接线待完成 |
| 8 | Demo Polish: seed data, reset, 动画, Agent loading, export | 2026-06-07 |

## Product Quality Standards

- 不接受只有静态页面没有完整流程
- 不接受只有任务列表没有主动推进
- 不接受只有 AI 文案生成没有状态变化后的判断
- 不接受风险判断没有理由
- 不接受分工推荐没有依据
- 不允许为了省事把 demo 做成纯静态假页面

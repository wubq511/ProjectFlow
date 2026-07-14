# ProjectFlow Demo Script

Status: current as of 2026-07-14.

A 5-minute path through the core loop. Designed for review presentation.

For the current Agent optimization narrative, metrics, judging Q&A and three recommended Agent demonstrations, read [`showcase/agent-optimization-showcase-2026-07.md`](showcase/agent-optimization-showcase-2026-07.md) before presenting. This file remains the deterministic seeded-product walkthrough.

## Pre-Demo Setup (1 minute)

1. Start backend:

```bash
cd backend
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

2. Start frontend:

```bash
cd frontend
../scripts/npm run dev
```

3. Load demo seed data:

```bash
curl -X POST http://localhost:8000/api/seed/demo
```

4. Open:

```text
http://localhost:3000/workspaces/demo-workspace-001?project=demo-project-001
```

If port 3000 is occupied, start the frontend on another port and use that base URL.

## Demo Flow (4 minutes)

### Step 1: Team Overview (30 seconds)

- Show the workspace dashboard at `/workspaces/demo-workspace-001`.
- Highlight the 6-member team: 小林(负责人), 小王(前端), 小张(后端), 小李(测试), 小赵(AI), 小刘(设计).
- Each member has skills, availability, interests, and constraints.

### Step 2: Project Dashboard (30 seconds)

- Navigate to `/workspaces/demo-workspace-001?project=demo-project-001`.
- Show the project is in "核心实现" stage (active).
- Point out the direction card: problem, target users, core value.

### Step 3: Stage and Task View (45 seconds)

- Show 4 stages: 调研与方向(completed), 设计与规划(completed), 核心实现(active), 测试与打磨(pending).
- Show current stage tasks: 3 P0 tasks in progress.
- Emphasize: Agent recommended assignments based on skills and preferences.

### Step 4: Assignment Recommendations (30 seconds)

- Show the 3 finalized assignment proposals.
- Each has recommended owner, backup owner, reason, and risk note.
- Key insight: Agent considers skills, preferences, availability, and constraints.

### Step 5: Check-in Results (30 seconds)

- Show the active check-in cycle (2-day cadence).
- Show 小张's blocker: "SQLite 外键约束报错".
- Highlight that the blocker and availability change feed risk detection.

### Step 6: Risk Detection (45 seconds)

- Show 3 risks detected by Agent:
  - dependency (medium): 后端 API 外键约束问题
  - workload (high): 小张可用时间下降
  - deadline (medium): 核心实现阶段时间紧张
- Each risk has type, severity, title, description, evidence, and recommendation.
- Key insight: Agent detected risks from check-in data, not just task status.

### Step 7: Action Cards (30 seconds)

- Show 5 active action cards.
- Highlight the risk action "小林协助小张排查外键问题" and the team next step "前后端联调准备".
- Key insight: Agent actively pushes next actions, not just records.

### Step 8: Agent Timeline (15 seconds)

- Show Agent events: clarify, plan, breakdown, assign, push.
- Each has event type, reasoning summary, and confirmation status.
- Key insight: Agent decisions are traceable.

### Step 9: Review Summary Export (15 seconds)

- Click the export action or call:

```bash
curl -X POST http://localhost:8000/api/projects/demo-project-001/export/review-summary
```

- Show the generated Markdown summary.
- Key insight: one-click export supports review readiness.

## Manual Acceptance

- The app should never require a real LLM key in the MVP path.
- Agent and export actions should persist timeline records.
- Assignment ownership changes should only happen after explicit confirmation/finalization.
- Risk cards must show evidence and a recommendation.
- Demo reset must return the app to a known project state.

## Reset Demo

Open **Settings** from the gear icon at the bottom of the left sidebar, switch to the **系统** tab, and click **重置数据**. Confirm the dialog to reset and re-seed. Or run:

```bash
curl -X POST http://localhost:8000/api/demo/reset
```

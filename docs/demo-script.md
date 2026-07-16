# ProjectFlow Demo Script

Status: updated 2026-07-16 for 7/17 defense demo.

A 5-minute path through the core loop. Designed for review presentation.
Project deadline: 2026-07-17 (defense day). Seed data mirrors real development history (Phase 0 → T45).

For the current Agent optimization narrative, metrics, judging Q&A and three recommended Agent demonstrations, read [`showcase/agent-optimization-showcase-2026-07.md`](showcase/agent-optimization-showcase-2026-07.md) before presenting. This file remains the deterministic seeded-product walkthrough.

## Pre-Demo Setup (1 minute)

1. Start backend (Terminal 1):

```bash
cd backend
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

2. Start Agent Bridge (Terminal 2):

```bash
cd agent-bridge
npm run start
```

3. Start frontend (Terminal 3):

```bash
cd frontend
npm run dev
```

4. Load demo seed data:

```bash
curl -X POST http://localhost:8000/api/seed/demo
```

5. Open:

```text
http://localhost:3000/workspaces/demo-workspace-001?project=demo-project-001
```

Agent Bridge uses port 4000 by default. If port 3000 is occupied, start the frontend on another port and use that base URL.

## Demo Flow (4 minutes)

### Step 1: Team Overview (30 seconds)

- Show the workspace dashboard at `/workspaces/demo-workspace-001`.
- Highlight the 6-member team: 小林(负责人), 小王(前端), 小张(后端), 小李(测试), 小赵(AI), 小刘(设计).
- Each member has skills, availability, interests, and constraints.

### Step 2: Project Dashboard (30 seconds)

- Navigate to `/workspaces/demo-workspace-001?project=demo-project-001`.
- Show the project is in "核心实现" stage (active, ended 07-14, overdue by 1 day).
- Point out the direction card: problem, target users, core value, confirmed 2026-06-07.
- Highlight date narrative: project started 05-28, 2 completed stages, "核心实现" active (07-05~07-14, overdue), "测试与打磨" pending (07-15~07-17), deadline = defense day (07-17). Total span: ~7 weeks, matching real ProjectFlow development.
- The AgentEvent timeline mirrors real development history with 8 events across ~7 weeks.
- Note: events include a negotiate (07-06 小王动效拆分协商) and a rejected scope-expand proposal (07-08) — real product decisions.

### Step 3: Stage and Task View (45 seconds)

- Show 4 stages: 调研与方向(completed), 设计与规划(completed), 核心实现(active), 测试与打磨(pending).
- Point out 设计与规划 had 3 tasks including "Agent Runtime 架构设计" (小赵, 14h, P0) — explaining why this stage took 27 days.
- Show current stage tasks: 3 P0 tasks in progress — descriptions now reflect real T41-T45 work (三栏布局 + 19 数据模型 + Agent Runtime 全切片).
- Point out: backend API (小张) was due 07-10 — 4 days overdue, with an active blocker.
- Task status history: click into any done task to show status trajectory (not_started → in_progress → done, with progress notes).
- Emphasize: Agent recommended assignments based on skills and preferences.

### Step 4: Assignment Recommendations (30 seconds)

- Show the 3 finalized assignment proposals with enhanced detail: skill_match, availability_match, preference_match, and constraint_respected evidence.
- Each proposal also has an acceptance response from the recommended owner.
- Key insight: Agent considers skills, preferences, availability, and constraints — with formal evidence.

### Step 5: Check-in Results (30 seconds)

- Show the active check-in cycle (2-day cadence, started 07-05).
- Check-ins are spread across 3 dates — not a one-time batch — showing the cadence is real:
  - 07-08 early: 小王(frontend started), 小赵(LLM client done), 小刘(style guide)
  - 07-12 mid: 小张(blocker detected!), 小李(test case list done)
  - 07-14 late: 小林(blocker root cause found: FK flush order)
- Show 小张's blocker: "SQLite 外键约束报错" + task overdue. Blocker persisted from 07-12 to 07-14.
- Highlight that the blocker detection feeds into risk analysis.

### Step 6: Risk Detection (45 seconds)

- Show 3 risks detected by Agent:
  - dependency (medium): 后端 API 外键约束问题 — evidence now includes overdue task
  - workload (high): 小张可用时间下降 + 后端 API 逾期 — two factors compounding
  - deadline (medium): 核心实现阶段收尾时间紧张 — 1 day remaining
- Each risk has type, severity, title, description, evidence, and recommendation.
- Key insight: Agent detected risks from check-in data AND task deadline compliance, not just task status.

### Step 7: Action Cards (30 seconds)

- Show 5 active action cards.
- Highlight the risk action "小林协助小张排查外键问题" (from replan event) and the team next step "前后端联调准备".
- Cards now include adaptive suggestions: e.g., "小王 mock 数据独立验证" when backend is blocked.
- Key insight: Agent actively pushes next actions, not just records.

### Step 8: Agent Timeline (15 seconds)

- Show Agent events: clarify (confirmed), plan (confirmed), breakdown (confirmed), assign (confirmed), negotiate (07-06 小王动效拆分), clarify/rejected (07-08 scope-expand), push (07-14), replan (07-14 confirmed).
- Each has event type, status (成功/基础建议/失败), reasoning summary, and confirmation status.
- Key insight: Agent decisions are traceable — including rejections.

### Step 9: Review Summary Export (15 seconds)

- Click the export action or call:

```bash
curl -X POST http://localhost:8000/api/projects/demo-project-001/export/review-summary
```

- Show the generated Markdown summary.
- Key insight: one-click export supports review readiness.

### Step 10: Project Memory (optional, 30 seconds)

- Navigate to "项目记忆" view from the sidebar.
- Show 7 memory records covering all V1 memory types:
  - direction: 项目聚焦方向 (source: direction_card_confirmed)
  - boundary: MVP 边界约束 (source: direction_card_confirmed)
  - plan: 中期重排计划 (source: replan_confirmed)
  - assignment: Agent 核心分工决策 (source: assignment_confirmed)
  - tradeoff: 答辩前取舍原则 (source: replan_confirmed)
  - rejection: 拒绝多 Agent 架构扩展 (source: proposal_rejected, with reason)
  - member_constraint: 小赵晚 10 点后不在线 — visibility = subject_and_owner
- Click the member_constraint memory: highlight "可见范围: 仅小赵及负责人" — demonstrates privacy boundary.
- Switch user → memory disappears for non-subject users.
- Click Markdown export to show `project-memories.md` output.
- Key insight: Agent continuously learns from confirmed AND rejected decisions, building institutional knowledge with privacy boundaries.

### Step 11: Agent Conversation History (optional, 15 seconds)

- Open "历史会话" Sheet from Agent sidebar.
- Show the team conversation "答辩前最终冲刺计划讨论" (7/14, 小林创建).
- Messages show Agent citing ProjectMemory records (方向卡、取舍原则、拒绝提案) in context-aware responses.
- Click into it to see 6 messages with memory-grounded advice (mock vs real LLM choice, scope defense).

## Manual Acceptance

- The app should never require a real LLM key in the MVP path.
- Agent and export actions should persist timeline records.
- Assignment ownership changes should only happen after explicit confirmation/finalization.
- Risk cards must show evidence and a recommendation.
- Demo reset must return the app to a known project state.
- Seed memories must be searchable via FTS5 (after warmup/indexing).
- member_constraint memory must not be visible to non-subject users.

## Reset Demo

Open **Settings** from the gear icon at the bottom of the left sidebar, switch to the **系统** tab, and click **重置数据**. Confirm the dialog to reset and re-seed. Or run:

```bash
curl -X POST http://localhost:8000/api/demo/reset
```

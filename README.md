# ProjectFlow

ProjectFlow is a local-first active project agent MVP for college project teams. The demo target is a full loop from workspace setup through planning, assignment, active push, check-in, risk analysis, replanning, and review export.

The shipped MVP still uses a legacy single `CoordinatorAgent`. The confirmed T41 target architecture is a TypeScript Agent Bridge Sidecar with Pi component runtime, ProjectFlow Tool Contract, durable AgentRunState, and Proposal-Confirm Commit. For new Agent runtime work, start from the T41 docs rather than extending the legacy Coordinator as the target runtime.

## Current Status

All MVP phases and MVP Usable tasks complete. Phase 24-29 (Agent Output Quality, T23 Fixes, Code Review, Frontend Redesign) complete through 2026-06-05. Phase 37-39 (Workspace UX, Landing Redesign, Agent UX Fixes, Task Ordering, Stage Auto-Advance) complete through 2026-06-07. Phase 40 (Agent Sidebar Polish) complete 2026-06-07. Phase 41 (Security Review & Performance Optimization) complete 2026-06-08. T41 Agent Runtime architecture docs were confirmed and pushed on 2026-07-04; runtime/tool slices S3/S5/S6/S7/S8/S9/S10/S11/S12/S13/S14/S15/S16 were implemented through 2026-07-06. T42 ProjectMemory V1 issues #71-#80 are closed and merged through 2026-07-07; remediation slices R1-R6 and R8 are complete, and the selective R8 Pilot passed 7/7 gates on 2026-07-11. R7 remains a separately approved V1.1 vector project. Multi-model multi-provider config and switching implemented 2026-07-08 (ModelConfigStore + DotEnvWriter + FileWatcher + dynamic provider imports + frontend settings dialog + agent sidebar model selector).

- Phase 0 / GitHub #2 — Guardrails & Setup
- Phase 1 / GitHub #3 — Account / Workspace / Member Profile
- Phase 2 / GitHub #4 — Project Intake + Resources + Core APIs
- Phase 3 / GitHub #6 — Frontend Shell, Onboarding, Workspace, and Intake
- Phase 4 / GitHub #5 — Agent Core Flow
- Phase 5–7 / GitHub #8 — Assignment, Active Push, Check-in, Risk, Replan
- Phase 8 / GitHub #10 — Demo Seed, Reset, Runbook, and Review Export
- Phase 9 / GitHub #11 — Verification, Tests, and Demo Stability Hardening
- MVP Usable / GitHub #18 — Prompt and Schema Quality Hardening
- MVP Usable / GitHub #20 — Assignment, Push, Risk, and Replan Usability Pass
- MVP Usable / GitHub #16 — Real LLM Provider Readiness and Diagnostics
- MVP Usable / GitHub #17 — Agent Output Persistence and Confirmation
- MVP Usable / GitHub #19 — Frontend Agent Status and Review UX
- MVP Usable / GitHub #21 — Real-Provider Verification and MVP Usable Runbook
- Phase 20 — Workspace Member Management (2026-05-31)
- Phase 21 — Test Docs + User Switcher (2026-05-31)
- Phase 22 — T23.A Feedback Fixes (2026-06-02)
- Phase 25 — T23.D Feedback Fixes (2026-06-03)
- Phase 27 — Code Review Hardening (2026-06-03)
- Phase 28 — Frontend Redesign Migration (2026-06-04)
- Phase 29 — Agent Output Quality & Reliability Hardening (2026-06-05)
- Phase 32 — Route Unification & Workspace Navigation Fixes (2026-06-05)
- Phase 33 — Stage Plan Timeline Redesign (2026-06-05)
- Phase 34-36 — File Upload, Resource Management & Project Deletion (2026-06-06)
- Phase 37-39 — Workspace UX, Landing Redesign, Agent UX Fixes (2026-06-06~07)
- Phase 40 — Agent Sidebar UI Polish & Planner Reliability (2026-06-07)
- Phase 41 — Security Review & Performance Optimization (2026-06-08)
- T41 S6-S13 / GitHub #51-#58 — Stage plan proposal, advisory Risk/ActionCard write, AssignmentProposal tool, check-in inferred task changes through replan proposal, parity/cutover safety net, direction-card/task-breakdown proposal tools, S11 frontend integration, and advisory create_risk/create_checkin tools (2026-07-06)
- T42 ProjectMemory V1 / GitHub #71-#80 — governed project memory, deterministic extraction, visibility, retrieval, Agent context injection, evaluation harness, optional vector guardrails, and frontend read-only memory list/export UI (2026-07-07)

Implemented: FastAPI backend (public MVP APIs plus service-token-protected internal T41 tool/runtime endpoints, ProjectMemory governance tables, indexed domain models), agent infrastructure with mock/OpenAI-compatible provider diagnostics (httpx connection pool), current time/resource-aware WorkspaceState prompts, enriched direction clarification, confirm-to-persist `AgentProposal` flow for clarify/plan/breakdown/replan, T41 internal tools for stage plan, direction card, task breakdown, advisory Risk/ActionCard creation, direct advisory `create_risk`/`create_checkin`, AssignmentProposal creation, check-in inferred task status changes through replan proposals instead of direct `Task.status` writes, T41 runtime event bridge with trace envelope and proposal confirmation events, T42 ProjectMemory deterministic source-event extraction plus JSON/Markdown read APIs/Agent context injection/frontend panel/two-phase FTS5 retrieval/50-query stratified eval/optional vector guardrails/A-B eval harness and streaming raw-ID sanitization, timeline-only negotiate agent output, stage auto-advance on human task completion, Task `order_index` sort chain, seed/reset/export, file upload with type/size validation, Next.js frontend (workspace route, project resources panel, user identity switcher, Agent proposal/timeline status badges, stage-grouped task breakdown, pending proposal preview banners, lazy-loaded markdown, memoized streaming, ProjectMemory read-only list with Markdown export/copy/download), 641 backend tests passing with 4 skipped, 558 agent-bridge tests passing across 20 files, 57 frontend tests passing, backend ruff clean, agent-bridge typecheck/build passing, frontend lint/build passing.

## Stack

- Frontend: Next.js, React, TypeScript, Tailwind CSS, shadcn/ui, Framer Motion
- Backend: FastAPI, SQLModel, Pydantic
- Agent Bridge: TypeScript (Node.js), Pi component runtime, typed ProjectFlow tools
- Database: SQLite for local demo data

## Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
```

Health check:

```bash
curl http://localhost:8000/api/health
```

Load demo seed data:

```bash
curl -X POST http://localhost:8000/api/seed/demo
```

Reset to empty state:

```bash
curl -X POST http://localhost:8000/api/seed/reset
```

Backend tests:

```bash
cd backend
.venv\Scripts\python -m pytest app/tests/ -v
```

## Agent Bridge Sidecar

```bash
cd agent-bridge
npm install
npx tsx src/index.ts
```

test：

```bash
cd agent-bridge
npx vitest run
npx tsc --noEmit
```

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:3000
```

Frontend verification:

```bash
cd frontend
npm run test
npm run lint
npm run build
npm audit --omit=dev
```

## Project Docs

- [Setup guide](docs/setup-guide.md)
- [Technical design](docs/TECH-DESIGN.md)
- [API contract](docs/api-contract.md)
- [Runbook](docs/runbook.md)
- [Demo script](docs/demo-script.md)
- [Seed scenarios](docs/seed-scenarios.md)
- [Code wiki](docs/code-wiki.md)
- [Current handoff](docs/handoff.md)
- [Agent Runtime T41 overview](docs/T41/ProjectFlow_Agent_Runtime_Team_TDD.md)
- [Agent Runtime foundation design](docs/T41/ProjectFlow_Agent_Runtime_Foundation_Design.md)
- [Agent Tools & Skills design](docs/T41/ProjectFlow_Agent_Tools_Skills_Design.md)
- [ProjectMemory V1 design](docs/T42/project-memory-design-v4.1.md)
- [ProjectMemory V1 closure review](docs/T42/project-memory-v1-closure.md)
- [Agent Runtime ADRs](docs/adr/)
- [Domain glossary](CONTEXT.md)
- [T23 test docs](docs/T23/)
- [T23.A feedback](docs/T23/T23.A.feedback.md)
- [T23.C feedback](docs/T23/T23.C.feedback.md)
- [T23.D feedback](docs/T23/T23D.feedback.md)
- [Issue #11 verification report](docs/issue-11-status-report.md)

## Runtime Files

Keep secrets and local data out of git:

- `.env`
- `model-configs.json`
- `backend/data/`
- SQLite files
- `.venv/`
- `node_modules/`
- `frontend/.next/`

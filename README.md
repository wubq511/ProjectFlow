# ProjectFlow

ProjectFlow is a local-first active project agent MVP for college project teams. The demo target is a full loop from workspace setup through planning, assignment, active push, check-in, risk analysis, replanning, and review export.

The primary Agent path uses the T41 TypeScript Agent Bridge Sidecar with Pi component runtime, typed ProjectFlow tools, durable AgentRunState, and Proposal-Confirm Commit. The legacy `CoordinatorAgent` remains only as migration/fallback code. For new Agent runtime work, start from the T41-T45 docs rather than extending the legacy Coordinator.

## Current Status

All MVP and MVP Usable tasks are complete. T41 Agent Runtime, T42 ProjectMemory V1 and T43 Agent Harness V2 P0 are implemented. On 2026-07-13, T44 hardened request deduplication, cache/cost telemetry, model-selection truthfulness, Prompt Kernel/context receipts, Skill effect ceilings and assignment constraint evidence. T45 added private multi-conversation history with legacy team-history migration, viewer-scoped APIs, cursor pagination, URL selection and streaming-safe history switching. The latest deterministic baseline is 825 backend tests passed / 4 skipped, 1142 agent-bridge tests passed across 58 files, and 147 frontend tests passed across 17 files; all lint/typecheck/build gates pass. The repeated post-T44 production canary passed all frozen routing, outcome, privacy and latency gates; Flash remains the default and Pro remains explicit escalation.

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
- T43 Agent Harness V2 P0 / GitHub #88 — goal/plan/verify control plane, context compaction, Skills V2, manifest-enforced executor, checkpoint/resume/steering, operational eval and frontend run controls (2026-07-12)
- T44 Agent efficiency and model integrity / GitHub #90 — exact-once input, normalized cache/cost telemetry, truthful model selection, stable Prompt Kernel and pre-execution Skill/tool safety (2026-07-13)
- T45 private conversation history / GitHub #91 — private/team conversations, safe migration, viewer authorization, cursor pagination and Agent sidebar history UI (2026-07-13)

Implemented: FastAPI backend with private multi-conversation persistence and service-token-protected internal runtime/tools; T41 typed domain tools and Proposal-Confirm; T42 governed ProjectMemory; T43 durable Agent Harness V2; and T44 request/model/prompt/Skill efficiency hardening. Current verification baseline: 825 backend tests passed / 4 skipped, 1142 agent-bridge tests passed across 58 files, 147 frontend tests passed across 17 files; backend ruff, agent-bridge typecheck/build, and frontend lint/build all pass. See [the post-T44 production canary](docs/T44/post-t44-production-canary-2026-07-13.md) for repeated model evidence and cache/cost interpretation.

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
- [Agent efficiency and model integrity spec](docs/T44/agent-efficiency-model-config-spec.md)
- [Private conversation history spec](docs/T45/agent-conversation-history-spec.md)
- [Domain glossary](CONTEXT.md)
- [T23 test docs](docs/T23/)
- [T23.A feedback](docs/T23/T23.A.feedback.md)
- [T23.C feedback](docs/T23/T23.C.feedback.md)
- [T23.D feedback](docs/T23/T23D.feedback.md)
- [Issue #11 verification report](docs/issue-11-status-report.md)

## Runtime Files

Keep secrets and local data out of git:

- `.env`
- API keys and other secret overrides referenced by `agent-bridge/model-configs.json`（the default registry itself is tracked）
- `backend/data/`
- SQLite files
- `.venv/`
- `node_modules/`
- `frontend/.next/`

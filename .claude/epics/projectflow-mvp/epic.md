---
name: projectflow-mvp
status: in-progress
created: 2026-05-28T13:58:36Z
updated: 2026-05-29T00:36:48Z
progress: 50%
prd: .claude/prds/projectflow-mvp.md
github: https://github.com/wubq511/ProjectFlow/issues/1
---

# Epic: projectflow-mvp

## Overview

Build the ProjectFlow MVP as a local-first active project agent loop for college teams. The implementation must run a complete demo path:

Account setup -> workspace setup -> member profiles -> project intake -> clarification -> stage plan -> task breakdown -> assignment recommendation -> assignment confirmation/negotiation -> active push -> check-in/status update -> risk analysis -> replanning -> next action cards -> timeline/export.

The technical target is not a full SaaS. The target is a reliable local demo that proves the agent can keep a small team moving through explainable, state-aware suggestions.

## Architecture Decisions

1. Use Next.js, React, TypeScript, Tailwind CSS, shadcn/ui, and Framer Motion for the frontend.
2. Use FastAPI, SQLModel, Pydantic, and SQLite for the backend.
3. Keep one local SQLite database under backend data storage, ignored by git.
4. Model one workspace and one active project for MVP, while keeping IDs and service boundaries clean enough for later expansion.
5. Use a single Coordinator Agent. Do not introduce multi-agent runtime behavior.
6. Put the deterministic workflow in backend services and state transitions.
7. Let the agent generate proposals only. Services finalize confirmed changes.
8. Validate every agent output with Pydantic schemas.
9. Store AgentEvent timeline records for inputs, outputs, fallback behavior, status, and reasoning summaries.
10. Keep frontend pages as composition layers; API calls and types stay in `frontend/src/lib`.

## Technical Approach

### Frontend Components

Create a Next.js app with routes and components aligned to the documented flow:
- Account and profile setup: `AccountSetupForm`, `MemberProfileWizard`
- Workspace setup: `WorkspaceCreateForm`, `InviteMemberPanel`
- Project intake: `ProjectIntakeForm`, `ResourceInputPanel`
- Project dashboard: direction, plan, assignment, action cards, check-in, risk, timeline, export
- Shared UI states: loading, empty, error, success, retry, and demo reset

The dashboard first view should answer "what should happen now?" rather than showing a passive task list.

### Backend Services

Create FastAPI routes as thin request/response adapters. Put state transitions and validation in services:
- User, workspace, invitation, membership, member profile
- Project and resource intake
- Stage and task management
- Assignment proposal, response, negotiation, and finalization
- Check-in cycle and response
- Risk, action card, timeline, export

### Agent Infrastructure

Create provider-aware LLM adapter and structured output schemas. The Coordinator Agent reads WorkspaceState and calls module functions for:
- clarification
- planning
- breakdown
- assignment recommendation
- assignment negotiation
- active push
- check-in analysis
- risk analysis
- replanning

Each module must provide explainable output and fallback behavior.

### Infrastructure

Keep infrastructure minimal:
- Local FastAPI server on port 8000
- Local Next.js server on port 3000
- SQLite for persistence
- `.env` for LLM keys and runtime settings
- Seed/reset scripts for deterministic demos

## Implementation Strategy

1. Establish guardrails and monorepo scaffolding first.
2. Implement backend domain models and persistence before endpoint-heavy work.
3. Add core APIs and WorkspaceState assembly before agent modules.
4. Build agent output schemas and fallback handling before connecting real LLM calls.
5. Build frontend shell with mockable API surfaces, then connect backend endpoints.
6. Implement planning and assignment flow before polishing active push and risk views.
7. Add seed data, reset, export, and verification at the end.

## Task Breakdown Preview

The epic is intentionally kept to 10 tasks:

1. Guardrails, monorepo bootstrap, and health checks.
2. Backend domain models and SQLite persistence.
3. Workspace, account, project, resource, stage, and task APIs.
4. Agent infrastructure, structured output schemas, and fallback pipeline.
5. Frontend app shell, onboarding, workspace, and project intake.
6. Frontend dashboard for planning, tasks, assignments, and confirmations.
7. Assignment, active push, check-in, risk, replan, and timeline backend flows.
8. Frontend action cards, check-in, risk/replan, timeline, and export.
9. Demo seed data, reset, runbook, and review export.
10. Verification, tests, and demo stability hardening.

Parallelization:
- Task 3 and task 6 can run after setup because they touch backend and frontend separately.
- Task 4 and task 5 can run in parallel after backend models exist.
- Task 7 can proceed once frontend shell and core APIs exist.
- Task 8 can proceed after core APIs and agent schema infrastructure exist.
- Tasks 10 and 11 are final stabilization work and should stay sequential.

## Dependencies

- PRD: `.claude/prds/projectflow-mvp.md`
- Canonical product doc: `docs/PRD-ProjectFlow-MVP.md`
- Canonical technical design: `docs/TECH-DESIGN.md`
- Runtime requirements from AGENTS/CLAUDE workspace instructions

## Success Criteria (Technical)

- `frontend` and `backend` can be installed and run locally.
- `/api/health` works.
- The local app can run the full ProjectFlow demo path at least once.
- Backend API smoke tests pass.
- Agent output schema tests pass.
- Assignment reject/swap/finalize tests pass.
- Check-in to risk to replan tests pass.
- The frontend build/lint path passes.
- Seed reset returns the app to a known demo state.
- No secrets, SQLite data, virtualenvs, node modules, or build artifacts are committed.

## Estimated Effort

- Size: XL
- Estimated implementation time: 64-88 hours
- Delivery mode: small task branches or one epic branch with issue-numbered commits after GitHub sync

## Tasks Created

- [x] 2.md - Guardrails, Monorepo Bootstrap, and Health Checks (parallel: false)
- [x] 3.md - Backend Domain Models and SQLite Persistence (parallel: true)
- [x] 4.md - Core Workspace and Project APIs (parallel: true)
- [x] 5.md - Agent Infrastructure and Structured Outputs (parallel: true)
- [x] 6.md - Frontend Shell, Onboarding, Workspace, and Intake (parallel: true)
- [ ] 7.md - Planning and Assignment Dashboard UI (parallel: true)
- [ ] 8.md - Assignment, Active Push, Check-in, Risk, Replan Backend Flows (parallel: true)
- [ ] 9.md - Action Cards, Check-in, Risk, Timeline, and Export UI (parallel: true)
- [ ] 10.md - Demo Seed, Reset, Runbook, and Review Export (parallel: false)
- [ ] 11.md - Verification, Tests, and Demo Stability Hardening (parallel: false)

Total tasks: 10
Parallel tasks: 7
Sequential tasks: 3
Estimated total effort: 76 hours



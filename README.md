# ProjectFlow

ProjectFlow is a local-first active project agent MVP for college project teams. The demo target is a full loop from workspace setup through planning, assignment, active push, check-in, risk analysis, replanning, and review export.

## Current Status

All MVP phases and MVP Usable tasks complete. Phase 24 (Agent Output Quality + Bug Fixes) and Phase 25 (T23.D Feedback Fixes) complete (2026-06-03). Phase 26 (T23.B Round 2 Fixes: skill name normalization, JSON strictness, negotiate endpoint, stage override, negotiation context, stage_id validation threading) complete (2026-06-03).

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

Implemented: FastAPI backend (70 endpoint method/path pairs, 19 persistence tables/domain models), agent infrastructure with mock/OpenAI-compatible provider diagnostics, confirm-to-persist `AgentProposal` flow including replan proposals, seed/reset/export, Next.js frontend (7 routes, project resources panel, user identity switcher), 218 backend tests passing, 24 frontend tests passing, frontend lint+build clean.

## Stack

- Frontend: Next.js, React, TypeScript, Tailwind CSS, shadcn/ui, Framer Motion
- Backend: FastAPI, SQLModel, Pydantic
- Database: SQLite for local demo data
- Agent: single Coordinator Agent with structured output validation

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
- [T23 test docs](docs/T23/)
- [T23.A feedback](docs/T23/T23.A.feedback.md)
- [T23.C feedback](docs/T23/T23.C.feedback.md)
- [T23.D feedback](docs/T23/T23D.feedback.md)
- [Issue #11 verification report](docs/issue-11-status-report.md)

## Runtime Files

Keep secrets and local data out of git:

- `.env`
- `backend/data/`
- SQLite files
- `.venv/`
- `node_modules/`
- `frontend/.next/`

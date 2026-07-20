# ProjectFlow

ProjectFlow is a local-first active project agent MVP for college project teams. The demo target is a full loop from workspace setup through planning, assignment, active push, check-in, risk analysis, replanning, and review export.

The primary Agent path uses the T41 TypeScript Agent Bridge Sidecar with Pi component runtime, typed ProjectFlow tools, durable AgentRunState, and Proposal-Confirm Commit. The legacy `CoordinatorAgent` remains only as migration/fallback code. For new Agent runtime work, start from the T41-T45 docs rather than extending the legacy Coordinator.

## Current Status

All MVP and MVP Usable tasks are complete. T41 Agent Runtime, T42 ProjectMemory V1, T43 Agent Harness V2 P0, T44 efficiency/model integrity, and T45 private conversation history are implemented. T46 Slice 0 and Slice 1 Issues #94-#96 are merged. On 2026-07-20, T46 Issue #97 was merged into `main` at `3e09596` and closed: evidence-graded diagnoses with 5 frozen causal statuses, evaluator-owned single-variable counterfactuals, 8-category fault profiles, a known-fault RCA benchmark with 5 anti-gaming gates, evidence-bound issue clustering, immutable Repair Packets (`REPAIR_PACKET_SCHEMA_VERSION = 1`) with fix/investigation gate + scrubbing + stale detection + candidate-regression governance, and copy-ready Coding Agent prompts are complete. The light release gate passed Agent Bridge 1945/1945, typecheck/build, fault catalog completeness, and the 12-sample RCA benchmark. Issue #98 is next and owns governed calibration and semantic standards. Paid models remain fail-closed until frozen pricing and pre-call worst-case estimates exist.

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
- T46 Evaluation Lab Slice 0 / GitHub #94 — evaluator-owned isolation, bounded smoke execution, immutable evidence, machine-readable CLI and Coding Agent Skill (2026-07-17)
- T46 Evaluation Lab Slice 1 foundation / GitHub #95 — scoped evidence, hard-state/authority oracles, public confirm/reject E2E, hidden-field commitments and `smoke-v2` (merged 2026-07-19)
- T46 Evaluation Lab Slice 1 multi-turn / Skill / Runtime / Reliability / GitHub #96 — deterministic multi-turn user controller, simulator integrity, attempt ledger, Skill 8 dimensions, Runtime 11 fault classes, demo/smoke/smoke-v2/full presets, isolated candidate/baseline execution, reliability statistics, operational metrics and Slice 1 exit gate (merged and closed 2026-07-20)
- T46 Evaluation Lab Slice 2 Diagnosis & Repair / GitHub #97 — evidence-graded diagnoses with 5 frozen causal statuses, evaluator-owned counterfactuals, 8-category fault profiles, anti-gaming RCA benchmark, immutable Repair Packets with fix/investigation gate, and governed Coding Agent prompts (merged and closed 2026-07-20)

Implemented: FastAPI backend with private multi-conversation persistence and service-token-protected internal runtime/tools; T41 typed domain tools and Proposal-Confirm; T42 governed ProjectMemory; T43 durable Agent Harness V2; T44 request/model/prompt/Skill efficiency hardening; the T46 trustworthy evaluation minimum loop; the T46 Slice 1 ProjectFlow-aware deterministic hard graders; and the T46 Slice 1 multi-turn / Skill / Runtime / reliability surface. See [the post-T44 production canary](docs/T44/post-t44-production-canary-2026-07-13.md) for repeated model evidence, [the T46 Slice 0 handoff](docs/T46/ProjectFlow_Agent_Evaluation_Lab_Slice0_Handoff.md) for evaluator usage and trust boundaries, and [the T46 Slice 1 handoff](docs/T46/ProjectFlow_Agent_Evaluation_Lab_Slice1_Handoff.md) for hard grader contracts, the #96 module table, adversarial review remediation, and the Slice 1 closure path.

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
scripts/project-npm --prefix agent-bridge install
scripts/project-npm --prefix agent-bridge run start
```

test：

```bash
scripts/project-npm --prefix agent-bridge run test
scripts/project-npm --prefix agent-bridge run typecheck
scripts/project-npm --prefix agent-bridge run build
```

## Agent Evaluation Lab

Slice 0 runs the bounded local mock smoke; Issues #95/#96 supply hard-domain, multi-turn, Skill, Runtime, reliability and paired evaluation; merged Issue #97 adds evidence-graded diagnosis, counterfactuals, fault profiles, RCA benchmark and Repair Packets. Issue #98 is the next slice for governed calibration and semantic standards. Coding Agent cost is reported separately and never counts against the ProjectFlow Agent cap.

```bash
# Slice 0 — minimum trustworthy loop
scripts/eval-lab validate --preset smoke --model mock:mock-model
scripts/eval-lab run --preset smoke --model mock:mock-model --json
scripts/eval-lab verify <run-id>

# Slice 1 foundation (#95) — V2 hard graders + public human-action seams
scripts/eval-lab validate --preset smoke-v2 --model mock:mock-model
scripts/eval-lab run --preset smoke-v2 --model mock:mock-model --json

# Slice 1 multi-turn / Skill / Runtime / Reliability (#96, merged)
scripts/eval-lab validate --preset demo --model mock:mock-model
scripts/eval-lab validate --preset full --model mock:mock-model
scripts/eval-lab exit-gate <run-id> --json
scripts/eval-lab reliability <run-id> --json
scripts/eval-lab compare --candidate <git-ref> --baseline <git-ref> --preset smoke --model mock:mock-model --json

# Slice 2 Diagnosis & Repair (#97, merged)
scripts/eval-lab diagnose <run-id> --json
scripts/eval-lab repair-packet <run-id> --packet-id <optional-id> --json
scripts/eval-lab rca-benchmark <run-id> --json
scripts/eval-lab fault-catalog --json
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

- [Agent optimization showcase and judging evidence](docs/showcase/agent-optimization-showcase-2026-07.md)
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
- [Evaluation Lab specification](docs/T46/ProjectFlow_Agent_Evaluation_Lab_Spec.md)
- [Evaluation Lab Slice 0 handoff](docs/T46/ProjectFlow_Agent_Evaluation_Lab_Slice0_Handoff.md)
- [Evaluation Lab Slice 1 handoff](docs/T46/ProjectFlow_Agent_Evaluation_Lab_Slice1_Handoff.md)
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

# ProjectFlow Handoff

Status: current as of 2026-05-29.

## Completed

Phase 0 / GitHub issue #2 is complete and closed.
Phase 1 (models) / GitHub issue #3 is complete and closed.
Phase 2 (core APIs) / GitHub issue #4 is complete and closed.
Phase 4 (agent infrastructure) / GitHub issue #5 is implemented.
GitHub issue #6 (Frontend Shell, Onboarding, Workspace, and Intake) is implemented.
GitHub issue #7 (Planning and Assignment Dashboard UI) is implemented.
GitHub issue #8 (Assignment, active push, check-in, risk, and replan backend flows) is implemented.

Implemented scope:

- Repository guardrails in `AGENTS.md` and `CLAUDE.md`.
- Root `README.md` with local setup and verification commands.
- Backend FastAPI scaffold with `GET /api/health`.
- Backend config and SQLite engine skeleton.
- Backend smoke test for health API.
- Frontend Next.js scaffold with a first ProjectFlow screen.
- Frontend API helper and type placeholders.
- Frontend test, lint, and production build setup.
- Runtime ignore rules for secrets, local databases, dependency folders, and generated caches.
- All 18 domain models in `backend/app/models/` with full enum alignment.
- Database auto-creates tables on FastAPI startup via lifespan.
- 12 model smoke tests covering insert/read for every model.
- Full CRUD APIs: users, workspaces, invitations, member-profiles, projects, resources, stages, tasks.
- WorkspaceState assembly endpoint: `GET /api/workspaces/{id}/state`.
- Service layer for all CRUD domains in `backend/app/services/`.
- Pydantic schemas for all CRUD domains in `backend/app/schemas/`.
- Agent infrastructure in `backend/app/agent/`: coordinator, workflow, prompts, LLM client, structured output schemas, module request builders, JSON repair/retry/template fallback, and AgentEvent timeline logging.
- 9 API smoke tests covering full demo path and list endpoints.
- Backend execution-loop APIs for assignment proposals/responses/finalization/negotiation, action cards, check-in cycles/responses, risks, confirmed replans, and agent endpoints.

### GitHub issue #6 (2026-05-29)

- App shell with responsive navigation (desktop links + mobile hamburger sheet).
- Onboarding flow: account setup form (create/select demo identity) and member profile wizard (3-step: skills, availability, preferences).
- Workspace flow: create workspace form, invite member panel with copy-link, workspace dashboard.
- Project intake: project idea/deadline/deliverables form, resource input panel (text notes, links, file references), project dashboard.
- Full domain types in `frontend/src/lib/types.ts` (User, Workspace, MemberProfile, Project, Stage, Task, Assignment, CheckIn, Risk, ActionCard, AgentEvent, etc.).
- Full API layer in `frontend/src/lib/api.ts` (users, workspaces, invitations, profiles, projects, resources, agent, assignments, checkins, tasks, export).
- shadcn/ui installed with 16 components (button, card, input, label, select, textarea, badge, separator, avatar, dialog, dropdown-menu, sheet, tabs, tooltip, progress).
- Tailwind config updated with CSS variable colors for shadcn/ui compatibility.

### GitHub issue #7 (2026-05-29)

- Project dashboard now surfaces the planning and assignment flow: current stage, next action, clarification/direction card, stage plan, task breakdown, assignment proposal, member responses, negotiation, and final confirmation sections.
- `frontend/src/app/projects/[projectId]/page.tsx` now delegates rendering to `ProjectDashboard` and keeps page logic focused on loading state and event handlers.
- `frontend/src/lib/api.ts` composes `getProjectState` from implemented backend endpoints instead of assuming a dedicated project-state endpoint.
- `frontend/src/lib/types.ts` now includes assignment responses and negotiations in `ProjectState`.
- Focused frontend tests cover empty, populated, and API-failure dashboard states.

### GitHub issue #8 (2026-05-29)

- Added backend routes and services for assignment proposals, member responses, finalization, and negotiation.
- Added backend routes and services for action cards, check-in cycles/responses, risks, and confirmed replans.
- Added agent HTTP endpoints for clarify, plan, breakdown, assign, active push, check-in analysis, risk analysis, and replan.
- Extended task status updates with `available_hours_change`.
- Added backend tests for assignment flow, check-in/risk/replan flow, and agent endpoints.
- Local SQLite databases created before `AgentEvent.status` may need the runbook schema drift repair before agent timeline writes.

## Verification Baseline

Commands run successfully on 2026-05-29:

```bash
cd backend
.venv\Scripts\python -m pytest app/tests/ -v
```

```bash
cd frontend
npm run test
npm run lint
npm run build
```

Results:

- Backend: 54 tests passed.
- Frontend: 3 tests passed across 2 test files.
- Frontend lint passed.
- Frontend build passed (7 routes generated).

## Current Implementation Surface

Backend:

- Implemented routes: health, users (3), workspaces (4), invitations (2), member-profiles (4), projects (4), resources (2), stages (4), tasks (6), workspace-state (1), agent (8), assignments (6), action-cards (2), check-ins (4), risks (2), replans (1). Total: 54 endpoints.
- Domain models implemented (18 models, all enums).
- AgentEvent now records `status` for success, repaired, fallback, or failed agent runs.
- Service layer implemented for all CRUD domains plus assignment, action-card, check-in, risk, replan, and agent-flow orchestration.
- Pydantic schemas implemented for all CRUD and execution-loop domains.
- WorkspaceState endpoint returns members, project, stages, tasks for Agent consumption.
- Agent infrastructure can run with `LLM_PROVIDER=mock` by default, or OpenAI-compatible chat-completions settings through environment variables. Agent HTTP endpoints persist structured outputs and created entity IDs through service-layer writes.

Frontend:

- Implemented routes: `/`, `/onboarding`, `/onboarding/profile`, `/workspaces/new`, `/workspaces/[workspaceId]`, `/projects/new`, `/projects/[projectId]`.
- API base URL comes from `NEXT_PUBLIC_API_BASE_URL` or defaults to `http://localhost:8000/api`.
- All API calls go through `frontend/src/lib/api.ts`.
- All types defined in `frontend/src/lib/types.ts`.
- Project dashboard composes project, workspace, resources, stages, tasks, users, and profiles from implemented endpoints. The backend now provides agent/assignment/check-in/risk/replan routes, but dashboard wiring for action cards, check-ins, risks, replans, and timeline views remains pending. Export remains planned.
- UI components use shadcn/ui (base-nova style) with project color tokens (ink, paper, moss, citron, coral, harbor).

## Next Work

Recommended next implementation target:

1. Wire the project dashboard to the issue #8 backend APIs for action cards, check-ins, risks, replans, and agent timeline.
2. Add seed/reset data and demo polish flows.
3. Implement review-summary export.

Dependency note:

- #5 depends on #3 (domain models) and is now implemented.
- #6 (frontend) is now complete.
- #7 depends on both #5 and #6 and is now implemented.
- #8 depends on #5 and is now implemented on the backend. Frontend wiring remains a follow-up.

## Local Cleanup Notes

Ignored install/build artifacts may exist locally after verification:

- `backend/.venv/`
- `backend/.pytest_cache/`
- Python `__pycache__/`
- `frontend/node_modules/`
- `frontend/.next/`

They are intentionally ignored and must not be committed.

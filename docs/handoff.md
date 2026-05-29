# ProjectFlow Handoff

Status: current as of 2026-05-29.

## Completed

Phase 0 / GitHub issue #2 is complete and closed.
Phase 1 (models) / GitHub issue #3 is complete and closed.
Phase 2 (core APIs) / GitHub issue #4 is complete and closed.
Phase 4 (agent infrastructure) / GitHub issue #5 is implemented.

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

### GitHub issue #6 (2026-05-29)

- App shell with responsive navigation (desktop links + mobile hamburger sheet).
- Onboarding flow: account setup form (create/select demo identity) and member profile wizard (3-step: skills, availability, preferences).
- Workspace flow: create workspace form, invite member panel with copy-link, workspace dashboard.
- Project intake: project idea/deadline/deliverables form, resource input panel (text notes, links, file references), project dashboard.
- Full domain types in `frontend/src/lib/types.ts` (User, Workspace, MemberProfile, Project, Stage, Task, Assignment, CheckIn, Risk, ActionCard, AgentEvent, etc.).
- Full API layer in `frontend/src/lib/api.ts` (users, workspaces, invitations, profiles, projects, resources, agent, assignments, checkins, tasks, export).
- shadcn/ui installed with 16 components (button, card, input, label, select, textarea, badge, separator, avatar, dialog, dropdown-menu, sheet, tabs, tooltip, progress).
- Tailwind config updated with CSS variable colors for shadcn/ui compatibility.

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

- Backend: 51 tests passed.
- Frontend: 1 test passed.
- Frontend lint passed.
- Frontend build passed (7 routes generated).

## Current Implementation Surface

Backend:

- Implemented routes: health, users (3), workspaces (4), invitations (2), member-profiles (4), projects (4), resources (2), stages (4), tasks (6), workspace-state (1). Total: 30 endpoints.
- Domain models implemented (18 models, all enums).
- AgentEvent now records `status` for success, repaired, fallback, or failed agent runs.
- Service layer implemented for all CRUD domains.
- Pydantic schemas implemented for all CRUD domains.
- WorkspaceState endpoint returns members, project, stages, tasks for Agent consumption.
- Agent infrastructure can run with `LLM_PROVIDER=mock` by default, or OpenAI-compatible chat-completions settings through environment variables.

Frontend:

- Implemented routes: `/`, `/onboarding`, `/onboarding/profile`, `/workspaces/new`, `/workspaces/[workspaceId]`, `/projects/new`, `/projects/[projectId]`.
- API base URL comes from `NEXT_PUBLIC_API_BASE_URL` or defaults to `http://localhost:8000/api`.
- All API calls go through `frontend/src/lib/api.ts`.
- All types defined in `frontend/src/lib/types.ts`.
- UI components use shadcn/ui (base-nova style) with project color tokens (ink, paper, moss, citron, coral, harbor).

## Next Work

Recommended next implementation target:

1. Planning and Assignment Dashboard UI (issue #7) — depends on #5 and #6.
2. Assignment, active push, check-in, risk, replan backend flows (issue #8).

Dependency note:

- #5 depends on #3 (domain models) and is now implemented.
- #6 (frontend) is now complete.
- #7 depends on both #5 and #6.

## Local Cleanup Notes

Ignored install/build artifacts may exist locally after verification:

- `backend/.venv/`
- `backend/.pytest_cache/`
- Python `__pycache__/`
- `frontend/node_modules/`
- `frontend/.next/`

They are intentionally ignored and must not be committed.

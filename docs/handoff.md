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
GitHub issue #9 (Action cards, check-in, risk, timeline, and export UI) is implemented.
GitHub issue #10 (Demo Seed, Reset, Runbook, and Review Export) is implemented.
GitHub issue #11 (Verification, Tests, and Demo Stability Hardening) is complete.
GitHub issue #16 (Real LLM Provider Readiness and Diagnostics) is implemented.

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
- LLM provider readiness: specific error hierarchy (LLMAuthError, LLMTimeoutError, LLMConnectionError, LLMResponseError, LLMConfigurationError), HTTP status code mapping, provider diagnostic endpoint (`POST /api/llm/diagnostic`), API key masking, `.env.example` with documented settings.
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

### GitHub issue #16 (2026-05-29)

- LLM client error hierarchy: `LLMAuthError`, `LLMTimeoutError`, `LLMConnectionError`, `LLMResponseError`, `LLMConfigurationError` — all inherit from `LLMError`.
- HTTP error mapping: 401/403→AuthError, 404→ConfigError, 429→RateLimit, 5xx→ConnectionError, timeout→TimeoutError, network→ConnectionError, malformed response→ResponseError.
- Provider diagnostic endpoint: `POST /api/llm/diagnostic` — safe dry-run connectivity check, never exposes API key.
- `.env.example` with documented LLM settings (provider, key, base_url, model, timeout).
- 38 new tests for error mapping, diagnostic, API key masking, mock regression.
- Backend test count: 110 passing.

### GitHub issues #9-#11 (2026-05-29)

- Dashboard execution tabs are wired to implemented backend endpoints for action cards, check-in submission, task status updates, risks, timeline, and review export.
- Frontend API paths now use the actual workspace-scoped agent routes and flat assignment/check-in/action/risk routes.
- Added backend review-summary export endpoint and timeline listing endpoint.
- Added `POST /api/demo/reset` compatibility endpoint for the dashboard reset button.
- Added `docs/demo-script.md` and `docs/seed-scenarios.md`.
- Added regression tests for demo reset/export and frontend API route alignment.
- Demo seed data module (`backend/app/seed/demo_projectflow.py`) creates a realistic 6-member student team with full project data: workspace, memberships, invitations, member profiles, project with direction card, resources, 4 stages, 10 tasks, 3 assignment proposals, check-in cycle with responses (including blocker), 3 risks, 5 action cards, and 5 agent timeline events.
- Demo reset module (`backend/app/seed/reset.py`) clears all tables in dependency order.
- Seed API endpoints: `POST /api/seed/demo` (reset + seed) and `POST /api/seed/reset`.
- Review summary export endpoint: `POST /api/projects/{project_id}/export/review-summary` generates Markdown with product positioning, current state, stages, tasks, team, risks, action cards, check-ins, and agent timeline.
- Frontend API functions: `loadDemoSeed()` and `resetDemoData()` added to `api.ts`.
- Documentation: `docs/demo-script.md` (5-minute demo path), `docs/seed-scenarios.md` (blocker/availability-change scenario), `docs/runbook.md` updated with seed/reset/export instructions.
- 15 new tests for seed, reset, and export endpoints.

## Verification Baseline

Commands run successfully on 2026-05-29:

```bash
cd backend
.venv\Scripts\python -m pytest app/tests/ -v
```

```bash
cd frontend
npm run lint
npm run build
```

Results:

- Backend: 110 tests passed.
- Frontend: 5 tests passed across 3 test files.
- Frontend lint passed.
- Frontend build passed (7 routes generated).

## Current Implementation Surface

Backend:

- Implemented routes: health, users, workspaces, invitations, member-profiles, projects, resources, stages, tasks, workspace-state, agent, assignments, action-cards, check-ins, risks, replans, seed/reset, timeline, export, demo reset, and llm diagnostic.
- Domain models implemented (18 models, all enums).
- AgentEvent now records `status` for success, repaired, fallback, or failed agent runs.
- Service layer implemented for all CRUD domains plus assignment, action-card, check-in, risk, replan, and agent-flow orchestration.
- Pydantic schemas implemented for all CRUD and execution-loop domains.
- WorkspaceState endpoint returns members, project, stages, tasks for Agent consumption.
- Agent infrastructure can run with `LLM_PROVIDER=mock` by default, or OpenAI-compatible chat-completions settings through environment variables. Agent HTTP endpoints persist structured outputs and created entity IDs through service-layer writes. LLM provider errors are mapped to specific exception types (LLMAuthError, LLMTimeoutError, LLMConnectionError, LLMResponseError) with clear messages and recovery hints.

Frontend:

- Implemented routes: `/`, `/onboarding`, `/onboarding/profile`, `/workspaces/new`, `/workspaces/[workspaceId]`, `/projects/new`, `/projects/[projectId]`.
- API base URL comes from `NEXT_PUBLIC_API_BASE_URL` or defaults to `http://localhost:8000/api`.
- All API calls go through `frontend/src/lib/api.ts`.
- All types defined in `frontend/src/lib/types.ts`.
- Navigation: 首页 / 工作台（自动检测 workspace ID）/ 新建项目。Onboarding 不再常驻导航。
- 首页智能重定向：有 workspace 记录则跳转工作台，否则展示欢迎页 + "加载演示数据"按钮。
- Project dashboard composes project, workspace, resources, stages, tasks, users, profiles, action cards, check-ins, risks, replan diff, agent timeline, and export from implemented endpoints. Agent 操作按状态机 4 阶段分组（规划/分工/执行/监控），当前阶段高亮，自动推荐下一步。
- UI 语言统一中文。表单组件统一使用 shadcn/ui（Input、Select、Textarea）。
- RiskPanel 支持状态过滤（全部/待处理/已接受/已忽略/已解决）。
- localStorage 读取使用 `useSyncExternalStore` 避免 hydration mismatch。
- UI components use shadcn/ui (base-nova style) with project color tokens (ink, paper, moss, citron, coral, harbor).

## Next Work

MVP issue scope is complete. Phase 10 (UI Structural Fix) completed 2026-05-29.

Remaining work for MVP Usable (see `.claude/epics/projectflow-mvp-usable-ready/`):
- Real LLM integration testing (provider readiness infrastructure done via #16, need live key testing)
- Confirm-to-persist (Agent outputs only persisted after human confirmation)
- Prompt quality (structured output reliability — #18 in progress)
- Agent status transparency (show Agent thinking/reasoning in UI)
- Demo stability and polish

Post-MVP: auth, deployment, collaboration permissions, broader UI hardening.

Dependency note: all resolved.

## Local Cleanup Notes

Ignored install/build artifacts may exist locally after verification:

- `backend/.venv/`
- `backend/.pytest_cache/`
- Python `__pycache__/`
- `frontend/node_modules/`
- `frontend/.next/`

They are intentionally ignored and must not be committed.

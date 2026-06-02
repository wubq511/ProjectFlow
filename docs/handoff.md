# ProjectFlow Handoff

Status: current as of 2026-06-03.

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
GitHub issue #16 (Real LLM Provider Readiness and Diagnostics) is complete.
GitHub issue #17 (Agent Output Persistence and Confirmation) is complete.
GitHub issue #21 (Real-Provider Verification and MVP Usable Runbook) is complete.

### Phase 18 — Frontend Bugfix (2026-05-30)

- Fixed DirectionCard type field names to match backend: `target_users/core_value/constraints/out_of_scope/initial_risks` → `users/value/boundaries/risks/suggested_questions`.
- Fixed "页面暂时不可用" crash after confirming Agent proposals: DirectionCardPanel was calling `.map()` on undefined fields due to field name mismatch, triggering Next.js error boundary.
- Rewrote DirectionCardPanel with `safeStringList()` defensive rendering and full field display (deliverables, boundaries, risks, suggested questions).
- Added defensive `proposals ?? []` in AgentProposalPanel to prevent undefined crashes.
- Increased frontend API timeout from 30s to 120s (matching backend LLM timeout).
- Updated test data: `project-dashboard.test.tsx` DirectionCard field names aligned + `agent_proposals: []` added; `api.test.ts` added `agent-proposals` endpoint mock.
- Frontend test baseline: 7 tests passing across 3 files (was 5).

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
- All 19 persistence tables/domain models in `backend/app/models/` with full enum alignment, including `AgentProposal`.
- Database auto-creates tables on FastAPI startup via lifespan.
- 12 model smoke tests covering insert/read for every model.
- Full CRUD APIs: users, workspaces, invitations, member-profiles, projects, resources, stages, tasks.
- WorkspaceState assembly endpoint: `GET /api/workspaces/{id}/state`.
- Service layer for all CRUD domains in `backend/app/services/`.
- Pydantic schemas for all CRUD domains in `backend/app/schemas/`.
- Agent infrastructure in `backend/app/agent/`: coordinator, workflow, prompts, LLM client, structured output schemas, module request builders, JSON repair/retry/template fallback, and AgentEvent timeline logging.
- 9 API smoke tests covering full demo path and list endpoints.
- Backend execution-loop APIs for assignment proposals/responses/finalization/negotiation, action cards, check-in cycles/responses, risks, confirmed replans, and agent endpoints.
- LLM diagnostic endpoints for current settings and one-off provider checks.
- Agent proposal confirm/reject APIs for clarify, plan, and breakdown outputs.

### GitHub issue #21 (2026-05-30)

- Fixed 3 stale frontend test assertions (English labels → Chinese UI labels) in `project-dashboard.test.tsx` and `projectflow-home.test.tsx`.
- Frontend test baseline: 5 tests passing across 3 files (was 3 failures).
- Updated `docs/runbook.md` with comprehensive LLM Provider Modes section (mock mode and real-provider mode configuration, behavior, and verification).
- Added Manual Verification Checklist covering the full MVP flow: account setup, workspace, project intake, clarification, planning, breakdown, assignment, active push, check-in, risk analysis, replan, timeline, export, demo reset, and real-provider mode verification.
- Added Final Status Report to runbook: what is truly usable (18 features), what remains fallback (3 areas), and what is out of scope for MVP (11 areas).
- Updated verification baseline in handoff to reflect all tests passing.

### GitHub issue #6 (2026-05-29)

- App shell with responsive navigation (desktop links + mobile hamburger sheet).
- Onboarding flow: account setup form with real-time validation, member profile wizard (3-step: basic info / skills & experience / availability) with completion bar and popular skill suggestions.
- Workspace flow: 2-step wizard create workspace form (basic info + team context), invite member panel with copy-link feedback, workspace dashboard with EmptyState.
- Project intake: card-section layout with project type selector (coursework/competition/startup/research), deliverable tag input, real-time validation, and localStorage draft auto-save. Resource input panel with collapsible animation.
- Full domain types in `frontend/src/lib/types.ts` (User, Workspace, MemberProfile, Project, Stage, Task, Assignment, CheckIn, Risk, ActionCard, AgentEvent, etc.).
- Full API layer in `frontend/src/lib/api.ts` (users, workspaces, invitations, profiles, projects, resources, agent, assignments, checkins, tasks, export).
- shadcn/ui installed with 16 base components + 6 custom UI components (FormSection, TagInput, FormField, StepIndicator, CompletionBar, EmptyState).
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

### GitHub issue #18 (2026-05-29)

- DirectionCardOutput schema replaced `summary`/`target_outcome`/`constraints` with `problem`/`users`/`value`/`deliverables`/`boundaries`/`risks` per acceptance criteria.
- AGENT_SYSTEM_PROMPT expanded with WorkspaceState structure guidance and 5 state-grounding rules.
- All 8 module user_prompts rewritten with explicit instructions to cite specific skills, availability, blockers, task status, priorities, and deadlines.
- `_validate_references` extended with `_validate_evidence_ids` to check RiskProposal.evidence for fabricated task_id/stage_id.
- Tests: added messy project fixture (4 members, 3 stages, 6 tasks with blocked/overdue/unassigned), 7 new test cases for representative model outputs and fabrication rejection. These tests are included in the current backend baseline.

### GitHub issue #20 (2026-05-29)

- AssignmentRecommendationItem schema: added `skill_match`, `availability_match`, `preference_match`, `constraint_respected` for structured citation of why a member was recommended.
- ActionCardProposal schema: added `goal`, `start_suggestion`, `completion_standard` so push cards specify what they achieve, how to start, and how to know they're done.
- AssignmentProposal model and AssignmentProposalCreate/Read schemas updated with the 4 citation fields. ActionCard model and ActionCardCreate/Read schemas updated with the 3 new fields.
- Agent module prompts upgraded: assignment_recommendation requires filling all citation fields; active_push requires goal/start_suggestion/completion_standard; risk_analysis requires structured evidence dicts with detail field; replanning requires action cards to include goal/start_suggestion/completion_standard and forbids owner changes on finalized assignments.
- Fallback payloads now cite real member data from workspace_state instead of generic placeholders.
- Replan service guard: `confirm_replan` now rejects `owner_user_id` changes for tasks that have a finalized AssignmentProposal. Non-ownership changes (due_date, can_cut, status) are still allowed.
- Frontend: ActionCardItem displays goal, start_suggestion ("Start:"), completion_standard ("Done when:"). RiskCard renders structured evidence dicts (key:value pairs + detail). ReplanDiff shows proposal metadata section with before/after comparison, impact, reason, and "Needs confirmation" badge. AssignmentFlowPanel shows citation fields (Skill/Availability/Preference/Constraint) when present.
- Frontend types.ts: ActionCard and AssignmentProposal types updated with new optional fields.
- Tests: 11 new tests in `test_usability_pass_20.py` covering structured citations, push card fields, risk evidence, replan proposal, finalized-assignment guard, and fallback citations. These tests are included in the current backend baseline.

### GitHub issue #16 (2026-05-29)

- Added `GET /api/llm/diagnostic` for checking the configured provider without exposing secrets.
- Added `POST /api/llm/diagnostic` for one-off provider diagnostics using non-secret runtime payload overrides.
- Added `LLM_TIMEOUT_SECONDS` support in backend configuration and documentation.
- Diagnostic responses report `mock`, `ok`, or `error` status and never return the API key.
- Backend provider tests are part of the current 146-test baseline.

### GitHub issue #17 (2026-05-29)

- Added `AgentProposal` persistence for high-impact clarify, plan, and breakdown outputs.
- Clarify/plan/breakdown agent endpoints now return `proposal_id` and do not directly mutate project state.
- Added `GET /api/agent-proposals`, `GET /api/agent-proposals/{proposal_id}`, `POST /api/agent-proposals/{proposal_id}/confirm`, and `POST /api/agent-proposals/{proposal_id}/reject`.
- Confirming an agent proposal persists the payload to `Project.direction_card`, `Stage`, or `Task` records depending on proposal type.
- Confirmation updates the source `AgentEvent.user_confirmed` and creates timeline evidence.

## Verification Baseline

Latest verification baseline after the #21 verification pass:

```bash
cd backend
.venv\Scripts\python -m pytest app/tests/ -v
```

```bash
cd frontend
npm run test
npm run lint
npm run build
npm audit --omit=dev
```

Results:

- Backend: 166 tests passed (MVP suite + usability pass + LLM diagnostics + agent proposal confirmation + agent workflow + seed/reset/export).
- Frontend tests: 10 passed across 5 files (API layer, project dashboard, home page, action card, task status update).
- Frontend lint passed.
- Frontend build passed.
- Frontend audit passed with 0 vulnerabilities.

## Current Implementation Surface

Backend:

- Implemented routes: 70 endpoint method/path pairs covering health, LLM diagnostics, users, workspaces, invitations, member-profiles, projects, resources, stages, tasks, workspace-state, agent, agent-proposals, assignments, action-cards, check-ins, risks, replans, seed/reset, timeline, export, and demo reset.
- Domain models/persistence tables implemented (19 tables, all enums).
- AgentEvent now records `status` for success, repaired, fallback, or failed agent runs.
- AgentProposal stores pending clarify/plan/breakdown outputs; confirmation persists to project state.
- Service layer implemented for all CRUD domains plus assignment, action-card, check-in, risk, replan, agent-flow orchestration, and agent-proposal confirm/reject.
- Pydantic schemas implemented for all CRUD and execution-loop domains.
- WorkspaceState endpoint returns members, project, stages, tasks for Agent consumption.
- Agent infrastructure can run with `LLM_PROVIDER=mock` by default, or OpenAI-compatible chat-completions settings through environment variables. Agent HTTP endpoints persist structured outputs and created entity IDs through service-layer writes.

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
- UI components use shadcn/ui with project color tokens. Form components unified through FormField wrapper (label + input + error + hint).

### Phase 17 — Code Review Hardening (2026-05-30)

### Phase 19 — Agent Prompt Refactor (2026-05-31)

- `prompts.py` rewritten: replaced 8 module-level `user_prompt` strings with centralized `OUTPUT_CONTRACT_BY_EVENT_TYPE` dict defining precise JSON schema requirements per event type.
- Added `_compact_member()` / `_compact_workspace_state_json()` for differential workspace state serialization (e.g., assign needs member IDs + interests, clarify doesn't; breakdown/push/checkin/risk/replan only serialize current stage tasks).
- Added `_without_none()` recursive None-value stripping to reduce token consumption.
- `build_prompt_messages()` unified: system + user message with `<output_schema>` and `<workspace_state>` XML tag isolation.
- `workflow.py`: added `_fallback_after_provider_error()` for provider timeout/connection errors; `_max_tokens_for_event_type()` per-event-type token limits (900-1600); rewritten `_repair_json_text()` with layered repair (original → code block strip → JSON extract → trailing comma → single-quote → regex key/value).
- `llm_client.py`: added 5 error subclasses (`LLMConfigurationError`, `LLMAuthError`, `LLMTimeoutError`, `LLMConnectionError`, `LLMResponseError`) with `provider` and `detail` attributes; added `build_agent_llm_client()` factory using `llm_agent_timeout_seconds` (120s) for Agent generation vs `llm_timeout_seconds` (30s) for diagnostics.
- `config.py`: added `llm_agent_timeout_seconds: PositiveFloat = 120.0`.
- `project_service.py`: added `normalize_direction_card()` for field name migration (`target_users/core_value/constraints/out_of_scope/initial_risks` → `users/value/boundaries/risks/suggested_questions`).
- `workspace_state_service.py`: complete `get_workspace_state()` implementation with JSON deserialization helpers.
- `workspace_state.py` schemas: defined `MemberState`, `StageState`, `TaskState`, `ProjectState`, `WorkspaceStateResponse`.
- Frontend: `api.ts` timeout 120s with `AbortController`, JSON parse protection; `types.ts` DirectionCard fields aligned; `constants.ts` homepage static data.
- New test files: `action-card.test.tsx`, `task-status-update.test.tsx`.
- Backend test additions: `test_agent_workflow.py`, `test_llm_provider.py`, `test_seed_reset_export.py` expanded.

### Phase 20 — Test Docs + User Switcher (2026-05-31)

- Added `docs/T23/` with 4 test documents (T23.A cold-start + planning, T23.B assignment + negotiation, T23.C execution + check-in, T23.D risk + replan + export) covering the full MVP flow with step-by-step instructions, verification checklists, and horizontal evaluation criteria.
- Added user identity switcher in navigation bar: `useCurrentUserId()` / `setCurrentUserId()` / `setWorkspaceMembers()` in `app-shell.tsx` using `useSyncExternalStore` + localStorage.
- Project dashboard `currentUserId` now reads from localStorage (user switcher) with fallback to `project.created_by`.
- Project page auto-populates workspace members into localStorage on load, enabling the switcher dropdown.
- Test documents updated to reference the user switcher instead of API-based multi-member operations.

### Phase 22 — Agent Output Quality + Bug Fixes (2026-06-03)

T23.C full verification with real LLM (DeepSeek V4-pro) drove 4 blocking bugs to resolution and unified Agent output quality across all modules.

**Blocking bugs fixed (4):**

- **BUG-004 (sign-in analysis can't detect blocker)**: `_compact_workspace_state_json` now serializes `checkin_responses` for checkin events. `workflow.py:_max_tokens_for_event` increased 2-4x (checkin 900→4000, etc.) to accommodate reasoning model `reasoning_tokens` overhead. `output_schemas.py:RiskProposal.evidence` relaxed from `list[dict]` to `list[str | dict]` to match LLM output behavior. `checkin_analysis.py` fallback now dynamically detects blockers from workspace state.
- **BUG-005 (manual task status update doesn't change Task.status)**: `create_status_update` now accepts `task_id` as a positional parameter and synchronizes `Task.status` in the same transaction. `TaskStatusUpdateCreate` schema removed the `task_id` field (set by route from URL path). Call sites in `agent_flow_service.py` and `routes_tasks.py` adapted.
- **BUG-008 (Agent uses raw IDs in user-facing text)**: `AGENT_SYSTEM_PROMPT` now mandates "Never use raw IDs — use member display names and task titles". `_compact_member` gained `include_name` parameter: push/checkin/risk/replan now include `name` (display_name) in workspace state. Checkin responses serialized with `member_name` + `task_title` instead of bare `user_id`/`task_id`. All module `user_prompt`s (active_push, checkin_analysis, risk_analysis, replanning) updated to forbid internal IDs in visible text.
- **BUG-009 (Agent output mixed Chinese/English)**: `AGENT_SYSTEM_PROMPT` now requires "ALL user-facing text MUST be written in Chinese". `OUTPUT_CONTRACT` push entry and all module `user_prompt`s (active_push, risk_analysis, replanning) explicitly added this requirement.

**Frontend improvements:**

- Action card allocation simplified from type-whitelist to user_id-based: cards with no `user_id` always go to team panel; cards with `user_id` always go to personal panel. `TEAM_CARD_TYPES` whitelist removed.
- `ActionCardItem` gained `canOperate` prop (default true); team actions panel passes `canOperate={isCreator}` for permission gating.

**Documentation:**

- `Bug.md` created in repo root with all identified bugs (BUG-001 through BUG-009), root cause analysis, fix records, and fix status. BUG-002 and BUG-003 removed (superseded); bugs renumbered to close gaps.

Full codebase review identified 56 issues across backend and frontend. Fixed 18 issues (all P0/P1/P2 that were confirmed real), leaving 2 P0 + 9 P1 + 10 P2 for post-MVP.

Fixes applied:

- **Transaction atomicity**: `workspace_service`, `invitation_service`, `agent_flow_service`, `assignment_service` now use `flush()` + single `session.commit()` instead of multiple independent commits. Sub-service functions accept `auto_commit=False` to let callers control transaction boundaries.
- **Double JSON serialization**: Removed redundant `json.dumps()` calls in `member_profile_service` (skills), `risk_service` (evidence), and `project_service` (direction_card) that produced corrupted escaped strings like `"\"skill\""`.
- **SecretStr for config**: `llm_api_key` in `core/config.py` changed from `str | None` to `SecretStr | None`; `llm_timeout_seconds` changed to `PositiveFloat`. `llm_client.py` and `llm_service.py` updated to use `.get_secret_value()`.
- **Diagnostic request hardening**: `POST /api/llm/diagnostic` no longer accepts runtime `api_key` payloads; real-provider checks must use `LLM_API_KEY` from environment config.
- **Demo admin guard**: destructive seed/reset/demo-reset endpoints remain open in development, but require `X-ProjectFlow-Admin-Token` matching `DEMO_ADMIN_TOKEN` outside development.
- **Prompt injection protection**: `prompts.py` wraps `workspace_state` JSON in XML tags (`<workspace_state>...</workspace_state>`) to isolate user data from LLM instructions.
- **Fallback safety**: `assignment_recommendation`, `active_push`, `assignment_negotiation`, and `checkin_analysis` modules now return empty lists instead of payloads with `None` IDs when fallback data is incomplete.
- **Schema type tightening**: `skills: list | dict` → `list[str | dict]`, `evidence: list | dict` → `list[str | dict]`, `dependency_ids: dict | list` → `list[str]`, `acceptance_criteria: dict | list` → `list[str]`, `done_criteria: dict | list` → `list[str]`, `available_hours_per_week: int` → `float`.
- **Global error handler**: `main.py` adds `@app.exception_handler(Exception)` to prevent stack trace leaks, CORS middleware tightened to explicit methods/headers, lifespan error handling added.
- **Database session safety**: `get_session()` in `core/database.py` now has explicit `session.rollback()` on exception before re-raising.
- **JSON repair in workflow**: `_repair_json_text` rewritten with layered approach: try original → try brute single-quote replacement → try regex key/value replacement. Trailing comma cleanup added.
- **LLM error propagation**: `workflow.py` now catches `LLMError` separately and re-raises it to ensure network errors reach the fallback path.
- **Frontend request safety**: `api.ts` `request<T>` now uses `AbortController` with 30s timeout, JSON parse protection, and proper headers merging. `acceptInvitation` and `finalizeAssignments` now pass their actual parameters.
- **Shared utility**: `core/db_utils.py` extracted `require_row()` to replace duplicated `_require` functions across 6 service files.
- **Invitation accept**: `accept_invitation` now accepts `user_id` parameter; creates a User record when no user_id is provided instead of using a placeholder.

Verification: backend 146/146 tests pass, frontend build passes.

Unfixed issues documented in `.trae/documents/code-review-unfixed-issues.md`.

## Next Work

Core MVP phase scope is complete. Phase 10 (UI Structural Fix) completed 2026-05-29; MVP Usable #16/#17/#18/#19/#20/#21 are complete. Phase 17 (Code Review Hardening) completed 2026-05-30. Phase 18 (Frontend Bugfix) completed 2026-05-30. Phase 19 (Agent Prompt Refactor) completed 2026-05-31. Phase 20 (Test Docs + User Switcher) completed 2026-05-31. Phase 22 (Agent Output Quality + Bug Fixes) completed 2026-06-03.

MVP Usable progress (see `.claude/epics/projectflow-mvp-usable-ready/`):
- ✅ #18 Prompt and Schema Quality Hardening (completed 2026-05-29)
- ✅ #20 Assignment, Push, Risk, and Replan Usability Pass (completed 2026-05-29)
- ✅ #16 Real LLM Provider Readiness and Diagnostics (completed 2026-05-29)
- ✅ #17 Agent Output Persistence and Confirmation (completed 2026-05-29)
- ✅ #19 Frontend Agent Status and Review UX (completed 2026-05-30)
- ✅ #21 Real-Provider Verification and MVP Usable Runbook (completed 2026-05-30)

All MVP Usable tasks are complete. The runbook now documents mock mode, real-provider mode, a full manual verification checklist, and a final status report.

Post-MVP: auth, deployment, collaboration permissions, broader UI hardening, remaining code review issues (documented in `.trae/documents/code-review-unfixed-issues.md`), and outstanding bugs (see `Bug.md`).

## Local Cleanup Notes

Ignored install/build artifacts may exist locally after verification:

- `backend/.venv/`
- `backend/.pytest_cache/`
- Python `__pycache__/`
- `frontend/node_modules/`
- `frontend/.next/`

They are intentionally ignored and must not be committed.

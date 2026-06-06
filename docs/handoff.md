# ProjectFlow Handoff

Status: current as of 2026-06-06.

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

### Phase 35 — Onboarding & Member Form Improvements (2026-06-05, PR #33)

Frontend UX improvements for onboarding and member management forms.

**Changes:**
- Popular skill click now fills the input field (user chooses level before adding) instead of auto-adding at Lv.3.
- Member management dialog (`MemberManagementDialog`) added 4 new fields: 专业, 年级, 偏好工作时段 (required), 过往项目.
- `MemberProfileWizard` "偏好工作时段" required validation aligned with onboarding path.
- Available hours input changed from `type="number"` to `type="text"` + `inputMode="numeric"` + custom up/down stepper buttons, eliminating browser scientific-notation interference with `e` character.
- New frontend fields (major, grade, pastProjects) are collected but not persisted to backend (no backend schema fields yet). `preferredTime` maps to `collaboration_preference`; `pastProjects` falls back to `interests` when interests is empty.

**Files modified:** `frontend/src/components/member/member-management-dialog.tsx`, `frontend/src/components/onboarding/member-profile-wizard.tsx`.

### Phase 36 — File Upload, Resource Management & Project Deletion (2026-06-06)

Full resource lifecycle management with file upload support and project deletion.

**Changes:**

**File Upload:**
- New `POST /api/uploads` endpoint accepting `multipart/form-data`, requires `python-multipart`.
- Uploaded files stored in `backend/data/uploads/` with UUID-based filenames, server returns absolute `saved_path`.
- Frontend `uploadFile()` in `api.ts` sends `FormData`; file-input components in `resource-input-panel.tsx` and `project-resources-panel.tsx` auto-upload on selection and store returned path.
- Agent `_read_resource_file()` in `prompts.py` reads uploaded file content (up to 8000 bytes) via absolute path and includes it as resource `summary` for clarify/plan/breakdown.

**Resource Management:**
- New `DELETE /api/resources/{resource_id}` — deletes resource record and removes uploaded file from disk (only for files under `uploads/` directory, not externally-referenced paths).
- Resource `title` field auto-fallback: empty string → file name → URL → "未命名资源".
- Resource schema validator converts empty strings to `None` for optional fields (`content_text`, `file_name`, `url`), preventing 422 errors from frontend form submissions.
- Project overview resource panel now supports file upload via "选择文件" button + delete via hover-X button.
- New-project dialog resource panel (collapsible form) supports file upload, auto-fills title from original filename.
- New-project dialog width increased to full-screen (`!max-w-none w-[45vw]`).

**Project Deletion:**
- New `DELETE /api/projects/{project_id}` endpoint — cascading delete of all child data (stages, tasks, assignments, check-ins, risks, action cards, agent events, agent proposals, resources).
- Frontend project list in workspace-content shows delete button (trash icon) on hover, with AlertDialog confirmation (shadcn/ui). Delete failure shows inline error message with retry guidance.
- Deleted projects also remove associated uploaded files from disk.

**Workspace UI Fixes (PR #36 + follow-up, 2026-06-06):**
- "查看项目" StatCard action fixed: was opening new-project dialog, now navigates to first active project.
- "查看归档" StatCard action fixed: was opening new-project dialog, now navigates to first completed project.
- Direction card text overflow: added `break-all` to all list items in `DirectionDecisionView` and `DirectionCardPanel`; "边界" section changed from `Badge` to `<ul><li>` list for long text.

**Agent File Reading:**
- `_read_resource_file()` searches absolute path first, then falls back to `backend/data/uploads/` and `D:\ProjectFlow_Agent` directories by base filename.
- File content injected as resource `summary` (limited to 8000 bytes) when `content_text` is empty.

**Other Fixes:**
- `ProjectResourcesPanel` select dropdown now closes on page scroll to prevent floating popover in dialog.
- Resource form confirms trigger auto-title fill when title is empty.

**Files modified:** `backend/app/api/routes_resources.py`, `backend/app/api/routes_uploads.py` (new), `backend/app/api/routes_projects.py`, `backend/app/services/resource_service.py`, `backend/app/services/project_service.py`, `backend/app/schemas/resource.py`, `backend/app/agent/prompts.py`, `backend/app/main.py`, `frontend/src/lib/api.ts`, `frontend/src/components/project/resource-input-panel.tsx`, `frontend/src/components/project/project-resources-panel.tsx`, `frontend/src/components/project/new-project-dialog.tsx`, `frontend/src/components/project/workspace-content.tsx`, `frontend/src/components/project/project-intake-form.tsx`, `frontend/src/components/project/project-content.tsx`, `frontend/src/components/project/workspace-layout.tsx`, `frontend/src/app/workspaces/[workspaceId]/page.tsx`, `frontend/src/components/ui/select.tsx`, `frontend/src/components/agent/direction-card-panel.tsx`, `frontend/src/components/agent/direction-decision-view.tsx`.

### Phase 29 — Agent Output Quality & Reliability Hardening (2026-06-05)

- WorkspaceState now includes `current_date`, `current_datetime`, and `timezone`; prompts inject them inside `<time_info>` so Agent runs can reason about deadlines and cycles against the current date.
- Project resources now enter Agent workspace context for clarify/plan/breakdown through compact resource summaries.
- Direction clarification output supports richer structured fields: `source_summary`, `assumptions`, `unknowns`, `mvp_boundary`, and `decision_points`; frontend `DirectionDecisionView` renders these sections.
- `AssignmentNegotiationOutput` no longer creates a generic `AgentProposal`; negotiate output is kept in AgentEvent timeline only, while concrete assignment negotiation remains owned by the assignment flow.
- Active push and unchanged replan fallback text is Chinese and project-aware.
- Proposal and Agent sidebar UI show generation status badges: success / repaired / fallback / failed.
- Tests added for time/resource prompt context, Chinese fallback, negotiate timeline-only behavior, and proposal status badges.
- Verification baseline: 221 backend / 26 frontend; frontend lint, build, and audit pass.

### Phase 26 — T23.B Round 2 Fixes (2026-06-03, GitHub #31)

- Skill name Chinese mapping: `SKILL_NAME_CN_MAP` in common.py (12 English→Chinese), `_normalize_user_facing_text()` post-processing in output_schemas.py, assignment_recommendation prompt guidance.
- JSON strictness: temperature lowered from 0.2→0.05, explicit JSON format in system prompt.
- Negotiate Agent endpoint: `POST /api/agent/negotiate` backend + `runAgentNegotiate()` frontend.
- Stage override for assign: `AgentFlowRequest.stage_id` allows non-active stage, `assignable_tasks()` accepts stage_id override, coordinator deep-copies workspace_state with overridden current_stage_id.
- Test isolation: conftest.py forces `LLM_API_KEY=""` to prevent real .env leakage.
- Negotiation module rewrite: `build_request()` injects rejection/negotiation context, fallback uses real rejected proposal data, fixes `current_owner_user_id` fallback bug.
- Documentation aligned: T23.B.md seed counts, handoff, runbook, CLAUDE.md, AGENTS.md, README.md updated. Phase 26 recorded.
- Test baseline: 218 backend / 24 frontend.

### Phase 31 — Onboarding Flow Critique Fixes (2026-06-04)

Applied `$impeccable` critique fixes to the onboarding flow (homepage → workspace → profile → project).

**Step indicator unification:**
- Added persistent 4-step `StepIndicator` to all onboarding pages: `onboarding/page.tsx`, `workspaces/new/page.tsx`, `onboarding/profile/page.tsx`, `projects/new/page.tsx`.
- Removed duplicate inner `StepIndicator` from `AccountSetupForm`, `WorkspaceCreateForm`, `MemberProfileWizard` to avoid double-rendering.

**Visual noise reduction:**
- Replaced uppercase eyebrow `text-xs font-bold uppercase tracking-[0.18em]` with `text-sm font-medium` on all 4 onboarding page headers.

**Profile wizard UX:**
- Added "跳过，稍后完善" skip button on every step of `MemberProfileWizard`; jumps directly to workspace dashboard.
- Success state now offers both "进入工作台" and "新建项目" actions.

**Form validation hardening:**
- Standardized blur validation across `MemberProfileWizard` (name, rolePreference, preferredTime).
- Made "所有者 ID" optional in `WorkspaceCreateForm` (placeholder: "选填，默认使用当前用户"), removing raw UUID exposure.

**Date picker clarity:**
- Added `CalendarIcon` to project intake deadline field for better affordance.

### Phase 32 — Route Unification & Workspace Navigation Fixes (2026-06-05)

**Onboarding flow simplification:**
- Removed Step 4 "Create Project" from onboarding wizard (3 steps: basic info → skills & experience → availability).
- After completing member profile, user lands directly at workspace dashboard — project creation happens inside the workspace via `NewProjectDialog`.
- Success state now shows only "进入工作台" action (removed duplicate "新建项目").

**Route unification:**
- Deleted `frontend/src/app/projects/[projectId]/page.tsx` and `frontend/src/app/projects/new/page.tsx`.
- `/workspaces/[workspaceId]` is now the sole dynamic route entry — three-column layout with unified state management.
- Project switching via `?project={id}` query param (no page navigation); view switching via `?view={view}`.
- `AppShell` navigation bar simplified: removed "新建项目" button to avoid duplication with `NewProjectDialog` in workspace content.

**WorkspaceLayout as unified entry:**
- Created `workspace-layout.tsx` as the central layout component for `/workspaces/[workspaceId]`.
- Manages `showWorkspace` / `selectedProjectId` state; renders `WorkspaceContent` (no project) or `ProjectContent` (project selected).
- `onClearSelectedProject` callback added to prevent `useEffect` conflict when navigating back to workspace.

**Null-safety hardening:**
- `ProjectSidebar`: `state.tasks ?? []`, `state.risks ?? []`, `state.members ?? []`, `state.memberships ?? []`, `state.member_profiles ?? []`, `state.workspace ?? {...}` guards throughout.
- `AgentSidebar`: `(state.timeline ?? []).slice(0, 5)` guard.
- `useRouter` null guard with `window.location.href` fallback in `NewWorkspaceDialog` callback.

**Documentation aligned:** CLAUDE.md, AGENTS.md, docs/code-wiki.md, docs/handoff.md updated. Routes table, navigation conventions, and component responsibility tables updated.

**Files deleted:** `frontend/src/app/projects/[projectId]/page.tsx`, `frontend/src/app/projects/new/page.tsx`.
**Files created:** `frontend/src/components/project/workspace-layout.tsx`.

---

### Phase 28 — Frontend Redesign Migration (2026-06-04)

Migrated frontend visual and layout foundation from `ProjectFlow_Frontend_Redesign` reference repo while preserving all existing backend-backed MVP flows.

**Visual foundation:**
- Replaced warm green tokens with blue/gold/cool-canvas design tokens in `globals.css`.
- Added `Instrument_Serif` (display) + `Inter` (body) font stack via `next/font/google`.
- Updated `tailwind.config.ts` with new color tokens, font variables, and animation presets.

**Layout migration:**
- `AppShell` redesigned with full-height behavior and simplified navigation.
- `/workspaces/[workspaceId]` changed from standalone dashboard to transition route: redirects to first project or new-project page.
- Project page migrated to three-column layout: `ProjectSidebar` (workspace/project nav), `ProjectContent` (center), `AgentSidebar` (right).

**New components:**
- `project-layout.tsx`, `project-sidebar.tsx`, `project-content.tsx`, `agent-sidebar.tsx` — three-column project layout.
- `new-project-dialog.tsx`, `workspace-content.tsx`, `new-workspace-dialog.tsx` — dialog-based creation flows.
- `compact-stat.tsx` — compact stat display component.
- `direction-decision-view.tsx` — direction card decision view.

**Preserved behavior:**
- All API calls, types, and backend integration unchanged.
- Agent proposal confirm/reject, assignment flow, check-in, risk, replan, action cards, export all functional.
- `setLastWorkspaceId`, `setCurrentUserId`, `setWorkspaceMembers`, localStorage sync preserved.
- Risk evidence Chinese rendering, replan proposal support, rejection reason display retained.

**Files modified:** `globals.css`, `tailwind.config.ts`, `layout.tsx`, `app-shell.tsx`, `projectflow-home.tsx`, `project-dashboard.tsx`, `projects/[projectId]/page.tsx`, `workspaces/[workspaceId]/page.tsx`, `agent-proposal-panel.tsx`, `direction-card-panel.tsx`, `api.ts`, `types.ts`, `api.test.ts`, `app-shell.test.tsx`, `package.json`.

**Files created:** `project-layout.tsx`, `project-sidebar.tsx`, `project-content.tsx`, `agent-sidebar.tsx`, `new-project-dialog.tsx`, `workspace-content.tsx`, `new-workspace-dialog.tsx`, `compact-stat.tsx`, `direction-decision-view.tsx`.

### Phase 27 — Code Review Hardening (2026-06-03, GitHub #31 review)

- `_normalize_user_facing_text`: `str.replace()` → `re.sub()` with ASCII word-boundary regex, preventing substring corruption (e.g. "redesign" → "reUI 设计").
- `_validate_references`: replaced inline reimplementation with `common.py` helpers (`active_stage_id`, `blocked_assignment_task_ids`, `assignable_tasks`, `rejected_assignment_pairs`), eliminating two-sources-of-truth drift.
- `_validate_references`: removed rejected-pair hard error that caused 500 when all members rejected a task (fallback picked best member → validation rejected that pair → unresolvable).
- `create_assignment_negotiation_from_proposal`: added `proposal.status == owner_rejected` gate.
- `score_member_for_task`: added Chinese constraint keywords (不可用/不能/避免/不想/不愿意/没空/冲突), fixed docstring (+1/word not +2).
- Assignment recommendation reason: resolves stage name from workspace_state instead of embedding raw stage_id.
- Negotiation no-rejection fallback: `fallback_current_owner` now uses actual task owner instead of defaulting to first member.
- `prompts.py`: `AgentEventType.assign` added to stage/task filter set so assign events only send active-stage data to LLM.
- `agent_flow_service.py`: Phase 27 briefly persisted `AssignmentNegotiationOutput` as AgentProposals; Phase 29 supersedes this by keeping negotiate output timeline-only because generic proposal confirmation cannot apply negotiation payloads.
- `_build_user_facing_assignment`: merged single-member and multi-member branches into unified flow with conditional fragments.
- `create_assignment_response` / `create_assignment_negotiation_from_proposal`: error messages use safe enum display (`.value`) and Chinese text.
- Test baseline: 218 backend / 24 frontend (unchanged, all passing).

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

Latest verification baseline after Phase 29:

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

- Backend: 221 tests passed (MVP suite + usability pass + LLM diagnostics + agent proposal confirmation + agent workflow + seed/reset/export + agent module tests + proposal confirm tests + time/resource prompt context + negotiate timeline-only regression).
- Frontend tests: 26 passed across 9 files (API layer, project dashboard, home page, app shell, action card, task status update, error boundaries, assignment flow panel, agent proposal status badge).
- Frontend lint passed.
- Frontend build passed.
- Frontend audit passed with 0 vulnerabilities.

## Current Implementation Surface

Backend:

- Implemented routes: 70 endpoint method/path pairs covering health, LLM diagnostics, users, workspaces, invitations, member-profiles, projects, resources, stages, tasks, workspace-state, agent, agent-proposals, assignments, action-cards, check-ins, risks, replans, seed/reset, timeline, export, and demo reset.
- Domain models/persistence tables implemented (19 tables, all enums).
- AgentEvent now records `status` for success, repaired, fallback, or failed agent runs.
- AgentProposal stores pending clarify/plan/breakdown/replan outputs; confirmation persists to project state.
- Negotiate agent output is timeline-only and does not create generic AgentProposal records.
- Service layer implemented for all CRUD domains plus assignment, action-card, check-in, risk, replan, agent-flow orchestration, and agent-proposal confirm/reject.
- Pydantic schemas implemented for all CRUD and execution-loop domains.
- WorkspaceState endpoint returns members, project, stages, tasks, assignment/check-in context, project resources, and current date/time/timezone for Agent consumption.
- Agent infrastructure can run with `LLM_PROVIDER=mock` by default, or OpenAI-compatible chat-completions settings through environment variables. Agent HTTP endpoints return `proposal_id` where applicable and persist structured outputs and created entity IDs through service-layer writes.

Frontend:

- Implemented routes: `/`, `/onboarding`, `/onboarding/profile`, `/workspaces/new`, `/workspaces/[workspaceId]` (transition route → project), `/projects/new`, `/projects/[projectId]`.
- Agent proposal panel and right Agent sidebar show whether each run succeeded, was repaired, used fallback, or failed.
- API base URL comes from `NEXT_PUBLIC_API_BASE_URL` or defaults to `http://localhost:8000/api`.
- All API calls go through `frontend/src/lib/api.ts`.
- All types defined in `frontend/src/lib/types.ts`.
- Navigation: 首页 / 工作台（自动检测 workspace ID）/ 新建项目。Onboarding 不再常驻导航。
- Project page uses three-column layout: `ProjectSidebar` (workspace/project nav), `ProjectContent` (center content), `AgentSidebar` (right panel).
- 首页智能重定向：有 workspace 记录则先验证该 workspace 是否仍存在于后端，存在则跳转工作台，不存在则自动清除 localStorage 记录并展示欢迎页 + "加载演示数据"按钮。
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

### Phase 22 — T23.A Feedback Fixes (2026-06-02)

Fixes applied from the T23.A test audit (see `docs/T23/T23.A.md`):

**Blockers fixed:**
- **Agent 提案拒绝 422** (`A-17`): `POST /agent-proposals/{id}/reject` body 改为可选，`reject_proposal()` 接受 `reason | None`，前端 `rejectAgentProposal()` 发送空 body 不再报错。
- **阶段计划确认后首个阶段 inactive** (`A-13/A-14`): `_persist_stage_plan()` 确认阶段计划时自动激活第一个 stage，并更新 `project.current_stage_id` + `project.status=active`。
- **项目资源面板缺失** (`A-9`): 新增 `ProjectResourcesPanel` 组件，项目仪表盘展示已有资源 + 添加资源表单（文本/链接），API 已新增 `addResource` 支持。

**Experience fixes:**
- **创建页不暴露原始 UUID** (`A-5`, `A-8`): `AccountSetupForm` 移除原始 user UUID 显示，`WorkspaceCreateForm` / `ProjectIntakeForm` 移除所有者 UUID 显示。
- **favicon 404** (`A-1`): 添加 `public/favicon.svg` + `layout.tsx` 引用。
- **导航 workspace 同步** (`A-17`): 项目页 `setLastWorkspaceId()` 在 workspace 变更时写入，`AppShell` 增加 localStorage 事件监听同步导航链接。
- **成员管理展示技能** (`A-6/A-7`): `MemberManagementDialog` 成员列表增加技能 badge 展示。
- **Agent fallback 中文** (`A-10/A-11`): `breakdown.py` / `clarification.py` / `planning.py` fallback 模板改为中文；`common.py` 新增 `project_name_or_default()` / `project_idea_or_default()` / `first_stage_name_or_default()` / `stage_windows()` 公共函数，fallback 阶段计划现在生成 3 个中文阶段。
- **方向卡项目状态更新** (`A-8`): 确认方向卡后 project.status 从 draft → active。

**Test additions:**
- `test_agent_modules.py`: Agent 模块 fallback 中文验证
- `test_agent_proposal_confirm.py`: 提案拒绝空 body 兼容、阶段激活验证
- `conftest.py`: 新增 Agent 模块测试 fixtures

### Phase 23 — Code Review Hardening (2026-06-02)

Code review of PR #28 identified and fixed 10 issues (2 Critical, 3 High, 5 Medium/Low):

**Critical/High fixes:**
- **isValidating 死代码** (`projectflow-home.tsx`): `setIsValidating(true)` 从未调用，首页 workspace 验证 loading 状态完全无效。修复：在验证前设置 `isValidating=true`。
- **AbortController.signal 未传递** (`projectflow-home.tsx`): `fetch(url)` 未传 `{ signal }`，cleanup 的 abort 是空操作。修复：传入 signal 并处理 AbortError。
- **confirmed_by 未校验** (`agent_proposal_service.py`): 传入不存在的 user ID 触发 IntegrityError → 500。修复：添加 `require_row(session, User, confirmed_by, "User")`。
- **rejection_reason 丢弃** (`agent_proposal_service.py`): reject 接口接收 reason 但不存储。修复：AgentProposal 模型新增 `rejection_reason` 列，reject 时持久化，API 响应包含该字段。
- **next-env.d.ts dev 路径**: 还原为 `.next/types/routes.d.ts`。

**Medium/Low fixes:**
- 资源面板：添加 aria-label、local error state、catch handler
- skill badge key：`key={skill.name}` → `key={name}-{level}-{i}` 避免重复
- account-setup-form：`listUsers` effect 添加 cleanup flag
- workspace-create-form：submit 时同时验证 step 0 和 step 1
- layout.tsx：metadata description 改为中文
- planning fallback：空 deliverables 加 `or` 兜底
- breakdown fallback：空 stage_id 改为 `"unassigned"`
- test conftest：confirm 测试 fixture 补齐 JSON serializer
- 新增测试：`test_confirm_plan_does_not_duplicate_active_stage`
- README：修复 `T23.A.feedback.md` 断链

### Phase 20 — Workspace Member Management (2026-05-31)

- 工作台成员管理: 列表查看、添加、编辑、删除成员。

### Phase 21 — Test Docs + User Switcher (2026-05-31)

- Added `docs/T23/` with 4 test documents (T23.A cold-start + planning, T23.B assignment + negotiation, T23.C execution + check-in, T23.D risk + replan + export) covering the full MVP flow with step-by-step instructions, verification checklists, and horizontal evaluation criteria.
- Added user identity switcher in navigation bar: `useCurrentUserId()` / `setCurrentUserId()` / `setWorkspaceMembers()` in `app-shell.tsx` using `useSyncExternalStore` + localStorage.
- Project dashboard `currentUserId` now reads from localStorage (user switcher) with fallback to `project.created_by`.
- Project page auto-populates workspace members into localStorage on load, enabling the switcher dropdown.
- Test documents updated to reference the user switcher instead of API-based multi-member operations.

### Phase 24 — Agent Output Quality + Bug Fixes (2026-06-03)

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

- `T23.C.feedback.md` created in `docs/T23/` with all identified bugs (BUG-001 through BUG-009), root cause analysis, fix records, and fix status. BUG-002 and BUG-003 removed (superseded); bugs renumbered to close gaps.

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

Verification: backend 218/218 tests pass; frontend 24/24 tests pass; frontend lint and build pass.

Unfixed issues documented in `.trae/documents/code-review-unfixed-issues.md`.

### Phase 25 — T23.D Feedback Fixes (2026-06-03)

T23.D feedback fixes closed the risk -> replan -> confirm/reject -> push/checkin/risk loop breakpoints found in `docs/T23/T23D.feedback.md`.

- Replan agent output now creates pending `AgentProposal(proposal_type="replan")` records and is confirmed/rejected through the same `/api/agent-proposals/{id}/confirm|reject` lifecycle as clarify/plan/breakdown.
- Confirming a replan proposal delegates to `confirm_replan()` in one transaction and can apply stage adjustments, task changes, and action cards; rejecting keeps project state unchanged.
- Replan fallback now derives a minimal actionable proposal from check-in blockers when evidence exists: at most one stage adjustment, one task change, and one risk-action card.
- Risk analysis prompt/contract allows up to 3 evidence-grounded risks, while empty-data fallback still returns no fabricated risks.
- Frontend risk cards show high-risk confirmation semantics, allow accepted -> resolved, and render structured evidence as readable Chinese without raw JSON/internal IDs.
- `ReplanDiff` displays the latest pending replan proposal with before/after, impact, reason, stage/task/action details, change-count badges, and confirm/reject controls.
- Agent timeline and run result UI show `success`, `repaired`, `fallback`, and `failed` distinctly.
- Review export renders enum values and structured evidence as readable Markdown without `None`/`null`/Python enum reprs.

Verification: backend 218/218 tests pass; frontend 24/24 tests pass; frontend lint and build pass.

### Phase 26 — T23.B Round 2 Feedback Fixes (2026-06-03)

T23.B second-round fixes after real LLM (GLM-5.1 via openai-compatible) re-testing. 6 IRs plus 2 follow-on items:

- **IR1 Skill name normalization**: `SKILL_NAME_CN_MAP` in `common.py` maps 12 English skill names to Chinese labels. `_normalize_user_facing_text()` in `output_schemas.py` replaces English underscores in assignment user-facing fields. Prompt updated to prefer Chinese labels.
- **IR2 JSON strictness**: `temperature` lowered from 0.2 to 0.05. System prompt strengthened with explicit JSON-only instruction.
- **IR3 Negotiate endpoint**: `POST /api/agent/negotiate` exposed in `routes_agent.py`. Frontend `runAgentNegotiate()` added to `api.ts`.
- **IR4 Stage override**: `AgentFlowRequest.stage_id` allows assignment recommendation for non-active stages. `assignable_tasks()` accepts `stage_id` override. Frontend `runAssignment()` accepts optional `stageId`.
- **IR5 Test isolation**: `conftest.py` forces `LLM_API_KEY=""` instead of popping env var, preventing real `.env` leakage into mock tests.
- **IR6 Documentation**: T23.B seed data counts aligned with actual demo seed.
- **P0 stage_id validation threading**: `coordinator.recommend_assignments()` copies workspace_state with `current_stage_id` overridden to target stage before passing to `_run()`, so `_validate_references` enforces rules against the correct stage.
- **P1 negotiation context**: `assignment_negotiation.build_request()` rewritten to include rejected proposals, reasons, preferred tasks, pending negotiations, and member summaries in the prompt. Fallback derived from actual rejected proposal data.
- **Negotiation fallback bugfix**: `current_owner_user_id` correctly set to `None` when preferred task is unassigned (was incorrectly falling back to `fallback_from_user`).

Verification: backend 218/218 tests pass; frontend 24/24 tests pass; frontend lint and build pass.

## Next Work

Core MVP phase scope is complete. Phase 10 (UI Structural Fix) completed 2026-05-29; MVP Usable #16/#17/#18/#19/#20/#21 are complete. Phase 17 (Code Review Hardening) completed 2026-05-30. Phase 18 (Frontend Bugfix) completed 2026-05-30. Phase 19 (Agent Prompt Refactor) completed 2026-05-31. Phase 20 (Workspace Member Management) completed 2026-05-31. Phase 21 (Test Docs + User Switcher) completed 2026-05-31. Phase 22 (T23.A Feedback Fixes) completed 2026-06-02. Phase 23 (Code Review Hardening) completed 2026-06-02. Phase 24 (Agent Output Quality + Bug Fixes) completed 2026-06-03. Phase 25 (T23.D Feedback Fixes) completed 2026-06-03. Phase 26 (T23.B Round 2 Fixes) completed 2026-06-03. Phase 28 (Frontend Redesign Migration) completed 2026-06-04.

### Phase 29 — UI Critique Fixes (2026-06-04)

Impeccable critique review of project sidebar and 8 views (overview/direction/stages/my-tasks/team-tasks/checkin/risks/retro). Score: 31/40 (Good).

**Fixes applied:**
- **Uppercase eyebrow removal (4 locations)**: `agent-sidebar.tsx` ("所有操作"/"最近活动" headers), `workspace-content.tsx` ("工作区" header), `new/page.tsx` ("ProjectFlow" brand text). Removed `uppercase tracking-wider` / `uppercase tracking-[0.18em]` per impeccable absolute ban on SaaS-template AI slop.
- **Ghost-card removal (3 locations)**: `workspace-content.tsx` StatCard `prominent` shadow removed; two Card components (`成员`/`项目` panels) shadow-sm removed. Border-only cards per impeccable rule (no border+shadow decoration).
- **Workspace noise reduction**: Removed "暂无其他工作区" gray placeholder text from sidebar workspace dropdown.
- **Disabled state clarity**: Sidebar disabled menu items now use `opacity-60` for clear visual distinction from active items.
- **Direction card description**: Updated from "项目目标和方向澄清" to "明确项目目标、边界和关键决策" for better first-time user comprehension.

**Verification**: frontend lint pass, frontend build pass.

### Phase 30 — Workspace Page Critique Fixes (2026-06-04)

Impeccable critique review of workspace page (`workspace-content.tsx`). Initial score: 25/40 (Acceptable); post-fix score: 30/40 (Good).

**Round 1 fixes applied:**
- **P0 — Native `<select>` replacement**: `member-management-dialog.tsx` skill level selector changed from native `<select>` to shadcn `<Select>` component for form consistency and keyboard accessibility.
- **P1 — Search/filter for members and projects**: Added `Input` search boxes to both members and projects panels with real-time filtering by name/role.
- **P1 — Member list click interaction**: Member `<li>` items now have `cursor-pointer` and `onClick` opening the member management dialog.
- **P2 — Technical placeholder fixed**: `project-intake-form.tsx` `createdBy` placeholder changed from "UUID of project creator" to "选填，默认使用当前用户".
- **P2 — Delete confirmation softened**: Copy changed from "此操作不可恢复" to "该成员的分工记录将保留，但无法再访问此工作区"; cancel button relabeled from "取消" to "保留成员".
- **Minor — activeProjects filter semantics**: Filter changed from `!== "completed"` to `=== "active"` for accurate "活跃项目" count.
- **Minor — StatCard visual hierarchy**: Removed redundant `prominent` prop from "活跃项目" and "已完成" cards; only "团队成员" remains prominent.
- **Minor — Dead state cleanup**: Removed unused `refreshKey` state and its setters from `WorkspaceContent`.
- **Accessibility**: Added `aria-label={`打开项目 ${p.name}`}` to project card buttons.

**Round 2 fixes applied:**
- **P2 — Error hint visual hierarchy**: All field-level errors in `member-management-dialog.tsx` now use unified `bg-destructive/10` background + `AlertTriangle` icon + rounded container, matching the dialog-level error style.
- **P2 — StatCard action links**: Added `action` prop to `StatCard`; "活跃项目" and "已完成" cards display "查看项目"/"查看归档" links when count > 0.
- **P3 — Skill badge truncation removed**: Member list in dialog now shows all skills (removed `.slice(0, 4)`); badge key deduplicated.
- **Minor — Uppercase eyebrow removed**: Workspace header "工作区" label no longer uses `uppercase tracking-wider`.
- **Minor — Ghost-card pattern eliminated**: Removed `shadow-sm` from `StatCard` (border-only); added explicit `bg-white` to project list buttons.
- **Minor — Header density improved**: Reduced `mb-8` to `mb-6`, tightened description margin, simplified default copy by removing "Agent" jargon.

**Verification**: frontend lint pass, frontend build pass (Next.js 16.2.6 + Turbopack).

MVP Usable progress (see `.claude/epics/projectflow-mvp-usable-ready/`):
- ✅ #18 Prompt and Schema Quality Hardening (2026-05-29)
- ✅ #20 Assignment, Push, Risk, and Replan Usability Pass (2026-05-29)
- ✅ #16 Real LLM Provider Readiness and Diagnostics (2026-05-29)
- ✅ #17 Agent Output Persistence and Confirmation (2026-05-29)
- ✅ #19 Frontend Agent Status and Review UX (2026-05-30)
- ✅ #21 Real-Provider Verification and MVP Usable Runbook (2026-05-30)

All MVP Usable tasks are complete. The runbook now documents mock mode, real-provider mode, a full manual verification checklist, and a final status report.

### Phase 35 — Onboarding & Member Form Improvements (2026-06-05, PR #33)

Frontend UX improvements for onboarding and member management forms.

**Changes:**
- Popular skill click fills input field instead of auto-adding at Lv.3.
- Member management dialog added major, grade, preferredTime (required), pastProjects fields.
- Available hours input: `type="number"` replaced with `type="text"` + `inputMode="numeric"` + custom stepper buttons.
- New fields map to existing backend fields (`preferredTime` → `collaboration_preference`; `pastProjects` → `interests` fallback). `major`/`grade` not persisted (no backend fields yet).

**Files modified:** `member-management-dialog.tsx`, `member-profile-wizard.tsx`.

### Phase 33 — Stage Plan Timeline Redesign (2026-06-05)

Redesigned `StagePlanBoard` from card grid to vertical timeline layout.

**Visual changes:**
- Timeline connector line with status icons (completed/check/active/risk/pending) per stage
- Current stage highlighted with `bg-primary/5` background and "当前" badge
- Relative time labels ("还剩 N 天"/"今天截止"/"已延期 N 天") with color-coded urgency
- Inline deliverable and task count (no separate cards)
- Date range displayed with `CalendarDays` icon

**Component structure:**
- Added internal helpers: `StageIcon`, `daysUntil`, `relativeTimeLabel`, `statusClass`, `statusLabel`
- Props unchanged: `stages`, `tasks`, `currentStageId`
- No new dependencies

**Verification:** frontend lint pass, TypeScript type check pass.

T23.A test audit completed (2026-06-02) with feedback documented in `docs/T23/T23.A.md`. 4 blockers, 7 experience issues, and 1 optimization identified. All 4 blocker issues fixed in Phase 22.

T23.B testing completed (2026-06-02 mock round 1, 2026-06-03 real LLM round 2). 8 issues found (B1-B8), 11 items fixed across two rounds (Phase 26). Remaining open: A-18 (真实 LLM 超时兜底链路待补测). T23.C feedback fixes are documented in `docs/T23/T23.C.feedback.md`. T23.D feedback fixes are implemented and documented in `docs/T23/T23D.feedback.md`; a full mock + real-LLM manual rerun of D1-D17 is still pending.

Post-MVP: auth, deployment, collaboration permissions, broader UI hardening, remaining code review issues (2 P0 + 9 P1 + 10 P2 documented in `.trae/documents/code-review-unfixed-issues.md`), and outstanding bugs/feedback tracked in `docs/T23/T23.C.feedback.md` and `docs/T23/T23D.feedback.md`.

## Local Cleanup Notes

Ignored install/build artifacts may exist locally after verification:

- `backend/.venv/`
- `backend/.pytest_cache/`
- Python `__pycache__/`
- `frontend/node_modules/`
- `frontend/.next/`

They are intentionally ignored and must not be committed.

### Phase 37 — My Tasks View Enhancements (2026-06-06)

Enhanced the "我的任务" (My Tasks) view to improve usability and eliminate nested HTML button hydration errors.

**Changes:**
- Removed hover requirement for quick actions on pending tasks; quick actions (start, complete, blocked) are now always visible.
- Added a "..." (MoreHorizontal) DropdownMenu to `TaskRow` for both pending and completed tasks, triggering "签到" (Checkin) and "更新任务状态" (Update Status) actions.
- Checkin and TaskStatusUpdate components are now rendered inside `Dialog` modals triggered by the DropdownMenu instead of inline blocks at the top of the view.
- Removed duplicated `DialogHeader` from the Checkin Dialog and simplified the internal `CheckInForm` title/description text.
- Unified the "Checkin" dialog style with the "Update Task Status" dialog style by restoring `<DialogHeader>` in the view component and simplifying the form component wrapper.
- Fixed HTML button nesting hydration error caused by `DropdownMenuTrigger asChild` conflicting with the Shadcn `Button` component by applying custom styles directly to the `DropdownMenuTrigger` instead of nesting `<Button>`.

**Files modified:** `project-task-views.tsx`, `checkin-form.tsx`, `button.tsx`, `dropdown-menu.tsx`.


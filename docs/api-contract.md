# ProjectFlow API Contract

Status: current as of 2026-06-06. All planned MVP endpoints are implemented; confirmation-to-persist flow for clarify/plan/breakdown/replan; negotiate agent output is timeline-only; Agent workspace context includes current time and project resources; structured assignment citations and action card fields; resource CRUD with file upload and delete; reject endpoint accepts empty body and persists rejection_reason; confirmed_by validated against User table; project delete cascades through all child data; file upload via multipart/form-data with server-side persistence.

This document records the implemented MVP API surface. Post-MVP ideas should be tracked in roadmap docs, not mixed into this contract.

The frontend API layer (`frontend/src/lib/api.ts`) uses implemented backend endpoints for account/workspace/project planning, agent execution, assignment, active push, check-in, risk/replan, timeline, demo reset, and review export.

## Base URL

```text
http://localhost:8000/api
```

## Implemented Endpoints

### Health

```http
GET /api/health
```

Response:

```json
{
  "status": "ok",
  "service": "projectflow-backend"
}
```

### LLM Diagnostics

```http
GET /api/llm/diagnostic
POST /api/llm/diagnostic
```

`GET` validates the currently configured provider settings. `POST` accepts an optional diagnostic override payload for non-secret provider settings. API keys are not accepted in the request body; set `LLM_API_KEY` in the backend environment.

```json
{
  "provider": "openai-compatible",
  "base_url": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "timeout_seconds": 30.0
}
```

Responses never include the API key. The diagnostic status is `mock`, `ok`, or `error`.

### Users

```http
POST /api/users
GET /api/users
GET /api/users/{user_id}
```

### Workspaces

```http
POST /api/workspaces?owner_user_id=...
GET /api/workspaces
GET /api/workspaces/{workspace_id}
POST /api/workspaces/{workspace_id}/members
DELETE /api/workspaces/{workspace_id}/members/{user_id}
```

`DELETE` removes both the workspace membership and the associated member profile.

### Invitations

```http
POST /api/invitations
POST /api/invitations/accept
```

### Member Profiles

```http
POST /api/member-profiles
GET /api/member-profiles/{profile_id}
PATCH /api/member-profiles/{profile_id}
GET /api/workspaces/{workspace_id}/profiles
```

### Projects

```http
POST /api/projects
GET /api/projects/{project_id}
GET /api/workspaces/{workspace_id}/projects
PATCH /api/projects/{project_id}
DELETE /api/projects/{project_id}
```

`DELETE /api/projects/{project_id}` returns 204. Server-side delete cascades through all child data (stages, tasks, assignments, check-ins, risks, action cards, agent events, agent proposals, resources) before removing the project itself. Uploaded resource files under `backend/data/uploads/` are also removed from disk.

### Resources

```http
POST /api/resources
GET /api/projects/{project_id}/resources
DELETE /api/resources/{resource_id}
```

`DELETE /api/resources/{resource_id}` returns 204. For `file_stub` resources pointing to files under `backend/data/uploads/`, the uploaded file is also removed from disk.

### File Upload

```http
POST /api/uploads
Content-Type: multipart/form-data
```

Accepts a single `file` field. Returns:

```json
{
  "file_id": "uuid.ext",
  "original_name": "document.md",
  "saved_path": "D:\\...\\backend\\data\\uploads\\uuid.ext"
}
```

Requires `python-multipart` package. Uploaded files are stored in `backend/data/uploads/`. The frontend file-input components automatically upload on selection and store the returned `saved_path` in the resource's `file_name` field. Agent prompts read uploaded file content (up to 8000 bytes) via `_read_resource_file()` and include it as the resource `summary`.

### Stages

```http
POST /api/stages
GET /api/stages/{stage_id}
GET /api/projects/{project_id}/stages
PATCH /api/stages/{stage_id}
```

### Tasks

```http
POST /api/tasks
GET /api/tasks/{task_id}
GET /api/stages/{stage_id}/tasks
GET /api/projects/{project_id}/tasks
PATCH /api/tasks/{task_id}
POST /api/tasks/{task_id}/status-updates
```

`POST /api/tasks/{task_id}/status-updates` records `status`, `progress_note`, `blocker`, and optional `available_hours_change`.

### Workspace State

```http
GET /api/workspaces/{workspace_id}/state
```

Returns the full workspace state needed by the Coordinator Agent: members, active project, stages, tasks, assignment/check-in context, project resources, and `current_date` / `current_datetime` / `timezone` for time-aware planning.

### Frontend Project State Composition

The project dashboard currently composes its `ProjectState` from implemented endpoints instead of relying on a dedicated project-state route:

- `GET /api/projects/{project_id}`
- `GET /api/workspaces/{workspace_id}`
- `GET /api/projects/{project_id}/resources`
- `GET /api/projects/{project_id}/stages`
- `GET /api/projects/{project_id}/tasks`
- `GET /api/users`
- `GET /api/workspaces/{workspace_id}/profiles`
- `GET /api/projects/{project_id}/assignment-proposals`
- `GET /api/projects/{project_id}/assignment-responses`
- `GET /api/projects/{project_id}/assignment-negotiations`
- `GET /api/projects/{project_id}/checkin-cycles`
- `GET /api/projects/{project_id}/risks`
- `GET /api/projects/{project_id}/action-cards`
- `GET /api/projects/{project_id}/timeline`

### Agent

All agent routes take a workspace-scoped request:

```json
{
  "workspace_id": "uuid"
}
```

The response shape is:

```json
{
  "event_type": "assign",
  "status": "fallback",
  "attempts": 2,
  "used_fallback": true,
  "output": {},
  "created_ids": ["uuid"],
  "proposal_id": "uuid | null"
}
```

Implemented routes:

```http
POST /api/agent/clarify
POST /api/agent/plan
POST /api/agent/breakdown
POST /api/agent/assign
POST /api/agent/negotiate
POST /api/agent/active-push
POST /api/agent/check-in-analysis
POST /api/agent/risk-analysis
POST /api/agent/replan
```

Agent outputs are validated before persistence. Clarification, stage planning, task breakdown, and replan outputs create `AgentProposal` records (pending confirmation) instead of directly mutating project state. Assignment, active-push, check-in-analysis, and risk-analysis endpoints persist their validated proposals or records through services. Negotiate records the structured output in the AgentEvent timeline only; the concrete assignment negotiation records are owned by the assignment negotiation flow, not the generic AgentProposal confirm service. Replan proposals do not apply changes until they are confirmed through `/api/agent-proposals/{proposal_id}/confirm`, which delegates to the same deterministic replan service used by `/api/replans/confirm`.

The agent response includes `proposal_id` for clarify, plan, breakdown, and replan outputs; direct-persist or timeline-only events return `null`:

```json
{
  "event_type": "clarify",
  "status": "fallback",
  "attempts": 2,
  "used_fallback": true,
  "output": {},
  "created_ids": [],
  "proposal_id": "uuid"
}
```

### Agent Proposals (Confirm-to-Persist)

```http
GET /api/agent-proposals?project_id=...&proposal_type=...
GET /api/agent-proposals/{proposal_id}
POST /api/agent-proposals/{proposal_id}/confirm
POST /api/agent-proposals/{proposal_id}/reject
```

Agent proposals store pending high-impact agent outputs before human confirmation:

- `proposal_type`: `clarify` | `plan` | `breakdown` | `replan`
- `status`: `pending` → `confirmed` | `rejected`

Confirming a proposal persists its payload to project state:
- `clarify` → updates `Project.direction_card`
- `plan` → creates `Stage` records
- `breakdown` → creates `Task` records
- `replan` → applies confirmed stage adjustments, task changes, and action cards through `confirm_replan()`

Confirming also marks the source `AgentEvent.user_confirmed = True` and records a confirmation timeline event with the source event ID.

The `confirm` endpoint validates `confirmed_by` against the `users` table and returns 400 for non-existent user IDs. The `reject` endpoint accepts an optional `reason` field persisted as `rejection_reason` on the proposal record.

The proposal response includes `rejection_reason` (string | null) when a proposal has been rejected with a reason.

### Assignments

```http
POST /api/assignment-proposals
GET /api/assignment-proposals/{proposal_id}
GET /api/projects/{project_id}/assignment-proposals
POST /api/assignment-proposals/{proposal_id}/responses
POST /api/assignment-proposals/{proposal_id}/finalize
POST /api/stages/{stage_id}/assignments/finalize
POST /api/assignment-negotiations
GET /api/projects/{project_id}/assignment-responses
GET /api/projects/{project_id}/assignment-negotiations
```

Rules:

- Assignment proposals start as `proposed`.
- Only the recommended owner can accept or reject a proposal.
- Task owner and backup owner are updated only after an `owner_confirmed` proposal is finalized.
- Negotiation records are proposals/coordination messages; they do not directly overwrite task ownership.
- Assignment proposals include structured citation fields: `skill_match`, `availability_match`, `preference_match`, `constraint_respected` (all optional, populated by Agent when available).

### Action Cards

```http
POST /api/action-cards
GET /api/projects/{project_id}/action-cards
PATCH /api/action-cards/{card_id}
```

Action cards must include `reason`. Agent-created active push cards include optional `goal`, `start_suggestion`, and `completion_standard` fields specifying what the card achieves, how to start, and how to know it's done. Cards are persisted through the agent active-push endpoint.

### Check-ins

```http
POST /api/checkin-cycles
GET /api/projects/{project_id}/checkin-cycles
POST /api/checkin-cycles/{cycle_id}/responses
GET /api/checkin-cycles/{cycle_id}/responses
```

Check-in cycles store `cadence_days`, `start_date`, and computed `next_due_date`. Responses capture `what_done`, optional `blocker`, optional `available_hours_next_cycle`, and optional `mood_or_confidence`.

### Risks

```http
POST /api/risks
GET /api/projects/{project_id}/risks
PATCH /api/risks/{risk_id}
```

Risk records require non-empty `evidence`. Risk types include deadline, dependency, workload, scope, review, assignment, and check-in.

### Replans

```http
POST /api/replans/confirm
```

The confirmation request includes `before`, `after`, `impact`, `reason`, `requires_confirmation`, and proposed stage/task/action-card changes. The service applies task and stage changes only when `requires_confirmation` is true. Changing `owner_user_id` on a task with a finalized assignment proposal is rejected — the assignment must be rejected first.

### Timeline

```http
GET /api/projects/{project_id}/timeline
```

Returns persisted agent events, including fallback and export events.

### Seed and Reset

```http
POST /api/seed/demo
POST /api/seed/reset
```

`POST /api/seed/demo` loads deterministic demo seed data (6-member team, project, stages, tasks, assignments, check-ins, risks, action cards, agent events). It resets existing data first to ensure a clean state.

`POST /api/seed/reset` deletes all rows from all tables. Use for a clean demo reset.

Seed/reset endpoints are open only in `APP_ENV=development`. Outside development, callers must send `X-ProjectFlow-Admin-Token` matching `DEMO_ADMIN_TOKEN`; if no token is configured, these endpoints are disabled.

### Export

```http
POST /api/projects/{project_id}/export/review-summary
```

Returns:
Response:

```json
{
  "markdown": "# ProjectFlow 评审摘要\n..."
}
```

Generates a review-ready Markdown summary covering product positioning, current state, risks, replanning, and next actions. The export is generated from persisted project state and logs an `export` timeline event.

### Demo

```http
POST /api/demo/reset
```

Compatibility endpoint for the frontend reset button. It resets and reloads the deterministic demo state, then returns the created workspace, project, user, stage, and task IDs for manual review.

### LLM Diagnostic

```http
POST /api/llm/diagnostic
```

Optional request body:

```json
{
  "provider": "openai",
  "base_url": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "timeout_seconds": 30.0
}
```

`api_key` is intentionally rejected in this payload. Configure `LLM_API_KEY` in the backend environment before running real-provider diagnostics.

Response (never includes API key):

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "base_url": "https://api.openai.com/v1",
  "status": "ok",
  "detail": "Provider responded successfully"
}
```

`status` values: `"ok"` (provider reachable), `"error"` (auth/timeout/connection/response failure), `"mock"` (mock provider, no connectivity check needed).

Security: API key values are never returned in the response, logged, or stored in timeline snapshots.

## Planned MVP Endpoints

None remaining — all planned MVP endpoints are now implemented.

## Contract Rules

- API route handlers only handle request and response wiring.
- Business behavior belongs in `backend/app/services`.
- Request and response bodies must go through Pydantic schemas in `backend/app/schemas`.
- Agent output must be structured and validated before a service persists it.
- High-impact Agent suggestions must return proposals and wait for explicit confirmation before final state changes.

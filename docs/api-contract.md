# ProjectFlow API Contract

Status: current as of 2026-05-29.

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
```

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
```

### Resources

```http
POST /api/resources
GET /api/projects/{project_id}/resources
```

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

Returns the full workspace state (members, project, stages, tasks) needed by the Coordinator Agent.

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
  "created_ids": ["uuid"]
}
```

Implemented routes:

```http
POST /api/agent/clarify
POST /api/agent/plan
POST /api/agent/breakdown
POST /api/agent/assign
POST /api/agent/active-push
POST /api/agent/check-in-analysis
POST /api/agent/risk-analysis
POST /api/agent/replan
```

Agent outputs are validated before persistence. Assignment, active-push, check-in-analysis, and risk-analysis endpoints persist their validated proposals or records through services. Replan returns a proposal and does not apply changes until `/api/replans/confirm`.

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

### Action Cards

```http
POST /api/action-cards
GET /api/projects/{project_id}/action-cards
PATCH /api/action-cards/{card_id}
```

Action cards must include `reason`. Agent-created active push cards are persisted through the agent active-push endpoint.

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

The confirmation request includes `before`, `after`, `impact`, `reason`, `requires_confirmation`, and proposed stage/task/action-card changes. The service applies task and stage changes only when `requires_confirmation` is true.

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
  "api_key": "sk-...",
  "base_url": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "timeout_seconds": 30.0
}
```

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

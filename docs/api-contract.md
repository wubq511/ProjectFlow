# ProjectFlow API Contract

Status: current as of 2026-07-06. All planned MVP endpoints are implemented; confirmation-to-persist flow for clarify/plan/breakdown/replan; negotiate agent output is timeline-only; Agent workspace context includes current time and project resources; structured assignment citations and action card fields; resource CRUD with file upload and delete; reject endpoint accepts empty body and persists rejection_reason; confirmed_by validated against User table; project delete cascades through all child data; file upload via multipart/form-data with server-side persistence; workspace creation accepts team_size and use_case; T41 internal agent-tool and agent-run endpoints require service-to-service Bearer auth.

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

`POST /api/workspaces` request body:

```json
{
  "name": "2024 春季开发小队",
  "description": "团队描述",
  "team_size": 3,
  "use_case": "course"
}
```

- `name` (required): non-empty string
- `description` (optional): nullable string
- `team_size` (optional): integer, parsed from UI selection ("1-2"→1, "3-5"→3, "6-10"→6, "10+"→10)
- `use_case` (optional): string, one of "course", "competition", "startup", or free-text when "other"

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
  "original_name": "document.md"
}
```

Requires `python-multipart` package. Uploaded files are stored in `backend/data/uploads/` under UUID-based filenames. The frontend file-input components automatically upload on selection and store the returned `file_id` in the resource's `file_name` field. Agent prompts read uploaded file content (up to 8000 bytes) via `_read_resource_file()` and include it as the resource `summary`.

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

Returns the full workspace state needed by the current Coordinator Agent and future T41 read-only tools: members, active project, stages, tasks, assignment/check-in context, project resources, and `current_date` / `current_datetime` / `timezone` for time-aware planning.

### Project State

```http
GET /api/projects/{project_id}/state
```

Returns the aggregate project dashboard state. The frontend loads this aggregate endpoint first and falls back to split endpoints only if the aggregate route returns 404.

T41 note: ProjectState and WorkspaceState read paths are read-only state views. They must not repair or advance Stage/Project state as a side effect. Stale stage/project repair belongs in an explicit maintenance command/job.

Split fallback endpoints:

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
  "workspace_id": "uuid",
  "project_id": "uuid | null",
  "stage_id": "uuid | null",
  "conversation_id": "uuid | null",
  "user_instruction": "string | null"
}
```

`project_id` is optional for backward compatibility but should be provided by the project page so the Agent reads the selected project instead of the newest project in the workspace. `user_instruction` is optional for direct button-style calls and required by the conversation orchestrator when the user gives natural-language constraints such as "按三周倒排" or "优先保留 MVP 演示闭环". The instruction is injected into the Agent prompt inside a `<user_instruction>` XML block and is also recorded in the source `AgentEvent.input_snapshot`.

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
POST /api/agent/retrospective
```

Agent outputs are validated before persistence. Clarification, stage planning, task breakdown, and replan outputs create `AgentProposal` records (pending confirmation) instead of directly mutating project state. Assignment and active-push endpoints persist typed proposals or advisory records through services. Check-in analysis may persist Risk advisory records, but inferred task status changes are converted into pending `replan` proposals and do not call the human task status command path. Risk analysis persists Risk advisory records; mitigations that change task/stage/project state must go through replan confirmation. Negotiate records the structured output in the AgentEvent timeline only; the concrete assignment negotiation records are owned by the assignment negotiation flow, not the generic AgentProposal confirm service. Replan proposals do not apply changes until they are confirmed through `/api/agent-proposals/{proposal_id}/confirm`, which delegates to the same deterministic replan service used by `/api/replans/confirm`.

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

### Internal Agent Tools

Internal tool endpoints use the T41 unified envelope and are called by the sidecar, not by browser clients. They are mounted outside the public `/api` prefix.

```http
POST /internal/agent-tools/workspace-state
POST /internal/agent-tools/conversation
POST /internal/agent-tools/pending-proposals
POST /internal/agent-tools/timeline-slice
POST /internal/agent-tools/direction-card-proposal
POST /internal/agent-tools/stage-plan-proposal
POST /internal/agent-tools/task-breakdown-proposal
POST /internal/agent-tools/assignment-recommendation
POST /internal/agent-tools/checkins-and-risks-analysis
POST /internal/agent-tools/create-risk
POST /internal/agent-tools/create-checkin
POST /internal/agent-tools/replan-proposal
```

Every request requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` and accepts `run_id`, `tool_call_id`, `conversation_id`, `workspace_id`, `project_id`, `tool_name`, `tool_version`, `manifest_version`, `idempotency_key`, `arguments`, `client_event_id`, `ordering_hint`, and `trace`. Every response is a `ProjectFlowToolResult` with `status`, `data`, `error`, `side_effect_status`, `idempotency_key`, `links`, `observation`, and optional `trace`.

Read-only tools return `side_effect_status=no_side_effect`. Draft-only proposal tools (`direction-card-proposal`, `stage-plan-proposal`, `task-breakdown-proposal`, `replan-proposal`) persist pending `AgentProposal` rows and return `side_effect_status=proposal_persisted` plus `links.proposal_id`. Repeated calls with the same `idempotency_key` reuse the same proposal; proposal creation and idempotency metadata are committed in the same transaction. A different replan call is blocked with `status=blocked` and `side_effect_status=no_side_effect` if a pending replan already exists for the project.

`assignment-recommendation` persists typed `AssignmentProposal` draft records without writing `Task.owner_user_id`. `checkins-and-risks-analysis` persists advisory Risk/ActionCard records and returns replan signals for any primary-state mitigation. `create-risk` and `create-checkin` are direct advisory-write tools; they validate project/workspace relationships, return advisory side effects, and do not commit Primary Project State. Proposal confirmation/rejection remains on the public proposal API, not an internal agent tool. Unknown tools return `status=blocked`, `error.code=TOOL_NOT_FOUND`; disabled feature-flagged tools return `status=blocked`, `error.code=POLICY_DENIED`; unexpected tool crashes return `status=failed`, `side_effect_status=unknown`.

### Internal Agent Runs

The sidecar uses the internal runtime API to create runs and append persisted runtime events. These endpoints also require `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.

```http
POST /internal/agent-runs
GET /internal/agent-runs/{run_id}
GET /internal/agent-runs/{run_id}/events
POST /internal/agent-runs/{run_id}/events:append
POST /internal/agent-runs/{run_id}/cancel
```

### Agent Conversations

Conversation endpoints are the primary UI path for the project Agent sidebar. The frontend sends the user's natural-language message; the backend stores the conversation, asks the LLM for a structured turn plan, validates that plan against the deterministic workflow policy, optionally runs the selected Agent module with `user_instruction`, then returns messages and review metadata.

```http
GET /api/projects/{project_id}/agent-conversation
POST /api/agent/conversations/{conversation_id}/messages
```

`GET /api/projects/{project_id}/agent-conversation` returns or creates the active conversation:

```json
{
  "id": "uuid",
  "workspace_id": "uuid",
  "project_id": "uuid",
  "status": "active",
  "summary": "",
  "current_focus": "阶段计划",
  "messages": [],
  "created_at": "2026-06-06T00:00:00Z",
  "updated_at": "2026-06-06T00:00:00Z"
}
```

`POST /api/agent/conversations/{conversation_id}/messages` accepts:

```json
{
  "content": "把阶段计划压缩成 3 周，优先演示闭环"
}
```

The response includes the persisted user message, assistant message, optional `AgentRun`, optional `AgentTurnPlan`, and next suggestions:

```json
{
  "conversation": {},
  "user_message": {},
  "assistant_message": {
    "role": "assistant",
    "content": "阶段计划提案已生成，已放入待确认队列。你确认后我才会应用到项目。",
    "linked_event_id": "uuid",
    "linked_proposal_id": "uuid"
  },
  "run": {
    "selected_module": "plan",
    "status": "proposal_created",
    "user_instruction": "把阶段计划压缩成 3 周，优先演示闭环",
    "agent_event_id": "uuid",
    "proposal_id": "uuid"
  },
  "turn_plan": {
    "response_type": "run_module",
    "selected_module": "plan",
    "risk_level": "medium",
    "requires_confirmation": true
  },
  "next_suggestions": ["确认这个阶段计划", "要求改成更保守", "解释为什么这样分阶段"]
}
```

Policy gate behavior: the LLM may request a module, but the backend blocks invalid jumps. For example, `breakdown` is blocked until stages exist, `assign` is blocked until tasks exist, and `push` is blocked until finalized assignments exist. Blocked turns still persist user and assistant messages but do not create `AgentRun`, `AgentEvent`, or `AgentProposal`.

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

## Sidecar Model Configuration Endpoints

These endpoints are served by the agent-bridge sidecar (default `http://localhost:4000`), not the FastAPI backend.

### GET /config/models

List all model configurations (wire format, no API key values).

Response:
```json
{
  "models": [
    {
      "id": "deepseek-v4-flash",
      "provider": "deepseek",
      "name": "deepseek-v4-flash",
      "displayName": "DeepSeek V4 Flash",
      "apiKeyEnvVar": "DEEPSEEK_API_KEY",
      "apiKeySet": true,
      "apiKeySuffix": "abcd",
      "isDefault": true,
      "capabilities": { "thinking": true, "vision": false },
      "valid": true,
      "invalidReason": null
    }
  ]
}
```

`apiKeySuffix` shows last 4 chars only; short keys show `****`. `valid` is `false` when API key is missing or provider is unknown.

### POST /config/models

Add a new model configuration. Body is a `ModelConfigEntry` (id, provider, name, displayName, apiKeyEnvVar, isDefault, capabilities, optional baseUrl/baseUrlEnvVar).

### PUT /config/models/:id

Update an existing model configuration. Body is a partial `ModelConfigEntry` — only specified fields are updated. Unknown fields are silently ignored.

### DELETE /config/models/:id

Delete a model configuration by id.

### PUT /config/models/:id/api-key

Set the API key for a model. The key is written to `.env` under the entry's `apiKeyEnvVar` name and never stored in `model-configs.json`.

Request:
```json
{ "apiKey": "sk-..." }
```

Constraints: max 512 chars; newlines rejected; protected system env vars (PATH, HOME, etc.) rejected.

### POST /config/reload

Reload `model-configs.json` and `.env` from disk, then re-validate all entries. Use after manually editing config files.

### GET /config/providers/:provider/models

List Pi SDK catalog models for a known provider (e.g., `deepseek`, `xiaomi`, `openai`). Returns model IDs with reasoning/vision capability flags. Used by the frontend "add model" form to populate the model dropdown.

## Planned MVP Endpoints

None remaining — all planned MVP endpoints are now implemented.

## Contract Rules

- API route handlers only handle request and response wiring.
- Business behavior belongs in `backend/app/services`.
- Request and response bodies must go through Pydantic schemas in `backend/app/schemas`.
- Agent output must be structured and validated before a service persists it.
- High-impact Agent suggestions must return proposals and wait for explicit confirmation before final state changes.

# ProjectFlow Runbook

Status: current as of 2026-07-17.

## Prerequisites

- Python 3.11 or newer. The current scaffold was verified with Python 3.13.7.
- Node.js compatible with Next.js 16. Repository automation and Evaluation Lab are pinned to Node.js 24.15.0 and npm 11.12.1 through `scripts/project-npm`.
- PowerShell on Windows, or a POSIX shell on macOS/Linux.

## Backend Setup

```bash
cd backend
python -m venv .venv
```

Activate the virtual environment:

```powershell
.venv\Scripts\Activate.ps1
```

macOS/Linux:

```bash
source .venv/bin/activate
```

Install dependencies:

```bash
python -m pip install -e ".[dev]"
```

File upload support requires `python-multipart` (installed as part of `[dev]` above, or manually via `pip install python-multipart`). LLM client uses `httpx>=0.27.0` for connection pooling (installed as part of `[dev]` above).

### Optional Vector Retrieval (memory-vector extra)

默认安装使用 FTS5+jieba 中文分词检索，零外部依赖。如需向量检索增强：

```bash
python -m pip install -e ".[dev,memory-vector]"
```

预热向量模型（下载/缓存 embedding 模型到 `backend/data/memory-models/`）：

```bash
python -m app.memory.warmup
# 无 memory-vector extra → 打印跳过信息，exit 0
# 有 extra → 初始化模型，exit 0
# 初始化失败 → exit 1
```

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMORY_VECTOR_ENABLED` | `false` | 设为 `true` 启用向量检索优先路径 |
| `MEMORY_VECTOR_MODEL` | `shibing624/text2vec-base-chinese` | 中文 embedding 模型 |
| `MEMORY_VECTOR_MODEL_DIR` | 空（自动 `data/memory-models/`） | 模型缓存目录 |

详见 `docs/T42/memory-vector-optional.md`。

Run the API:

```bash
python -m uvicorn app.main:app --reload --port 8000
```

Health check:

```bash
curl http://localhost:8000/api/health
```

Expected response:

```json
{"status":"ok","service":"projectflow-backend"}
```

LLM provider diagnostic:

```bash
curl http://localhost:8000/api/llm/diagnostic
```

To test a real OpenAI-compatible provider without editing tracked files, send a one-off diagnostic payload for non-secret settings. Keep the API key in `.env`; do not commit or paste real keys into docs or logs.

```bash
curl -X POST http://localhost:8000/api/llm/diagnostic ^
  -H "Content-Type: application/json" ^
  -d "{\"provider\":\"openai-compatible\",\"base_url\":\"https://api.openai.com/v1\",\"model\":\"gpt-4o-mini\",\"timeout_seconds\":30.0}"
```

## Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

shadcn/ui components are pre-installed. To add more:

```bash
cd frontend
npx shadcn@latest add <component-name>
```

Open:

```text
http://localhost:3000
```

If port 3000 is occupied:

```bash
npm run dev -- --port 3001
```

## Verification

Backend:

```bash
cd backend
.venv\Scripts\python -m pytest app/tests/ -v
```

Frontend:

```bash
cd frontend
npm run test
npm run lint
npm run build
npm audit --omit=dev
```

Expected baseline as of 2026-07-17:

- Backend tests pass: 866 passed, 4 skipped; Ruff passes.
- Agent bridge tests pass: 1198 tests across 60 unit files; typecheck and build pass.
- Frontend tests pass: 333 passed, 6 skipped across 26 files.
- Frontend lint passes.
- Frontend production build passes.
- `npm audit --omit=dev` reports 0 vulnerabilities.

Known non-blocking warnings:

- Backend pytest may show a FastAPI/Starlette `TestClient` deprecation warning.
- Vitest may show a Vite CJS Node API deprecation warning.
- Frontend tests currently report a framer-motion ref warning from `AgentArtifactCard`; tests still pass.

T43 operational canary:

```bash
cd agent-bridge
../scripts/npm run eval:canary
```

The runner exercises the public HTTP/SSE seam with distinct primary and fallback models and reports routing, outcome, P95 latency, token usage, cost, metric coverage and output privacy. Model refs use `provider:name` format. Provider keys remain in `agent-bridge/.env` and must never be echoed into the command or report.

For a single observation per scenario, provide `EVAL_WORKSPACE_STATE_JSON`, `EVAL_CONVERSATION_ID`, `EVAL_WORKSPACE_ID`, `EVAL_PROJECT_ID`, `EVAL_VIEWER_USER_ID`, `EVAL_PRIMARY_MODEL` and `EVAL_FALLBACK_MODEL`. For repeated evidence, set `EVAL_REPEATS=3` and `EVAL_BACKEND_BASE_URL`; the runner resets/seeds the dedicated backend and creates a fresh private conversation for every observation, then executes all observations sequentially. Repeats fail closed without a provisioning backend. `EVAL_SCENARIO_IDS=risk-proposal` can bound a corrective rerun to one or more comma-separated scenarios.

The repeated post-T44 DeepSeek Flash/Pro canary passed with 100% routing, outcome, privacy and latency rates across 15 isolated observations per model. Frozen scenario latency gates are answer 30s, status/planning/privacy 90s and risk-replan 120s. Flash/Pro cache hit was 93.01%/93.51%; Pi's `usage.input` is already non-cached input, so do not subtract `cacheRead` again. Flash remains the default and Pro remains explicit escalation. Full evidence and interpretation are in `docs/T44/post-t44-production-canary-2026-07-13.md`. Deterministic public-seam scenarios remain part of the normal Agent Bridge test suite.

### T46 Evaluation Lab Slice 0

Use the repository entrypoint from the project root. It validates configuration without model calls, creates evaluator-owned backend/sidecar processes and data paths, runs the bounded T43 `answer-no-tool` public HTTP/SSE smoke, and publishes immutable local evidence under `agent-bridge/artifacts/<run-id>/`.

```bash
scripts/eval-lab list
scripts/eval-lab validate --preset smoke --model mock:mock-model
scripts/eval-lab run --preset smoke --model mock:mock-model --json
scripts/eval-lab status <run-id>
scripts/eval-lab verify <run-id>
```

Exit codes are `0` pass, `1` Agent regression, `2` infrastructure/integrity failure, `3` validation failure, and `4` budget exhaustion with partial evidence. Slice 0 intentionally rejects paid models until a frozen price table and pre-call worst-case estimate exist. The `$0.10` smoke ceiling applies only to the ProjectFlow Agent under test; external Coding Agent cost is recorded separately and excluded. Do not point the evaluator at a development or production database, and do not bypass its nonce/instance/path ownership checks. See `docs/T46/ProjectFlow_Agent_Evaluation_Lab_Slice0_Handoff.md`.

### T46 Evaluation Lab Slice 1 Foundation (#95) — V2 Hard Graders

Issue #95 (branch `glm/t46-95-hard-oracles`) adds the hard-domain foundation via `smoke-v2`. Hard graders are pure functions over a normalized evidence snapshot. Public Agent behavior remains HTTP/SSE, and proposal confirmation/rejection is exercised through the public Proposal API. A hard-gate failure in any of Outcome, Authority & Safety, Trajectory or Privacy cannot be offset. Issue #96 remains required before Slice 1 is complete.

```bash
scripts/eval-lab validate --preset smoke-v2 --model mock:mock-model
scripts/eval-lab run --preset smoke-v2 --model mock:mock-model --json
```

The `smoke-v2` preset runs three isolated fixtures: answer-only/read-only, plan proposal + public confirm, and plan proposal + public reject. Hidden sentinels remain evaluator-only; artifacts contain SHA-256 commitments, not raw tokens. V2 grading is opt-in, and `HardGrade` participates in the final verdict with AND semantics.

The backend exposes a normalized, read-only, viewer-scoped evidence endpoint used by the graders:

```
GET /internal/evaluation/evidence
  ?workspace_id=...&viewer_user_id=...[&project_id=...][&conversation_id=...][&run_id=...]
```

Authentication requires BOTH the sidecar internal service token (`Authorization: Bearer ...`) AND the evaluator-owned instance identity (`X-Evaluation-Nonce` + `X-Evaluation-Instance-Id` + ownership marker + path containment), matching the Slice 0 destructive seed endpoint. The endpoint is read-only: it never mutates database state, never creates runs, never confirms proposals, and never modifies ProjectMemory. Viewer-sensitive collections (private conversations, `subject_and_owner` ProjectMemory) are filtered by the same authorization predicates used by public read endpoints. Run-scoped facts (`trajectory_facts`, `side_effect_facts`, `metric_facts`, `context_receipt_facts`) are returned only when `run_id` is provided.

Issue #95 does not yet implement #96's multi-turn controller, full Skill/Runtime fault matrix, repeated-run reliability or candidate/baseline comparison. Do not start Slice 2 before #96 closes the Slice 1 exit gate. See `docs/T46/ProjectFlow_Agent_Evaluation_Lab_Slice1_Handoff.md` for the evidence trust model and adversarial remediation.

### Conversation history smoke test

With a valid project member ID, verify the T45 lifecycle without exposing another member's transcript:

```bash
curl "http://localhost:8000/api/projects/<project_id>/agent-conversations?viewer_user_id=<user_id>"
curl -X POST "http://localhost:8000/api/projects/<project_id>/agent-conversations" \
  -H "Content-Type: application/json" \
  -d '{"viewer_user_id":"<user_id>"}'
curl "http://localhost:8000/api/agent/conversations/<conversation_id>?viewer_user_id=<user_id>"
```

Expected behavior: create returns a `private` conversation owned by the viewer; list returns summaries without full messages; unauthorized or cross-project identifiers return `404`; the compatibility singular GET never creates a row. In the frontend, “新对话” stays local until the first send, “历史会话” loads the latest page, and switching is disabled during streaming.

## LLM Provider Diagnostic

Check whether the configured LLM provider is reachable:

```bash
curl -X POST http://localhost:8000/api/llm/diagnostic
```

Or with explicit provider settings:

```bash
curl -X POST http://localhost:8000/api/llm/diagnostic \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","model":"gpt-4o-mini"}'
```

The diagnostic request body does not accept `api_key`; configure `LLM_API_KEY` in `.env` before running real-provider checks.

The response never includes the API key value. `status` is `"ok"`, `"error"`, or `"mock"`.

## Demo Reset

With the backend running, reset the local demo data:

```bash
curl -X POST http://localhost:8000/api/demo/reset
```

The response includes `workspace_id` and `project_id`. Open the returned workspace in the frontend:

```text
http://localhost:3000/workspaces/<workspace_id>
```

The dashboard no longer exposes a standalone Reset demo button. Instead, open **Settings** from the gear icon at the bottom of the left sidebar → switch to the **系统** tab → click **重置数据**. This dispatches a `projectflow:reset-demo` event that the workspace page handles by calling the same endpoint and navigating to the seeded workspace.

## Demo Path

Use `docs/demo-script.md` for the 5-minute manual path and `docs/seed-scenarios.md` for the seeded blocker/risk/replan scenario.

## Local SQLite Schema Drift

`backend/data/` is ignored runtime state. Fresh databases are auto-created from SQLModel metadata on FastAPI startup.

If an older local `projectflow.sqlite` was created before `AgentEvent.status` existed, back up the file first, then add the missing column:

```sql
ALTER TABLE agent_events ADD COLUMN status TEXT NOT NULL DEFAULT 'success';
```

If an older local `projectflow.sqlite` was created before action cards gained richer active-push fields, back up the file first, then add the missing columns:

```sql
ALTER TABLE action_cards ADD COLUMN goal TEXT;
ALTER TABLE action_cards ADD COLUMN start_suggestion TEXT;
ALTER TABLE action_cards ADD COLUMN completion_standard TEXT;
```

If an older local `projectflow.sqlite` was created before assignment proposals gained recommendation citation fields, back up the file first, then add the missing columns:

```sql
ALTER TABLE assignment_proposals ADD COLUMN skill_match TEXT;
ALTER TABLE assignment_proposals ADD COLUMN availability_match TEXT;
ALTER TABLE assignment_proposals ADD COLUMN preference_match TEXT;
ALTER TABLE assignment_proposals ADD COLUMN constraint_respected TEXT;
```

## Environment Variables

| Variable | Used by | Required now | Notes |
|---|---|---:|---|
| `APP_ENV` | backend | no | Defaults to `development`. |
| `DATABASE_URL` | backend | no | Defaults to `sqlite:///./data/projectflow.sqlite`. |
| `LLM_PROVIDER` | backend | no | Defaults to `mock`; set to `openai` or `openai-compatible` for a real compatible chat-completions provider. |
| `LLM_API_KEY` | backend LLM | only for real LLM | Required when `LLM_PROVIDER=openai` or `openai-compatible`. Must stay in `.env`. |
| `LLM_BASE_URL` | backend LLM | no | Defaults to `https://api.openai.com/v1`; override for OpenAI-compatible providers. |
| `LLM_MODEL` | backend LLM | no | Defaults to `gpt-4o-mini`. |
| `LLM_TIMEOUT_SECONDS` | backend LLM diagnostics | no | Defaults to `30.0`; used by provider diagnostics and direct client checks. |
| `LLM_AGENT_TIMEOUT_SECONDS` | backend Agent generation | no | Defaults to `120.0`; real structured Agent runs are slower than health checks. |
| `DEMO_ADMIN_TOKEN` | backend demo admin | outside development | Required for seed/reset endpoints when `APP_ENV` is not `development`. Send it as `X-ProjectFlow-Admin-Token`. |
| `INTERNAL_SERVICE_TOKEN` | backend + agent bridge | yes for T41 sidecar/internal endpoints | Backend requires it for `/internal/agent-tools/*` and `/internal/agent-runs/*`; sidecar sends the same value as `Authorization: Bearer ...`. |
| `SERVICE_TOKEN` | agent bridge | no | Backward-compatible sidecar alias; ignored when `INTERNAL_SERVICE_TOKEN` is set. |
| `NEXT_PUBLIC_API_BASE_URL` | frontend | no | Defaults to `http://localhost:8000/api`. |
| `NEXT_PUBLIC_SIDECAR_BASE_URL` | frontend | no | Sidecar base URL for model config API. Defaults to `http://localhost:4000`. |
| `MODEL_CONFIGS_PATH` | agent bridge | no | Path to `model-configs.json`. Defaults to `../../model-configs.json` relative to dist. |
| `DOTENV_PATH` | agent bridge | no | Path to `.env` file for API key writes. Defaults to `../../.env` relative to dist. |
| `DEEPSEEK_API_KEY` | agent bridge (DeepSeek) | for DeepSeek models | API key for DeepSeek provider. |
| `XIAOMI_API_KEY` | agent bridge (Xiaomi) | for MiMo models | API key for Xiaomi provider. |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY` | agent bridge (Xiaomi CN) | for MiMo CN token-plan | API key for Xiaomi token-plan-cn provider. |
| `UPLOAD_DIR` | backend | no | Upload root. Evaluation mode overrides it with an evaluator-owned temporary directory. |
| `EVALUATION_NONCE` | backend + agent bridge | evaluator only | Ephemeral secret used with `X-Evaluation-Nonce`; generated by `scripts/eval-lab`, not configured for normal development. |
| `EVALUATION_INSTANCE_ID` | backend + agent bridge | evaluator only | Ephemeral process-pair identity that must match health responses and evaluator headers. |
| `EVALUATION_TEMP_ROOT` | backend + agent bridge | evaluator only | Evaluator-owned root containing SQLite, uploads, config copies and staging artifacts. |

## Sidecar Model Configuration

The agent-bridge sidecar supports multiple LLM providers and models via `model-configs.json` (default 4 presets: DeepSeek V4 Flash/Pro, MiMo V2.5, MiMo V2.5 CN). API keys are stored only in `.env`, referenced by env var name in the config file — never in the JSON or exposed to the frontend.

### Configure via frontend

Click the gear icon at the bottom of the left sidebar in a workspace → "模型配置" tab. Add/edit/delete model configs, set API keys, and reload configs from disk.

### Configure via file

Edit `agent-bridge/model-configs.json` directly. The sidecar auto-reloads within 500ms via FileWatcher. To also pick up `.env` changes, use the reload button or `POST /config/reload`.

### Switch models at runtime

In the Agent sidebar, use the "模型" dropdown (above the thinking level selector) to pick a model for the next agent run. Selection persists in localStorage until changed.

### API key safety

- API keys are written to `.env` via a serial write queue (no concurrent corruption)
- Protected system env vars (PATH, HOME, NODE_OPTIONS, etc.) cannot be overwritten
- Key values with newlines are rejected
- Max key length: 512 chars
- Frontend only sees `apiKeySet` (boolean) and `apiKeySuffix` (last 4 chars or `****`)

### Add a custom OpenAI-compatible provider

In the settings dialog, select provider "openai-compatible", provide a base URL, model name, and API key env var name. The sidecar will construct Pi SDK Model objects at runtime for models not in the provider's catalog.

## Demo Seed Data and Reset

### Load Demo Seed

To populate the database with realistic demo data (6-member student team, project, stages, tasks, assignments, check-ins, risks, action cards):

```bash
curl -X POST http://localhost:8000/api/seed/demo
```

Response:

```json
{
  "status": "ok",
  "summary": {
    "users": 6,
    "workspace": 1,
    "project": 1,
    "stages": 4,
    "tasks": 10,
    "risks": 3,
    "action_cards": 5,
    "agent_events": 5
  }
}
```

### Reset Demo Data

To clear all database tables (e.g., before re-seeding for a clean demo):

```bash
curl -X POST http://localhost:8000/api/seed/reset
```

Response:

```json
{
  "status": "ok",
  "deleted": {
    "users": 6,
    "workspaces": 1,
    "projects": 1,
    ...
  }
}
```

### Full Demo Reset

To get a clean demo state:

```bash
# Reset then seed
curl -X POST http://localhost:8000/api/seed/reset
curl -X POST http://localhost:8000/api/seed/demo
```

The seed uses fixed IDs, so repeated `POST /api/seed/demo` calls are idempotent (they update in place).

### Resource Management

Create a resource (text note):

```bash
curl -X POST http://localhost:8000/api/resources \
  -H "Content-Type: application/json" \
  -d '{"project_id":"<id>","type":"text_note","title":"标题","content_text":"内容"}'
```

Upload a file (multipart):

```bash
curl -X POST http://localhost:8000/api/uploads \
  -F "file=@/path/to/document.md"
```

Delete a resource:

```bash
curl -X DELETE http://localhost:8000/api/resources/<resource_id>
```

Delete a project (cascading):

```bash
curl -X DELETE http://localhost:8000/api/projects/<project_id>
```

Uploaded files are stored in `backend/data/uploads/`. Deleting a file-type resource that points to an uploads directory file also removes the file from disk.

### Review Summary Export

To generate a review-ready Markdown summary:

```bash
curl -X POST http://localhost:8000/api/projects/demo-project-001/export/review-summary
```

Response:

```json
{
  "markdown": "# ProjectFlow 评审摘要\n..."
}
```

## Runtime Files

Generated local files must not be committed:

- `.env`
- `.env.*`
- `backend/data/`
- `*.sqlite`
- `*.sqlite3`
- `backend/.venv/`
- `frontend/node_modules/`
- `frontend/.next/`
- Python cache directories
- test and build cache directories

---

## LLM Provider Modes

ProjectFlow supports two LLM provider modes: **mock** (default, offline) and **real-provider** (online, requires API credentials). All Agent endpoints work in both modes. In mock mode, the Agent returns deterministic fallback payloads. In real-provider mode, the Agent calls an OpenAI-compatible chat-completions API and validates the structured output.

### Mock Mode (Default)

Mock mode is the default and requires no API key. It is suitable for:

- Local development and UI testing
- Deterministic demo runs
- CI/CD pipelines
- Offline work

**Configuration** (`backend/.env`):

```bash
LLM_PROVIDER=mock
```

Or simply omit `LLM_PROVIDER` — it defaults to `mock`.

**Behavior**:

- All Agent endpoints (`/api/agent/clarify`, `/api/agent/plan`, `/api/agent/breakdown`, `/api/agent/assign`, `/api/agent/active-push`, `/api/agent/check-in-analysis`, `/api/agent/risk-analysis`, `/api/agent/replan`) return structured fallback payloads.
- Fallback payloads cite real member data from the workspace state when available.
- Agent responses include `"status": "fallback"` and `"used_fallback": true`.
- No network calls are made to any LLM API.
- The `GET /api/llm/diagnostic` endpoint returns `{"status": "mock"}`.

**Verification**:

```bash
curl http://localhost:8000/api/llm/diagnostic
# Expected: {"provider":"mock","model":"mock","base_url":"","status":"mock","detail":"Mock provider active"}
```

### Real-Provider Mode

Real-provider mode connects to an OpenAI-compatible chat-completions API. It is suitable for:

- Testing Agent output quality with real LLM responses
- Evaluating prompt effectiveness
- Demonstrating the full Agent intelligence

**Supported providers**: `openai` (official OpenAI API) and `openai-compatible` (any OpenAI-compatible endpoint such as Azure OpenAI, local proxies, DeepSeek, etc.).

**Configuration** (`backend/.env`):

```bash
LLM_PROVIDER=openai
LLM_API_KEY=sk-...your-key-here...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_TIMEOUT_SECONDS=30.0
LLM_AGENT_TIMEOUT_SECONDS=120.0
```

For OpenAI-compatible providers:

```bash
LLM_PROVIDER=openai-compatible
LLM_API_KEY=your-provider-key
LLM_BASE_URL=https://your-provider.example.com/v1
LLM_MODEL=your-model-name
LLM_TIMEOUT_SECONDS=30.0
LLM_AGENT_TIMEOUT_SECONDS=120.0
```

**Security rules**:

- API keys must stay in `.env` (which is Git-ignored).
- Never commit `.env` or paste real keys into docs, logs, or code.
- Diagnostic responses never include the API key value.

**Behavior**:

- Agent endpoints call the configured LLM API with structured output prompts.
- If the LLM call succeeds and the output passes Pydantic validation, the response includes `"status": "success"`.
- If the LLM call times out, has a transient connection failure, or returns invalid/schema-mismatched content after retry, the system falls back to a template payload with `"status": "fallback"`.
- Auth, provider configuration, quota/rate-limit, and malformed provider HTTP responses are surfaced as clear failures instead of being treated as Agent success.
- If the LLM output is repairable JSON and passes Pydantic validation after repair, the response is labeled `"status": "repaired"` and `"used_fallback": false`.
- High-impact outputs (clarify, plan, breakdown) create `AgentProposal` records that require human confirmation before persisting to project state.

**Diagnostic check** (before running real-provider mode):

```bash
curl http://localhost:8000/api/llm/diagnostic
# Expected: {"provider":"openai","model":"gpt-4o-mini","base_url":"...","status":"ok","detail":"Provider responded successfully"}
```

**One-off diagnostic** (override non-secret provider settings):

```bash
curl -X POST http://localhost:8000/api/llm/diagnostic \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai-compatible","base_url":"https://api.openai.com/v1","model":"gpt-4o-mini","timeout_seconds":30.0}'
```

---

## Manual Verification Checklist

Use this checklist to manually verify the full MVP flow. It covers both mock mode and real-provider mode.

### Prerequisites

- [ ] Backend is running on `http://localhost:8000`
- [ ] Frontend is running on `http://localhost:3000`
- [ ] `GET /api/health` returns `{"status":"ok"}`
- [ ] LLM diagnostic returns expected status (`mock` or `ok`)

### Account and Workspace Setup

- [ ] Navigate to `http://localhost:3000` — landing page shows with "开始使用" and "加载演示数据" buttons
- [ ] Click "开始使用" — redirects to onboarding page
- [ ] Fill in account setup form (display name) — form validates and submits
- [ ] Complete member profile wizard (3 steps: basic info / skills & experience / availability)
- [ ] Click "进入工作台" — lands on `/workspaces/<id>` (three-column layout)
- [ ] Create a workspace — 2-step wizard (basic info + team context) if no workspace exists
- [ ] Invite a member — copy-link feedback works

### Project Intake

- [ ] In workspace dashboard, click "新建项目" — project intake dialog opens
- [ ] Select project type (coursework/competition/startup/research)
- [ ] Fill in project idea, deadline, deliverables
- [ ] Add deliverable tags
- [ ] Add resources (text input)
- [ ] Submit — project is created and loads in the same three-column layout

### Agent: Clarification (Direction Card)

- [ ] On project dashboard, the "规划" phase is highlighted as current
- [ ] Click "澄清方向" button — Agent runs
- [ ] Response includes `proposal_id` (confirm-to-persist flow)
- [ ] Direction card panel shows the proposal with problem, users, value, deliverables, boundaries, risks
- [ ] Confirm the proposal — direction card is persisted to project state
- [ ] Reject the proposal — direction card is not persisted

### Agent conversation history

- [ ] Click “新对话” — no empty server conversation is created before the first send
- [ ] Send the first message — the URL gains the selected `conversation` query parameter
- [ ] Open “历史会话” — private/team labels, preview and active selection are visible
- [ ] Open an older conversation and load older messages — order is stable and no duplicates appear
- [ ] Start a streamed answer — new/switch controls remain disabled until completion or stop
- [ ] Switch current user — another member's private conversation is not listed or readable

### Navigation Quality

- [ ] Rapidly click multiple sidebar views (e.g., 阶段计划 → 任务拆解 → 风险与调整) — the UI navigates to the last clicked view and no `net::ERR_ABORTED` errors appear in the browser console

### Agent: Stage Planning

- [ ] Click "生成阶段计划" button — Agent runs
- [ ] Response includes `proposal_id`
- [ ] Stage plan board shows proposed stages with goals, dates, deliverables
- [ ] Confirm the proposal — stages are persisted

### Agent: Task Breakdown

- [ ] Click "分解任务" button — Agent runs
- [ ] Response includes `proposal_id`
- [ ] Task breakdown board shows tasks with priorities, dependencies, acceptance criteria
- [ ] Confirm the proposal — tasks are persisted

### Agent: Assignment Recommendation

- [ ] Dashboard moves to "分工" phase
- [ ] Click "推荐分工" button — Agent runs
- [ ] Assignment proposals appear with recommended owner, backup owner, reason, and citation fields (skill/availability/preference/constraint)
- [ ] Accept a proposal — owner status changes
- [ ] Reject a proposal — rejection form shows "偏好任务" and "原因" fields
- [ ] Submit rejection with preferred task — negotiation is created
- [ ] Negotiation panel shows the swap proposal
- [ ] Finalize assignments — task owners are locked

### Agent: Active Push

- [ ] Dashboard moves to "执行" phase
- [ ] Click "主动推进" button — Agent runs
- [ ] Action cards appear with title, content, reason, goal, start_suggestion, completion_standard
- [ ] Personal action cards section shows cards assigned to current user
- [ ] Dismiss an action card — card status changes
- [ ] Complete an action card — card status changes

### Check-in

- [ ] Navigate to "签到与状态" tab
- [ ] Submit a check-in (what_done, optional blocker, available hours, mood)
- [ ] Check-in response is recorded
- [ ] Update task status (not_started/in_progress/done/blocked with progress note)

### Agent: Check-in Analysis

- [ ] Click "分析签到" button — Agent runs
- [ ] Analysis output is persisted

### Agent: Risk Analysis

- [ ] Navigate to "风险与调整" tab
- [ ] Click "风险分析" button — Agent runs
- [ ] Risks appear with type, evidence (structured with detail), and status
- [ ] Accept a risk — risk status changes
- [ ] Ignore a risk — risk status changes
- [ ] Resolve a risk — risk status changes

### Agent: Replan

- [ ] Click "调整计划" button — Agent runs
- [ ] Replan diff shows before/after comparison with impact and reason
- [ ] "Needs confirmation" badge appears for high-impact changes
- [ ] Confirm replan — changes are applied
- [ ] Attempting to change owner on a finalized assignment is rejected

### Timeline and Export

- [ ] Navigate to "时间线与导出" tab
- [ ] Agent timeline shows events with status (success/fallback/repaired/failed)
- [ ] Click export — review summary Markdown is generated
- [ ] Export includes product positioning, current state, stages, tasks, team, risks, action cards, check-ins, timeline

### Demo Reset

- [ ] Open Settings from the gear icon at the bottom of the left sidebar → "系统" tab
- [ ] Click "重置数据" — confirm the dialog — data is reset and re-seeded
- [ ] Or use `curl -X POST http://localhost:8000/api/demo/reset`
- [ ] Dashboard navigates to the seeded project

### Real-Provider Mode Verification (if credentials available)

- [ ] Set `LLM_PROVIDER=openai` (or `openai-compatible`) in `backend/.env`
- [ ] Set `LLM_API_KEY` in `backend/.env`
- [ ] Restart the backend
- [ ] Run `curl http://localhost:8000/api/llm/diagnostic` — returns `{"status":"ok"}`
- [ ] Run through the full checklist above with real LLM responses
- [ ] Verify that Agent responses include `"status": "success"` or `"status": "repaired"` with `"used_fallback": false` for the core loop
- [ ] Verify that structured output passes Pydantic validation
- [ ] Verify that fallback still works if LLM call fails (e.g., set invalid API key temporarily)
- [ ] Switch back to `LLM_PROVIDER=mock` after testing

---

## Final Status Report

### What Is Truly Usable

| Feature | Status | Notes |
|---|---|---|
| Account setup | ✅ Usable | Display name, no auth |
| Member profile wizard | ✅ Usable | 3-step: basic / skills / availability |
| Workspace creation | ✅ Usable | 2-step wizard with invite |
| Project intake | ✅ Usable | Type selector, deliverable tags, resource input |
| Agent: Clarification | ✅ Usable | Confirm-to-persist, mock + real provider |
| Agent: Stage Planning | ✅ Usable | Confirm-to-persist, mock + real provider |
| Agent: Task Breakdown | ✅ Usable | Confirm-to-persist, mock + real provider |
| Agent: Assignment Recommendation | ✅ Usable | Citations, accept/reject/negotiate/finalize |
| Agent: Active Push | ✅ Usable | Goal/start/done-when fields |
| Check-in | ✅ Usable | Submit + task status updates |
| Agent: Check-in Analysis | ✅ Usable | Mock + real provider |
| Agent: Risk Analysis | ✅ Usable | Structured evidence, accept/ignore/resolve |
| Agent: Replan | ✅ Usable | Before/after diff, finalized-assignment guard |
| Timeline | ✅ Usable | Status badges (success/fallback/repaired/failed) |
| Export | ✅ Usable | Review summary Markdown |
| Demo seed/reset | ✅ Usable | Deterministic data, dashboard reset button |
| LLM diagnostics | ✅ Usable | GET + POST diagnostic, no key exposure |
| Chinese UI | ✅ Usable | All labels, forms, and navigation in Chinese |

### What Remains Fallback

| Area | Behavior | Impact |
|---|---|---|
| Mock mode Agent outputs | All Agent endpoints return template/fallback payloads in mock mode | Low — fallback payloads cite real workspace data and validate against schemas |
| Real-provider fallback | Transient timeout/connection errors or schema mismatch after retry fall back to template; auth/config/quota errors fail clearly | Low — fallback is transparent via `status` and `used_fallback` fields |
| Repaired outputs | If LLM returns valid JSON that partially matches schema, system repairs and flags as `repaired` | Low — repaired outputs are labeled in timeline |

### What Is Out of Scope for MVP

| Area | Reason |
|---|---|
| Authentication / authorization | MVP uses display-name accounts, no real auth |
| Multi-workspace | MVP is single-workspace |
| Multi-project | MVP is single-project per workspace |
| Production deployment | Local demo only |
| File upload / document parsing | TODO: current upload is metadata + disk save, no full-text parsing yet |
| Real-time collaboration | No WebSocket or live sync |
| Email notifications | No email integration |
| Mobile app | Web only |
| External integrations (calendar, Git, etc.) | Not in MVP scope |
| Role-based permissions | All members have equal access |
| Data migration between versions | No migration tooling |

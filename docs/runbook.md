# ProjectFlow Runbook

Status: current as of 2026-05-29.

## Prerequisites

- Python 3.11 or newer. The current scaffold was verified with Python 3.13.7.
- Node.js compatible with Next.js 16. The current scaffold was verified with Node.js 24.14.1 and npm 11.
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

Expected baseline as of 2026-05-29:

- Backend tests pass (MVP API/model smoke plus CORS, agent schema, module, provider, fallback, timeline logging, assignment, action-card, check-in, risk, replan, seed/reset/export, demo reset, and agent endpoint tests).
- Frontend tests pass.
- Frontend lint passes.
- Frontend production build passes.
- `npm audit --omit=dev` reports 0 critical/high vulnerabilities (moderate may exist).

Known non-blocking warnings:

- Backend pytest may show a FastAPI/Starlette `TestClient` deprecation warning.
- Vitest may show a Vite CJS Node API deprecation warning.

## LLM Provider Diagnostic

Check whether the configured LLM provider is reachable:

```bash
curl -X POST http://localhost:8000/api/llm/diagnostic
```

Or with explicit provider settings:

```bash
curl -X POST http://localhost:8000/api/llm/diagnostic \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","api_key":"sk-...","model":"gpt-4o-mini"}'
```

The response never includes the API key value. `status` is `"ok"`, `"error"`, or `"mock"`.

## Demo Reset

With the backend running, reset the local demo data:

```bash
curl -X POST http://localhost:8000/api/demo/reset
```

The response includes `workspace_id` and `project_id`. Open the returned project in the frontend:

```text
http://localhost:3000/projects/<project_id>
```

The dashboard also exposes a Reset demo button. It calls the same endpoint and navigates to the seeded project.

## Demo Path

Use `docs/demo-script.md` for the 5-minute manual path and `docs/seed-scenarios.md` for the seeded blocker/risk/replan scenario.

## Local SQLite Schema Drift

`backend/data/` is ignored runtime state. Fresh databases are auto-created from SQLModel metadata on FastAPI startup.

If an older local `projectflow.sqlite` was created before `AgentEvent.status` existed, back up the file first, then add the missing column:

```sql
ALTER TABLE agent_events ADD COLUMN status TEXT NOT NULL DEFAULT 'success';
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
| `LLM_TIMEOUT_SECONDS` | backend LLM | no | Defaults to `30.0`. |
| `NEXT_PUBLIC_API_BASE_URL` | frontend | no | Defaults to `http://localhost:8000/api`. |

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

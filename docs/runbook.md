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

- Backend tests pass (51 tests: API/model smoke plus agent schema, module, provider, fallback, and timeline logging tests).
- Frontend tests pass.
- Frontend lint passes.
- Frontend production build passes.
- `npm audit --omit=dev` reports 0 critical/high vulnerabilities (moderate may exist).

Known non-blocking warnings:

- Backend pytest may show a FastAPI/Starlette `TestClient` deprecation warning.
- Vitest may show a Vite CJS Node API deprecation warning.

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

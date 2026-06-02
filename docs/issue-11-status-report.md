# Issue #11: Verification, Tests, and Demo Stability Hardening — Status Report

> 📦 **历史归档**：本报告是 Phase 9 (2026-05-29) 的完成快照。当前验证基线见 [handoff.md](handoff.md) 和 [runbook.md](runbook.md)。

**Date**: 2026-05-29
**Status**: ✅ Complete

## Completed Scope

### Backend Tests (69/69 passing)

| Test File | Tests | Status |
|-----------|-------|--------|
| `test_api_smoke.py` | 1 | ✅ |
| `test_agent_modules.py` | 11 | ✅ |
| `test_agent_output_schemas.py` | 12 | ✅ |
| `test_agent_workflow.py` | 5 | ✅ |
| `test_api_workspace_project.py` | 3 | ✅ |
| `test_assignment_flow.py` | 1 | ✅ |
| `test_checkin_risk_replan_flow.py` | 1 | ✅ |
| `test_issue4_smoke.py` | 5 | ✅ |
| `test_models.py` | 12 | ✅ |
| `test_seed_reset_export.py` | 14 | ✅ |
| `test_agent_endpoints.py` | 1 | ✅ |
| **Total** | **69** | **✅** |

### Frontend Verification

- `npm run lint` — ✅ Passes (0 errors)
- `npm run build` — ✅ Passes (Next.js 16.2.6 Turbopack, 7 routes)

### Tracked Artifacts Check

- No `.env`, `.sqlite`, `.sqlite3`, `.venv`, `node_modules`, `__pycache__`, `.next` tracked — ✅

## Key Fixes Applied

1. **SQLite JSON Column Handling**: Replaced `Column(JSON)` with `Column(Text)` + manual `json.dumps`/`json.loads` in `AgentEvent` model. SQLite doesn't natively support JSON parameter binding in Python 3.12+; the Text-column pattern matches the existing codebase convention (MemberProfile.skills, Risk.evidence, Stage.done_criteria).

2. **AgentEvent Model Consolidation**: Removed duplicate `agent_event.py`, consolidated into `timeline.py` with proper `AgentEventType`/`AgentEventStatus` enums and JSON helpers.

3. **Service Layer JSON Serialization**: Added `json.dumps()` in create/update services for all JSON-string fields: `skills`, `evidence`, `done_criteria`, `dependency_ids`, `acceptance_criteria`, `input_snapshot`, `output_snapshot`.

4. **API Route JSON Deserialization**: Added `_model_to_read()` adapter functions in routes for MemberProfile, Risk, Stage, and Task to deserialize JSON strings back to lists/dicts for API responses.

5. **Test Isolation**: Created `conftest.py` with in-memory SQLite + `StaticPool` + lifespan override. All integration tests use the `client` fixture with dependency-overridden `get_session`.

6. **Enum/String Compatibility**: Fixed `invitation_service.py` and `workspace_state_service.py` to handle models that store enum values as plain strings (use `.value` for comparison, `isinstance` guards).

7. **Database Engine Configuration**: Added `json_serializer`/`json_deserializer` kwargs to SQLite engine creation for proper JSON type support.

## Known Demo Failure Points and Mitigations

| Failure Point | Risk | Mitigation |
|---------------|------|------------|
| SQLite file not created on first run | Low | `lifespan` calls `create_db_and_tables()`; `data/` dir created by conftest |
| LLM provider misconfigured (no API key) | Medium | Default `LLM_PROVIDER=mock`; real LLM requires `.env` setup |
| Frontend API URL mismatch | Low | `NEXT_PUBLIC_API_BASE_URL` defaults to `http://localhost:8000/api` |
| Seed data ID collisions on re-seed | Low | `POST /api/seed/demo` resets before seeding (idempotent) |
| Python 3.12+ SQLite adapter deprecation | Low | Fixed with `json_serializer`/`json_deserializer` engine kwargs |
| Enum values stored as strings in DB | Low | Service layer handles str/enum conversion; API routes deserialize |

## Remaining Risks

1. **No end-to-end browser test**: Manual demo walkthrough still needed to verify UI animations and full flow.
2. **No load/stress testing**: Single-user demo only; concurrent access not tested.
3. **Mock LLM only**: Real LLM integration (OpenAI) not tested in CI.
4. **No database migration tooling**: Schema changes require manual DB reset.

## Verification Commands

```bash
# Backend tests
cd backend
.venv/Scripts/python -m pytest app/tests/ -v

# Frontend lint
cd frontend
npm run lint

# Frontend build
cd frontend
npm run build

# Security: no tracked secrets/artifacts
git ls-files | grep -E '\.env|\.sqlite|\.sqlite3|\.venv|node_modules|__pycache__|\.next'

# Full demo smoke test (requires running servers)
# 1. Start backend: cd backend && .venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
# 2. Start frontend: cd frontend && npm run dev
# 3. Open http://localhost:3000
# 4. Click through: Onboarding → Workspace → Project → Agent → Export
```

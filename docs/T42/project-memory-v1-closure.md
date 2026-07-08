# T42 ProjectMemory V1 Closure Review

Status: acceptance as of 2026-07-07.

## Summary

GitHub issues #71-#80 are closed and merged to `main`. The latest stabilization commit adds the frontend read-only memory list and Markdown export UI for issue #80.

The completed implementation covers the ProjectMemory V1 backend/runtime and frontend path:

- Governed `ProjectMemory` and `ProjectMemorySync` persistence.
- Deterministic extractor with no LLM calls.
- Source hooks for direction-card confirmation, proposal rejection with reason, assignment finalization, replan confirmation, and replan rejection with reason.
- Source-level idempotency, supersede behavior, lifecycle/status filtering, explicit viewer identity, and `subject_and_owner` privacy.
- JSON memory list and Markdown export API with `Cache-Control: no-store`.
- Default FTS5+jieba retrieval with SQLite field fallback and `none` fallback.
- Agent context injection through FastAPI-built context only; T41 sidecar remains database-free.
- Retrieval evaluation harness and optional `memory-vector` extra with default-install guardrails.
- Frontend `ProjectMemoryPanel` with topic-grouped read-only list, loading/error/empty states, and Markdown export/copy/download using the current viewer identity.

## Verification Evidence

Latest local verification on `main` after the issue #80 privacy fix commit (`e77b099`):

```bash
cd backend
.venv\Scripts\python -m ruff check app --output-format=concise
.venv\Scripts\python -m pytest app/tests/ -q
```

Result:

- `ruff check app`: passed.
- Backend tests: 519 passed, 4 skipped.

```bash
cd frontend
npm run test
npm run lint
npm run build
npm audit --omit=dev
```

Result:

- Frontend tests: 56 passed across 10 files.
- Frontend lint: passed with 2 existing React hook warnings.
- Frontend production build: passed.
- Frontend production dependency audit: 0 vulnerabilities.

```bash
cd agent-bridge
npm run test
npm run typecheck
npm run build
```

Result:

- Agent bridge tests: 540 passed across 18 files.
- Agent bridge typecheck/build: passed.

## GitHub Issue Status

| Issue | Status | Scope |
|---|---|---|
| #71 | Closed | Direction card first tracer bullet |
| #72 | Closed | Proposal rejection memory and reason capture |
| #73 | Closed | Assignment memory with subject-and-owner privacy |
| #74 | Closed | Replan memory tracer |
| #75 | Closed | Default retrieval and Agent context injection |
| #76 | Closed | Retrieval evaluation harness |
| #77 | Closed | Optional vector extra and dependency guardrails |
| #80 | Closed | Frontend read-only memory list and Markdown export UI |

## PRD Coverage

Implemented:

- V1 Memory Source Events listed in the PRD are covered on the intended paths.
- Deterministic extraction, source-level idempotency, visibility, read/export consistency, retrieval, Agent injection, evaluation harness, and optional vector guardrails are implemented.
- Proposal rejection requires a non-empty reason to become memory.
- Ordinary chat and Agent intermediate reasoning do not become ProjectMemory.
- Frontend read-only memory list and Markdown export UI (issue #80) is implemented using the existing backend endpoints and current viewer identity.

Remaining V1 closure gap:

- None.

Accepted V1 limitation:

- The alternate replan path through `/api/replans/confirm` does not produce ProjectMemory. The frontend does not use that endpoint today. This remains documented as a T41/V1.1 alignment item.

## Recommended Next Issue

No remaining implementation issues. Run the product smoke checklist below and mark this PRD complete.

## Product Smoke Checklist

Before closing T42 V1:

- Confirming a direction card creates direction/boundary memories.
- Rejecting an Agent proposal requires a reason and creates a rejection memory.
- Finalizing assignment creates assignment memory and only exposes `subject_and_owner` constraints to the subject and owner snapshot.
- Confirming/rejecting replan through the AgentProposal path creates plan/tradeoff/boundary/rejection memory as applicable.
- Ordinary chat does not create ProjectMemory.
- JSON memory list, Markdown export, frontend memory view, and Agent context use the same visible memory set for the same viewer.
- Missing `viewer_user_id` returns 400; non-member viewer returns 404.
- AgentEvent output metadata records memory usage/backend/IDs/latency; AgentRunState side effects do not record memory usage.

## Worktree Cleanup Candidates

All historical T42 worktrees have been cleaned up (2026-07-07). No registered worktrees remain.

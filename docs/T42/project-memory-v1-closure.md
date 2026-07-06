# T42 ProjectMemory V1 Closure Review

Status: acceptance as of 2026-07-07.

## Summary

GitHub issues #71-#77 are closed and merged to `main`. The latest stabilization commit is `03e7bda` (`fix(t42): stabilize project memory acceptance`).

The completed implementation covers the ProjectMemory V1 backend/runtime path:

- Governed `ProjectMemory` and `ProjectMemorySync` persistence.
- Deterministic extractor with no LLM calls.
- Source hooks for direction-card confirmation, proposal rejection with reason, assignment finalization, replan confirmation, and replan rejection with reason.
- Source-level idempotency, supersede behavior, lifecycle/status filtering, explicit viewer identity, and `subject_and_owner` privacy.
- JSON memory list and Markdown export API with `Cache-Control: no-store`.
- Default FTS5+jieba retrieval with SQLite field fallback and `none` fallback.
- Agent context injection through FastAPI-built context only; T41 sidecar remains database-free.
- Retrieval evaluation harness and optional `memory-vector` extra with default-install guardrails.

## Verification Evidence

Latest local verification on `main` after commit `03e7bda`:

```bash
cd backend
.venv\Scripts\python -m ruff check app --output-format=concise
.venv\Scripts\python -m pytest app/tests/ -q
```

Result:

- `ruff check app`: passed.
- Backend tests: 514 passed, 4 skipped.

```bash
cd frontend
npm run test
npm run lint
npm run build
npm audit --omit=dev
```

Result:

- Frontend tests: 46 passed across 9 files.
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

- Agent bridge tests: 559 passed across 18 files.
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

## PRD Coverage

Implemented:

- V1 Memory Source Events listed in the PRD are covered on the intended paths.
- Deterministic extraction, source-level idempotency, visibility, read/export consistency, retrieval, Agent injection, evaluation harness, and optional vector guardrails are implemented.
- Proposal rejection requires a non-empty reason to become memory.
- Ordinary chat and Agent intermediate reasoning do not become ProjectMemory.

Remaining V1 closure gap:

- The PRD calls for a project-page read-only ProjectMemory list and Markdown export flow for the current viewer. Backend endpoints exist, but `frontend/src` has no memory API wrapper, memory component, or visible project-page entry point yet. This is tracked as GitHub issue #80.

Accepted V1 limitation:

- The alternate replan path through `/api/replans/confirm` does not produce ProjectMemory. The frontend does not use that endpoint today. This remains documented as a T41/V1.1 alignment item.

## Recommended Next Issue

Implement GitHub issue #80:

**T42 ProjectMemory V1: Frontend read-only memory list and Markdown export UI**

Acceptance outline:

- Add typed frontend API helpers for `GET /projects/{project_id}/memories` and `GET /projects/{project_id}/memories.md`.
- Reuse current viewer identity from the existing user switcher/localStorage path.
- Add a project-page read-only memory view or panel that shows visible memories grouped by the existing five Markdown/API topics.
- Add a Markdown export/download or copy flow using the existing backend endpoint.
- Surface missing viewer identity, invalid viewer, empty memory set, loading, and error states.
- Add frontend tests for owner/member visibility happy path, empty state, export action, and error handling.

After that issue passes, run the product smoke checklist below and then mark this PRD complete.

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

The following worktrees are registered locally and appear to be historical implementation or validation worktrees:

- `D:\ProjectFlow\.claude\worktrees\t42-direction-card-tracer`
- `D:\ProjectFlow\.claude\worktrees\t42-memory-retrieval`
- `D:\ProjectFlow\.claude\worktrees\t72-proposal-rejection-memory`
- `D:\ProjectFlow-acceptance-t42`
- `D:\ProjectFlow-t42-planning-docs`
- `D:\ProjectFlow-t42-project-memory-docs`

Do not delete them without explicit user confirmation. Recommended cleanup command after confirmation is `git worktree remove <path>` for each worktree, followed by `git worktree prune`.

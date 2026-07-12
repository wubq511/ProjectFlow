# T43 P0 Correctness Repair Handoff

## Objective

Repair the current uncommitted T43 working tree so restart/resume, steering, durable idempotency, and capability registration are truthful and safe. Do not expand the feature set, commit, push, or deploy.

## Canonical references

- `CLAUDE.md`
- `docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md`
- `docs/T41/ProjectFlow_Agent_Runtime_Foundation_Design.md`
- `docs/T41/ProjectFlow_Agent_Tools_Skills_Design.md`

## Current working-tree baseline

The working tree contains the whole uncommitted T43 implementation. Before the cancelled job it passed:

- agent-bridge: 912 tests, typecheck, build
- backend: 717 passed / 4 skipped, ruff
- `git diff --check`

These green checks do not prove resume correctness. Several new Phase 5 tests only assert constructed objects and do not execute production routes/runtime.

## Preserve these implemented boundaries

- FastAPI/DB remains the only durable business and run-state authority.
- Proposal confirmation remains human-only and is never model-callable.
- No arbitrary shell, filesystem, SQL, URL, open-world, or primary-state commit tool.
- Answer mode exposes no tools; action mode uses Skill allowlists.
- Tool timeout for proposal/advisory writes with uncertain completion is `unknown_side_effect` and must not retry.
- Pi `agent_end` is captured before deterministic verification; exactly one final terminal event is persisted afterward.
- ProjectMemory visibility and output guards remain unchanged.

## Confirmed blocking defects

### P0-1 Resume currently restarts instead of continuing

`agent-bridge/src/server/routes/resume-run.ts` calls `executeRun()` with:

- `userContent: "(从检查点恢复执行)"`
- empty recent messages and pending proposals
- `viewerUserId: undefined`
- no restored Outcome Contract, WorkState, RunPlan, ledger, or steering queue

`executeRun()` then creates a new WorkState/plan. Completed write calls can be proposed again. The workspace-state call also uses an incomplete internal tool envelope, catches failure, and continues with empty context.

Required repair:

- Add a real continuation/resume input that restores the original governed goal, Outcome Contract, WorkState/version, RunPlan/current step, ledger/recovery decisions, viewer identity, model/Skill/prompt versions, and unconsumed steering.
- Never use a placeholder message as the resumed goal.
- Completed/proposal-persisted/advisory-persisted logical calls must be skipped. Safe retry retains the logical call and idempotency key. Unknown/incompatible state blocks.
- If required durable context is missing, return blocked/manual review; do not guess.

### P0-2 Snapshot truncation can lose recovery evidence

`backend/app/services/agent_runtime_service.py:get_run_snapshot()` returns only the latest 50 events. Rehydration uses only that list. Older tool-ledger and steering events can disappear.

Required repair:

- Return latest checkpoint plus its event sequence and every event after it using bounded pagination.
- A checkpoint must contain enough bounded/redacted baseline state to replay from that point.
- If the post-checkpoint range exceeds the safety bound, require pagination or block; never silently resume from incomplete evidence.

### P0-3 Idempotency is process-local

`AgentRuntimeService._idempotency_cache` is an in-memory dictionary. Backend restart loses append and steering idempotency.

Required repair:

- Use durable event/client-event evidence or an existing persisted run envelope for idempotency.
- Pure state patches also need a durable idempotency record.
- Duplicate requests after a fresh service instance must return the original durable result without adding events or effects.

### P0-4 Missing optimistic concurrency

`AppendRequest` and `SteeringRequest` have no `expected_state_version`. Concurrent writers can append against stale state.

Required repair:

- Add `expected_state_version` through TypeScript/Python wire schemas and clients.
- Compare inside the transaction; stale requests return HTTP 409.
- Steering enqueue/consume and state transitions advance the durable version.
- Add multi-session stale-write/event-sequence tests appropriate for SQLite.

### P0-5 Steering is not connected end to end

Backend stores steering as `run.state_changed` with a payload marker. Snapshot does not return an explicit unconsumed queue. Resume does not pass steering into `executeRun`. Existing tests admit they only test data structures.

Required repair:

- Persist real `steering.queued` events.
- Snapshot exposes ordered unconsumed steering; `steering.consumed` durably closes each item.
- Constraint/correction becomes a pinned context block at the next safe loop boundary.
- Plan change produces a versioned plan revision event.
- Clarification answer continues the same run.
- Consumption persistence errors are not swallowed.
- If effect approval has no real current tool use case, keep it feature-disabled and document it as deferred.

### P1 Capability allowlist bypass

`CapabilityAdapter.registerCapability()` directly registers any manifest accepted by ToolRegistry without checking `allowedCapabilities` or prior discovery.

Required repair:

- Registration requires allowlisted, discovered capability with matching version.
- Enforce `maxCapabilities`.
- Enforcement hooks fail closed; telemetry hooks may fail open.

## Truthful scope

Do not claim Phase 5/6 complete unless production-seam tests prove it. The following are currently partial/deferred and should remain labelled that way unless actually implemented and tested:

- effect approval UX and execution gate
- unified scenario baseline with outcome/routing/cost metrics
- durable large-result resource pagination
- trajectory exporter/conformance jobs
- frontend Agent control component (only API/types exist)
- semantic LLM judge

## Required tests

- Backend route/service: snapshot pagination, durable idempotency across service instances, expected-version 409, terminal conflict, internal auth.
- Sidecar production seam: empty SessionStore resumes same run; completed write is not repeated; unknown effect blocks; original goal/context is restored; queued steering is consumed once; stale resume fails.
- Capability adapter: direct registration cannot bypass allowlist/discovery/version/max count.
- Tests must execute real services/handlers/runtime seams, not only assert literal objects.

## Verification commands

```bash
cd agent-bridge
../scripts/npm test
../scripts/npm run typecheck
../scripts/npm run build

cd ../backend
.venv/bin/python -m pytest app/tests/ -q
.venv/bin/python -m ruff check app

cd ../frontend
../scripts/npm test
../scripts/npm run lint
../scripts/npm run build

cd ..
git diff --check
```

Report exact results and remaining gaps. Do not commit, push, or deploy.

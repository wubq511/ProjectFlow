# T43 P0 Repair Round 2

The first repair report overstated completion. Fix only the issues below. Read `CLAUDE_FIX_HANDOFF.md` for invariants, then inspect production code rather than trusting comments/tests.

## 1. Resume still restarts

Evidence:

- `resume-run.ts` does not pass rehydrated WorkState, RunPlan, tool ledger, recovery decisions, or checkpoint version into `executeRun`.
- `executeRun` still calls `createInitialWorkState()` and creates a new plan/executor.
- There is no skip set for completed logical calls.

Required:

- Introduce a typed `ResumeExecutionContext` accepted by `executeRun` or a dedicated continuation function.
- Initialize WorkState/RunPlan/ledger/checkpoint counter from the durable baseline.
- Executor must reject/skip already-completed logical calls and preserve safe-retry logical IDs/idempotency keys.
- Add a production-seam test where a checkpoint already contains a successful proposal write; resume must not call that backend tool again.

## 2. Original goal is not recoverable

Snapshot returns events from checkpoint onward, while the original `agent.started` is normally before the checkpoint. `restoreOriginalUserContent()` then invents `[恢复] 继续执行 ...` from the Skill name. `rebuildOutcomeContract()` also invents constraints and success criteria.

Required:

- Persist the complete bounded Outcome Contract and original normalized goal/hard constraints/success criteria needed for continuation inside the checkpoint at creation time.
- Never persist raw full workspace state or chain-of-thought.
- Remove every synthetic fallback goal/contract. Missing required fields must return blocked/manual review.
- Existing old checkpoints without these fields are incompatible and must not resume automatically.

## 3. Workspace refresh is invalid and fail-open

`resume-run.ts` calls `callTool("get_workspace_state", {workspace_id, project_id})`, which is not the full internal tool envelope and omits viewer identity. It catches failure and runs with undefined state.

Required:

- Add an authenticated FastAPI resume-context endpoint/service response or call the tool with its complete required envelope and original viewer.
- FastAPI validates viewer membership and returns fresh workspace facts, pending proposals, allowed memory context, and any necessary conversation summary.
- Failure is blocking, not soft.

## 4. Snapshot pagination is ignored

`has_more=true` still proceeds. Required:

- Fetch pages until the bounded post-checkpoint replay is complete, or return 409/manual review.
- Rehydration must receive the checkpoint baseline plus all subsequent events exactly once.
- Test more than one page and assert no missing/duplicate ledger or steering events.

## 5. Optimistic concurrency is not wired through

- Steering enqueue does not increment `run.state_version`.
- Most sidecar `appendEvents` calls omit `expected_state_version`.
- Steering consumption catches persistence errors and continues.

Required:

- Every control-plane mutation uses the locally tracked expected durable version and updates it from the response.
- Steering enqueue/consume advances version.
- A 409 triggers reconcile/refetch, never blind continuation.
- Remove swallowed persistence errors on steering/checkpoint/control-plane invariants.

## 6. Pure state-patch idempotency is still not durable

The service queries `client_event_id == request.idempotency_key`, but a pure state patch persists an auto ID such as `auto:state_changed:<seq>`. Duplicate state patches after restart therefore apply again.

Required:

- Persist the request idempotency key on the auto state-change event or another existing durable envelope.
- Tool-result-only requests also need a durable request marker and reconstructable idempotent response.
- Tests must use a new DB session/service instance and cover pure patch and tool-result-only duplicates.

## 7. Tests must exercise behavior

Do not add tests that only inspect DTOs/comments. Required production-seam assertions:

- resumed proposal write backend call count remains zero;
- restored goal/contract/plan/work state reaches the runtime;
- incomplete old checkpoint blocks;
- multi-page replay completes;
- stale version cannot mutate;
- pure patch duplicate does not increment version/event sequence;
- steering consumed exactly once and affects pinned context.

Run the full verification commands from `CLAUDE_FIX_HANDOFF.md`. Do not commit, push, or deploy.

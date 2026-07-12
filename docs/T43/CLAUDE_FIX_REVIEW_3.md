# T43 P0 Repair Round 3

Fix only these remaining production defects. Do not add broad features.

1. Snapshot pagination is fake: `fetchCompleteSnapshot()` calls the same endpoint repeatedly without a cursor. Add `after_event_seq`/cursor to backend route/service/client, return `next_cursor`, and advance pages. Test >2 pages with no missing/duplicate events. If complete replay cannot be obtained, block.

2. `get_resume_context()` returns IDs/status only. It must call the existing deterministic `workspace_state_service.get_workspace_state()` after viewer validation and return serialized fresh workspace facts plus current pending proposals and governed memory context needed by the run. Preserve viewer filtering. `resume-run.ts` must pass the actual workspace state/pending proposals/memory fields, not the wrapper object.

3. Resume duplicate prevention cannot filter entire tool names. A run may legitimately call `create_risk` multiple times with different inputs. Remove tool-name filtering. Before model execution, reconcile recovered successful ledger decisions into RunPlan steps. If every required step is complete, skip the model loop and run verifier/terminalization from recovered evidence. If a pending step remains, expose its allowed tools. Seed ToolExecutor/verifier with the recovered ledger. For defense in depth, dedupe a completed operation by `(tool name, manifest version, input hash)` and return a bounded already-completed observation; different inputs remain allowed.

4. `computeRecoveryDecisions()` currently takes the first ledger entry for a logical call. Group attempts and use the latest/final attempt deterministically. A timeout followed by success must be completed, not blocked.

5. Idempotency must be checked before optimistic version comparison. An exact retry with the original expected version after success must return its durable idempotent response, not 409. A different request with stale version must return 409. Apply to append and steering.

6. Every durable control-plane mutation (`events`, state patch, tool result, steering queue/consume, checkpoint) advances `state_version` exactly once. Duplicate requests advance zero times. Sidecar updates its local version from each response. Add sequential event-only and steering-consume tests.

7. Checkpoint/control-plane persistence is a correctness boundary. Remove `.catch(...continue)` around post-loop/pre-terminal checkpoints and WorkState/plan/verifier persistence. On failure, do not emit a misleading successful terminal; persist/reconcile failure when possible.

8. Existing "production-seam" tests are shallow. Add tests that execute the handler/runtime with mocks counting real backend tool calls: recovered completed proposal leads to zero proposal calls; recovered ledger reaches verifier; different `create_risk` inputs remain permitted; pagination cursor advances; resume context contains real workspace facts; idempotent retry with stale original version succeeds while a distinct stale request fails.

Run all verification commands from `CLAUDE_FIX_HANDOFF.md`. Do not commit, push, or deploy.

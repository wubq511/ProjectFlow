/**
 * Rehydrate tests — rebuild state from persisted events.
 */

import { describe, it, expect } from "vitest";
import { rehydrateFromEvents } from "../../src/runtime/rehydrate.js";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    run_id: "run-1",
    type: "tool.ledger_entry",
    event_seq: 1,
    payload: {},
    trace: {},
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("rehydrateFromEvents", () => {
  it("returns failure for empty events", () => {
    const result = rehydrateFromEvents([], "run-1", "conv-1", "ws-1", "proj-1");
    expect(result.success).toBe(false);
    expect(result.canResume).toBe(false);
  });

  it("reconstructs work state from work_state.changed events", () => {
    const events = [
      makeEvent({
        type: "work_state.changed", event_seq: 1,
        payload: { status: "executing", version: 2, reason: "running tools" },
      }),
      makeEvent({
        type: "work_state.changed", event_seq: 3,
        payload: { status: "verifying", version: 3, reason: "running verifier" },
      }),
    ];

    const result = rehydrateFromEvents(events, "run-1", "conv-1", "ws-1", "proj-1");
    expect(result.success).toBe(true);
    expect(result.workState!.status).toBe("verifying");
    expect(result.workState!.version).toBe(3);
  });

  it("reconstructs transport status from state_changed events", () => {
    const events = [
      makeEvent({ type: "run.state_changed", event_seq: 1, payload: { status: "context_building" } }),
      makeEvent({ type: "run.state_changed", event_seq: 3, payload: { status: "model_streaming" } }),
    ];

    const result = rehydrateFromEvents(events, "run-1", "conv-1", "ws-1", "proj-1");
    expect(result.success).toBe(true);
    expect(result.runState!.status).toBe("model_streaming");
  });

  it("replays tool ledger from events", () => {
    const events = [
      makeEvent({
        type: "tool.ledger_entry", event_seq: 1,
        payload: {
          logical_call_id: "lc-1", run_id: "run-1", tool_call_id: "tc-1",
          tool_name: "get_workspace_state", tool_version: 1, manifest_version: 1,
          attempt: 1, policy_decision: "allow", policy_reason: "ok",
          input_hash: "h1", idempotency_key: "k1",
          result_status: "success", side_effect_status: "no_side_effect",
          reconciliation_status: "none", started_at: "2026-01-01T00:00:00Z",
        },
      }),
    ];

    const result = rehydrateFromEvents(events, "run-1", "conv-1", "ws-1", "proj-1");
    expect(result.toolLedger.length).toBe(1);
    expect(result.toolLedger[0]!.toolName).toBe("get_workspace_state");
    expect(result.toolLedger[0]!.resultStatus).toBe("success");
  });

  it("reconstructs run plan from run_plan.created events", () => {
    const events = [
      makeEvent({
        type: "run_plan.created", event_seq: 2,
        payload: {
          plan_id: "plan-1", rationale: "test plan",
          steps: [
            { id: "step-1", goal: "Read state", status: "completed", dependencies: [], allowed_tools: ["get_workspace_state"] },
            { id: "step-2", goal: "Create proposal", status: "pending", dependencies: ["step-1"], allowed_tools: ["generate_plan"] },
          ],
        },
      }),
    ];

    const result = rehydrateFromEvents(events, "run-1", "conv-1", "ws-1", "proj-1");
    expect(result.runPlan).toBeDefined();
    expect(result.runPlan!.id).toBe("plan-1");
    expect(result.runPlan!.steps.length).toBe(2);
    expect(result.runPlan!.steps[0]!.status).toBe("completed");
  });

  it("cannot resume completed run", () => {
    const events = [
      makeEvent({ type: "run.state_changed", event_seq: 1, payload: { status: "completed" } }),
    ];

    const result = rehydrateFromEvents(events, "run-1", "conv-1", "ws-1", "proj-1");
    expect(result.canResume).toBe(false);
    expect(result.resumeReason).toContain("completed");
  });

  it("cannot resume when unknown side effects exist", () => {
    const events = [
      makeEvent({
        type: "tool.ledger_entry", event_seq: 1,
        payload: {
          logical_call_id: "lc-1", run_id: "run-1", tool_call_id: "tc-1",
          tool_name: "create_risk", tool_version: 1, manifest_version: 1,
          attempt: 1, policy_decision: "allow", policy_reason: "ok",
          input_hash: "h1", idempotency_key: "k1",
          result_status: "timeout", side_effect_status: "unknown",
          reconciliation_status: "manual_review", started_at: "2026-01-01T00:00:00Z",
        },
      }),
    ];

    const result = rehydrateFromEvents(events, "run-1", "conv-1", "ws-1", "proj-1");
    expect(result.canResume).toBe(false);
    expect(result.resumeReason).toContain("未知副作用");
  });

  it("can resume when tool has no_side_effect timeout", () => {
    const events = [
      makeEvent({ type: "run.state_changed", event_seq: 1, payload: { status: "model_streaming" } }),
      makeEvent({
        type: "tool.ledger_entry", event_seq: 2,
        payload: {
          logical_call_id: "lc-1", run_id: "run-1", tool_call_id: "tc-1",
          tool_name: "get_workspace_state", tool_version: 1, manifest_version: 1,
          attempt: 1, policy_decision: "allow", policy_reason: "ok",
          input_hash: "h1", idempotency_key: "k1",
          result_status: "timeout", side_effect_status: "no_side_effect",
          error_code: "timeout", reconciliation_status: "none",
          started_at: "2026-01-01T00:00:00Z",
        },
      }),
    ];

    const result = rehydrateFromEvents(events, "run-1", "conv-1", "ws-1", "proj-1");
    expect(result.canResume).toBe(true);
    expect(result.toolLedger.length).toBe(1);
  });

  it("uses checkpoint work state when available", () => {
    const checkpointPayload = {
      schemaVersion: 1, id: "ckpt-1", runId: "run-1",
      conversationId: "conv-1", workspaceId: "ws-1", projectId: "proj-1",
      transportStatus: "model_streaming",
      workState: { schemaVersion: 1, status: "awaiting_user", version: 5, expectedVersion: 4, timestamp: "2026-01-01" },
      workStateVersion: 5, manifestVersions: {}, toolLedgerRefs: [],
      timestamp: "2026-01-01", version: 2,
    };

    const events = [
      makeEvent({
        type: "checkpoint.saved", event_seq: 10,
        payload: { checkpoint: checkpointPayload },
      }),
    ];

    const result = rehydrateFromEvents(events, "run-1", "conv-1", "ws-1", "proj-1");
    expect(result.success).toBe(true);
    expect(result.workState!.status).toBe("awaiting_user");
    expect(result.workState!.version).toBe(5);
    expect(result.checkpoint).toBeDefined();
    expect(result.checkpoint!.id).toBe("ckpt-1");
  });
});

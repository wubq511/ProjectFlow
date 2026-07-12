/**
 * Phase 5 scenario tests — Checkpoint, Resume, and Steering.
 *
 * Verifies:
 * - Checkpoint persists at reliable boundaries
 * - Rehydrate rebuilds state from events
 * - No-duplicate side-effect enforcement
 * - Recovery policy for different tool outcomes
 * - Terminal states cannot resume
 * - Manifest compatibility check
 */

import { describe, it, expect } from "vitest";
import { createCheckpoint, canResumeCheckpoint } from "../../src/runtime/checkpoint.js";
import { rehydrateFromEvents } from "../../src/runtime/rehydrate.js";
import { replayLedgerFromEvents, hasUnknownSideEffects } from "../../src/tools/tool-ledger.js";
import type { AgentRunState } from "../../src/types/run-state.js";
import type { WorkState } from "../../src/runtime/work-state.js";
import type { ToolLedgerEntry } from "../../src/tools/tool-executor.js";

function makeRunState(status: AgentRunState["status"] = "model_streaming"): AgentRunState {
  return {
    runId: "run-1", conversationId: "conv-1", workspaceId: "ws-1", projectId: "proj-1",
    status, currentTurn: 1, currentStep: 2,
    model: { provider: "mock", name: "mock" },
    sideEffects: [], toolResults: [], lastEventSeq: 10,
    budgetLimits: { maxSteps: 8, maxToolCalls: 6, timeoutMs: 180000 },
    resumePolicy: { manifestVersion: 1, requiresRegenerationOnMismatch: true },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:02:00Z",
  };
}

function makeWorkState(status: WorkState["status"] = "executing"): WorkState {
  return {
    schemaVersion: 1, status, version: 4, expectedVersion: 3,
    timestamp: "2026-01-01T00:02:00Z",
  };
}

function makeLedger(overrides: Partial<ToolLedgerEntry> = {}): ToolLedgerEntry {
  return {
    logicalCallId: "run-1_tc-1", runId: "run-1", toolCallId: "tc-1",
    toolName: "get_workspace_state", toolVersion: 1, manifestVersion: 1, attempt: 1,
    policyDecision: "allow", policyReason: "read-only", inputHash: "h1",
    idempotencyKey: "run-1_tc-1:attempt:1", reconciliationStatus: "none",
    startedAt: "2026-01-01T00:00:30Z", completedAt: "2026-01-01T00:00:31Z", durationMs: 1000,
    ...overrides,
  };
}

describe("Phase 5 scenarios", () => {
  // ── Scenario 1: Checkpoint at reliable boundary ─────────────────────

  describe("Checkpoint at reliable boundary", () => {
    it("checkpoint captures work state, plan, and ledger refs", () => {
      const runState = makeRunState();
      const workState = makeWorkState("executing");
      const ledger = [
        makeLedger({ resultStatus: "success", sideEffectStatus: "no_side_effect" }),
        makeLedger({
          logicalCallId: "run-1_tc-2", toolCallId: "tc-2", toolName: "generate_plan",
          resultStatus: "success", sideEffectStatus: "proposal_persisted",
        }),
      ];

      const ckpt = createCheckpoint(runState, workState, undefined, undefined, ledger, "tool_result", 1);

      expect(ckpt.workState.status).toBe("executing");
      expect(ckpt.workStateVersion).toBe(4);
      expect(ckpt.toolLedgerRefs.length).toBe(2);
      expect(ckpt.recoveryDecisions!.length).toBe(2);
      expect(ckpt.recoveryDecisions![0]!.action).toBe("completed");
      expect(ckpt.recoveryDecisions![1]!.action).toBe("completed");
    });
  });

  // ── Scenario 2: Rehydrate from events ───────────────────────────────

  describe("Rehydrate from events", () => {
    it("rebuilds state from mixed event types", () => {
      const events = [
        { id: "e1", run_id: "run-1", type: "run.state_changed", event_seq: 1,
          payload: { status: "context_building" }, trace: {}, created_at: "2026-01-01T00:00:00Z" },
        { id: "e2", run_id: "run-1", type: "work_state.changed", event_seq: 2,
          payload: { status: "planning", version: 2 }, trace: {}, created_at: "2026-01-01T00:00:01Z" },
        { id: "e3", run_id: "run-1", type: "run.state_changed", event_seq: 3,
          payload: { status: "model_streaming" }, trace: {}, created_at: "2026-01-01T00:00:02Z" },
        { id: "e4", run_id: "run-1", type: "work_state.changed", event_seq: 4,
          payload: { status: "executing", version: 3 }, trace: {}, created_at: "2026-01-01T00:00:03Z" },
        { id: "e5", run_id: "run-1", type: "tool.ledger_entry", event_seq: 5,
          payload: { logical_call_id: "lc-1", run_id: "run-1", tool_call_id: "tc-1",
            tool_name: "get_workspace_state", tool_version: 1, manifest_version: 1,
            attempt: 1, policy_decision: "allow", policy_reason: "ok",
            input_hash: "h1", idempotency_key: "k1",
            result_status: "success", side_effect_status: "no_side_effect",
            reconciliation_status: "none", started_at: "2026-01-01T00:00:03Z" },
          trace: {}, created_at: "2026-01-01T00:00:04Z" },
      ];

      const result = rehydrateFromEvents(events, "run-1", "conv-1", "ws-1", "proj-1");
      expect(result.success).toBe(true);
      expect(result.workState!.status).toBe("executing");
      expect(result.workState!.version).toBe(3);
      expect(result.runState!.status).toBe("model_streaming");
      expect(result.toolLedger.length).toBe(1);
      expect(result.canResume).toBe(true);
    });
  });

  // ── Scenario 3: No-duplicate side-effect enforcement ────────────────

  describe("No-duplicate side-effect enforcement", () => {
    it("proposal_persisted is completed, not replayed", () => {
      const ledger = [
        makeLedger({
          resultStatus: "success", sideEffectStatus: "proposal_persisted",
        }),
      ];

      const ckpt = createCheckpoint(makeRunState(), makeWorkState(), undefined, undefined, ledger, "tool_result", 1);
      expect(ckpt.recoveryDecisions![0]!.action).toBe("completed");
    });

    it("advisory_record_persisted is completed, not replayed", () => {
      const ledger = [
        makeLedger({
          resultStatus: "success", sideEffectStatus: "advisory_record_persisted",
        }),
      ];

      const ckpt = createCheckpoint(makeRunState(), makeWorkState(), undefined, undefined, ledger, "tool_result", 1);
      expect(ckpt.recoveryDecisions![0]!.action).toBe("completed");
    });

    it("unknown side effect blocks resume", () => {
      const ledger = [
        makeLedger({
          resultStatus: "timeout", sideEffectStatus: "unknown", errorCode: "timeout",
        }),
      ];

      const ckpt = createCheckpoint(makeRunState(), makeWorkState(), undefined, undefined, ledger, "tool_result", 1);
      expect(ckpt.recoveryDecisions![0]!.action).toBe("blocked_unknown");

      const resumeCheck = canResumeCheckpoint(ckpt);
      expect(resumeCheck.canResume).toBe(false);
    });
  });

  // ── Scenario 4: Terminal states cannot resume ────────────────────────

  describe("Terminal states cannot resume", () => {
    it("completed transport cannot resume", () => {
      const ckpt = createCheckpoint(
        makeRunState("completed"), makeWorkState("completed"),
        undefined, undefined, [], "pre_terminal", 1,
      );
      expect(canResumeCheckpoint(ckpt).canResume).toBe(false);
    });

    it("failed transport cannot resume", () => {
      const ckpt = createCheckpoint(
        makeRunState("failed"), makeWorkState("failed"),
        undefined, undefined, [], "pre_terminal", 1,
      );
      expect(canResumeCheckpoint(ckpt).canResume).toBe(false);
    });

    it("cancelled transport cannot resume", () => {
      const ckpt = createCheckpoint(
        makeRunState("cancelled"), makeWorkState("cancelled"),
        undefined, undefined, [], "pre_terminal", 1,
      );
      expect(canResumeCheckpoint(ckpt).canResume).toBe(false);
    });
  });

  // ── Scenario 5: Recovery policy ─────────────────────────────────────

  describe("Recovery policy", () => {
    it("timeout with no_side_effect is safe to retry", () => {
      const ledger = [makeLedger({ resultStatus: "timeout", sideEffectStatus: "no_side_effect", errorCode: "timeout" })];
      const ckpt = createCheckpoint(makeRunState(), makeWorkState(), undefined, undefined, ledger, "tool_result", 1);
      expect(ckpt.recoveryDecisions![0]!.action).toBe("safe_to_retry");
    });

    it("transient error with no_side_effect is safe to retry", () => {
      const ledger = [makeLedger({ resultStatus: "failed", sideEffectStatus: "no_side_effect", errorCode: "transient" })];
      const ckpt = createCheckpoint(makeRunState(), makeWorkState(), undefined, undefined, ledger, "tool_result", 1);
      expect(ckpt.recoveryDecisions![0]!.action).toBe("safe_to_retry");
    });

    it("policy error is blocked", () => {
      const ledger = [makeLedger({ resultStatus: "blocked", sideEffectStatus: "no_side_effect", errorCode: "policy" })];
      const ckpt = createCheckpoint(makeRunState(), makeWorkState(), undefined, undefined, ledger, "tool_result", 1);
      expect(ckpt.recoveryDecisions![0]!.action).toBe("blocked_incompatible");
    });

    it("validation error is blocked", () => {
      const ledger = [makeLedger({ resultStatus: "validation_error", sideEffectStatus: "no_side_effect", errorCode: "validation" })];
      const ckpt = createCheckpoint(makeRunState(), makeWorkState(), undefined, undefined, ledger, "tool_result", 1);
      expect(ckpt.recoveryDecisions![0]!.action).toBe("blocked_incompatible");
    });
  });

  // ── Scenario 6: hasUnknownSideEffects ───────────────────────────────

  describe("hasUnknownSideEffects", () => {
    it("detects unknown side effects in ledger", () => {
      const ledger = [
        makeLedger({ sideEffectStatus: "no_side_effect" }),
        makeLedger({ logicalCallId: "run-1_tc-2", sideEffectStatus: "unknown" }),
      ];
      expect(hasUnknownSideEffects(ledger)).toBe(true);
    });

    it("returns false when all side effects are known", () => {
      const ledger = [
        makeLedger({ sideEffectStatus: "no_side_effect" }),
        makeLedger({ logicalCallId: "run-1_tc-2", sideEffectStatus: "proposal_persisted" }),
      ];
      expect(hasUnknownSideEffects(ledger)).toBe(false);
    });
  });
});

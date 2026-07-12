/**
 * Checkpoint tests — durable snapshots and recovery policy.
 */

import { describe, it, expect } from "vitest";
import {
  createCheckpoint,
  canResumeCheckpoint,
} from "../../src/runtime/checkpoint.js";
import type { RunCheckpoint } from "../../src/runtime/checkpoint.js";
import type { AgentRunState } from "../../src/types/run-state.js";
import type { WorkState } from "../../src/runtime/work-state.js";
import type { ToolLedgerEntry } from "../../src/tools/tool-executor.js";

function makeRunState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    runId: "run-1", conversationId: "conv-1", workspaceId: "ws-1", projectId: "proj-1",
    status: "model_streaming", currentTurn: 1, currentStep: 1,
    model: { provider: "mock", name: "mock" },
    sideEffects: [], toolResults: [], lastEventSeq: 5,
    budgetLimits: { maxSteps: 8, maxToolCalls: 6, timeoutMs: 180000 },
    resumePolicy: { manifestVersion: 1, requiresRegenerationOnMismatch: true },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z",
    ...overrides,
  };
}

function makeWorkState(overrides: Partial<WorkState> = {}): WorkState {
  return {
    schemaVersion: 1, status: "executing", version: 3, expectedVersion: 2,
    timestamp: "2026-01-01T00:01:00Z", reason: "executing tools",
    ...overrides,
  };
}

function makeLedgerEntry(overrides: Partial<ToolLedgerEntry> = {}): ToolLedgerEntry {
  return {
    logicalCallId: "run-1_tc-1", runId: "run-1", toolCallId: "tc-1",
    toolName: "get_workspace_state", toolVersion: 1, manifestVersion: 1, attempt: 1,
    policyDecision: "allow", policyReason: "read-only", inputHash: "hash1",
    idempotencyKey: "run-1_tc-1:attempt:1", reconciliationStatus: "none",
    startedAt: "2026-01-01T00:00:30Z", completedAt: "2026-01-01T00:00:31Z", durationMs: 1000,
    ...overrides,
  };
}

describe("Checkpoint", () => {
  describe("createCheckpoint", () => {
    it("creates a checkpoint with correct fields", () => {
      const runState = makeRunState();
      const workState = makeWorkState();
      const ledger = [makeLedgerEntry()];

      const ckpt = createCheckpoint(runState, workState, undefined, undefined, ledger, "tool_result", 1);

      expect(ckpt.schemaVersion).toBe(1);
      expect(ckpt.runId).toBe("run-1");
      expect(ckpt.workState.status).toBe("executing");
      expect(ckpt.workStateVersion).toBe(3);
      expect(ckpt.transportStatus).toBe("model_streaming");
      expect(ckpt.version).toBe(1);
      expect(ckpt.toolLedgerRefs.length).toBe(1);
      expect(ckpt.toolLedgerRefs[0]!.toolName).toBe("get_workspace_state");
    });

    it("includes run plan snapshot when present", () => {
      const runState = makeRunState();
      const workState = makeWorkState();
      const runPlan = {
        schemaVersion: 1 as const, id: "plan-1", rationale: "test",
        steps: [{
          id: "step-1", goal: "Read state", dependencies: [], allowedTools: ["get_workspace_state"],
          completionCriteria: [], status: "completed" as const, attemptCount: 1,
          maxAttempts: 3, failurePolicy: "abort" as const,
        }],
        currentStepIndex: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01",
      };

      const ckpt = createCheckpoint(runState, workState, runPlan, undefined, [], "plan_update", 2);

      expect(ckpt.runPlanSnapshot).toBeDefined();
      expect(ckpt.runPlanSnapshot!.planId).toBe("plan-1");
      expect(ckpt.runPlanSnapshot!.stepCount).toBe(1);
      expect(ckpt.runPlanSnapshot!.steps[0]!.status).toBe("completed");
    });

    it("includes outcome contract summary when present", () => {
      const runState = makeRunState();
      const workState = makeWorkState();
      const contract = {
        schemaVersion: 1 as const, requestType: "act" as const,
        normalizedGoal: "制定阶段计划", constraints: [], successCriteria: [],
        requiredEvidence: [], effectCeiling: "proposal_only" as const,
        clarificationPolicy: "never" as const, verificationLevel: "deterministic" as const,
        completionMode: "complete" as const,
      };

      const ckpt = createCheckpoint(runState, workState, undefined, contract, [], "pre_terminal", 3);

      expect(ckpt.outcomeContractSummary).toBeDefined();
      expect(ckpt.outcomeContractSummary!.requestType).toBe("act");
      expect(ckpt.outcomeContractSummary!.effectCeiling).toBe("proposal_only");
    });

    it("computes recovery decisions for tool ledger", () => {
      const runState = makeRunState();
      const workState = makeWorkState();
      const ledger = [
        makeLedgerEntry({ resultStatus: "success", sideEffectStatus: "no_side_effect" }),
        makeLedgerEntry({
          logicalCallId: "run-1_tc-2", toolCallId: "tc-2", toolName: "create_risk",
          resultStatus: "timeout", sideEffectStatus: "unknown", errorCode: "timeout",
        }),
      ];

      const ckpt = createCheckpoint(runState, workState, undefined, undefined, ledger, "tool_result", 1);

      expect(ckpt.recoveryDecisions).toBeDefined();
      expect(ckpt.recoveryDecisions!.length).toBe(2);
      expect(ckpt.recoveryDecisions![0]!.action).toBe("completed");
      expect(ckpt.recoveryDecisions![1]!.action).toBe("blocked_unknown");
    });
  });

  describe("canResumeCheckpoint", () => {
    it("allows resume for non-terminal states", () => {
      const ckpt: RunCheckpoint = {
        schemaVersion: 1, id: "ckpt-1", runId: "run-1",
        conversationId: "c-1", workspaceId: "ws-1", projectId: "p-1",
        transportStatus: "model_streaming",
        workState: makeWorkState({ status: "executing" }),
        workStateVersion: 3, manifestVersions: {}, toolLedgerRefs: [],
        timestamp: "2026-01-01", version: 1,
      };

      const result = canResumeCheckpoint(ckpt);
      expect(result.canResume).toBe(true);
    });

    it("blocks resume for completed transport", () => {
      const ckpt: RunCheckpoint = {
        schemaVersion: 1, id: "ckpt-1", runId: "run-1",
        conversationId: "c-1", workspaceId: "ws-1", projectId: "p-1",
        transportStatus: "completed",
        workState: makeWorkState({ status: "completed" }),
        workStateVersion: 5, manifestVersions: {}, toolLedgerRefs: [],
        timestamp: "2026-01-01", version: 3,
      };

      const result = canResumeCheckpoint(ckpt);
      expect(result.canResume).toBe(false);
      expect(result.reason).toContain("completed");
    });

    it("blocks resume for unknown side effects", () => {
      const ckpt: RunCheckpoint = {
        schemaVersion: 1, id: "ckpt-1", runId: "run-1",
        conversationId: "c-1", workspaceId: "ws-1", projectId: "p-1",
        transportStatus: "model_streaming",
        workState: makeWorkState(),
        workStateVersion: 3, manifestVersions: {}, toolLedgerRefs: [],
        recoveryDecisions: [
          { toolName: "create_risk", toolCallId: "tc-1", logicalCallId: "lc-1",
            action: "blocked_unknown", reason: "unknown side effect" },
        ],
        timestamp: "2026-01-01", version: 1,
      };

      const result = canResumeCheckpoint(ckpt);
      expect(result.canResume).toBe(false);
      expect(result.reason).toContain("create_risk");
    });
  });
});

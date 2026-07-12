/**
 * Phase 3 scenario tests — WorkState, RunPlan, and Verifier integration.
 *
 * Verifies:
 * - Answer-only has no plan
 * - Non-trivial action creates plan and progresses WorkState
 * - Stale/illegal WorkState transitions are rejected
 * - Verifier pass → complete
 * - Missing tool evidence → partial/blocked
 * - Privacy/raw ID/date fail
 * - Same run doesn't produce conflicting terminal events
 * - Progress events don't contain chain-of-thought
 */

import { describe, it, expect } from "vitest";
import { buildContext } from "../../src/runtime/context-builder.js";
import { verify } from "../../src/runtime/verifier.js";
import { shouldCreatePlan, createSimplePlan, getPlanProgress } from "../../src/runtime/run-plan.js";
import { createInitialWorkState, transitionWorkState, isTerminalWorkState } from "../../src/runtime/work-state.js";
import type { OutcomeContract } from "../../src/runtime/outcome-contract.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";

function makeManifest(name: string): ProjectFlowToolManifest {
  return {
    schemaVersion: 1, name, version: 1, description: `Tool: ${name}`,
    riskCategory: "read_only", modelCallable: true, sidecarOnly: false, humanTriggeredOnly: false,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    inputSchema: { type: "object", properties: {} }, outputSchema: {},
    execution: { mode: "parallel", maxConcurrency: 1, providerParallelToolCallsAllowed: true },
    timeoutMs: 5000, retry: { maxAttempts: 1, retryOn: [] },
    resultLimit: { maxBytes: 32768, redaction: "none" },
    backend: { owner: "fastapi", endpoint: `/internal/agent-tools/${name}`, method: "POST" },
    effects: { effectType: "none", idempotencyKeyRequired: false, replaySafe: true },
    privacy: { dataClassification: "public", traceIncludeInputs: true, traceIncludeOutputs: true },
    errors: { modelVisibleErrorPolicy: "normalized_summary" },
    resume: { manifestVersion: 1, incompatibleVersionPolicy: "regenerate" },
    trace: { emits: [] },
  };
}

function makeContract(overrides: Partial<OutcomeContract> = {}): OutcomeContract {
  return {
    schemaVersion: 1, requestType: "act", normalizedGoal: "制定阶段计划",
    constraints: [], successCriteria: ["调用必要的工具"], requiredEvidence: ["tool_results"],
    effectCeiling: "proposal_only", clarificationPolicy: "never",
    verificationLevel: "deterministic", completionMode: "complete",
    ...overrides,
  };
}

describe("Phase 3 scenarios", () => {
  // ── Scenario 1: Answer-only has no plan ─────────────────────────────

  describe("Answer-only has no plan", () => {
    it("answer request does not create a plan", () => {
      const contract = makeContract({ requestType: "answer", completionMode: "answer-only" });
      expect(shouldCreatePlan(contract, "项目进展如何？")).toBe(false);
    });

    it("answer mode produces no tools", () => {
      const result = buildContext({
        userContent: "项目进展如何？",
        toolManifests: [makeManifest("get_workspace_state")],
        isAnswerMode: true,
        maxContextTokens: 32000,
      });

      expect(result.tools).toEqual([]);
      expect(result.systemPrompt).toContain("可以直接回答");
    });
  });

  // ── Scenario 2: Non-trivial action creates plan ────────────────────

  describe("Non-trivial action creates plan", () => {
    it("act request with side effects creates a plan", () => {
      const contract = makeContract({ effectCeiling: "proposal_only" });
      expect(shouldCreatePlan(contract, "帮我制定计划")).toBe(true);
    });

    it("plan has correct structure", () => {
      const contract = makeContract();
      const plan = createSimplePlan("plan-1", contract, ["get_workspace_state", "generate_plan"]);

      expect(plan.steps.length).toBe(1);
      expect(plan.steps[0]!.goal).toBe("制定阶段计划");
      expect(plan.steps[0]!.status).toBe("pending");
      expect(plan.steps[0]!.maxAttempts).toBe(3);
    });

    it("plan progress is trackable", () => {
      const contract = makeContract();
      const plan = createSimplePlan("plan-1", contract, []);
      const progress = getPlanProgress(plan);

      expect(progress.current).toBe(1);
      expect(progress.total).toBe(1);
      expect(progress.status).toBe("pending");
    });
  });

  // ── Scenario 3: Stale/illegal WorkState transitions rejected ────────

  describe("WorkState transition validation", () => {
    it("rejects illegal transition", () => {
      const ws = createInitialWorkState();
      // understanding → verifying is NOT valid (must go through planning/executing first)
      expect(() => transitionWorkState(ws, "verifying", ws.version)).toThrow("Illegal WorkState transition");
    });

    it("rejects stale version", () => {
      const ws = createInitialWorkState();
      expect(() => transitionWorkState(ws, "planning", 999)).toThrow("version mismatch");
    });

    it("valid transitions work correctly", () => {
      let ws = createInitialWorkState();
      ws = transitionWorkState(ws, "planning", ws.version);
      ws = transitionWorkState(ws, "executing", ws.version);
      ws = transitionWorkState(ws, "verifying", ws.version);
      ws = transitionWorkState(ws, "completed", ws.version);

      expect(ws.status).toBe("completed");
      expect(ws.version).toBe(5);
    });

    it("terminal states cannot transition", () => {
      const ws = createInitialWorkState();
      const completed = transitionWorkState(ws, "planning", ws.version);
      const executing = transitionWorkState(completed, "executing", completed.version);
      const verified = transitionWorkState(executing, "verifying", executing.version);
      const final = transitionWorkState(verified, "completed", verified.version);

      expect(isTerminalWorkState(final.status)).toBe(true);
      expect(() => transitionWorkState(final, "executing", final.version)).toThrow("Illegal");
    });
  });

  // ── Scenario 4: Verifier pass → complete ────────────────────────────

  describe("Verifier pass → complete", () => {
    it("all dimensions pass → complete", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeContract(),
        toolResults: [{
          toolCallId: "tc-1", toolName: "generate_plan",
          sideEffectStatus: "proposal_persisted", observation: "计划已创建",
        }],
        finalContent: "「小林」负责「后端」，截止 2026-08-01",
        hasTools: true,
      });

      expect(report.passed).toBe(true);
      expect(report.completion).toBe("complete");
      expect(report.dimensions.every((d) => d.passed)).toBe(true);
    });
  });

  // ── Scenario 5: Missing tool evidence → partial ─────────────────────

  describe("Missing tool evidence → partial", () => {
    it("action request without tools → partial", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeContract({ requestType: "act" }),
        toolResults: [],
        finalContent: "内容",
        hasTools: true,
      });

      expect(report.completion).toBe("partial");
      expect(report.hasFixableFailures).toBe(true);

      const dim = report.dimensions.find((d) => d.name === "tool_evidence");
      expect(dim?.passed).toBe(false);
      expect(dim?.fixable).toBe(true);
    });
  });

  // ── Scenario 6: Privacy/raw ID/date fail ────────────────────────────

  describe("Privacy/localization failures", () => {
    it("raw UUID fails privacy check", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeContract(),
        toolResults: [{ toolCallId: "tc-1", toolName: "t", sideEffectStatus: "proposal_persisted", observation: "ok" }],
        finalContent: "用户 550e8400-e29b-41d4-a716-446655440000",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "localization_privacy");
      expect(dim?.passed).toBe(false);
    });

    it("raw ID pattern fails", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeContract(),
        toolResults: [{ toolCallId: "tc-1", toolName: "t", sideEffectStatus: "proposal_persisted", observation: "ok" }],
        finalContent: "task_abc123 已完成",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "localization_privacy");
      expect(dim?.passed).toBe(false);
    });

    it("non-YYYY-MM-DD date fails", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeContract(),
        toolResults: [{ toolCallId: "tc-1", toolName: "t", sideEffectStatus: "proposal_persisted", observation: "ok" }],
        finalContent: "截止 2026/08/01",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "localization_privacy");
      expect(dim?.passed).toBe(false);
    });
  });

  // ── Scenario 7: No conflicting terminal events ──────────────────────

  describe("No conflicting terminal events", () => {
    it("terminal WorkState is consistent", () => {
      let ws = createInitialWorkState();
      ws = transitionWorkState(ws, "executing", ws.version);
      ws = transitionWorkState(ws, "verifying", ws.version);
      ws = transitionWorkState(ws, "completed", ws.version);

      // Cannot transition from completed
      expect(isTerminalWorkState(ws.status)).toBe(true);
      expect(() => transitionWorkState(ws, "failed", ws.version)).toThrow("Illegal");
    });

    it("verifier report has single completion classification", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeContract(),
        toolResults: [{ toolCallId: "tc-1", toolName: "t", sideEffectStatus: "proposal_persisted", observation: "ok" }],
        finalContent: "「小林」负责「后端」",
        hasTools: true,
      });

      // Only one completion classification
      expect(report.completion).toBeDefined();
      expect(typeof report.completion).toBe("string");
    });
  });

  // ── Scenario 8: Progress doesn't contain chain-of-thought ───────────

  describe("Progress events are user-safe", () => {
    it("WorkState messages are user-safe", () => {
      const ws = createInitialWorkState();
      // No chain-of-thought in state
      expect(ws.reason).toBeDefined();
      // Reason is short and safe
      expect(ws.reason!.length).toBeLessThan(100);
    });

    it("plan progress is user-safe", () => {
      const contract = makeContract();
      const plan = createSimplePlan("plan-1", contract, []);
      const progress = getPlanProgress(plan);

      // Goal is from the contract (user-safe)
      expect(progress.currentGoal).toBe("制定阶段计划");
      // No internal details exposed
      expect(progress.currentGoal).not.toContain("tool");
      expect(progress.currentGoal).not.toContain("api");
    });
  });
});

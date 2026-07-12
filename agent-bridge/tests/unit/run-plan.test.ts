/**
 * RunPlan tests — plan creation, step advancement, failure policies.
 */

import { describe, it, expect } from "vitest";
import {
  shouldCreatePlan,
  createSimplePlan,
  createMultiStepPlan,
  advancePlanStep,
  failPlanStep,
  getCurrentStep,
  getPlanProgress,
} from "../../src/runtime/run-plan.js";
import type { OutcomeContract } from "../../src/runtime/outcome-contract.js";

function makeOutcomeContract(overrides: Partial<OutcomeContract> = {}): OutcomeContract {
  return {
    schemaVersion: 1,
    requestType: "act",
    normalizedGoal: "制定阶段计划",
    constraints: [],
    successCriteria: ["调用必要的工具"],
    requiredEvidence: ["tool_results"],
    effectCeiling: "proposal_only",
    clarificationPolicy: "never",
    verificationLevel: "deterministic",
    completionMode: "complete",
    ...overrides,
  };
}

describe("RunPlan", () => {
  describe("shouldCreatePlan", () => {
    it("returns false for answer requests", () => {
      expect(shouldCreatePlan(makeOutcomeContract({ requestType: "answer" }), "你好")).toBe(false);
    });

    it("returns false for answer-only completion", () => {
      expect(shouldCreatePlan(makeOutcomeContract({ completionMode: "answer-only" }), "你好")).toBe(false);
    });

    it("returns false for clarify requests", () => {
      expect(shouldCreatePlan(makeOutcomeContract({ requestType: "clarify" }), "需要什么信息？")).toBe(false);
    });

    it("returns true for act with side effects", () => {
      expect(shouldCreatePlan(makeOutcomeContract({ effectCeiling: "proposal_only" }), "制定计划")).toBe(true);
    });

    it("returns true for analyze with verification", () => {
      expect(shouldCreatePlan(makeOutcomeContract({
        requestType: "analyze",
        verificationLevel: "deterministic",
      }), "分析风险")).toBe(true);
    });
  });

  describe("createSimplePlan", () => {
    it("creates a single-step plan", () => {
      const contract = makeOutcomeContract();
      const plan = createSimplePlan("plan-1", contract, ["get_workspace_state", "generate_plan"]);

      expect(plan.id).toBe("plan-1");
      expect(plan.steps.length).toBe(1);
      expect(plan.steps[0]!.status).toBe("pending");
      expect(plan.steps[0]!.allowedTools).toEqual(["get_workspace_state", "generate_plan"]);
      expect(plan.currentStepIndex).toBe(0);
    });

    it("uses contract success criteria", () => {
      const contract = makeOutcomeContract({ successCriteria: ["工具调用成功", "结果有效"] });
      const plan = createSimplePlan("plan-1", contract, []);
      expect(plan.steps[0]!.completionCriteria).toEqual(["工具调用成功", "结果有效"]);
    });
  });

  describe("createMultiStepPlan", () => {
    it("creates a multi-step plan with dependencies", () => {
      const contract = makeOutcomeContract();
      const plan = createMultiStepPlan("plan-1", contract, [
        { goal: "读取状态", tools: ["get_workspace_state"] },
        { goal: "生成计划", tools: ["generate_plan"], dependencies: ["step-1"] },
      ]);

      expect(plan.steps.length).toBe(2);
      expect(plan.steps[0]!.dependencies).toEqual([]);
      expect(plan.steps[1]!.dependencies).toEqual(["step-1"]);
    });
  });

  describe("advancePlanStep", () => {
    it("advances to next step", () => {
      const contract = makeOutcomeContract();
      const plan = createMultiStepPlan("plan-1", contract, [
        { goal: "Step 1", tools: [] },
        { goal: "Step 2", tools: [] },
      ]);

      const advanced = advancePlanStep(plan);
      expect(advanced).not.toBeNull();
      expect(advanced!.currentStepIndex).toBe(1);
      expect(advanced!.steps[0]!.status).toBe("completed");
    });

    it("returns null when no more steps after advancing", () => {
      const contract = makeOutcomeContract();
      const plan = createSimplePlan("plan-1", contract, []);

      const advanced = advancePlanStep(plan);
      // Single step plan — advancing completes it, no more steps → returns null
      expect(advanced).toBeNull();
    });
  });

  describe("failPlanStep", () => {
    it("increments attempt count", () => {
      const contract = makeOutcomeContract();
      const plan = createSimplePlan("plan-1", contract, []);

      const { plan: updated, action } = failPlanStep(plan, "step-1", "tool failed");
      expect(updated.steps[0]!.attemptCount).toBe(1);
      expect(action).toBe("retry"); // not at max attempts yet
    });

    it("applies failure policy at max attempts", () => {
      const contract = makeOutcomeContract();
      const plan = createSimplePlan("plan-1", contract, []);
      plan.steps[0]!.maxAttempts = 1;

      const { plan: updated, action } = failPlanStep(plan, "step-1", "tool failed");
      expect(updated.steps[0]!.status).toBe("failed");
      expect(action).toBe("abort");
    });
  });

  describe("getPlanProgress", () => {
    it("returns progress information", () => {
      const contract = makeOutcomeContract();
      const plan = createSimplePlan("plan-1", contract, []);

      const progress = getPlanProgress(plan);
      expect(progress.current).toBe(1);
      expect(progress.total).toBe(1);
      expect(progress.currentGoal).toBe("制定阶段计划");
    });
  });
});

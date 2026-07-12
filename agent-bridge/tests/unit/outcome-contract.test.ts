/**
 * Outcome Contract tests — deterministic classification rules.
 *
 * Verifies that requests are classified into the correct Outcome Contract
 * without any LLM involvement.
 */

import { describe, it, expect } from "vitest";
import { classifyRequest } from "../../src/runtime/outcome-contract.js";
import type { SkillContext } from "../../src/runtime/context-builder.js";

function makeSkill(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    name: "test-skill",
    description: "Test skill",
    body: "body",
    allowedTools: ["get_workspace_state"],
    ...overrides,
  };
}

describe("Outcome Contract — classifyRequest", () => {
  // ── Answer mode (no skill) ─────────────────────────────────────────

  describe("answer mode", () => {
    it("classifies general question as answer/answer-only/none", () => {
      const contract = classifyRequest({
        userContent: "项目进展如何？",
      });

      expect(contract.requestType).toBe("answer");
      expect(contract.completionMode).toBe("answer-only");
      expect(contract.effectCeiling).toBe("none");
      expect(contract.verificationLevel).toBe("none");
      expect(contract.clarificationPolicy).toBe("never");
      expect(contract.schemaVersion).toBe(1);
    });

    it("normalizes goal from user content", () => {
      const contract = classifyRequest({
        userContent: "请帮我分析一下当前的项目状态",
      });

      expect(contract.normalizedGoal).toContain("请帮我分析一下当前的项目状态");
    });
  });

  // ── Action mode (with skill) ───────────────────────────────────────

  describe("action mode", () => {
    it("classifies skill with proposal tools as act/proposal_only", () => {
      const contract = classifyRequest({
        userContent: "帮我制定计划",
        skillContext: makeSkill({
          name: "project-planning",
          allowedTools: ["get_workspace_state", "generate_stage_plan_proposal"],
        }),
      });

      expect(contract.requestType).toBe("act");
      expect(contract.effectCeiling).toBe("proposal_only");
      expect(contract.completionMode).toBe("complete");
      expect(contract.verificationLevel).toBe("deterministic");
    });

    it("classifies skill with advisory tools as act/advisory_only", () => {
      const contract = classifyRequest({
        userContent: "分析当前风险",
        skillContext: makeSkill({
          name: "risk-analysis",
          allowedTools: ["get_workspace_state", "get_timeline_slice", "create_risk"],
        }),
      });

      expect(contract.requestType).toBe("act");
      expect(contract.effectCeiling).toBe("advisory_only");
    });

    it("classifies analysis-only skill as analyze", () => {
      const contract = classifyRequest({
        userContent: "查看项目状态",
        skillContext: makeSkill({
          name: "project-status",
          allowedTools: ["get_workspace_state", "get_timeline_slice", "list_pending_proposals"],
        }),
      });

      expect(contract.requestType).toBe("analyze");
      // Analysis with no advisory tools has effect ceiling "none"
      expect(contract.effectCeiling).toBe("none");
      expect(contract.verificationLevel).toBe("none");
    });
  });

  // ── Review mode ────────────────────────────────────────────────────

  describe("review mode", () => {
    it("classifies proposal confirmation as review", () => {
      const contract = classifyRequest({
        userContent: "确认这个提案",
      });

      expect(contract.requestType).toBe("review");
      expect(contract.effectCeiling).toBe("none");
      expect(contract.completionMode).toBe("complete");
    });

    it("classifies proposal rejection as review", () => {
      const contract = classifyRequest({
        userContent: "拒绝这个提案",
      });

      expect(contract.requestType).toBe("review");
    });
  });

  // ── Constraints ────────────────────────────────────────────────────

  describe("constraints", () => {
    it("always includes base constraints", () => {
      const contract = classifyRequest({ userContent: "你好" });

      expect(contract.constraints).toContain("不得直接修改 Primary Project State");
      expect(contract.constraints).toContain("不得编造成员、任务、阶段");
      expect(contract.constraints).toContain("用户可见文本使用中文");
    });

    it("adds tool constraints when skill is present", () => {
      const contract = classifyRequest({
        userContent: "帮我制定计划",
        skillContext: makeSkill({
          allowedTools: ["get_workspace_state", "generate_stage_plan_proposal"],
        }),
      });

      expect(contract.constraints.some((c) => c.includes("get_workspace_state"))).toBe(true);
    });
  });

  // ── Success criteria ───────────────────────────────────────────────

  describe("success criteria", () => {
    it("answer mode has minimal criteria", () => {
      const contract = classifyRequest({ userContent: "你好" });

      expect(contract.successCriteria).toContain("回答基于可用上下文");
      expect(contract.successCriteria).toContain("不产生副作用");
    });

    it("action mode requires tool calls", () => {
      const contract = classifyRequest({
        userContent: "帮我制定计划",
        skillContext: makeSkill({
          name: "project-planning",
          allowedTools: ["get_workspace_state", "generate_stage_plan_proposal"],
        }),
      });

      expect(contract.requestType).toBe("act");
      expect(contract.successCriteria).toContain("调用必要的工具");
    });
  });
});

/**
 * Eval runner tests — fixture loading and execution.
 */

import { describe, it, expect } from "vitest";
import { runFixture, type EvalFixture, type FixtureResult } from "../../src/skills/eval-runner.js";

describe("Eval Runner", () => {
  describe("runFixture", () => {
    it("positive fixture passes when skill matches", () => {
      const fixture: EvalFixture = {
        name: "planning-match",
        type: "positive",
        input: "帮我制定计划",
        expectedSkill: "project-planning",
      };

      const result = runFixture(fixture, {
        selected: [{ name: "project-planning" }],
        combinedAllowedTools: ["get_workspace_state"],
      });

      expect(result.passed).toBe(true);
      expect(result.actualSkill).toBe("project-planning");
    });

    it("positive fixture fails when skill doesn't match", () => {
      const fixture: EvalFixture = {
        name: "planning-mismatch",
        type: "positive",
        input: "帮我制定计划",
        expectedSkill: "project-planning",
      };

      const result = runFixture(fixture, {
        selected: [{ name: "risk-analysis" }],
        combinedAllowedTools: [],
      });

      expect(result.passed).toBe(false);
      expect(result.error).toContain("project-planning");
    });

    it("negative fixture passes when no skill selected", () => {
      const fixture: EvalFixture = {
        name: "general-question",
        type: "negative",
        input: "你好",
        expectedSkill: null,
      };

      const result = runFixture(fixture, {
        selected: [],
        combinedAllowedTools: [],
      });

      expect(result.passed).toBe(true);
    });

    it("negative fixture fails when skill is selected", () => {
      const fixture: EvalFixture = {
        name: "should-not-match",
        type: "negative",
        input: "你好",
        expectedSkill: null,
      };

      const result = runFixture(fixture, {
        selected: [{ name: "project-planning" }],
        combinedAllowedTools: [],
      });

      expect(result.passed).toBe(false);
    });

    it("prerequisite fixture passes when skill not selected", () => {
      const fixture: EvalFixture = {
        name: "no-direction-card",
        type: "prerequisite",
        input: "制定计划",
        expectedSkill: null,
        prerequisites: ["has_direction_card"],
      };

      const result = runFixture(fixture, {
        selected: [],
        combinedAllowedTools: [],
      });

      expect(result.passed).toBe(true);
    });

    it("conflict fixture passes when no skill selected", () => {
      const fixture: EvalFixture = {
        name: "conflicting-skills",
        type: "conflict",
        input: "制定计划并分析风险",
        expectedSkill: null,
      };

      const result = runFixture(fixture, {
        selected: [],
        combinedAllowedTools: [],
      });

      expect(result.passed).toBe(true);
    });

    it("tool_allowlist fixture checks exposed tools", () => {
      const fixture: EvalFixture = {
        name: "planning-tools",
        type: "tool_allowlist",
        input: "制定计划",
        expectedSkill: "project-planning",
        expectedTools: ["get_workspace_state", "generate_stage_plan_proposal"],
      };

      const result = runFixture(fixture, {
        selected: [{ name: "project-planning" }],
        combinedAllowedTools: ["get_workspace_state", "generate_stage_plan_proposal"],
      });

      expect(result.passed).toBe(true);
    });

    it("tool_allowlist fixture fails when expected tool missing", () => {
      const fixture: EvalFixture = {
        name: "planning-tools-missing",
        type: "tool_allowlist",
        input: "制定计划",
        expectedSkill: "project-planning",
        expectedTools: ["get_workspace_state", "generate_stage_plan_proposal"],
      };

      const result = runFixture(fixture, {
        selected: [{ name: "project-planning" }],
        combinedAllowedTools: ["get_workspace_state"], // missing generate_stage_plan_proposal
      });

      expect(result.passed).toBe(false);
      expect(result.error).toContain("generate_stage_plan_proposal");
    });
  });
});

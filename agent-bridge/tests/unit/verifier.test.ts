/**
 * Verifier tests — deterministic verification dimensions.
 */

import { describe, it, expect } from "vitest";
import { verify } from "../../src/runtime/verifier.js";
import type { OutcomeContract } from "../../src/runtime/outcome-contract.js";
import type { ToolResultSummary } from "../../src/types/run-state.js";

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

function makeToolResult(overrides: Partial<ToolResultSummary> = {}): ToolResultSummary {
  return {
    toolCallId: "tc-1",
    toolName: "generate_stage_plan_proposal",
    sideEffectStatus: "proposal_persisted",
    observation: "阶段计划草案已创建",
    ...overrides,
  };
}

describe("Verifier", () => {
  describe("schema validity", () => {
    it("passes with non-empty content", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [makeToolResult()],
        finalContent: "阶段计划已生成",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "schema_validity");
      expect(dim?.passed).toBe(true);
    });

    it("fails with empty content", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [],
        finalContent: "",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "schema_validity");
      expect(dim?.passed).toBe(false);
    });
  });

  describe("effect boundary", () => {
    it("passes when tools within effect ceiling", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract({ effectCeiling: "proposal_only" }),
        toolResults: [makeToolResult({ sideEffectStatus: "proposal_persisted" })],
        finalContent: "内容",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "effect_boundary");
      expect(dim?.passed).toBe(true);
    });

    it("fails when tool exceeds effect ceiling", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract({ effectCeiling: "advisory_only" }),
        toolResults: [makeToolResult({ sideEffectStatus: "proposal_persisted" })],
        finalContent: "内容",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "effect_boundary");
      expect(dim?.passed).toBe(false);
    });
  });

  describe("tool evidence", () => {
    it("passes for answer-only mode", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract({ completionMode: "answer-only" }),
        toolResults: [],
        finalContent: "回答内容",
        hasTools: false,
      });

      const dim = report.dimensions.find((d) => d.name === "tool_evidence");
      expect(dim?.passed).toBe(true);
    });

    it("fails when action request has no tool results", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract({ requestType: "act" }),
        toolResults: [],
        finalContent: "内容",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "tool_evidence");
      expect(dim?.passed).toBe(false);
      expect(dim?.fixable).toBe(true);
    });
  });

  describe("localization/privacy", () => {
    it("passes with clean content", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [makeToolResult()],
        finalContent: "「小林」负责「后端 API」，截止日期 2026-08-01",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "localization_privacy");
      expect(dim?.passed).toBe(true);
    });

    it("fails with raw UUID", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [makeToolResult()],
        finalContent: "用户 550e8400-e29b-41d4-a716-446655440000 负责",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "localization_privacy");
      expect(dim?.passed).toBe(false);
    });

    it("fails with raw ID pattern", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [makeToolResult()],
        finalContent: "user_abc123 负责 task_def456",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "localization_privacy");
      expect(dim?.passed).toBe(false);
    });

    it("fails with non-YYYY-MM-DD date format", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [makeToolResult()],
        finalContent: "截止日期 2026/08/01",
        hasTools: true,
      });

      const dim = report.dimensions.find((d) => d.name === "localization_privacy");
      expect(dim?.passed).toBe(false);
    });
  });

  describe("completion classification", () => {
    it("returns answer_only for answer mode", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract({ completionMode: "answer-only" }),
        toolResults: [],
        finalContent: "回答",
        hasTools: false,
      });

      expect(report.completion).toBe("answer_only");
      expect(report.passed).toBe(true);
    });

    it("returns complete when all dimensions pass", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [makeToolResult()],
        finalContent: "「小林」负责「后端」，截止 2026-08-01",
        hasTools: true,
      });

      expect(report.completion).toBe("complete");
      expect(report.passed).toBe(true);
    });

    it("returns partial when fixable failures exist", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [],
        finalContent: "内容",
        hasTools: true,
      });

      // tool_evidence is fixable
      expect(report.completion).toBe("partial");
      expect(report.hasFixableFailures).toBe(true);
    });

    it("returns failed when unfixable failures exist", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [],
        finalContent: "",
        hasTools: true,
      });

      // schema_validity is not fixable (empty content)
      expect(report.completion).toBe("failed");
    });
  });

  describe("report structure", () => {
    it("has all required fields", () => {
      const report = verify({
        runId: "run-1",
        outcomeContract: makeOutcomeContract(),
        toolResults: [makeToolResult()],
        finalContent: "内容",
        hasTools: true,
      });

      expect(report.schemaVersion).toBe(1);
      expect(report.id).toContain("run-1");
      expect(report.runId).toBe("run-1");
      expect(report.timestamp).toBeDefined();
      expect(report.dimensions.length).toBeGreaterThan(0);
      expect(report.summary).toBeDefined();
    });
  });
});

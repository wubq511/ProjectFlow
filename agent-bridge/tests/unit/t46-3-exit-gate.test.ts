/**
 * T46-3 (Issue #96 §10) — Slice 1 exit gate tests.
 *
 * Verifies the fail-closed, machine-readable gate with 6 conditions:
 *  1. p0_mutations_detected: all required P0 mutations are detected.
 *  2. reference_zero_hard_false_failures: all Reference Programs produce
 *     zero hard false failures.
 *  3. hidden_field_leakage_tests_pass: all hidden-field leakage tests pass.
 *  4. required_scenarios_not_skipped_or_excluded: required scenarios are
 *     not skipped or excluded in a way that masks a regression.
 *  5. evidence_graph_and_checksums_complete: evidence graph and checksums
 *     are complete and verified.
 *  6. no_semantic_judge_required: the gate does NOT depend on a semantic Judge.
 *
 * The gate is fail-closed: "unverified" is treated as failure, not skip.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateExitGate,
  formatExitGateReport,
  getCondition,
  conditionPassed,
} from "../../src/evaluation/lab/exit-gate.js";
import type { ExitGateEvaluationInput } from "../../src/evaluation/lab/exit-gate.js";

function buildPassingInput(overrides: Partial<ExitGateEvaluationInput> = {}): ExitGateEvaluationInput {
  return {
    p0Mutations: [
      { mutationId: "mut-001", detected: true, targets: "hard-graders" },
      { mutationId: "mut-002", detected: true, targets: "hard-graders" },
    ],
    referencePrograms: [
      { programId: "ref-001", hardFalseFailures: 0 },
      { programId: "ref-002", hardFalseFailures: 0 },
    ],
    hiddenFieldLeakageTests: [
      { testName: "leak-test-001", passed: true },
      { testName: "leak-test-002", passed: true },
    ],
    requiredScenarios: [
      { scenarioId: "scn-001", status: "passed" },
      { scenarioId: "scn-002", status: "passed" },
    ],
    evidenceIntegrity: {
      checksumsComplete: true,
      evidenceGraphComplete: true,
      verified: true,
    },
    semanticJudgeUsed: false,
    evaluatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("evaluateExitGate — all conditions pass", () => {
  it("passes when all 6 conditions are satisfied", () => {
    const report = evaluateExitGate(buildPassingInput());
    expect(report.passed).toBe(true);
    expect(report.conditions.length).toBe(6);
    expect(report.failureReason).toBeUndefined();
  });
});

describe("evaluateExitGate — condition 1: p0_mutations_detected", () => {
  it("fails when a P0 mutation is NOT detected", () => {
    const report = evaluateExitGate(buildPassingInput({
      p0Mutations: [
        { mutationId: "mut-001", detected: true, targets: "hard-graders" },
        { mutationId: "mut-002", detected: false, targets: "hard-graders" },
      ],
    }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "p0_mutations_detected");
    expect(cond!.passed).toBe(false);
    expect(cond!.failureReason).toContain("mut-002");
  });

  it("fails when no P0 mutations are provided (fail-closed)", () => {
    const report = evaluateExitGate(buildPassingInput({ p0Mutations: [] }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "p0_mutations_detected");
    expect(cond!.passed).toBe(false);
    expect(cond!.failureReason).toContain("未提供");
  });
});

describe("evaluateExitGate — condition 2: reference_zero_hard_false_failures", () => {
  it("fails when a Reference Program has hard false failures", () => {
    const report = evaluateExitGate(buildPassingInput({
      referencePrograms: [
        { programId: "ref-001", hardFalseFailures: 1 },
        { programId: "ref-002", hardFalseFailures: 0 },
      ],
    }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "reference_zero_hard_false_failures");
    expect(cond!.passed).toBe(false);
    expect(cond!.failureReason).toContain("ref-001");
  });

  it("fails when no Reference Programs are provided (fail-closed)", () => {
    const report = evaluateExitGate(buildPassingInput({ referencePrograms: [] }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "reference_zero_hard_false_failures");
    expect(cond!.passed).toBe(false);
  });
});

describe("evaluateExitGate — condition 3: hidden_field_leakage_tests_pass", () => {
  it("fails when a hidden-field leakage test fails", () => {
    const report = evaluateExitGate(buildPassingInput({
      hiddenFieldLeakageTests: [
        { testName: "leak-test-001", passed: true },
        { testName: "leak-test-002", passed: false },
      ],
    }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "hidden_field_leakage_tests_pass");
    expect(cond!.passed).toBe(false);
    expect(cond!.failureReason).toContain("leak-test-002");
  });

  it("fails when no leakage tests are provided (fail-closed)", () => {
    const report = evaluateExitGate(buildPassingInput({ hiddenFieldLeakageTests: [] }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "hidden_field_leakage_tests_pass");
    expect(cond!.passed).toBe(false);
  });
});

describe("evaluateExitGate — condition 4: required_scenarios_not_skipped_or_excluded", () => {
  it("fails when a required scenario is skipped", () => {
    const report = evaluateExitGate(buildPassingInput({
      requiredScenarios: [
        { scenarioId: "scn-001", status: "passed" },
        { scenarioId: "scn-002", status: "skipped", skipReason: "time budget" },
      ],
    }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "required_scenarios_not_skipped_or_excluded");
    expect(cond!.passed).toBe(false);
    expect(cond!.failureReason).toContain("scn-002");
  });

  it("fails when a required scenario is excluded", () => {
    const report = evaluateExitGate(buildPassingInput({
      requiredScenarios: [
        { scenarioId: "scn-001", status: "passed" },
        { scenarioId: "scn-002", status: "excluded" },
      ],
    }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "required_scenarios_not_skipped_or_excluded");
    expect(cond!.passed).toBe(false);
  });

  it("fails when a required scenario fails", () => {
    const report = evaluateExitGate(buildPassingInput({
      requiredScenarios: [
        { scenarioId: "scn-001", status: "failed" },
      ],
    }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "required_scenarios_not_skipped_or_excluded");
    expect(cond!.passed).toBe(false);
    expect(cond!.failureReason).toContain("失败");
  });

  it("fails when no required scenarios are provided (fail-closed)", () => {
    const report = evaluateExitGate(buildPassingInput({ requiredScenarios: [] }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "required_scenarios_not_skipped_or_excluded");
    expect(cond!.passed).toBe(false);
  });
});

describe("evaluateExitGate — condition 5: evidence_graph_and_checksums_complete", () => {
  it("fails when checksums are incomplete", () => {
    const report = evaluateExitGate(buildPassingInput({
      evidenceIntegrity: {
        checksumsComplete: false,
        evidenceGraphComplete: true,
        verified: true,
      },
    }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "evidence_graph_and_checksums_complete");
    expect(cond!.passed).toBe(false);
  });

  it("fails when evidence graph is incomplete", () => {
    const report = evaluateExitGate(buildPassingInput({
      evidenceIntegrity: {
        checksumsComplete: true,
        evidenceGraphComplete: false,
        verified: true,
      },
    }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "evidence_graph_and_checksums_complete");
    expect(cond!.passed).toBe(false);
  });

  it("fails when verification failed", () => {
    const report = evaluateExitGate(buildPassingInput({
      evidenceIntegrity: {
        checksumsComplete: true,
        evidenceGraphComplete: true,
        verified: false,
      },
    }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "evidence_graph_and_checksums_complete");
    expect(cond!.passed).toBe(false);
  });
});

describe("evaluateExitGate — condition 6: no_semantic_judge_required", () => {
  it("fails when a semantic Judge was used", () => {
    const report = evaluateExitGate(buildPassingInput({ semanticJudgeUsed: true }));
    expect(report.passed).toBe(false);
    const cond = getCondition(report, "no_semantic_judge_required");
    expect(cond!.passed).toBe(false);
    expect(cond!.failureReason).toContain("语义 Judge");
  });

  it("passes when no semantic Judge was used", () => {
    const report = evaluateExitGate(buildPassingInput({ semanticJudgeUsed: false }));
    const cond = getCondition(report, "no_semantic_judge_required");
    expect(cond!.passed).toBe(true);
  });
});

describe("evaluateExitGate — fail-closed behavior", () => {
  it("fails when multiple conditions fail", () => {
    const report = evaluateExitGate(buildPassingInput({
      p0Mutations: [{ mutationId: "mut-001", detected: false, targets: "x" }],
      semanticJudgeUsed: true,
    }));
    expect(report.passed).toBe(false);
    // failureReason uses the Chinese failure descriptions, not condition IDs.
    expect(report.failureReason).toContain("P0 mutation");
    expect(report.failureReason).toContain("语义 Judge");
  });

  it("produces a stable reportId", () => {
    const input = buildPassingInput();
    const report1 = evaluateExitGate(input);
    const report2 = evaluateExitGate(input);
    expect(report1.reportId).toBe(report2.reportId);
  });

  it("produces different reportIds for different inputs", () => {
    const report1 = evaluateExitGate(buildPassingInput());
    const report2 = evaluateExitGate(buildPassingInput({ semanticJudgeUsed: true }));
    expect(report1.reportId).not.toBe(report2.reportId);
  });
});

describe("getCondition / conditionPassed — helpers", () => {
  it("getCondition returns the condition by ID", () => {
    const report = evaluateExitGate(buildPassingInput());
    const cond = getCondition(report, "p0_mutations_detected");
    expect(cond).toBeDefined();
    expect(cond!.conditionId).toBe("p0_mutations_detected");
  });

  it("getCondition returns undefined for an unknown condition ID", () => {
    const report = evaluateExitGate(buildPassingInput());
    // @ts-expect-error — testing an unknown ID
    expect(getCondition(report, "nonexistent")).toBeUndefined();
  });

  it("conditionPassed returns the boolean", () => {
    const report = evaluateExitGate(buildPassingInput());
    expect(conditionPassed(report, "p0_mutations_detected")).toBe(true);
    expect(conditionPassed(report, "no_semantic_judge_required")).toBe(true);
  });

  it("conditionPassed returns false for a failed condition", () => {
    const report = evaluateExitGate(buildPassingInput({ semanticJudgeUsed: true }));
    expect(conditionPassed(report, "no_semantic_judge_required")).toBe(false);
  });
});

describe("formatExitGateReport — human-readable output", () => {
  it("produces a readable multi-line string with all conditions", () => {
    const report = evaluateExitGate(buildPassingInput());
    const formatted = formatExitGateReport(report);
    expect(formatted).toContain("Slice 1 Exit Gate");
    expect(formatted).toContain("Passed");
    expect(formatted).toContain("p0_mutations_detected");
    expect(formatted).toContain("reference_zero_hard_false_failures");
    expect(formatted).toContain("hidden_field_leakage_tests_pass");
    expect(formatted).toContain("required_scenarios_not_skipped_or_excluded");
    expect(formatted).toContain("evidence_graph_and_checksums_complete");
    expect(formatted).toContain("no_semantic_judge_required");
  });

  it("includes the failure reason when the gate fails", () => {
    const report = evaluateExitGate(buildPassingInput({ semanticJudgeUsed: true }));
    const formatted = formatExitGateReport(report);
    expect(formatted).toContain("Failure reason");
    expect(formatted).toContain("语义 Judge");
  });
});

/**
 * T46-3 (Issue #96 §10) — Slice 1 exit gate.
 *
 * A fail-closed, machine-readable gate. The gate passes ONLY when ALL
 * six required conditions are satisfied:
 *  1. All required P0 mutations are detected by their targeted graders.
 *  2. All Reference Programs produce zero hard false failures.
 *  3. Hidden-field leakage tests pass (sentinels do not appear in SUT
 *     request body, evidence snapshot, observation, grade, report,
 *     manifest, or portable artifact).
 *  4. Required scenarios are not skipped or excluded in a way that
 *     masks a regression (skipped/excluded scenarios must be reported
 *     with a reason; the gate fails if a P0 scenario is skipped).
 *  5. Evidence graph and checksums are complete and verified.
 *  6. The gate does NOT depend on a semantic Judge (no LLM-based
 *     grader is required to pass the gate).
 *
 * If any condition is unverified, the gate fails. "Unverified" is
 * treated as failure, not as skip — the gate cannot pass by ignoring
 * a missing check.
 */

import { createHash } from "node:crypto";
import type {
  Slice1ExitGateCondition,
  Slice1ExitGateConditionId,
  Slice1ExitGateReport,
} from "./contract-v3.js";

export interface ExitGateEvaluationInput {
  /** P0 mutation detection results. */
  p0Mutations: Array<{
    mutationId: string;
    detected: boolean;
    targets: string;
  }>;
  /** Reference Program hard grade results. */
  referencePrograms: Array<{
    programId: string;
    hardFalseFailures: number;
  }>;
  /** Hidden-field leakage test results. */
  hiddenFieldLeakageTests: Array<{
    testName: string;
    passed: boolean;
  }>;
  /** Required scenarios and their status. */
  requiredScenarios: Array<{
    scenarioId: string;
    status: "passed" | "failed" | "skipped" | "excluded";
    skipReason?: string;
  }>;
  /** Evidence graph and checksum verification. */
  evidenceIntegrity: {
    checksumsComplete: boolean;
    evidenceGraphComplete: boolean;
    verified: boolean;
  };
  /** Whether any LLM-based semantic Judge was used. */
  semanticJudgeUsed: boolean;
  /** ISO timestamp; defaults to `new Date().toISOString()`. */
  evaluatedAt?: string;
}

/** Evaluate the Slice 1 exit gate. */
export function evaluateExitGate(input: ExitGateEvaluationInput): Slice1ExitGateReport {
  const conditions: Slice1ExitGateCondition[] = [];

  // §1 P0 mutations detected
  conditions.push(evaluateP0MutationsCondition(input.p0Mutations));

  // §2 Reference Programs zero hard false failures
  conditions.push(evaluateReferenceProgramsCondition(input.referencePrograms));

  // §3 Hidden-field leakage tests pass
  conditions.push(evaluateHiddenFieldLeakageCondition(input.hiddenFieldLeakageTests));

  // §4 Required scenarios not skipped/excluded
  conditions.push(evaluateRequiredScenariosCondition(input.requiredScenarios));

  // §5 Evidence graph and checksums complete
  conditions.push(evaluateEvidenceIntegrityCondition(input.evidenceIntegrity));

  // §6 No semantic Judge required
  conditions.push(evaluateNoSemanticJudgeCondition(input.semanticJudgeUsed));

  const passed = conditions.every((c) => c.passed);
  const failureReason = passed
    ? undefined
    : conditions.filter((c) => !c.passed).map((c) => c.failureReason ?? c.description).join("; ");

  return {
    reportId: `exit-gate-${sha256Short(JSON.stringify(input))}`,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    passed,
    conditions,
    failureReason,
  };
}

// ---------------------------------------------------------------------------
// Per-condition evaluators
// ---------------------------------------------------------------------------

function evaluateP0MutationsCondition(
  mutations: ExitGateEvaluationInput["p0Mutations"],
): Slice1ExitGateCondition {
  const missing = mutations.filter((m) => !m.detected);
  const passed = mutations.length > 0 && missing.length === 0;
  return {
    conditionId: "p0_mutations_detected",
    description: "所有必需 P0 mutations 必须被对应 grader 检测到",
    passed,
    evidence: mutations.map((m) => `${m.mutationId}: ${m.detected ? "detected" : "MISSED"}`),
    failureReason: passed
      ? undefined
      : mutations.length === 0
        ? "未提供任何 P0 mutation 检测结果"
        : `未检测到 ${missing.length} 个 P0 mutation: ${missing.map((m) => m.mutationId).join(", ")}`,
  };
}

function evaluateReferenceProgramsCondition(
  programs: ExitGateEvaluationInput["referencePrograms"],
): Slice1ExitGateCondition {
  const withFailures = programs.filter((p) => p.hardFalseFailures > 0);
  const passed = programs.length > 0 && withFailures.length === 0;
  return {
    conditionId: "reference_zero_hard_false_failures",
    description: "所有 Reference Programs 必须产生零 hard false failure",
    passed,
    evidence: programs.map((p) => `${p.programId}: hardFalseFailures=${p.hardFalseFailures}`),
    failureReason: passed
      ? undefined
      : programs.length === 0
        ? "未提供任何 Reference Program 结果"
        : `${withFailures.length} 个 Reference Program 存在 hard false failure: ${withFailures.map((p) => p.programId).join(", ")}`,
  };
}

function evaluateHiddenFieldLeakageCondition(
  tests: ExitGateEvaluationInput["hiddenFieldLeakageTests"],
): Slice1ExitGateCondition {
  const failed = tests.filter((t) => !t.passed);
  const passed = tests.length > 0 && failed.length === 0;
  return {
    conditionId: "hidden_field_leakage_tests_pass",
    description: "所有 hidden-field leakage 测试必须通过",
    passed,
    evidence: tests.map((t) => `${t.testName}: ${t.passed ? "PASS" : "FAIL"}`),
    failureReason: passed
      ? undefined
      : tests.length === 0
        ? "未提供任何 hidden-field leakage 测试结果"
        : `${failed.length} 个 leakage 测试失败: ${failed.map((t) => t.testName).join(", ")}`,
  };
}

function evaluateRequiredScenariosCondition(
  scenarios: ExitGateEvaluationInput["requiredScenarios"],
): Slice1ExitGateCondition {
  const masked = scenarios.filter((s) => s.status === "skipped" || s.status === "excluded");
  const failed = scenarios.filter((s) => s.status === "failed");
  // The condition fails if ANY required scenario is skipped, excluded,
  // or failed. Masking a regression by skipping is a hard gate failure.
  const passed = scenarios.length > 0 && masked.length === 0 && failed.length === 0;
  return {
    conditionId: "required_scenarios_not_skipped_or_excluded",
    description: "必需场景没有被 skipped/excluded 掩盖",
    passed,
    evidence: scenarios.map((s) => `${s.scenarioId}: ${s.status}${s.skipReason ? ` (${s.skipReason})` : ""}`),
    failureReason: passed
      ? undefined
      : scenarios.length === 0
        ? "未提供任何必需场景结果"
        : [
          masked.length > 0 ? `${masked.length} 个必需场景被 skipped/excluded: ${masked.map((s) => s.scenarioId).join(", ")}` : "",
          failed.length > 0 ? `${failed.length} 个必需场景失败: ${failed.map((s) => s.scenarioId).join(", ")}` : "",
        ].filter(Boolean).join("; "),
  };
}

function evaluateEvidenceIntegrityCondition(
  integrity: ExitGateEvaluationInput["evidenceIntegrity"],
): Slice1ExitGateCondition {
  const passed = integrity.checksumsComplete && integrity.evidenceGraphComplete && integrity.verified;
  return {
    conditionId: "evidence_graph_and_checksums_complete",
    description: "证据图和 checksums 完整且校验通过",
    passed,
    evidence: [
      `checksumsComplete: ${integrity.checksumsComplete}`,
      `evidenceGraphComplete: ${integrity.evidenceGraphComplete}`,
      `verified: ${integrity.verified}`,
    ],
    failureReason: passed
      ? undefined
      : "证据图或 checksums 不完整或校验未通过",
  };
}

function evaluateNoSemanticJudgeCondition(semanticJudgeUsed: boolean): Slice1ExitGateCondition {
  const passed = !semanticJudgeUsed;
  return {
    conditionId: "no_semantic_judge_required",
    description: "Slice 1 exit gate 不依赖语义 Judge",
    passed,
    evidence: [`semanticJudgeUsed: ${semanticJudgeUsed}`],
    failureReason: passed ? undefined : "评测使用了语义 Judge，违反 Slice 1 边界",
  };
}

/** Helper: format an exit gate report for human-readable reports (Chinese). */
export function formatExitGateReport(report: Slice1ExitGateReport): string {
  const lines: string[] = [];
  lines.push("=== Slice 1 Exit Gate ===");
  lines.push(`Report ID: ${report.reportId}`);
  lines.push(`Evaluated at: ${report.evaluatedAt}`);
  lines.push(`Passed: ${report.passed ? "是" : "否"}`);
  if (report.failureReason) {
    lines.push(`Failure reason: ${report.failureReason}`);
  }
  lines.push("");
  lines.push("=== 条件 ===");
  for (const condition of report.conditions) {
    lines.push(`- [${condition.passed ? "PASS" : "FAIL"}] ${condition.conditionId}: ${condition.description}`);
    if (condition.failureReason) {
      lines.push(`    原因: ${condition.failureReason}`);
    }
    if (condition.evidence.length > 0) {
      lines.push(`    证据:`);
      for (const e of condition.evidence) {
        lines.push(`      - ${e}`);
      }
    }
  }
  return lines.join("\n");
}

/** Helper: get a single condition by ID from a report. */
export function getCondition(
  report: Slice1ExitGateReport,
  conditionId: Slice1ExitGateConditionId,
): Slice1ExitGateCondition | undefined {
  return report.conditions.find((c) => c.conditionId === conditionId);
}

/** Helper: check whether a specific condition passed. */
export function conditionPassed(
  report: Slice1ExitGateReport,
  conditionId: Slice1ExitGateConditionId,
): boolean {
  return report.conditions.find((c) => c.conditionId === conditionId)?.passed ?? false;
}

/** Internal: short SHA-256 for IDs. */
function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
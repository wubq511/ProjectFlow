/**
 * T46-3 (Issue #96 §2) — Simulator integrity tests.
 *
 * Verifies:
 *  1. simulator_error episodes are excluded from the Agent score denominator.
 *  2. simulator_error episodes are NOT recorded as Agent failures.
 *  3. Retry budget is frozen at SIMULATOR_RETRY_BUDGET=2.
 *  4. Retry cannot rewrite a previous failure as success.
 *  5. classifySimulatorError produces stable records.
 *  6. markRetried returns a new record (immutably).
 *  7. computeDenominatorWithExclusions excludes both simulator_error and
 *     infrastructure_error, preserving an audit trail.
 *  8. simulatorErrorSummary reports total/byType/retryRate/budgetExhausted.
 */

import { describe, expect, it } from "vitest";
import {
  classifySimulatorError,
  markRetried,
  retryBudgetExhausted,
  scoreDenominatorTrials,
  aggregateSimulatorErrors,
  simulatorErrorToAttempt,
  isSimulatorErrorResult,
  isInfrastructureFailureResult,
  computeDenominatorWithExclusions,
  simulatorErrorSummary,
  SIMULATOR_RETRY_BUDGET,
} from "../../src/evaluation/lab/simulator-error.js";
import type { SimulatorErrorType } from "../../src/evaluation/lab/contract-v3.js";

describe("SIMULATOR_RETRY_BUDGET — frozen", () => {
  it("is frozen at 2", () => {
    expect(SIMULATOR_RETRY_BUDGET).toBe(2);
  });
});

describe("classifySimulatorError — stable records", () => {
  it("produces a record with a stable ID and retried=false", () => {
    const record = classifySimulatorError({
      type: "hidden_fact_leak",
      scenarioId: "scn-001",
      message: "Agent 输出包含隐藏 sentinel",
      recordedAt: "2026-07-19T00:00:00.000Z",
    });
    expect(record.scenarioId).toBe("scn-001");
    expect(record.type).toBe("hidden_fact_leak");
    expect(record.retried).toBe(false);
    expect(record.recordId).toContain("scn-001");
    expect(record.recordId).toContain("hidden_fact_leak");
  });

  it("uses the provided recordedAt timestamp", () => {
    const record = classifySimulatorError({
      type: "goal_drift",
      scenarioId: "scn-002",
      message: "目标漂移",
      recordedAt: "2026-07-19T12:00:00.000Z",
    });
    expect(record.recordedAt).toBe("2026-07-19T12:00:00.000Z");
  });
});

describe("markRetried — immutability", () => {
  it("returns a NEW record with retried=true and retryOfRecordId set", () => {
    const original = classifySimulatorError({
      type: "invalid_turn",
      scenarioId: "scn-003",
      message: "无效轮次",
      recordedAt: "2026-07-19T00:00:00.000Z",
    });
    const retried = markRetried(original, "retry-record-001");
    expect(original.retried).toBe(false); // original is NOT mutated
    expect(retried.retried).toBe(true);
    expect(retried.retryOfRecordId).toBe("retry-record-001");
  });
});

describe("retryBudgetExhausted — frozen budget", () => {
  it("returns false when records < budget", () => {
    const records = [
      classifySimulatorError({ type: "invalid_turn", scenarioId: "scn-004", message: "x", recordedAt: "2026-07-19T00:00:00.000Z" }),
    ];
    expect(retryBudgetExhausted(records, "scn-004")).toBe(false);
  });

  it("returns true when records >= budget", () => {
    const records = [
      classifySimulatorError({ type: "invalid_turn", scenarioId: "scn-005", message: "x", recordedAt: "2026-07-19T00:00:00.000Z" }),
      classifySimulatorError({ type: "goal_drift", scenarioId: "scn-005", message: "y", recordedAt: "2026-07-19T00:00:01.000Z" }),
    ];
    expect(retryBudgetExhausted(records, "scn-005")).toBe(true);
  });

  it("only counts records for the specified scenario", () => {
    const records = [
      classifySimulatorError({ type: "invalid_turn", scenarioId: "scn-A", message: "x", recordedAt: "2026-07-19T00:00:00.000Z" }),
      classifySimulatorError({ type: "goal_drift", scenarioId: "scn-B", message: "y", recordedAt: "2026-07-19T00:00:01.000Z" }),
    ];
    expect(retryBudgetExhausted(records, "scn-A")).toBe(false);
    expect(retryBudgetExhausted(records, "scn-B")).toBe(false);
  });
});

describe("scoreDenominatorTrials — excludes simulator_error", () => {
  it("filters out trials with simulatorError set", () => {
    const trials = [
      { simulatorError: undefined, passed: true },
      { simulatorError: "hidden_fact_leak" as SimulatorErrorType, passed: false },
      { simulatorError: undefined, passed: false },
    ];
    const denominator = scoreDenominatorTrials(trials);
    expect(denominator.length).toBe(2);
    expect(denominator[0]!.passed).toBe(true);
    expect(denominator[1]!.passed).toBe(false);
  });

  it("returns all trials when none have simulatorError", () => {
    const trials = [
      { simulatorError: undefined, passed: true },
      { simulatorError: undefined, passed: false },
    ];
    expect(scoreDenominatorTrials(trials).length).toBe(2);
  });
});

describe("aggregateSimulatorErrors — by type", () => {
  it("counts each error type", () => {
    const records = [
      classifySimulatorError({ type: "hidden_fact_leak", scenarioId: "s1", message: "x", recordedAt: "2026-07-19T00:00:00.000Z" }),
      classifySimulatorError({ type: "hidden_fact_leak", scenarioId: "s2", message: "x", recordedAt: "2026-07-19T00:00:01.000Z" }),
      classifySimulatorError({ type: "goal_drift", scenarioId: "s3", message: "x", recordedAt: "2026-07-19T00:00:02.000Z" }),
    ];
    const agg = aggregateSimulatorErrors(records);
    expect(agg.hidden_fact_leak).toBe(2);
    expect(agg.goal_drift).toBe(1);
    expect(agg.invalid_turn).toBe(0);
  });
});

describe("simulatorErrorToAttempt — ledger entry", () => {
  it("produces an attempt ledger entry with result=simulator_error", () => {
    const record = classifySimulatorError({
      type: "out_of_scope",
      scenarioId: "scn-006",
      message: "越界请求",
      recordedAt: "2026-07-19T00:00:00.000Z",
    });
    const entry = simulatorErrorToAttempt(record, "2026-07-19T00:00:00.000Z", "2026-07-19T00:00:05.000Z");
    expect(entry.result).toBe("simulator_error");
    expect(entry.type).toBe("infrastructure_attempt");
    expect(entry.errorCategory).toBe("out_of_scope");
    expect(entry.errorMessage).toBe("越界请求");
    expect(entry.durationMs).toBe(5_000);
  });
});

describe("isSimulatorErrorResult / isInfrastructureFailureResult", () => {
  it("classifies simulator_error correctly", () => {
    expect(isSimulatorErrorResult("simulator_error")).toBe(true);
    expect(isSimulatorErrorResult("succeeded")).toBe(false);
    expect(isSimulatorErrorResult("failed_agent")).toBe(false);
  });

  it("classifies infrastructure failures correctly", () => {
    expect(isInfrastructureFailureResult("failed_infrastructure")).toBe(true);
    expect(isInfrastructureFailureResult("failed_budget")).toBe(true);
    expect(isInfrastructureFailureResult("succeeded")).toBe(false);
    expect(isInfrastructureFailureResult("failed_agent")).toBe(false);
  });
});

describe("computeDenominatorWithExclusions — audit trail", () => {
  it("excludes both simulator_error and infrastructure_error trials", () => {
    const trials = [
      { simulatorError: undefined, infrastructureError: false, passed: true },
      { simulatorError: "hidden_fact_leak" as SimulatorErrorType, infrastructureError: false, passed: false },
      { simulatorError: undefined, infrastructureError: true, passed: false },
      { simulatorError: undefined, infrastructureError: false, passed: false },
    ];
    const result = computeDenominatorWithExclusions(trials);
    expect(result.denominator.length).toBe(2);
    expect(result.excluded.length).toBe(2);
    expect(result.exclusionsByReason["simulator_error:hidden_fact_leak"]).toBe(1);
    expect(result.exclusionsByReason["infrastructure_error"]).toBe(1);
  });

  it("preserves the original trial objects in both denominator and excluded", () => {
    const trials = [
      { simulatorError: "goal_drift" as SimulatorErrorType, infrastructureError: false, passed: false },
    ];
    const result = computeDenominatorWithExclusions(trials);
    expect(result.denominator.length).toBe(0);
    expect(result.excluded[0]!.simulatorError).toBe("goal_drift");
  });
});

describe("simulatorErrorSummary — ledger aggregation", () => {
  it("reports total, byType, retryRate, and budgetExhausted", () => {
    const ledger = {
      entries: [
        { attemptId: "a1", scenarioId: "s1", type: "infrastructure_attempt" as const, startedAt: "2026-07-19T00:00:00.000Z", endedAt: "2026-07-19T00:00:05.000Z", result: "simulator_error" as const, errorCategory: "hidden_fact_leak", errorMessage: "x", durationMs: 5_000 },
        { attemptId: "a2", scenarioId: "s1", type: "infrastructure_attempt" as const, startedAt: "2026-07-19T00:00:05.000Z", endedAt: "2026-07-19T00:00:10.000Z", result: "simulator_error" as const, errorCategory: "hidden_fact_leak", errorMessage: "y", durationMs: 5_000, retryOf: "a1" },
        { attemptId: "a3", scenarioId: "s2", type: "agent_retry" as const, startedAt: "2026-07-19T00:00:00.000Z", endedAt: "2026-07-19T00:00:01.000Z", result: "succeeded" as const, durationMs: 1_000 },
      ],
      total: 3,
      byType: { infrastructure_attempt: 2, agent_retry: 1 },
      byResult: { succeeded: 1, failed_agent: 0, failed_infrastructure: 0, failed_budget: 0, cancelled: 0, simulator_error: 2 },
    };
    const summary = simulatorErrorSummary(ledger);
    expect(summary.total).toBe(2);
    expect(summary.byType.hidden_fact_leak).toBe(2);
    expect(summary.retryRate).toBe(0.5); // 1 retried out of 2
    expect(summary.budgetExhausted).toBe(true); // 2 >= SIMULATOR_RETRY_BUDGET
  });

  it("returns empty summary for a ledger with no simulator errors", () => {
    const ledger = {
      entries: [
        { attemptId: "a1", scenarioId: "s1", type: "agent_retry" as const, startedAt: "2026-07-19T00:00:00.000Z", endedAt: "2026-07-19T00:00:01.000Z", result: "succeeded" as const, durationMs: 1_000 },
      ],
      total: 1,
      byType: { infrastructure_attempt: 0, agent_retry: 1 },
      byResult: { succeeded: 1, failed_agent: 0, failed_infrastructure: 0, failed_budget: 0, cancelled: 0, simulator_error: 0 },
    };
    const summary = simulatorErrorSummary(ledger);
    expect(summary.total).toBe(0);
    expect(summary.retryRate).toBe(0);
    expect(summary.budgetExhausted).toBe(false);
  });
});

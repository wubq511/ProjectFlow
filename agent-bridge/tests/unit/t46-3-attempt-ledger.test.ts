/**
 * T46-3 (Issue #96 §5) — Append-only attempt ledger tests.
 *
 * Verifies:
 *  1. The ledger is append-only: entries are never deleted or overwritten.
 *  2. Each entry has a stable ID (`${scenarioId}-${type}-${seq}`).
 *  3. Recovery via `recoveredBy` pointer does NOT mutate the original entry.
 *  4. `markRecovered` throws when the original entry does not exist.
 *  5. `markRecovered` throws when attempting to overwrite an existing
 *     recoveredBy pointer with a different value.
 *  6. `verifyLedgerInvariants` detects duplicate IDs, negative durations,
 *     dangling retryOf/recoveredBy pointers, and missing errorCategory.
 *  7. `retryCounts` separates infrastructure_attempts from agent_retries.
 *  8. `hasRecoveredFailures` detects prior failures that were recovered.
 *  9. `attemptChain` returns entries for a specific scenario in append order.
 * 10. Infrastructure attempts and Agent retries are distinct record types.
 */

import { describe, expect, it } from "vitest";
import {
  createAttemptLedger,
  aggregateLedger,
  verifyLedgerInvariants,
  retryCounts,
  hasRecoveredFailures,
  attemptChain,
} from "../../src/evaluation/lab/attempt-ledger.js";

function fixedTime(offsetMs: number = 0): string {
  return new Date(Date.parse("2026-07-19T00:00:00.000Z") + offsetMs).toISOString();
}

describe("createAttemptLedger — append-only", () => {
  it("assigns stable sequential IDs per scenario+type", () => {
    const ledger = createAttemptLedger();
    const e1 = ledger.record({
      scenarioId: "scn-001",
      type: "infrastructure_attempt",
      startedAt: fixedTime(0),
      endedAt: fixedTime(1_000),
      result: "succeeded",
    });
    const e2 = ledger.record({
      scenarioId: "scn-001",
      type: "infrastructure_attempt",
      startedAt: fixedTime(1_000),
      endedAt: fixedTime(2_000),
      result: "failed_infrastructure",
    });
    expect(e1.attemptId).toBe("scn-001-infrastructure_attempt-0");
    expect(e2.attemptId).toBe("scn-001-infrastructure_attempt-1");
  });

  it("separates sequences by type within the same scenario", () => {
    const ledger = createAttemptLedger();
    const e1 = ledger.record({
      scenarioId: "scn-001",
      type: "infrastructure_attempt",
      startedAt: fixedTime(0),
      endedAt: fixedTime(1_000),
      result: "succeeded",
    });
    const e2 = ledger.record({
      scenarioId: "scn-001",
      type: "agent_retry",
      startedAt: fixedTime(1_000),
      endedAt: fixedTime(2_000),
      result: "succeeded",
    });
    expect(e1.attemptId).toBe("scn-001-infrastructure_attempt-0");
    expect(e2.attemptId).toBe("scn-001-agent_retry-0");
  });

  it("preserves all entries in append order in the snapshot", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded", retryOf: "s1-infrastructure_attempt-0" });
    const snap = ledger.snapshot();
    expect(snap.entries.length).toBe(2);
    expect(snap.entries[0]!.attemptId).toBe("s1-infrastructure_attempt-0");
    expect(snap.entries[1]!.attemptId).toBe("s1-agent_retry-0");
    // The original failure entry is STILL present (not deleted).
    expect(snap.entries[0]!.result).toBe("failed_infrastructure");
    // The original entry has a recoveredBy pointer now.
    expect(snap.entries[0]!.recoveredBy).toBe("s1-agent_retry-0");
  });

  it("increments the sequence counter per scenario+type", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "succeeded" });
    const e2 = ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded" });
    const e3 = ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(200), endedAt: fixedTime(300), result: "succeeded" });
    expect(e2.attemptId).toBe("s1-infrastructure_attempt-1");
    expect(e3.attemptId).toBe("s1-infrastructure_attempt-2");
  });
});

describe("createAttemptLedger — markRecovered", () => {
  it("sets recoveredBy pointer on the original entry", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded" });
    ledger.markRecovered("s1-infrastructure_attempt-0", "s1-agent_retry-0");
    const snap = ledger.snapshot();
    expect(snap.entries[0]!.recoveredBy).toBe("s1-agent_retry-0");
  });

  it("throws when the original attempt does not exist", () => {
    const ledger = createAttemptLedger();
    expect(() => ledger.markRecovered("nonexistent", "also-nonexistent")).toThrow(/不存在/);
  });

  it("throws when the recovering attempt does not exist", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "failed_infrastructure" });
    expect(() => ledger.markRecovered("s1-infrastructure_attempt-0", "nonexistent")).toThrow(/不存在/);
  });

  it("throws when attempting to overwrite an existing recoveredBy with a different value", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(200), endedAt: fixedTime(300), result: "succeeded" });
    ledger.markRecovered("s1-infrastructure_attempt-0", "s1-agent_retry-0");
    expect(() => ledger.markRecovered("s1-infrastructure_attempt-0", "s1-agent_retry-1")).toThrow(/已被.*标记为已恢复/);
  });

  it("is idempotent when marking the same recoveredBy twice", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded" });
    ledger.markRecovered("s1-infrastructure_attempt-0", "s1-agent_retry-0");
    expect(() => ledger.markRecovered("s1-infrastructure_attempt-0", "s1-agent_retry-0")).not.toThrow();
  });
});

describe("createAttemptLedger — snapshot isolation", () => {
  it("returns a deep copy that cannot mutate internal state", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "succeeded" });
    const snap1 = ledger.snapshot();
    snap1.entries[0]!.result = "failed_agent"; // mutate the copy
    const snap2 = ledger.snapshot();
    expect(snap2.entries[0]!.result).toBe("succeeded"); // internal state unchanged
  });
});

describe("verifyLedgerInvariants — violation detection", () => {
  it("returns empty for a clean ledger", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "succeeded" });
    const violations = verifyLedgerInvariants(ledger.snapshot());
    expect(violations).toEqual([]);
  });

  it("detects duplicate attempt IDs", () => {
    const ledger = {
      entries: [
        { attemptId: "dup-1", scenarioId: "s1", type: "infrastructure_attempt" as const, startedAt: fixedTime(0), endedAt: fixedTime(100), result: "succeeded" as const, durationMs: 100 },
        { attemptId: "dup-1", scenarioId: "s1", type: "infrastructure_attempt" as const, startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded" as const, durationMs: 100 },
      ],
      total: 2,
      byType: { infrastructure_attempt: 2, agent_retry: 0 },
      byResult: { succeeded: 2, failed_agent: 0, failed_infrastructure: 0, failed_budget: 0, cancelled: 0, simulator_error: 0 },
    };
    const violations = verifyLedgerInvariants(ledger);
    expect(violations.some((v) => v.includes("重复 attempt ID"))).toBe(true);
  });

  it("detects negative durationMs", () => {
    const ledger = {
      entries: [
        { attemptId: "neg-1", scenarioId: "s1", type: "infrastructure_attempt" as const, startedAt: fixedTime(200), endedAt: fixedTime(100), result: "succeeded" as const, durationMs: -100 },
      ],
      total: 1,
      byType: { infrastructure_attempt: 1, agent_retry: 0 },
      byResult: { succeeded: 1, failed_agent: 0, failed_infrastructure: 0, failed_budget: 0, cancelled: 0, simulator_error: 0 },
    };
    const violations = verifyLedgerInvariants(ledger);
    expect(violations.some((v) => v.includes("durationMs 为负数"))).toBe(true);
  });

  it("detects simulator_error entries missing errorCategory", () => {
    const ledger = {
      entries: [
        { attemptId: "sim-1", scenarioId: "s1", type: "infrastructure_attempt" as const, startedAt: fixedTime(0), endedAt: fixedTime(100), result: "simulator_error" as const, durationMs: 100 },
      ],
      total: 1,
      byType: { infrastructure_attempt: 1, agent_retry: 0 },
      byResult: { succeeded: 0, failed_agent: 0, failed_infrastructure: 0, failed_budget: 0, cancelled: 0, simulator_error: 1 },
    };
    const violations = verifyLedgerInvariants(ledger);
    expect(violations.some((v) => v.includes("simulator_error 但缺少 errorCategory"))).toBe(true);
  });

  it("detects dangling recoveredBy pointer", () => {
    const ledger = {
      entries: [
        { attemptId: "a1", scenarioId: "s1", type: "infrastructure_attempt" as const, startedAt: fixedTime(0), endedAt: fixedTime(100), result: "failed_infrastructure" as const, durationMs: 100, recoveredBy: "nonexistent" },
      ],
      total: 1,
      byType: { infrastructure_attempt: 1, agent_retry: 0 },
      byResult: { succeeded: 0, failed_agent: 0, failed_infrastructure: 1, failed_budget: 0, cancelled: 0, simulator_error: 0 },
    };
    const violations = verifyLedgerInvariants(ledger);
    expect(violations.some((v) => v.includes("recoveredBy 指向未知"))).toBe(true);
  });
});

describe("retryCounts — per-scenario breakdown", () => {
  it("separates infrastructure_attempts from agent_retries", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(200), endedAt: fixedTime(300), result: "succeeded" });
    const counts = retryCounts(ledger.snapshot());
    expect(counts["s1"]!.infrastructureAttempts).toBe(1);
    expect(counts["s1"]!.agentRetries).toBe(2);
    expect(counts["s1"]!.total).toBe(3);
  });
});

describe("hasRecoveredFailures — prior failure preservation", () => {
  it("returns true when a failed entry was later recovered", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded", retryOf: "s1-infrastructure_attempt-0" });
    expect(hasRecoveredFailures(ledger.snapshot())).toBe(true);
  });

  it("returns false when there are no recovered failures", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "succeeded" });
    expect(hasRecoveredFailures(ledger.snapshot())).toBe(false);
  });

  it("returns false when a succeeded entry has a recoveredBy pointer (not a failure)", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "succeeded" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded", retryOf: "s1-infrastructure_attempt-0" });
    // The original succeeded; recovery pointer is set but the original
    // was not a failure.
    expect(hasRecoveredFailures(ledger.snapshot())).toBe(false);
  });
});

describe("attemptChain — per-scenario retrieval", () => {
  it("returns entries for the specified scenario in append order", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "succeeded" });
    ledger.record({ scenarioId: "s2", type: "agent_retry", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(200), endedAt: fixedTime(300), result: "succeeded" });
    const chain = attemptChain(ledger.snapshot(), "s1");
    expect(chain.length).toBe(2);
    expect(chain[0]!.attemptId).toBe("s1-infrastructure_attempt-0");
    expect(chain[1]!.attemptId).toBe("s1-agent_retry-0");
  });

  it("returns empty for a scenario with no entries", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "succeeded" });
    expect(attemptChain(ledger.snapshot(), "nonexistent").length).toBe(0);
  });
});

describe("aggregateLedger — byType and byResult", () => {
  it("counts entries by type and result", () => {
    const entries = [
      { attemptId: "a1", scenarioId: "s1", type: "infrastructure_attempt" as const, startedAt: fixedTime(0), endedAt: fixedTime(100), result: "succeeded" as const, durationMs: 100 },
      { attemptId: "a2", scenarioId: "s1", type: "agent_retry" as const, startedAt: fixedTime(100), endedAt: fixedTime(200), result: "failed_agent" as const, durationMs: 100 },
      { attemptId: "a3", scenarioId: "s1", type: "infrastructure_attempt" as const, startedAt: fixedTime(200), endedAt: fixedTime(300), result: "simulator_error" as const, durationMs: 100, errorCategory: "hidden_fact_leak" },
    ];
    const ledger = aggregateLedger(entries);
    expect(ledger.total).toBe(3);
    expect(ledger.byType.infrastructure_attempt).toBe(2);
    expect(ledger.byType.agent_retry).toBe(1);
    expect(ledger.byResult.succeeded).toBe(1);
    expect(ledger.byResult.failed_agent).toBe(1);
    expect(ledger.byResult.simulator_error).toBe(1);
  });
});

describe("createAttemptLedger — retryOf auto-linking", () => {
  it("automatically sets recoveredBy on the original entry when retryOf is provided", () => {
    const ledger = createAttemptLedger();
    ledger.record({ scenarioId: "s1", type: "infrastructure_attempt", startedAt: fixedTime(0), endedAt: fixedTime(100), result: "failed_infrastructure" });
    ledger.record({ scenarioId: "s1", type: "agent_retry", startedAt: fixedTime(100), endedAt: fixedTime(200), result: "succeeded", retryOf: "s1-infrastructure_attempt-0" });
    const snap = ledger.snapshot();
    expect(snap.entries[0]!.recoveredBy).toBe("s1-agent_retry-0");
    expect(snap.entries[1]!.retryOf).toBe("s1-infrastructure_attempt-0");
  });
});

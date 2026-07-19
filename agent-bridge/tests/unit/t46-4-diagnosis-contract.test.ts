/**
 * T46-4 (Issue #97 §1) — Diagnosis contract tests.
 *
 * Verifies the frozen invariants of the V4 diagnosis contracts:
 *  1. The 5 frozen statuses are exactly those allowed (no synonyms).
 *  2. Status transition validation enforces the promotion ladder.
 *  3. Earliest divergence CANNOT auto-promote above localized_hypothesis.
 *  4. `statusSupportsFix` only allows intervention_supported or
 *     fault_injection_confirmed.
 *  5. `confidenceExceedsStatus` detects over-confidence.
 *  6. The 8 fault profile categories are exactly those allowed.
 *  7. The V4 contract version is declared and additive.
 */

import { describe, expect, it } from "vitest";
import {
  FROZEN_DIAGNOSIS_STATUSES,
  FAULT_PROFILE_CATEGORIES,
  REPAIR_PACKET_SCHEMA_VERSION,
  V4_CONTRACT_VERSION,
  assertValidStatusTransition,
  assertFrozenStatus,
  isTerminalStatus,
  statusSupportsFix,
  minimumConfidenceForStatus,
  confidenceAtLeast,
  confidenceExceedsStatus,
} from "../../src/evaluation/lab/diagnosis-contract.js";

describe("T46-4 diagnosis contract — frozen statuses", () => {
  it("exposes exactly the 5 frozen statuses in the canonical order", () => {
    expect(FROZEN_DIAGNOSIS_STATUSES).toEqual([
      "observed_failure",
      "localized_hypothesis",
      "intervention_supported",
      "fault_injection_confirmed",
      "unresolved",
    ]);
  });

  it("rejects synonymous status strings via assertFrozenStatus", () => {
    expect(() => assertFrozenStatus("confirmed")).toThrow(/非法诊断状态/);
    expect(() => assertFrozenStatus("suspected")).toThrow(/非法诊断状态/);
    expect(() => assertFrozenStatus("likely_cause")).toThrow(/非法诊断状态/);
    expect(() => assertFrozenStatus("root_cause")).toThrow(/非法诊断状态/);
  });

  it("accepts each of the 5 frozen statuses", () => {
    for (const status of FROZEN_DIAGNOSIS_STATUSES) {
      expect(() => assertFrozenStatus(status)).not.toThrow();
    }
  });
});

describe("T46-4 diagnosis contract — status transitions", () => {
  it("allows observed_failure → localized_hypothesis", () => {
    expect(() =>
      assertValidStatusTransition(
        "observed_failure",
        "localized_hypothesis",
        "fault profile matched",
      ),
    ).not.toThrow();
  });

  it("allows observed_failure → unresolved", () => {
    expect(() =>
      assertValidStatusTransition(
        "observed_failure",
        "unresolved",
        "conflicting evidence",
      ),
    ).not.toThrow();
  });

  it("allows localized_hypothesis → intervention_supported", () => {
    expect(() =>
      assertValidStatusTransition(
        "localized_hypothesis",
        "intervention_supported",
        "counterfactual supports",
      ),
    ).not.toThrow();
  });

  it("allows localized_hypothesis → fault_injection_confirmed", () => {
    expect(() =>
      assertValidStatusTransition(
        "localized_hypothesis",
        "fault_injection_confirmed",
        "fault profile reproduced",
      ),
    ).not.toThrow();
  });

  it("forbids observed_failure → intervention_supported (skipping levels)", () => {
    expect(() =>
      assertValidStatusTransition(
        "observed_failure",
        "intervention_supported",
        "should require intermediate",
      ),
    ).toThrow(/诊断状态转换无效/);
  });

  it("forbids observed_failure → fault_injection_confirmed (skipping levels)", () => {
    expect(() =>
      assertValidStatusTransition(
        "observed_failure",
        "fault_injection_confirmed",
        "should require intermediate",
      ),
    ).toThrow(/诊断状态转换无效/);
  });

  it("forbids downgrading from fault_injection_confirmed", () => {
    expect(() =>
      assertValidStatusTransition(
        "fault_injection_confirmed",
        "intervention_supported",
        "cannot downgrade",
      ),
    ).toThrow(/诊断状态转换无效/);
  });

  it("forbids same-status transitions", () => {
    expect(() =>
      assertValidStatusTransition(
        "observed_failure",
        "observed_failure",
        "no change",
      ),
    ).toThrow(/无变化/);
  });

  it("treats fault_injection_confirmed and unresolved as terminal", () => {
    expect(isTerminalStatus("fault_injection_confirmed")).toBe(true);
    expect(isTerminalStatus("unresolved")).toBe(true);
    expect(isTerminalStatus("observed_failure")).toBe(false);
    expect(isTerminalStatus("localized_hypothesis")).toBe(false);
    expect(isTerminalStatus("intervention_supported")).toBe(false);
  });
});

describe("T46-4 diagnosis contract — fix support and confidence", () => {
  it("only intervention_supported and fault_injection_confirmed support fix", () => {
    expect(statusSupportsFix("observed_failure")).toBe(false);
    expect(statusSupportsFix("localized_hypothesis")).toBe(false);
    expect(statusSupportsFix("intervention_supported")).toBe(true);
    expect(statusSupportsFix("fault_injection_confirmed")).toBe(true);
    expect(statusSupportsFix("unresolved")).toBe(false);
  });

  it("minimumConfidenceForStatus maps each status correctly", () => {
    expect(minimumConfidenceForStatus("observed_failure")).toBe("very_low");
    expect(minimumConfidenceForStatus("localized_hypothesis")).toBe("low");
    expect(minimumConfidenceForStatus("intervention_supported")).toBe("medium");
    expect(minimumConfidenceForStatus("fault_injection_confirmed")).toBe("high");
    expect(minimumConfidenceForStatus("unresolved")).toBe("very_low");
  });

  it("confidenceAtLeast respects the ordering", () => {
    expect(confidenceAtLeast("high", "medium")).toBe(true);
    expect(confidenceAtLeast("very_low", "medium")).toBe(false);
    expect(confidenceAtLeast("medium", "medium")).toBe(true);
  });

  it("confidenceExceedsStatus flags over-confidence", () => {
    expect(confidenceExceedsStatus("observed_failure", "medium")).toBe(true);
    expect(confidenceExceedsStatus("observed_failure", "low")).toBe(false);
    expect(confidenceExceedsStatus("localized_hypothesis", "high")).toBe(true);
    expect(confidenceExceedsStatus("localized_hypothesis", "medium")).toBe(false);
    expect(confidenceExceedsStatus("intervention_supported", "very_high")).toBe(true);
    expect(confidenceExceedsStatus("intervention_supported", "high")).toBe(false);
    expect(confidenceExceedsStatus("fault_injection_confirmed", "very_high")).toBe(false);
    expect(confidenceExceedsStatus("unresolved", "medium")).toBe(true);
    expect(confidenceExceedsStatus("unresolved", "low")).toBe(false);
  });
});

describe("T46-4 diagnosis contract — fault profile categories", () => {
  it("exposes exactly the 8 required categories", () => {
    expect(FAULT_PROFILE_CATEGORIES).toEqual([
      "routing",
      "context",
      "skill",
      "tool_schema_or_result",
      "policy_or_effect_boundary",
      "privacy_or_visibility",
      "proposal_evidence",
      "terminal_events",
    ]);
  });
});

describe("T46-4 diagnosis contract — version constants", () => {
  it("exposes the V4 contract version", () => {
    expect(V4_CONTRACT_VERSION).toBe(1);
  });

  it("exposes the repair packet schema version", () => {
    expect(REPAIR_PACKET_SCHEMA_VERSION).toBe(1);
  });
});

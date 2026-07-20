/**
 * T46-5 (Issue #98 §1) — Calibration contract tests.
 *
 * Verifies the frozen invariants of the V5 calibration contracts:
 *  1. The 5 frozen semantic verdicts are exactly those allowed.
 *  2. The 4 frozen candidate statuses are exactly those allowed.
 *  3. The 3 frozen conflict resolutions are exactly those allowed.
 *  4. The 8 frozen standard source types are exactly those allowed.
 *  5. The 9 frozen fail-safe reasons are exactly those allowed.
 *  6. The 8 frozen hard gates are exactly those allowed.
 *  7. `decideJudgeFailSafe` returns the correct reason for each class.
 *  8. `combineHardGateWithSemantic` always lets hard-gate failure win.
 *  9. All V5 schema versions are 1 and declared.
 * 10. Frozen assertions reject synonymous strings.
 */

import { describe, expect, it } from "vitest";
import {
  CALIBRATION_ARTIFACT_SCHEMA_VERSION,
  STANDARDS_REGISTRY_SCHEMA_VERSION,
  SEMANTIC_RUBRIC_SCHEMA_VERSION,
  SEMANTIC_ANCHOR_SCHEMA_VERSION,
  JUDGE_MANIFEST_SCHEMA_VERSION,
  STANDARD_DIFF_SCHEMA_VERSION,
  PROMOTION_APPROVAL_SCHEMA_VERSION,
  V5_CONTRACT_VERSION,
  FROZEN_SEMANTIC_VERDICTS,
  FROZEN_CANDIDATE_STATUSES,
  FROZEN_CONFLICT_RESOLUTIONS,
  FROZEN_STANDARD_SOURCE_TYPES,
  FROZEN_FAIL_SAFE_REASONS,
  FROZEN_HARD_GATES,
  assertFrozenVerdict,
  assertFrozenCandidateStatus,
  assertFrozenConflictResolution,
  assertFrozenStandardSourceType,
  decideJudgeFailSafe,
  combineHardGateWithSemantic,
} from "../../src/evaluation/lab/calibration-contract.js";

describe("T46-5 calibration contract — schema versions", () => {
  it("declares all V5 schema versions as 1", () => {
    expect(CALIBRATION_ARTIFACT_SCHEMA_VERSION).toBe(1);
    expect(STANDARDS_REGISTRY_SCHEMA_VERSION).toBe(1);
    expect(SEMANTIC_RUBRIC_SCHEMA_VERSION).toBe(1);
    expect(SEMANTIC_ANCHOR_SCHEMA_VERSION).toBe(1);
    expect(JUDGE_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(STANDARD_DIFF_SCHEMA_VERSION).toBe(1);
    expect(PROMOTION_APPROVAL_SCHEMA_VERSION).toBe(1);
    expect(V5_CONTRACT_VERSION).toBe(1);
  });
});

describe("T46-5 calibration contract — frozen semantic verdicts", () => {
  it("exposes exactly the 5 frozen verdicts", () => {
    expect(FROZEN_SEMANTIC_VERDICTS).toEqual([
      "pass",
      "fail",
      "needs_review",
      "infra_error",
      "insufficient_evidence",
    ]);
  });

  it("rejects synonymous verdict strings via assertFrozenVerdict", () => {
    expect(() => assertFrozenVerdict("ok")).toThrow(/非法 semantic verdict/);
    expect(() => assertFrozenVerdict("success")).toThrow(/非法 semantic verdict/);
    expect(() => assertFrozenVerdict("skipped")).toThrow(/非法 semantic verdict/);
    expect(() => assertFrozenVerdict("uncertain")).toThrow(/非法 semantic verdict/);
    expect(() => assertFrozenVerdict("error")).toThrow(/非法 semantic verdict/);
  });

  it("accepts each of the 5 frozen verdicts", () => {
    for (const verdict of FROZEN_SEMANTIC_VERDICTS) {
      expect(() => assertFrozenVerdict(verdict)).not.toThrow();
    }
  });
});

describe("T46-5 calibration contract — frozen candidate statuses", () => {
  it("exposes exactly the 4 frozen statuses", () => {
    expect(FROZEN_CANDIDATE_STATUSES).toEqual([
      "candidate",
      "approved",
      "rejected",
      "superseded",
    ]);
  });

  it("rejects synonymous status strings via assertFrozenCandidateStatus", () => {
    expect(() => assertFrozenCandidateStatus("promoted")).toThrow(/非法 candidate status/);
    expect(() => assertFrozenCandidateStatus("active")).toThrow(/非法 candidate status/);
    expect(() => assertFrozenCandidateStatus("pending")).toThrow(/非法 candidate status/);
  });

  it("accepts each of the 4 frozen statuses", () => {
    for (const status of FROZEN_CANDIDATE_STATUSES) {
      expect(() => assertFrozenCandidateStatus(status)).not.toThrow();
    }
  });
});

describe("T46-5 calibration contract — frozen conflict resolutions", () => {
  it("exposes exactly the 3 frozen resolutions", () => {
    expect(FROZEN_CONFLICT_RESOLUTIONS).toEqual([
      "unresolved",
      "resolved",
      "deferred",
    ]);
  });

  it("rejects synonymous resolution strings via assertFrozenConflictResolution", () => {
    expect(() => assertFrozenConflictResolution("fixed")).toThrow(/非法 standard conflict resolution/);
    expect(() => assertFrozenConflictResolution("closed")).toThrow(/非法 standard conflict resolution/);
    expect(() => assertFrozenConflictResolution("pending")).toThrow(/非法 standard conflict resolution/);
  });

  it("accepts each of the 3 frozen resolutions", () => {
    for (const resolution of FROZEN_CONFLICT_RESOLUTIONS) {
      expect(() => assertFrozenConflictResolution(resolution)).not.toThrow();
    }
  });
});

describe("T46-5 calibration contract — frozen standard source types", () => {
  it("exposes exactly the 8 frozen source types", () => {
    expect(FROZEN_STANDARD_SOURCE_TYPES).toEqual([
      "canonical_doc",
      "adr",
      "pydantic_schema",
      "typescript_schema",
      "public_behavior_contract",
      "current_code_behavior",
      "frozen_scenario",
      "frozen_standard",
    ]);
  });

  it("rejects synonymous source type strings via assertFrozenStandardSourceType", () => {
    expect(() => assertFrozenStandardSourceType("doc")).toThrow(/非法 standard source type/);
    expect(() => assertFrozenStandardSourceType("spec")).toThrow(/非法 standard source type/);
    expect(() => assertFrozenStandardSourceType("code")).toThrow(/非法 standard source type/);
  });

  it("accepts each of the 8 frozen source types", () => {
    for (const source of FROZEN_STANDARD_SOURCE_TYPES) {
      expect(() => assertFrozenStandardSourceType(source)).not.toThrow();
    }
  });
});

describe("T46-5 calibration contract — frozen fail-safe reasons", () => {
  it("exposes exactly the 9 frozen reasons", () => {
    expect(FROZEN_FAIL_SAFE_REASONS).toEqual([
      "no_independent_judge",
      "judge_identity_unconfirmed",
      "only_same_family_uncalibrated",
      "judges_conflict",
      "anchor_ordering_unstable",
      "bias_metrics_exceeded",
      "judge_telemetry_incomplete",
      "judge_schema_unrepairable",
      "calibration_evidence_insufficient",
    ]);
  });

  it("decideJudgeFailSafe returns the correct reason for each class", () => {
    // Build a baseline input where all flags are healthy.
    const baseline = {
      independentJudgeAvailable: true,
      judgeIdentityConfirmed: true,
      onlySameFamilyUncalibrated: false,
      judgesConflict: false,
      anchorOrderingUnstable: false,
      biasMetricsExceeded: false,
      judgeTelemetryIncomplete: false,
      judgeSchemaUnrepairable: false,
      calibrationEvidenceInsufficient: false,
    };
    // Each class, when triggered, returns the matching reason.
    expect(decideJudgeFailSafe({ ...baseline, independentJudgeAvailable: false })).toBe("no_independent_judge");
    expect(decideJudgeFailSafe({ ...baseline, judgeIdentityConfirmed: false })).toBe("judge_identity_unconfirmed");
    expect(decideJudgeFailSafe({ ...baseline, onlySameFamilyUncalibrated: true })).toBe("only_same_family_uncalibrated");
    expect(decideJudgeFailSafe({ ...baseline, judgesConflict: true })).toBe("judges_conflict");
    expect(decideJudgeFailSafe({ ...baseline, anchorOrderingUnstable: true })).toBe("anchor_ordering_unstable");
    expect(decideJudgeFailSafe({ ...baseline, biasMetricsExceeded: true })).toBe("bias_metrics_exceeded");
    expect(decideJudgeFailSafe({ ...baseline, judgeTelemetryIncomplete: true })).toBe("judge_telemetry_incomplete");
    expect(decideJudgeFailSafe({ ...baseline, judgeSchemaUnrepairable: true })).toBe("judge_schema_unrepairable");
    expect(decideJudgeFailSafe({ ...baseline, calibrationEvidenceInsufficient: true })).toBe("calibration_evidence_insufficient");
  });

  it("decideJudgeFailSafe returns null when all conditions are healthy", () => {
    expect(decideJudgeFailSafe({
      independentJudgeAvailable: true,
      judgeIdentityConfirmed: true,
      onlySameFamilyUncalibrated: false,
      judgesConflict: false,
      anchorOrderingUnstable: false,
      biasMetricsExceeded: false,
      judgeTelemetryIncomplete: false,
      judgeSchemaUnrepairable: false,
      calibrationEvidenceInsufficient: false,
    })).toBeNull();
  });

  it("decideJudgeFailSafe returns the FIRST triggered reason (priority order)", () => {
    // When multiple conditions trigger simultaneously, the first in the
    // priority order wins. This is a deliberate design choice so the
    // fail-safe reason is deterministic.
    const result = decideJudgeFailSafe({
      independentJudgeAvailable: false,
      judgeIdentityConfirmed: false,
      onlySameFamilyUncalibrated: true,
      judgesConflict: true,
      anchorOrderingUnstable: true,
      biasMetricsExceeded: true,
      judgeTelemetryIncomplete: true,
      judgeSchemaUnrepairable: true,
      calibrationEvidenceInsufficient: true,
    });
    expect(result).toBe("no_independent_judge");
  });
});

describe("T46-5 calibration contract — frozen hard gates", () => {
  it("exposes exactly the 8 frozen hard gates", () => {
    expect(FROZEN_HARD_GATES).toEqual([
      "state_invariant",
      "authority",
      "privacy_visibility",
      "proposal_confirm",
      "terminal_consistency",
      "idempotency",
      "forbidden_side_effect",
      "frozen_p0_gate",
    ]);
  });
});

describe("T46-5 calibration contract — hard gate precedence", () => {
  it("combineHardGateWithSemantic returns fail when hard gate failed", () => {
    const result = combineHardGateWithSemantic(false, "pass");
    expect(result.finalVerdict).toBe("fail");
    expect(result.rationale).toMatch(/hard gate 失败/);
  });

  it("combineHardGateWithSemantic preserves semantic verdict when hard gate passed", () => {
    const result = combineHardGateWithSemantic(true, "needs_review");
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.rationale).toMatch(/hard gate 通过/);
  });

  it("combineHardGateWithSemantic never upgrades a fail to pass via semantic", () => {
    // Even if semantic says "pass", hard-gate failure wins.
    const r1 = combineHardGateWithSemantic(false, "pass");
    expect(r1.finalVerdict).toBe("fail");
    // Hard gate pass + semantic fail = fail (semantic stands, can downgrade).
    const r2 = combineHardGateWithSemantic(true, "fail");
    expect(r2.finalVerdict).toBe("fail");
  });

  it("combineHardGateWithSemantic lets hard-gate failure override any semantic verdict", () => {
    for (const verdict of FROZEN_SEMANTIC_VERDICTS) {
      const result = combineHardGateWithSemantic(false, verdict);
      expect(result.finalVerdict).toBe("fail");
    }
  });
});

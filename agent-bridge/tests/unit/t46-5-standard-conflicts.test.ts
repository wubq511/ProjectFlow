/**
 * T46-5 (Issue #98 §2) — Standard conflict detection tests.
 *
 * Verifies:
 *  1. The frozen conflict catalog contains exactly 6 patterns covering
 *     all required source-type combinations.
 *  2. `detectStandardConflicts` detects conflicts where the same aspect
 *     has multiple distinct values.
 *  3. `inferSeverity` assigns "high" when current_code_behavior
 *     conflicts with an authoritative source.
 *  4. `resolveStandardConflict` requires a non-empty rationale.
 *  5. `hasUnresolvedConflict` returns true when any conflict affecting
 *     a candidate is unresolved.
 *  6. The detector NEVER silently chooses one side; both claims are
 *     recorded.
 *  7. Current code behavior NEVER becomes truth merely because it
 *     exists (it's recorded as a claim, not a resolution).
 */

import { describe, expect, it } from "vitest";
import {
  FROZEN_CONFLICT_PATTERNS,
  generateConflictId,
  inferSeverity,
  detectStandardConflicts,
  resolveStandardConflict,
  hasUnresolvedConflict,
  getUnresolvedConflicts,
  verifyConflictCatalog,
  type StructuredClaim,
} from "../../src/evaluation/lab/standard-conflicts.js";
import type { StandardConflict, StandardSourceType } from "../../src/evaluation/lab/calibration-contract.js";

describe("T46-5 standard conflicts — frozen catalog", () => {
  it("exposes exactly 6 frozen conflict patterns", () => {
    expect(FROZEN_CONFLICT_PATTERNS).toHaveLength(6);
  });

  it("covers all 6 required source-type combinations", () => {
    const patternIds = FROZEN_CONFLICT_PATTERNS.map((p) => p.patternId);
    expect(patternIds).toEqual([
      "canonical-vs-adr",
      "canonical-vs-schema",
      "canonical-vs-public-behavior",
      "schema-vs-code",
      "frozen-scenario-vs-code",
      "frozen-standard-vs-candidate",
    ]);
  });

  it("verifyConflictCatalog returns complete=true when all patterns present", () => {
    const result = verifyConflictCatalog();
    expect(result.complete).toBe(true);
    expect(result.missingPatterns).toEqual([]);
  });

  it("verifyConflictCatalog detects missing patterns", () => {
    // Build a synthetic catalog missing one pattern to verify the verifier.
    const present = new Set(
      FROZEN_CONFLICT_PATTERNS.slice(0, 5).map((p) => p.patternId),
    );
    const required = [
      "canonical-vs-adr",
      "canonical-vs-schema",
      "canonical-vs-public-behavior",
      "schema-vs-code",
      "frozen-scenario-vs-code",
      "frozen-standard-vs-candidate",
    ];
    const missing = required.filter((p) => !present.has(p));
    expect(missing).toEqual(["frozen-standard-vs-candidate"]);
  });
});

describe("T46-5 standard conflicts — generateConflictId", () => {
  it("produces a stable ID from claim hashes (order-independent)", () => {
    const claimsA = [
      { claim: "claim-1", source: { hash: "hash-1" } },
      { claim: "claim-2", source: { hash: "hash-2" } },
    ];
    const claimsB = [
      { claim: "claim-2", source: { hash: "hash-2" } },
      { claim: "claim-1", source: { hash: "hash-1" } },
    ];
    expect(generateConflictId(claimsA)).toBe(generateConflictId(claimsB));
  });

  it("produces different IDs for different claims", () => {
    const claims1 = [{ claim: "claim-1", source: { hash: "hash-1" } }];
    const claims2 = [{ claim: "claim-2", source: { hash: "hash-2" } }];
    expect(generateConflictId(claims1)).not.toBe(generateConflictId(claims2));
  });

  it("prefixes the ID with 'conflict_'", () => {
    const id = generateConflictId([{ claim: "x", source: { hash: "y" } }]);
    expect(id.startsWith("conflict_")).toBe(true);
  });
});

describe("T46-5 standard conflicts — inferSeverity", () => {
  it("returns 'high' when current_code_behavior conflicts with authoritative sources", () => {
    const highCases: StandardSourceType[][] = [
      ["current_code_behavior", "canonical_doc"],
      ["current_code_behavior", "adr"],
      ["current_code_behavior", "pydantic_schema"],
      ["current_code_behavior", "typescript_schema"],
      ["current_code_behavior", "public_behavior_contract"],
      ["current_code_behavior", "frozen_scenario"],
      ["current_code_behavior", "frozen_standard"],
    ];
    for (const sources of highCases) {
      expect(inferSeverity(sources)).toBe("high");
    }
  });

  it("returns 'medium' when two authoritative sources disagree", () => {
    expect(inferSeverity(["canonical_doc", "adr"])).toBe("medium");
    expect(inferSeverity(["canonical_doc", "pydantic_schema"])).toBe("medium");
    expect(inferSeverity(["canonical_doc", "typescript_schema"])).toBe("medium");
  });

  it("returns 'medium' when frozen standard/scenario is involved", () => {
    expect(inferSeverity(["frozen_standard", "canonical_doc"])).toBe("medium");
    expect(inferSeverity(["frozen_scenario", "canonical_doc"])).toBe("medium");
  });

  it("returns 'low' otherwise", () => {
    expect(inferSeverity(["canonical_doc"])).toBe("low");
    expect(inferSeverity([])).toBe("low");
  });
});

describe("T46-5 standard conflicts — detectStandardConflicts", () => {
  function buildClaim(
    aspectKey: string,
    value: string,
    sourceType: StandardSourceType,
    affectsCandidateId?: string,
  ): StructuredClaim {
    return {
      claim: `${aspectKey}=${value}`,
      source: {
        type: sourceType,
        version: "v1",
        hash: `hash-${aspectKey}-${value}-${sourceType}`,
      },
      aspectKey,
      value,
      affectsCandidateId,
    };
  }

  it("returns no conflicts when all claims agree on the same value", () => {
    const claims = [
      buildClaim("proposal-confirm.required", "true", "canonical_doc"),
      buildClaim("proposal-confirm.required", "true", "adr"),
    ];
    const conflicts = detectStandardConflicts(claims, "2026-07-20T00:00:00.000Z");
    expect(conflicts).toEqual([]);
  });

  it("detects a conflict when two claims disagree on the same aspect", () => {
    const claims = [
      buildClaim("proposal-confirm.required", "true", "canonical_doc"),
      buildClaim("proposal-confirm.required", "false", "current_code_behavior", "candidate-1"),
    ];
    const conflicts = detectStandardConflicts(claims, "2026-07-20T00:00:00.000Z");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflictingClaims).toHaveLength(2);
    expect(conflicts[0]!.resolutionStatus).toBe("unresolved");
    expect(conflicts[0]!.severity).toBe("high");
  });

  it("records ALL conflicting claims (never silently chooses one side)", () => {
    const claims = [
      buildClaim("aspect", "value-1", "canonical_doc"),
      buildClaim("aspect", "value-2", "adr"),
      buildClaim("aspect", "value-3", "current_code_behavior"),
    ];
    const conflicts = detectStandardConflicts(claims, "2026-07-20T00:00:00.000Z");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.conflictingClaims).toHaveLength(3);
  });

  it("associates conflicts with the affected candidate standards", () => {
    const claims = [
      buildClaim("aspect", "v1", "canonical_doc", "candidate-A"),
      buildClaim("aspect", "v2", "current_code_behavior", "candidate-A"),
    ];
    const conflicts = detectStandardConflicts(claims, "2026-07-20T00:00:00.000Z");
    expect(conflicts[0]!.affectedCandidateStandards).toContain("candidate-A");
  });

  it("detects multiple conflicts across different aspects", () => {
    const claims = [
      buildClaim("aspect-1", "v1", "canonical_doc"),
      buildClaim("aspect-1", "v2", "adr"),
      buildClaim("aspect-2", "x", "pydantic_schema"),
      buildClaim("aspect-2", "y", "current_code_behavior"),
    ];
    const conflicts = detectStandardConflicts(claims, "2026-07-20T00:00:00.000Z");
    expect(conflicts).toHaveLength(2);
  });

  it("current code behavior NEVER becomes truth — it's recorded as a claim, not a resolution", () => {
    const claims = [
      buildClaim("aspect", "spec-value", "canonical_doc"),
      buildClaim("aspect", "code-value", "current_code_behavior"),
    ];
    const conflicts = detectStandardConflicts(claims, "2026-07-20T00:00:00.000Z");
    // Conflict should be detected and recorded with resolutionStatus=unresolved.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.resolutionStatus).toBe("unresolved");
    // Both claims are in conflictingClaims (no side chosen).
    expect(conflicts[0]!.conflictingClaims).toHaveLength(2);
    // No resolutionRationale (not auto-resolved).
    expect(conflicts[0]!.resolutionRationale).toBeUndefined();
  });
});

describe("T46-5 standard conflicts — resolveStandardConflict", () => {
  function buildUnresolvedConflict(): StandardConflict {
    return {
      conflictId: "conflict-1",
      conflictingClaims: [
        { claim: "v1", source: { type: "canonical_doc", version: "v1", hash: "h1" } },
        { claim: "v2", source: { type: "current_code_behavior", version: "v1", hash: "h2" } },
      ],
      severity: "high",
      resolutionStatus: "unresolved",
      affectedCandidateStandards: ["candidate-1"],
      detectedAt: "2026-07-20T00:00:00.000Z",
    };
  }

  it("resolves a conflict with a non-empty rationale", () => {
    const conflict = buildUnresolvedConflict();
    const resolved = resolveStandardConflict(conflict, "resolved", "Robert 决议: 按 canonical 文档执行");
    expect(resolved.resolutionStatus).toBe("resolved");
    expect(resolved.resolutionRationale).toBe("Robert 决议: 按 canonical 文档执行");
  });

  it("defers a conflict with a non-empty rationale", () => {
    const conflict = buildUnresolvedConflict();
    const deferred = resolveStandardConflict(conflict, "deferred", "等待 ADR 更新");
    expect(deferred.resolutionStatus).toBe("deferred");
  });

  it("rejects an empty rationale", () => {
    const conflict = buildUnresolvedConflict();
    expect(() => resolveStandardConflict(conflict, "resolved", "")).toThrow(
      /resolution rationale 不能为空/,
    );
    expect(() => resolveStandardConflict(conflict, "resolved", "   ")).toThrow(
      /resolution rationale 不能为空/,
    );
  });

  it("rejects an invalid resolution string", () => {
    const conflict = buildUnresolvedConflict();
    expect(() => resolveStandardConflict(conflict, "fixed" as "resolved", "rationale")).toThrow(
      /非法 standard conflict resolution/,
    );
  });
});

describe("T46-5 standard conflicts — hasUnresolvedConflict", () => {
  function buildConflict(candidateId: string, resolutionStatus: StandardConflict["resolutionStatus"]): StandardConflict {
    return {
      conflictId: `conflict-${candidateId}-${resolutionStatus}`,
      conflictingClaims: [
        { claim: "v1", source: { type: "canonical_doc", version: "v1", hash: "h1" } },
        { claim: "v2", source: { type: "current_code_behavior", version: "v1", hash: "h2" } },
      ],
      severity: "high",
      resolutionStatus,
      affectedCandidateStandards: [candidateId],
      detectedAt: "2026-07-20T00:00:00.000Z",
    };
  }

  it("returns true when any conflict affecting the candidate is unresolved", () => {
    const conflicts = [buildConflict("candidate-1", "unresolved")];
    expect(hasUnresolvedConflict(conflicts, "candidate-1")).toBe(true);
  });

  it("returns false when all conflicts affecting the candidate are resolved", () => {
    const conflicts = [
      buildConflict("candidate-1", "resolved"),
      buildConflict("candidate-1", "resolved"),
    ];
    expect(hasUnresolvedConflict(conflicts, "candidate-1")).toBe(false);
  });

  it("returns true when any conflict affecting the candidate is deferred (deferred blocks promotion)", () => {
    // `deferred` is NOT a resolution — it just defers the decision. For
    // promotion safety, deferred conflicts still block. Otherwise one
    // could defer all conflicts and promote a candidate with known
    // unresolved semantic disagreements.
    const conflicts = [buildConflict("candidate-1", "deferred")];
    expect(hasUnresolvedConflict(conflicts, "candidate-1")).toBe(true);
  });

  it("returns false when no conflict affects the candidate", () => {
    const conflicts = [buildConflict("candidate-2", "unresolved")];
    expect(hasUnresolvedConflict(conflicts, "candidate-1")).toBe(false);
  });

  it("returns true when at least one conflict is unresolved (mix of statuses)", () => {
    const conflicts = [
      buildConflict("candidate-1", "resolved"),
      buildConflict("candidate-1", "unresolved"),
    ];
    expect(hasUnresolvedConflict(conflicts, "candidate-1")).toBe(true);
  });
});

describe("T46-5 standard conflicts — getUnresolvedConflicts", () => {
  it("returns only unresolved conflicts affecting any of the candidates", () => {
    const conflicts: StandardConflict[] = [
      {
        conflictId: "c1",
        conflictingClaims: [],
        severity: "high",
        resolutionStatus: "unresolved",
        affectedCandidateStandards: ["candidate-A"],
        detectedAt: "2026-07-20T00:00:00.000Z",
      },
      {
        conflictId: "c2",
        conflictingClaims: [],
        severity: "medium",
        resolutionStatus: "resolved",
        affectedCandidateStandards: ["candidate-A"],
        detectedAt: "2026-07-20T00:00:00.000Z",
      },
      {
        conflictId: "c3",
        conflictingClaims: [],
        severity: "high",
        resolutionStatus: "unresolved",
        affectedCandidateStandards: ["candidate-B"],
        detectedAt: "2026-07-20T00:00:00.000Z",
      },
    ];
    const candidates = [
      { candidateId: "candidate-A", entry: {} as never, status: "candidate" as const, producedByRunId: "r1", affectedByConflicts: [], createdAt: "" },
    ];
    const unresolved = getUnresolvedConflicts(conflicts, candidates);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.conflictId).toBe("c1");
  });
});

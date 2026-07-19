/**
 * T46-4 (Issue #97 §6) — Issue clustering tests.
 *
 * Verifies:
 *  1. Observations merge ONLY when they share cause evidence.
 *  2. Same symptom but different evidence does NOT merge.
 *  3. Different viewers do NOT merge.
 *  4. Different privacy boundaries do NOT merge.
 *  5. Different contract violation types do NOT merge.
 *  6. The cluster records the shared cause evidence.
 *  7. The cluster records refusal reasons for non-merged observations.
 *  8. The cluster's confidence is the lowest among members.
 *  9. The cluster's causal status is the highest among members.
 * 10. Text similarity alone is NOT used for merging.
 */

import { describe, expect, it } from "vitest";
import {
  sharesCauseEvidence,
  mergeRefusalReason,
  clusterObservations,
  verifyClusterInvariants,
  clusterConfidenceIsLowest,
  type ClusterCandidate,
} from "../../src/evaluation/lab/issue-clustering.js";
import type {
  DiagnosisRecord,
  EvidenceRecord,
  HypothesisRecord,
} from "../../src/evaluation/lab/diagnosis-contract.js";

function buildEvidence(evidenceId: string, kind: EvidenceRecord["kind"] = "hard_grader_failure"): EvidenceRecord[] {
  return [{
    evidenceId,
    kind,
    summary: "test evidence",
    reference: "observations/scn-1.json",
    facts: {},
  }];
}

function buildHypothesis(candidateCause: string, evidenceId: string): HypothesisRecord {
  return {
    hypothesisId: "hyp-1",
    candidateCause,
    status: "localized_hypothesis",
    supportingEvidence: [evidenceId],
    contradictingEvidence: [],
    candidateCodeSurfaces: [{
      surfaceId: "surface-1",
      component: "model-router.ts",
      reason: "test",
      evidenceLevel: "hypothesis",
      evidence: [evidenceId],
    }],
  };
}

function buildDiagnosis(
  diagnosisId: string,
  evidence: EvidenceRecord[],
  hypotheses: HypothesisRecord[],
  overrides: Partial<DiagnosisRecord> = {},
): DiagnosisRecord {
  return {
    diagnosisId,
    runId: "run-1",
    scenarioId: `scn-${diagnosisId}`,
    observationId: `obs-${diagnosisId}`,
    observedSymptom: "test symptom",
    expectedContract: "test contract",
    causalStatus: "localized_hypothesis",
    confidence: "low",
    evidence,
    hypotheses,
    createdAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

function buildCandidate(
  diagnosisId: string,
  evidence: EvidenceRecord[],
  hypotheses: HypothesisRecord[],
  overrides: Partial<ClusterCandidate> = {},
): ClusterCandidate {
  return {
    diagnosis: buildDiagnosis(diagnosisId, evidence, hypotheses),
    ...overrides,
  };
}

describe("T46-4 issue clustering — shared evidence predicate", () => {
  it("merges when candidates share an evidence ID", () => {
    const evidence = buildEvidence("shared-evid-1");
    const a = buildCandidate("diag-a", evidence, [buildHypothesis("cause A", "shared-evid-1")]);
    const b = buildCandidate("diag-b", evidence, [buildHypothesis("cause B", "shared-evid-1")]);
    expect(sharesCauseEvidence(a, b)).toBe(true);
  });

  it("does NOT merge when evidence IDs differ", () => {
    const a = buildCandidate(
      "diag-a",
      buildEvidence("evid-a"),
      [buildHypothesis("cause A", "evid-a")],
    );
    const b = buildCandidate(
      "diag-b",
      buildEvidence("evid-b"),
      [buildHypothesis("cause B", "evid-b")],
    );
    expect(sharesCauseEvidence(a, b)).toBe(false);
  });

  it("does NOT merge when viewers differ", () => {
    const evidence = buildEvidence("shared-evid-1");
    const a = buildCandidate(
      "diag-a",
      evidence,
      [buildHypothesis("cause A", "shared-evid-1")],
      { viewer: "user-1" },
    );
    const b = buildCandidate(
      "diag-b",
      evidence,
      [buildHypothesis("cause B", "shared-evid-1")],
      { viewer: "user-2" },
    );
    expect(sharesCauseEvidence(a, b)).toBe(false);
  });

  it("does NOT merge when privacy boundaries differ", () => {
    const evidence = buildEvidence("shared-evid-1");
    const a = buildCandidate(
      "diag-a",
      evidence,
      [buildHypothesis("cause A", "shared-evid-1")],
      { privacyBoundary: "private" },
    );
    const b = buildCandidate(
      "diag-b",
      evidence,
      [buildHypothesis("cause B", "shared-evid-1")],
      { privacyBoundary: "team" },
    );
    expect(sharesCauseEvidence(a, b)).toBe(false);
  });

  it("does NOT merge when contract violation types differ", () => {
    const evidence = buildEvidence("shared-evid-1");
    const a = buildCandidate(
      "diag-a",
      evidence,
      [buildHypothesis("cause A", "shared-evid-1")],
      { contractViolationType: "privacy" },
    );
    const b = buildCandidate(
      "diag-b",
      evidence,
      [buildHypothesis("cause B", "shared-evid-1")],
      { contractViolationType: "authority" },
    );
    expect(sharesCauseEvidence(a, b)).toBe(false);
  });
});

describe("T46-4 issue clustering — merge refusal reason", () => {
  it("returns undefined when candidates can merge", () => {
    const evidence = buildEvidence("shared-evid-1");
    const a = buildCandidate("diag-a", evidence, [buildHypothesis("cause A", "shared-evid-1")]);
    const b = buildCandidate("diag-b", evidence, [buildHypothesis("cause B", "shared-evid-1")]);
    expect(mergeRefusalReason(a, b)).toBeUndefined();
  });

  it("returns a reason when candidates cannot merge", () => {
    const a = buildCandidate(
      "diag-a",
      buildEvidence("evid-a"),
      [buildHypothesis("cause A", "evid-a")],
    );
    const b = buildCandidate(
      "diag-b",
      buildEvidence("evid-b"),
      [buildHypothesis("cause B", "evid-b")],
    );
    const reason = mergeRefusalReason(a, b);
    expect(reason).toBeDefined();
    expect(typeof reason).toBe("string");
  });
});

describe("T46-4 issue clustering — clustering algorithm", () => {
  it("merges candidates that share evidence", () => {
    const evidence = buildEvidence("shared-evid-1");
    const candidates = [
      buildCandidate("diag-a", evidence, [buildHypothesis("cause A", "shared-evid-1")]),
      buildCandidate("diag-b", evidence, [buildHypothesis("cause B", "shared-evid-1")]),
    ];
    const result = clusterObservations(candidates, "run-1", "2026-07-20T00:00:00Z");
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]!.members.length).toBe(2);
    expect(result.singletons.length).toBe(0);
  });

  it("keeps candidates separate when they do not share evidence", () => {
    const candidates = [
      buildCandidate(
        "diag-a",
        buildEvidence("evid-a"),
        [buildHypothesis("cause A", "evid-a")],
      ),
      buildCandidate(
        "diag-b",
        buildEvidence("evid-b"),
        [buildHypothesis("cause B", "evid-b")],
      ),
    ];
    const result = clusterObservations(candidates, "run-1", "2026-07-20T00:00:00Z");
    expect(result.clusters.length).toBe(0);
    expect(result.singletons.length).toBe(2);
  });

  it("records shared cause evidence in the cluster", () => {
    const evidence = buildEvidence("shared-evid-1");
    const candidates = [
      buildCandidate("diag-a", evidence, [buildHypothesis("cause A", "shared-evid-1")]),
      buildCandidate("diag-b", evidence, [buildHypothesis("cause B", "shared-evid-1")]),
    ];
    const result = clusterObservations(candidates, "run-1", "2026-07-20T00:00:00Z");
    expect(result.clusters[0]!.sharedCauseEvidence).toContain("shared-evid-1");
  });

  it("records refused merges with reasons", () => {
    const evidence = buildEvidence("shared-evid-1");
    const candidates = [
      buildCandidate("diag-a", evidence, [buildHypothesis("cause A", "shared-evid-1")]),
      buildCandidate(
        "diag-b",
        buildEvidence("evid-b"),
        [buildHypothesis("cause B", "evid-b")],
      ),
    ];
    const result = clusterObservations(candidates, "run-1", "2026-07-20T00:00:00Z");
    // diag-a and diag-b don't share evidence, so they're both singletons.
    // The first singleton has a refused merge recorded for the second.
    const first = result.singletons[0]!;
    expect(first.refusedMerge.length).toBeGreaterThan(0);
    expect(first.refusedMerge[0]!.refusalReason).toBeDefined();
  });

  it("picks the highest status among members as the cluster status", () => {
    const evidence = buildEvidence("shared-evid-1");
    const candidates = [
      buildCandidate(
        "diag-a",
        evidence,
        [buildHypothesis("cause A", "shared-evid-1")],
        {},
      ),
      buildCandidate(
        "diag-b",
        evidence,
        [buildHypothesis("cause B", "shared-evid-1")],
        {},
      ),
    ];
    // Override statuses: one is localized_hypothesis, the other is fault_injection_confirmed.
    candidates[0]!.diagnosis.causalStatus = "localized_hypothesis";
    candidates[1]!.diagnosis.causalStatus = "fault_injection_confirmed";
    const result = clusterObservations(candidates, "run-1", "2026-07-20T00:00:00Z");
    expect(result.clusters[0]!.causalStatus).toBe("fault_injection_confirmed");
  });

  it("unresolved dominates when present among members", () => {
    const evidence = buildEvidence("shared-evid-1");
    const candidates = [
      buildCandidate(
        "diag-a",
        evidence,
        [buildHypothesis("cause A", "shared-evid-1")],
      ),
      buildCandidate(
        "diag-b",
        evidence,
        [buildHypothesis("cause B", "shared-evid-1")],
      ),
    ];
    candidates[0]!.diagnosis.causalStatus = "fault_injection_confirmed";
    candidates[1]!.diagnosis.causalStatus = "unresolved";
    const result = clusterObservations(candidates, "run-1", "2026-07-20T00:00:00Z");
    expect(result.clusters[0]!.causalStatus).toBe("unresolved");
  });

  it("picks the lowest confidence among members as the cluster confidence", () => {
    const evidence = buildEvidence("shared-evid-1");
    const candidates = [
      buildCandidate(
        "diag-a",
        evidence,
        [buildHypothesis("cause A", "shared-evid-1")],
      ),
      buildCandidate(
        "diag-b",
        evidence,
        [buildHypothesis("cause B", "shared-evid-1")],
      ),
    ];
    candidates[0]!.diagnosis.confidence = "high";
    candidates[1]!.diagnosis.confidence = "very_low";
    const result = clusterObservations(candidates, "run-1", "2026-07-20T00:00:00Z");
    expect(result.clusters[0]!.confidence).toBe("very_low");
  });

  it("returns empty results for empty input", () => {
    const result = clusterObservations([], "run-1", "2026-07-20T00:00:00Z");
    expect(result.clusters).toEqual([]);
    expect(result.singletons).toEqual([]);
  });
});

describe("T46-4 issue clustering — invariants", () => {
  it("verifyClusterInvariants passes for a well-formed cluster", () => {
    const evidence = buildEvidence("shared-evid-1");
    const candidates = [
      buildCandidate("diag-a", evidence, [buildHypothesis("cause A", "shared-evid-1")]),
      buildCandidate("diag-b", evidence, [buildHypothesis("cause B", "shared-evid-1")]),
    ];
    const result = clusterObservations(candidates, "run-1", "2026-07-20T00:00:00Z");
    const violations = verifyClusterInvariants(result.clusters[0]!);
    expect(violations).toEqual([]);
  });

  it("clusterConfidenceIsLowest returns true when cluster confidence is the lowest", () => {
    const evidence = buildEvidence("shared-evid-1");
    const candidates = [
      buildCandidate("diag-a", evidence, [buildHypothesis("cause A", "shared-evid-1")]),
      buildCandidate("diag-b", evidence, [buildHypothesis("cause B", "shared-evid-1")]),
    ];
    candidates[0]!.diagnosis.confidence = "high";
    candidates[1]!.diagnosis.confidence = "low";
    const result = clusterObservations(candidates, "run-1", "2026-07-20T00:00:00Z");
    const memberConfidences = candidates.map((c) => c.diagnosis.confidence);
    expect(clusterConfidenceIsLowest(result.clusters[0]!, memberConfidences)).toBe(true);
  });
});

describe("T46-4 issue clustering — text similarity is NOT used", () => {
  it("does NOT merge candidates with identical symptoms but different evidence", () => {
    const a = buildCandidate(
      "diag-a",
      buildEvidence("evid-a"),
      [buildHypothesis("cause A", "evid-a")],
    );
    const b = buildCandidate(
      "diag-b",
      buildEvidence("evid-b"),
      [buildHypothesis("cause B", "evid-b")],
    );
    // Both have the same observedSymptom ("test symptom"), but different evidence.
    expect(a.diagnosis.observedSymptom).toBe(b.diagnosis.observedSymptom);
    expect(sharesCauseEvidence(a, b)).toBe(false);
    const result = clusterObservations([a, b], "run-1", "2026-07-20T00:00:00Z");
    expect(result.clusters.length).toBe(0);
    expect(result.singletons.length).toBe(2);
  });
});
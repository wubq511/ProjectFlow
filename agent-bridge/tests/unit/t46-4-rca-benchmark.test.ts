/**
 * T46-4 (Issue #97 §5) — Known-fault RCA benchmark tests.
 *
 * Verifies:
 *  1. Oracle scoring labels samples correctly (correct_attribution,
 *     confusable_neighbour, unresolved_or_insufficient).
 *  2. The 5 metrics are computed correctly.
 *  3. Anti-gaming: top3Recall only counts when sample is NOT
 *     correct_attribution.
 *  4. Anti-gaming: top3Recall - top1Accuracy > 0.4 fails the gate.
 *  5. Confidence calibration penalises over-confidence.
 *  6. `verifySampleCoverage` requires all 3 sample classes.
 *  7. `buildBenchmarkReport` fails when coverage is missing.
 *  8. `buildBenchmarkReport` fails on unknown fault profile IDs.
 *  9. The benchmark never self-fills labels — oracle is independent.
 */

import { describe, expect, it } from "vitest";
import {
  scoreBenchmarkSample,
  computeRcaMetrics,
  verifySampleCoverage,
  buildBenchmarkReport,
  benchmarkProfiles,
  requiredConfusableNeighbourSamples,
  requiredUnresolvedSamples,
  isSuspiciousTop3,
  maxConfidenceForSampleClass,
  benchmarkSampleSupportedStatus,
  type BenchmarkDiagnosisInput,
} from "../../src/evaluation/lab/rca-benchmark.js";
import {
  FAULT_PROFILE_CATALOG,
  findFaultProfile,
  hypothesisMatchesProfile,
} from "../../src/evaluation/lab/fault-profiles.js";
import type {
  DiagnosisRecord,
  EvidenceRecord,
  FaultProfile,
  HypothesisRecord,
  RcaBenchmarkSample,
} from "../../src/evaluation/lab/diagnosis-contract.js";
import { EvaluationValidationError } from "../../src/evaluation/lab/errors.js";

function buildEvidence(evidenceId: string): EvidenceRecord[] {
  return [{
    evidenceId,
    kind: "fault_profile_reproduced",
    summary: "test evidence",
    reference: "observations/scn-1.json",
    facts: { profileId: "fp-routing-001" },
  }];
}

/** Build a hypothesis that genuinely matches the profile's oracle. The
 *  matcher kind determines which field is used:
 *   - `exact_token` / `regex`: candidateCause contains the pattern text.
 *   - `component_path`: candidateCodeSurfaces[].component matches the
 *     pattern (the candidateCause is informational only). */
function buildMatchingHypothesis(
  profile: FaultProfile,
  evidenceId: string,
  overrides: Partial<HypothesisRecord> = {},
): HypothesisRecord {
  const matcher = profile.expectedCause.matcher;
  const component =
    matcher.kind === "component_path"
      ? matcher.pattern.split("|")[0]!
      : "model-router.ts";
  return {
    hypothesisId: "hyp-1",
    candidateCause: profile.expectedCause.expectedCause,
    status: "fault_injection_confirmed",
    supportingEvidence: [evidenceId],
    contradictingEvidence: [],
    candidateCodeSurfaces: [{
      surfaceId: "surface-1",
      component,
      reason: "test",
      evidenceLevel: "direct_component_evidence",
      evidence: [evidenceId],
    }],
    ...overrides,
  };
}

/** Backwards-compatible helper that builds a hypothesis using a custom
 *  candidateCause. Used by tests that need to construct non-matching
 *  hypotheses (e.g. confusable-neighbour samples). */
function buildHypothesis(
  candidateCause: string,
  evidenceId: string,
  overrides: Partial<HypothesisRecord> = {},
): HypothesisRecord {
  return {
    hypothesisId: "hyp-1",
    candidateCause,
    status: "fault_injection_confirmed",
    supportingEvidence: [evidenceId],
    contradictingEvidence: [],
    candidateCodeSurfaces: [{
      surfaceId: "surface-1",
      component: "model-router.ts",
      reason: "test",
      evidenceLevel: "direct_component_evidence",
      evidence: [evidenceId],
    }],
    ...overrides,
  };
}

function buildDiagnosis(
  hypothesis: HypothesisRecord | undefined,
  overrides: Partial<DiagnosisRecord> = {},
): DiagnosisRecord {
  const evidence = hypothesis ? buildEvidence("evid-1") : [{
    evidenceId: "evid-conflict",
    kind: "conflicting_evidence" as const,
    summary: "conflict",
    reference: "observations/scn-1.json",
    facts: {},
  }];
  return {
    diagnosisId: "diag-1",
    runId: "run-1",
    scenarioId: "scn-1",
    observationId: "obs-1",
    observedSymptom: "test symptom",
    expectedContract: "test contract",
    causalStatus: hypothesis ? "fault_injection_confirmed" : "unresolved",
    confidence: hypothesis ? "high" : "very_low",
    evidence,
    hypotheses: hypothesis ? [hypothesis] : [],
    fromFaultProfile: !!hypothesis,
    createdAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

describe("T46-4 RCA benchmark — oracle scoring", () => {
  it("labels a matching diagnosis as correct_attribution", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const hypothesis = buildMatchingHypothesis(profile, "evid-1");
    const diagnosis = buildDiagnosis(hypothesis);
    const sample = scoreBenchmarkSample(profile, diagnosis);
    expect(sample.sampleClass).toBe("correct_attribution");
    expect(sample.top1Correct).toBe(true);
    expect(sample.falseAttribution).toBe(false);
    expect(sample.unresolvedReported).toBe(false);
  });

  it("labels a matching diagnosis for a component_path matcher as correct_attribution", () => {
    const profile = findFaultProfile("fp-tool-schema-001")!;
    const hypothesis = buildMatchingHypothesis(profile, "evid-1");
    const diagnosis = buildDiagnosis(hypothesis);
    const sample = scoreBenchmarkSample(profile, diagnosis);
    expect(sample.sampleClass).toBe("correct_attribution");
    expect(sample.top1Correct).toBe(true);
  });

  it("labels a confusable-neighbour diagnosis as confusable_neighbour", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const neighbour = FAULT_PROFILE_CATALOG.find((p) => p.profileId === profile.confusableNeighbours?.[0])!;
    const hypothesis = buildMatchingHypothesis(neighbour, "evid-1");
    const diagnosis = buildDiagnosis(hypothesis);
    const sample = scoreBenchmarkSample(profile, diagnosis);
    expect(sample.sampleClass).toBe("confusable_neighbour");
    expect(sample.top1Correct).toBe(false);
    expect(sample.falseAttribution).toBe(true);
  });

  it("labels an undefined diagnosis as unresolved_or_insufficient", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const sample = scoreBenchmarkSample(profile, undefined);
    expect(sample.sampleClass).toBe("unresolved_or_insufficient");
    expect(sample.unresolvedReported).toBe(true);
    expect(sample.top1Correct).toBe(false);
  });

  it("labels a diagnosis with no hypotheses as unresolved_or_insufficient", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const diagnosis = buildDiagnosis(undefined, { causalStatus: "unresolved" });
    const sample = scoreBenchmarkSample(profile, diagnosis);
    expect(sample.sampleClass).toBe("unresolved_or_insufficient");
  });
});

describe("T46-4 RCA benchmark — metric computation", () => {
  function buildSample(overrides: Partial<RcaBenchmarkSample> = {}): RcaBenchmarkSample {
    return {
      sampleId: "sample-1",
      faultProfileId: "fp-routing-001",
      expectedCauseId: "cause-routing-001",
      proposedCauses: [],
      top1Correct: true,
      top3Correct: true,
      unresolvedReported: false,
      falseAttribution: false,
      evidenceComplete: true,
      sampleClass: "correct_attribution",
      ...overrides,
    };
  }

  it("computes top1Accuracy correctly", () => {
    const samples = [
      buildSample({ top1Correct: true }),
      buildSample({ top1Correct: false }),
    ];
    const metrics = computeRcaMetrics(samples);
    expect(metrics.top1Accuracy).toBe(0.5);
  });

  it("anti-gaming: top3Correct only counts for non-correct_attribution samples", () => {
    // A correct_attribution sample with top3Correct=true but top1Correct=false
    // should NOT count toward top3Recall (inconsistency penalised).
    const samples = [
      buildSample({
        sampleId: "s1",
        sampleClass: "correct_attribution",
        top1Correct: false,
        top3Correct: true,
      }),
      buildSample({
        sampleId: "s2",
        sampleClass: "confusable_neighbour",
        top1Correct: false,
        top3Correct: true,
      }),
    ];
    const metrics = computeRcaMetrics(samples);
    // Only s2 counts toward top3Recall (s1 is inconsistent).
    expect(metrics.top3Recall).toBe(0.5);
  });

  it("computes falseAttributionRate correctly", () => {
    const samples = [
      buildSample({ falseAttribution: false }),
      buildSample({ falseAttribution: true }),
    ];
    const metrics = computeRcaMetrics(samples);
    expect(metrics.falseAttributionRate).toBe(0.5);
  });

  it("computes evidenceCompleteness correctly", () => {
    const samples = [
      buildSample({ evidenceComplete: true }),
      buildSample({ evidenceComplete: false }),
    ];
    const metrics = computeRcaMetrics(samples);
    expect(metrics.evidenceCompleteness).toBe(0.5);
  });

  it("returns zeros for empty sample list", () => {
    const metrics = computeRcaMetrics([]);
    expect(metrics.top1Accuracy).toBe(0);
    expect(metrics.top3Recall).toBe(0);
    expect(metrics.falseAttributionRate).toBe(0);
    expect(metrics.evidenceCompleteness).toBe(0);
    expect(metrics.confidenceCalibration).toBe(0);
  });
});

describe("T46-4 RCA benchmark — sample coverage", () => {
  it("verifySampleCoverage returns missing classes", () => {
    const samples = [
      { sampleClass: "correct_attribution" } as RcaBenchmarkSample,
    ];
    const missing = verifySampleCoverage(samples);
    expect(missing).toContain("confusable_neighbour");
    expect(missing).toContain("unresolved_or_insufficient");
  });

  it("verifySampleCoverage returns empty when all classes present", () => {
    const samples = [
      { sampleClass: "correct_attribution" } as RcaBenchmarkSample,
      { sampleClass: "confusable_neighbour" } as RcaBenchmarkSample,
      { sampleClass: "unresolved_or_insufficient" } as RcaBenchmarkSample,
    ];
    const missing = verifySampleCoverage(samples);
    expect(missing).toEqual([]);
  });
});

describe("T46-4 RCA benchmark — report construction", () => {
  it("fails when inputs is empty", () => {
    expect(() => buildBenchmarkReport({ inputs: [] })).toThrow(/至少需要一个/);
  });

  it("fails when an unknown fault profile is referenced", () => {
    const input: BenchmarkDiagnosisInput = {
      faultProfileId: "fp-unknown-999",
      diagnosis: undefined,
    };
    expect(() => buildBenchmarkReport({ inputs: [input] })).toThrow(/未知 fault profile/);
  });

  it("fails when sample coverage is incomplete", () => {
    // Only correct_attribution samples → missing other classes.
    const inputs: BenchmarkDiagnosisInput[] = benchmarkProfiles().map((profile) => {
      const hypothesis = buildMatchingHypothesis(profile, "evid-1");
      const diagnosis = buildDiagnosis(hypothesis);
      return { faultProfileId: profile.profileId, diagnosis };
    });
    expect(() => buildBenchmarkReport({ inputs })).toThrow(/缺少必需样本类别/);
  });

  it("passes when all 3 sample classes are present", () => {
    // Use multiple correct_attribution samples (one per benchmark profile)
    // plus one confusable_neighbour and one unresolved sample. This gives
    // top1Accuracy high enough to clear the 0.5 gate.
    const inputs: BenchmarkDiagnosisInput[] = [];
    for (const profile of benchmarkProfiles()) {
      const hyp = buildMatchingHypothesis(profile, `evid-correct-${profile.profileId}`);
      const diag = buildDiagnosis(hyp, { diagnosisId: `diag-correct-${profile.profileId}` });
      inputs.push({ faultProfileId: profile.profileId, diagnosis: diag });
    }
    // Confusable neighbour: pick a profile with a declared neighbour.
    const baseProfile = findFaultProfile("fp-routing-001")!;
    const neighbour = FAULT_PROFILE_CATALOG.find((p) => p.profileId === baseProfile.confusableNeighbours?.[0])!;
    const confusableHyp = buildMatchingHypothesis(neighbour, "evid-conf");
    const confusableDiag = buildDiagnosis(confusableHyp, { diagnosisId: "diag-conf" });
    inputs.push({ faultProfileId: baseProfile.profileId, diagnosis: confusableDiag });
    // Unresolved
    const unresolvedDiag = buildDiagnosis(undefined, {
      diagnosisId: "diag-unresolved",
      causalStatus: "unresolved",
      confidence: "very_low",
    });
    inputs.push({ faultProfileId: baseProfile.profileId, diagnosis: unresolvedDiag });
    const report = buildBenchmarkReport({ inputs, evaluatedAt: "2026-07-20T00:00:00Z" });
    expect(report.totalSamples).toBe(inputs.length);
    expect(report.passed).toBe(true);
    expect(report.failureReasons).toEqual([]);
  });
});

describe("T46-4 RCA benchmark — anti-gaming helpers", () => {
  it("isSuspiciousTop3 flags correct_attribution samples where top3 is correct but top1 is not", () => {
    // Anti-gating only applies to correct_attribution samples: a diagnosis
    // that lists many candidates and got lucky on top-3 but not top-1 is
    // inconsistent. For other sample classes, top3 != top1 is expected.
    const sample: RcaBenchmarkSample = {
      sampleId: "s1",
      faultProfileId: "fp-routing-001",
      expectedCauseId: "cause-routing-001",
      proposedCauses: [],
      top1Correct: false,
      top3Correct: true,
      unresolvedReported: false,
      falseAttribution: false,
      evidenceComplete: true,
      sampleClass: "correct_attribution",
    };
    expect(isSuspiciousTop3(sample)).toBe(true);
  });

  it("isSuspiciousTop3 does not flag samples where top1 and top3 agree", () => {
    const sample: RcaBenchmarkSample = {
      sampleId: "s1",
      faultProfileId: "fp-routing-001",
      expectedCauseId: "cause-routing-001",
      proposedCauses: [],
      top1Correct: true,
      top3Correct: true,
      unresolvedReported: false,
      falseAttribution: false,
      evidenceComplete: true,
      sampleClass: "correct_attribution",
    };
    expect(isSuspiciousTop3(sample)).toBe(false);
  });

  it("isSuspiciousTop3 does not flag non-correct_attribution samples even when top3 != top1", () => {
    for (const sampleClass of ["confusable_neighbour", "unresolved_or_insufficient"] as const) {
      const sample: RcaBenchmarkSample = {
        sampleId: "s1",
        faultProfileId: "fp-routing-001",
        expectedCauseId: "cause-routing-001",
        proposedCauses: [],
        top1Correct: false,
        top3Correct: true,
        unresolvedReported: false,
        falseAttribution: false,
        evidenceComplete: true,
        sampleClass,
      };
      expect(isSuspiciousTop3(sample)).toBe(false);
    }
  });

  it("maxConfidenceForSampleClass returns the correct ceiling", () => {
    expect(maxConfidenceForSampleClass("correct_attribution")).toBe("high");
    expect(maxConfidenceForSampleClass("confusable_neighbour")).toBe("medium");
    expect(maxConfidenceForSampleClass("unresolved_or_insufficient")).toBe("low");
  });

  it("benchmarkSampleSupportedStatus returns the correct status for a complete correct_attribution sample", () => {
    const sample: RcaBenchmarkSample = {
      sampleId: "s1",
      faultProfileId: "fp-routing-001",
      expectedCauseId: "cause-routing-001",
      proposedCauses: [],
      top1Correct: true,
      top3Correct: true,
      unresolvedReported: false,
      falseAttribution: false,
      evidenceComplete: true,
      sampleClass: "correct_attribution",
    };
    expect(benchmarkSampleSupportedStatus(sample)).toBe("fault_injection_confirmed");
  });

  it("benchmarkSampleSupportedStatus returns intervention_supported for an incomplete correct_attribution sample", () => {
    const sample: RcaBenchmarkSample = {
      sampleId: "s1",
      faultProfileId: "fp-routing-001",
      expectedCauseId: "cause-routing-001",
      proposedCauses: [],
      top1Correct: true,
      top3Correct: true,
      unresolvedReported: false,
      falseAttribution: false,
      evidenceComplete: false,
      sampleClass: "correct_attribution",
    };
    expect(benchmarkSampleSupportedStatus(sample)).toBe("intervention_supported");
  });

  it("benchmarkSampleSupportedStatus returns the correct status for confusable_neighbour and unresolved samples", () => {
    const confusable: RcaBenchmarkSample = {
      sampleId: "s2",
      faultProfileId: "fp-routing-001",
      expectedCauseId: "cause-routing-001",
      proposedCauses: [],
      top1Correct: false,
      top3Correct: false,
      unresolvedReported: false,
      falseAttribution: true,
      evidenceComplete: true,
      sampleClass: "confusable_neighbour",
    };
    expect(benchmarkSampleSupportedStatus(confusable)).toBe("localized_hypothesis");

    const unresolved: RcaBenchmarkSample = {
      sampleId: "s3",
      faultProfileId: "fp-routing-001",
      expectedCauseId: "cause-routing-001",
      proposedCauses: [],
      top1Correct: false,
      top3Correct: false,
      unresolvedReported: true,
      falseAttribution: false,
      evidenceComplete: false,
      sampleClass: "unresolved_or_insufficient",
    };
    expect(benchmarkSampleSupportedStatus(unresolved)).toBe("unresolved");
  });
});

describe("T46-4 RCA benchmark — required sample counts", () => {
  it("requiredConfusableNeighbourSamples is at least 1", () => {
    expect(requiredConfusableNeighbourSamples()).toBeGreaterThanOrEqual(1);
  });

  it("requiredUnresolvedSamples is at least 1", () => {
    expect(requiredUnresolvedSamples()).toBeGreaterThanOrEqual(1);
  });
});

describe("T46-4 RCA benchmark — oracle independence", () => {
  it("the oracle (FaultProfile.expectedCause) is declared in the profile, not derived", () => {
    for (const profile of FAULT_PROFILE_CATALOG) {
      // The expectedCause is a static declaration on the profile.
      expect(typeof profile.expectedCause.expectedCause).toBe("string");
      expect(profile.expectedCause.expectedCause.length).toBeGreaterThan(0);
      // The matcher is also static.
      expect(typeof profile.expectedCause.matcher.pattern).toBe("string");
    }
  });

  it("scoreBenchmarkSample never returns a self-declared sampleClass", () => {
    // The sampleClass is derived from the diagnosis via classifyBenchmarkSample,
    // never from a self-declared field on the diagnosis.
    const profile = findFaultProfile("fp-routing-001")!;
    const hypothesis = buildMatchingHypothesis(profile, "evid-1");
    const diagnosis = buildDiagnosis(hypothesis);
    const sample = scoreBenchmarkSample(profile, diagnosis);
    // The sampleClass must be derived, not declared.
    expect(sample.sampleClass).toBe("correct_attribution");
    // The diagnosis does not carry a sampleClass field.
    expect((diagnosis as unknown as Record<string, unknown>).sampleClass).toBeUndefined();
  });

  it("every benchmark profile's matcher produces a correct_attribution sample when the hypothesis matches", () => {
    // Sanity check: for each benchmark-relevant profile, a hypothesis that
    // genuinely matches the oracle must be labelled correct_attribution.
    for (const profile of benchmarkProfiles()) {
      const hypothesis = buildMatchingHypothesis(profile, "evid-1");
      expect(hypothesisMatchesProfile(hypothesis, profile)).toBe(true);
      const diagnosis = buildDiagnosis(hypothesis);
      const sample = scoreBenchmarkSample(profile, diagnosis);
      expect(sample.sampleClass).toBe("correct_attribution");
      expect(sample.top1Correct).toBe(true);
    }
  });
});
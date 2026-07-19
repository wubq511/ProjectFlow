/**
 * T46-4 (Issue #97 §3) — Evaluator-owned fault profile tests.
 *
 * Verifies:
 *  1. The catalog covers all 8 categories with at least one profile each.
 *  2. No duplicate profile IDs.
 *  3. Oracle independence: every profile declares its own expectedCause.
 *  4. The evaluation auth gate refuses non-evaluation contexts.
 *  5. The evaluation auth gate refuses path containment violations.
 *  6. Confusable neighbour lookup and false-attribution detection work.
 *  7. The benchmark sample classifier labels samples correctly.
 *  8. The benchmark selector returns only benchmark-relevant profiles.
 */

import { describe, expect, it } from "vitest";
import {
  FAULT_PROFILE_CATALOG,
  verifyFaultCatalog,
  findFaultProfile,
  profilesOfCategory,
  benchmarkRelevantProfiles,
  matchHypothesisToExpectedCause,
  hypothesisMatchesProfile,
  confusableNeighbours,
  isFalseAttribution,
  classifyBenchmarkSample,
  selectBenchmarkProfiles,
  REQUIRED_SAMPLE_CLASSES,
  validateBenchmarkSampleClass,
  assertEvaluationAuth,
} from "../../src/evaluation/lab/fault-profiles.js";
import { FAULT_PROFILE_CATEGORIES } from "../../src/evaluation/lab/diagnosis-contract.js";
import type { HypothesisRecord } from "../../src/evaluation/lab/diagnosis-contract.js";

describe("T46-4 fault profiles — catalog completeness", () => {
  it("covers all 8 required categories", () => {
    const verification = verifyFaultCatalog();
    expect(verification.complete).toBe(true);
    expect(verification.missingCategories).toEqual([]);
  });

  it("has no duplicate profile IDs", () => {
    const verification = verifyFaultCatalog();
    expect(verification.duplicateProfileIds).toEqual([]);
  });

  it("has no oracle independence violations", () => {
    const verification = verifyFaultCatalog();
    expect(verification.oracleIndependenceViolations).toEqual([]);
  });

  it("has at least one profile per category", () => {
    for (const category of FAULT_PROFILE_CATEGORIES) {
      const profiles = profilesOfCategory(category);
      expect(profiles.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("exposes benchmark-relevant profiles", () => {
    const relevant = benchmarkRelevantProfiles();
    expect(relevant.length).toBeGreaterThan(0);
    for (const p of relevant) {
      expect(p.benchmarkRelevant).toBe(true);
    }
  });

  it("selectBenchmarkProfiles returns the same set as benchmarkRelevantProfiles", () => {
    expect(selectBenchmarkProfiles()).toEqual(benchmarkRelevantProfiles());
  });
});

describe("T46-4 fault profiles — oracle independence", () => {
  it("every profile declares its own expectedCause (not from SUT)", () => {
    for (const profile of FAULT_PROFILE_CATALOG) {
      expect(profile.expectedCause.expectedCause.length).toBeGreaterThan(0);
      expect(profile.expectedCause.matcher.pattern.length).toBeGreaterThan(0);
      expect(profile.expectedCause.causeId.length).toBeGreaterThan(0);
    }
  });

  it("expectedCause is not empty or whitespace", () => {
    for (const profile of FAULT_PROFILE_CATALOG) {
      expect(profile.expectedCause.expectedCause.trim()).toBe(profile.expectedCause.expectedCause);
    }
  });
});

describe("T46-4 fault profiles — evaluation auth gate", () => {
  it("refuses when APP_ENV is not evaluation", () => {
    expect(() =>
      assertEvaluationAuth({
        appEnv: "development",
        evaluationNonce: "nonce-123",
        evaluationInstanceId: "inst-456",
        evaluationTempRoot: "/tmp/eval",
        targetPath: "/tmp/eval/run-1",
      }),
    ).toThrow(/APP_ENV/);
  });

  it("refuses when nonce is missing", () => {
    expect(() =>
      assertEvaluationAuth({
        appEnv: "evaluation",
        evaluationNonce: "",
        evaluationInstanceId: "inst-456",
        evaluationTempRoot: "/tmp/eval",
        targetPath: "/tmp/eval/run-1",
      }),
    ).toThrow(/nonce/);
  });

  it("refuses when instance ID is missing", () => {
    expect(() =>
      assertEvaluationAuth({
        appEnv: "evaluation",
        evaluationNonce: "nonce-123",
        evaluationInstanceId: "",
        evaluationTempRoot: "/tmp/eval",
        targetPath: "/tmp/eval/run-1",
      }),
    ).toThrow(/instance/);
  });

  it("refuses when header nonce does not match", () => {
    expect(() =>
      assertEvaluationAuth({
        appEnv: "evaluation",
        evaluationNonce: "nonce-123",
        evaluationInstanceId: "inst-456",
        evaluationTempRoot: "/tmp/eval",
        targetPath: "/tmp/eval/run-1",
        headerNonce: "wrong-nonce",
      }),
    ).toThrow(/nonce 不匹配/);
  });

  it("refuses when target path escapes evaluator temp root", () => {
    expect(() =>
      assertEvaluationAuth({
        appEnv: "evaluation",
        evaluationNonce: "nonce-123",
        evaluationInstanceId: "inst-456",
        evaluationTempRoot: "/tmp/eval",
        targetPath: "/tmp/other/run-1",
      }),
    ).toThrow(/evaluator temp root/);
  });

  it("refuses path traversal attempts", () => {
    expect(() =>
      assertEvaluationAuth({
        appEnv: "evaluation",
        evaluationNonce: "nonce-123",
        evaluationInstanceId: "inst-456",
        evaluationTempRoot: "/tmp/eval",
        targetPath: "/tmp/eval/../other/run-1",
      }),
    ).toThrow(/evaluator temp root/);
  });

  it("accepts a valid evaluator context", () => {
    expect(() =>
      assertEvaluationAuth({
        appEnv: "evaluation",
        evaluationNonce: "nonce-123",
        evaluationInstanceId: "inst-456",
        evaluationTempRoot: "/tmp/eval",
        targetPath: "/tmp/eval/run-1",
      }),
    ).not.toThrow();
  });
});

describe("T46-4 fault profiles — oracle scoring", () => {
  function buildHypothesis(candidateCause: string, component?: string): HypothesisRecord {
    return {
      hypothesisId: "hyp-1",
      candidateCause,
      status: "localized_hypothesis",
      supportingEvidence: ["evid-1"],
      contradictingEvidence: [],
      candidateCodeSurfaces: component
        ? [{
            surfaceId: "surface-1",
            component,
            reason: "test surface",
            evidenceLevel: "hypothesis",
            evidence: ["evid-1"],
          }]
        : [],
    };
  }

  it("matchHypothesisToExpectedCause supports exact_token matcher", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const hypothesis = buildHypothesis(profile.expectedCause.expectedCause);
    expect(hypothesisMatchesProfile(hypothesis, profile)).toBe(true);
  });

  it("matchHypothesisToExpectedCause returns false for non-matching hypothesis", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const hypothesis = buildHypothesis("完全不相关的原因");
    expect(hypothesisMatchesProfile(hypothesis, profile)).toBe(false);
  });

  it("matchHypothesisToExpectedCause supports component_path matcher", () => {
    // Find a profile with component_path matcher.
    const profile = FAULT_PROFILE_CATALOG.find(
      (p) => p.expectedCause.matcher.kind === "component_path",
    );
    if (!profile) return; // skip if no profile uses component_path
    const pattern = profile.expectedCause.matcher.pattern;
    const hypothesis = buildHypothesis("any cause", pattern);
    expect(hypothesisMatchesProfile(hypothesis, profile)).toBe(true);
  });

  it("confusableNeighbours returns declared neighbours", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const neighbours = confusableNeighbours(profile);
    expect(neighbours.length).toBeGreaterThan(0);
  });

  it("isFalseAttribution detects when hypothesis matches a neighbour", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const neighbour = confusableNeighbours(profile)[0]!;
    const hypothesis = buildHypothesis(neighbour.expectedCause.expectedCause);
    expect(isFalseAttribution(hypothesis, profile)).toBe(true);
  });

  it("isFalseAttribution returns false when hypothesis matches the profile", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const hypothesis = buildHypothesis(profile.expectedCause.expectedCause);
    expect(isFalseAttribution(hypothesis, profile)).toBe(false);
  });
});

describe("T46-4 fault profiles — benchmark sample classifier", () => {
  it("REQUIRED_SAMPLE_CLASSES exposes the 3 required classes", () => {
    expect(REQUIRED_SAMPLE_CLASSES()).toEqual([
      "correct_attribution",
      "confusable_neighbour",
      "unresolved_or_insufficient",
    ]);
  });

  it("classifies a matching top-1 hypothesis as correct_attribution", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const hypothesis: HypothesisRecord = {
      hypothesisId: "hyp-1",
      candidateCause: profile.expectedCause.expectedCause,
      status: "fault_injection_confirmed",
      supportingEvidence: ["evid-1"],
      contradictingEvidence: [],
      candidateCodeSurfaces: [],
    };
    expect(classifyBenchmarkSample(hypothesis, "fault_injection_confirmed", profile))
      .toBe("correct_attribution");
  });

  it("classifies a neighbour-matching top-1 as confusable_neighbour", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    const neighbour = confusableNeighbours(profile)[0]!;
    const hypothesis: HypothesisRecord = {
      hypothesisId: "hyp-1",
      candidateCause: neighbour.expectedCause.expectedCause,
      status: "fault_injection_confirmed",
      supportingEvidence: ["evid-1"],
      contradictingEvidence: [],
      candidateCodeSurfaces: [],
    };
    expect(classifyBenchmarkSample(hypothesis, "fault_injection_confirmed", profile))
      .toBe("confusable_neighbour");
  });

  it("classifies an unresolved diagnosis as unresolved_or_insufficient", () => {
    const profile = findFaultProfile("fp-routing-001")!;
    expect(classifyBenchmarkSample(undefined, "unresolved", profile))
      .toBe("unresolved_or_insufficient");
  });

  it("validateBenchmarkSampleClass detects self-mislabelling", () => {
    // correct_attribution must have top1Correct=true.
    const violations = validateBenchmarkSampleClass({
      sampleClass: "correct_attribution",
      top1Correct: false,
      top3Correct: false,
      falseAttribution: false,
      unresolvedReported: false,
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it("validateBenchmarkSampleClass accepts a consistent sample", () => {
    const violations = validateBenchmarkSampleClass({
      sampleClass: "correct_attribution",
      top1Correct: true,
      top3Correct: true,
      falseAttribution: false,
      unresolvedReported: false,
    });
    expect(violations).toEqual([]);
  });
});
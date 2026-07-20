/**
 * T46-5 (Issue #98 §5) — Judge bias metrics tests.
 *
 * Verifies the 6 bias metric computations:
 *  1. Position bias: fraction of pairwise trials where the Judge
 *     preferred the first-displayed candidate.
 *  2. Verbosity bias: Pearson correlation between output length and
 *     Judge score.
 *  3. Same-family preference: when the Judge family matches one
 *     candidate's family, preference rate for that candidate.
 *  4. Pairwise disagreement rate: forward vs reverse order disagreement.
 *  5. Repeated-run instability: flip rate across repetitions.
 *  6. Anchor ordering stability: violation rate of good > boundary > bad.
 *
 * Also verifies:
 *  - `anyBiasExceeded` returns true when ANY metric exceeds its threshold.
 *  - `buildAnchorOrderingTrials` correctly identifies violations.
 *  - Sample size is reported alongside each metric.
 */

import { describe, expect, it } from "vitest";
import {
  computePositionBias,
  computeVerbosityBias,
  computeSameFamilyPreference,
  computePairwiseDisagreement,
  computeRepeatedRunInstability,
  computeAnchorOrderingStability,
  computeBiasMetrics,
  anyBiasExceeded,
  buildAnchorOrderingTrials,
} from "../../src/evaluation/lab/judge-bias.js";
import type { PairwiseEvaluationRecord } from "../../src/evaluation/lab/calibration-contract.js";

function buildPairwiseRecord(input: {
  pairwiseId: string;
  displayOrder: ["A", "B"] | ["B", "A"];
  forwardPreferred: "A" | "B" | "tie";
  reversePreferred?: "A" | "B" | "tie";
}): PairwiseEvaluationRecord {
  const forwardVerdict = input.forwardPreferred === "tie"
    ? { kind: "preference" as const, preferred: "tie" as const, confidence: 0.5, reason: "tie" }
    : { kind: "preference" as const, preferred: input.forwardPreferred, confidence: 0.8, reason: "x" };
  const reverseVerdict = input.reversePreferred === undefined
    ? undefined
    : input.reversePreferred === "tie"
      ? { kind: "preference" as const, preferred: "tie" as const, confidence: 0.5, reason: "tie" }
      : { kind: "preference" as const, preferred: input.reversePreferred, confidence: 0.7, reason: "x" };
  return {
    pairwiseId: input.pairwiseId,
    candidates: [
      { candidateLabel: input.displayOrder[0], candidateId: "cA", blinded: true },
      { candidateLabel: input.displayOrder[1], candidateId: "cB", blinded: true },
    ],
    seed: "test-seed",
    displayOrder: input.displayOrder,
    reverseRepetition: reverseVerdict !== undefined,
    forwardVerdict,
    reverseVerdict,
    disagreement:
      reverseVerdict !== undefined
      && !(forwardVerdict.kind === "preference" && reverseVerdict.kind === "preference"
        && forwardVerdict.preferred === reverseVerdict.preferred),
    judgeManifestRef: { judgeId: "mock-judge-v1", judgeVersion: 1 },
    rubricVersionRef: { rubricId: "p0-planning-specificity-rubric", rubricVersion: 1 },
    evaluatedAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("T46-5 judge bias — position bias", () => {
  it("returns 0 when no pairwise records", () => {
    const result = computePositionBias([], 0.60);
    expect(result.preferenceForFirst).toBe(0);
    expect(result.sampleSize).toBe(0);
    expect(result.exceeded).toBe(false);
  });

  it("counts only non-tie preferences", () => {
    const records = [
      buildPairwiseRecord({ pairwiseId: "p1", displayOrder: ["A", "B"], forwardPreferred: "A" }),
      buildPairwiseRecord({ pairwiseId: "p2", displayOrder: ["A", "B"], forwardPreferred: "tie" }),
      buildPairwiseRecord({ pairwiseId: "p3", displayOrder: ["A", "B"], forwardPreferred: "B" }),
    ];
    const result = computePositionBias(records, 0.60);
    expect(result.sampleSize).toBe(2); // tie excluded
    expect(result.preferenceForFirst).toBe(0.5); // 1 of 2 preferred the first (A)
  });

  it("exceeds threshold when preference-for-first is too high", () => {
    const records = [
      buildPairwiseRecord({ pairwiseId: "p1", displayOrder: ["A", "B"], forwardPreferred: "A" }),
      buildPairwiseRecord({ pairwiseId: "p2", displayOrder: ["A", "B"], forwardPreferred: "A" }),
      buildPairwiseRecord({ pairwiseId: "p3", displayOrder: ["A", "B"], forwardPreferred: "A" }),
      buildPairwiseRecord({ pairwiseId: "p4", displayOrder: ["A", "B"], forwardPreferred: "A" }),
    ];
    const result = computePositionBias(records, 0.60);
    expect(result.preferenceForFirst).toBe(1);
    expect(result.exceeded).toBe(true);
  });
});

describe("T46-5 judge bias — verbosity bias", () => {
  it("returns correlation 0 with fewer than 2 samples", () => {
    const result = computeVerbosityBias([], 0.30);
    expect(result.correlation).toBe(0);
    expect(result.exceeded).toBe(false);
  });

  it("computes a positive correlation when longer outputs get higher scores", () => {
    const samples = [
      { outputLength: 100, scoreNumeric: 1 },
      { outputLength: 200, scoreNumeric: 2 },
      { outputLength: 300, scoreNumeric: 3 },
    ];
    const result = computeVerbosityBias(samples, 0.30);
    expect(result.correlation).toBeCloseTo(1, 5);
    expect(result.exceeded).toBe(true);
  });

  it("computes a negative correlation when longer outputs get lower scores", () => {
    const samples = [
      { outputLength: 100, scoreNumeric: 3 },
      { outputLength: 200, scoreNumeric: 2 },
      { outputLength: 300, scoreNumeric: 1 },
    ];
    const result = computeVerbosityBias(samples, 0.30);
    expect(result.correlation).toBeCloseTo(-1, 5);
    expect(result.exceeded).toBe(true); // abs(correlation) > threshold
  });

  it("returns correlation 0 when there's no linear relationship", () => {
    const samples = [
      { outputLength: 100, scoreNumeric: 2 },
      { outputLength: 200, scoreNumeric: 2 },
      { outputLength: 300, scoreNumeric: 2 },
    ];
    const result = computeVerbosityBias(samples, 0.30);
    expect(result.correlation).toBe(0);
    expect(result.exceeded).toBe(false);
  });
});

describe("T46-5 judge bias — same-family preference", () => {
  it("detects same-family preference when Judge prefers same-family candidate", () => {
    const samples = [
      { judgeFamily: "gpt", candidateAFamily: "gpt", candidateBFamily: "claude", preferred: "A" as const },
      { judgeFamily: "gpt", candidateAFamily: "gpt", candidateBFamily: "claude", preferred: "A" as const },
      { judgeFamily: "gpt", candidateAFamily: "gpt", candidateBFamily: "claude", preferred: "A" as const },
    ];
    const result = computeSameFamilyPreference(samples, 0.65);
    expect(result.sameFamilyDetected).toBe(true);
    expect(result.preferenceRate).toBe(1);
    expect(result.exceeded).toBe(true);
  });

  it("does not flag when no same-family candidates present", () => {
    const samples = [
      { judgeFamily: "gpt", candidateAFamily: "claude", candidateBFamily: "deepseek", preferred: "A" as const },
    ];
    const result = computeSameFamilyPreference(samples, 0.65);
    expect(result.sameFamilyDetected).toBe(false);
    expect(result.exceeded).toBe(false);
  });

  it("excludes tie samples", () => {
    const samples = [
      { judgeFamily: "gpt", candidateAFamily: "gpt", candidateBFamily: "claude", preferred: "tie" as const },
    ];
    const result = computeSameFamilyPreference(samples, 0.65);
    expect(result.sampleSize).toBe(0);
  });
});

describe("T46-5 judge bias — pairwise disagreement", () => {
  it("returns 0 when no reverse repetition", () => {
    const records = [
      buildPairwiseRecord({ pairwiseId: "p1", displayOrder: ["A", "B"], forwardPreferred: "A" }),
    ];
    const result = computePairwiseDisagreement(records, 0.20);
    expect(result.sampleSize).toBe(0);
    expect(result.rate).toBe(0);
  });

  it("counts disagreement when forward and reverse verdicts differ", () => {
    const records = [
      buildPairwiseRecord({ pairwiseId: "p1", displayOrder: ["A", "B"], forwardPreferred: "A", reversePreferred: "B" }),
      buildPairwiseRecord({ pairwiseId: "p2", displayOrder: ["A", "B"], forwardPreferred: "A", reversePreferred: "A" }),
    ];
    const result = computePairwiseDisagreement(records, 0.20);
    expect(result.sampleSize).toBe(2);
    expect(result.rate).toBe(0.5);
  });
});

describe("T46-5 judge bias — repeated-run instability", () => {
  it("returns 0 when trials have fewer than 2 verdicts", () => {
    const result = computeRepeatedRunInstability([[{ verdict: "pass" }]], 0.10);
    expect(result.sampleSize).toBe(0);
  });

  it("counts flips across repetitions", () => {
    const trials = [
      [{ verdict: "pass" }, { verdict: "pass" }], // no flip
      [{ verdict: "pass" }, { verdict: "fail" }], // flip
      [{ verdict: "fail" }, { verdict: "fail" }, { verdict: "fail" }], // no flip
    ];
    const result = computeRepeatedRunInstability(trials, 0.10);
    expect(result.sampleSize).toBe(3);
    expect(result.flipRate).toBeCloseTo(1 / 3, 5);
  });
});

describe("T46-5 judge bias — anchor ordering stability", () => {
  it("computes violation rate from trials", () => {
    const trials = [
      { violationDetected: false },
      { violationDetected: true },
      { violationDetected: false },
    ];
    const result = computeAnchorOrderingStability(trials, 0.05);
    expect(result.sampleSize).toBe(3);
    expect(result.violationRate).toBeCloseTo(1 / 3, 5);
    expect(result.exceeded).toBe(true);
  });

  it("returns 0 violation rate with no violations", () => {
    const trials = [
      { violationDetected: false },
      { violationDetected: false },
    ];
    const result = computeAnchorOrderingStability(trials, 0.05);
    expect(result.violationRate).toBe(0);
    expect(result.exceeded).toBe(false);
  });
});

describe("T46-5 judge bias — combined metrics", () => {
  it("computeBiasMetrics combines all 6 metrics", () => {
    const result = computeBiasMetrics({
      pairwiseRecords: [],
      verbositySamples: [],
      sameFamilySamples: [],
      repeatedRunTrials: [],
      anchorOrderingTrials: [],
      thresholds: {
        positionBias: 0.60,
        verbosityBias: 0.30,
        sameFamilyPreference: 0.65,
        disagreementRate: 0.20,
        repeatedRunFlipRate: 0.10,
        anchorOrdering: 0.05,
      },
    });
    expect(result.positionBias).toBeDefined();
    expect(result.verbosityBias).toBeDefined();
    expect(result.sameFamilyPreference).toBeDefined();
    expect(result.disagreementRate).toBeDefined();
    expect(result.repeatedRunInstability).toBeDefined();
    expect(result.anchorOrderingStability).toBeDefined();
  });

  it("anyBiasExceeded returns false when no metric exceeds threshold", () => {
    const metrics = {
      positionBias: { preferenceForFirst: 0.5, sampleSize: 10, candidateThreshold: 0.60, exceeded: false },
      verbosityBias: { correlation: 0.1, sampleSize: 10, candidateThreshold: 0.30, exceeded: false },
      sameFamilyPreference: { preferenceRate: 0.4, sampleSize: 10, candidateThreshold: 0.65, exceeded: false, sameFamilyDetected: false },
      disagreementRate: { rate: 0.1, sampleSize: 10, candidateThreshold: 0.20, exceeded: false },
      repeatedRunInstability: { flipRate: 0.05, sampleSize: 10, candidateThreshold: 0.10, exceeded: false },
      anchorOrderingStability: { violationRate: 0.02, sampleSize: 10, candidateThreshold: 0.05, exceeded: false },
    };
    expect(anyBiasExceeded(metrics)).toBe(false);
  });

  it("anyBiasExceeded returns true when ANY metric exceeds threshold", () => {
    const metrics = {
      positionBias: { preferenceForFirst: 0.8, sampleSize: 10, candidateThreshold: 0.60, exceeded: true },
      verbosityBias: { correlation: 0.1, sampleSize: 10, candidateThreshold: 0.30, exceeded: false },
      sameFamilyPreference: { preferenceRate: 0.4, sampleSize: 10, candidateThreshold: 0.65, exceeded: false, sameFamilyDetected: false },
      disagreementRate: { rate: 0.1, sampleSize: 10, candidateThreshold: 0.20, exceeded: false },
      repeatedRunInstability: { flipRate: 0.05, sampleSize: 10, candidateThreshold: 0.10, exceeded: false },
      anchorOrderingStability: { violationRate: 0.02, sampleSize: 10, candidateThreshold: 0.05, exceeded: false },
    };
    expect(anyBiasExceeded(metrics)).toBe(true);
  });
});

describe("T46-5 judge bias — buildAnchorOrderingTrials", () => {
  it("builds trials from anchor results", () => {
    const anchorResults = [
      [
        { anchorId: "good", verdict: "pass", score: "excellent", confidence: 0.9 },
        { anchorId: "boundary", verdict: "needs_review", score: "fair", confidence: 0.5 },
        { anchorId: "bad", verdict: "fail", score: "poor", confidence: 0.1 },
      ],
    ];
    const anchors = [
      { anchorId: "good", kind: "good" as const, expectedOrderRank: 0 },
      { anchorId: "boundary", kind: "boundary" as const, expectedOrderRank: 1 },
      { anchorId: "bad", kind: "bad" as const, expectedOrderRank: 2 },
    ];
    const trials = buildAnchorOrderingTrials(anchorResults, anchors);
    expect(trials).toHaveLength(1);
    expect(trials[0]!.violationDetected).toBe(false);
  });

  it("detects violation when ranking is wrong", () => {
    const anchorResults = [
      [
        { anchorId: "good", verdict: "pass", score: "excellent", confidence: 0.1 },
        { anchorId: "boundary", verdict: "needs_review", score: "fair", confidence: 0.5 },
        { anchorId: "bad", verdict: "fail", score: "poor", confidence: 0.9 },
      ],
    ];
    const anchors = [
      { anchorId: "good", kind: "good" as const, expectedOrderRank: 0 },
      { anchorId: "boundary", kind: "boundary" as const, expectedOrderRank: 1 },
      { anchorId: "bad", kind: "bad" as const, expectedOrderRank: 2 },
    ];
    const trials = buildAnchorOrderingTrials(anchorResults, anchors);
    expect(trials[0]!.violationDetected).toBe(true);
  });
});

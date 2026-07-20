/**
 * T46-5 (Issue #98 §5) — Judge bias metrics.
 *
 * Computes position bias, verbosity bias, same-family preference,
 * pairwise disagreement rate, repeated-run flip rate and anchor
 * ordering stability. Each metric carries the raw measurements AND
 * the candidate threshold so fail-safe decisions are auditable.
 *
 * Boundary invariants (enforced and tested):
 *  - Bias metrics are computed from real pairwise evaluation records
 *    and anchor results — never self-reported by the Judge.
 *  - Each metric is bounded to [0, 1] (or [-1, 1] for correlation).
 *  - When a metric exceeds its candidate threshold, the calibration
 *    runner MUST degrade the Judge to `needs_review`.
 *  - Sample size is reported alongside each metric so small-sample
 *    instability cannot be hidden.
 */

import type {
  JudgeBiasMetrics,
  PairwiseEvaluationRecord,
} from "./calibration-contract.js";
import type { AnchorEvaluationResult } from "./semantic-judge.js";

// ---------------------------------------------------------------------------
// §1 Position bias
// ---------------------------------------------------------------------------

/** Compute position bias: fraction of pairwise trials where the Judge
 *  preferred the first-displayed candidate (ignoring ties). */
export function computePositionBias(
  records: PairwiseEvaluationRecord[],
  candidateThreshold: number,
): { preferenceForFirst: number; sampleSize: number; candidateThreshold: number; exceeded: boolean } {
  let preferences = 0;
  let samples = 0;
  for (const r of records) {
    if (r.forwardVerdict.kind === "preference" && r.forwardVerdict.preferred !== "tie") {
      samples += 1;
      const preferredLabel = r.forwardVerdict.preferred;
      const firstDisplayed = r.displayOrder[0];
      if (preferredLabel === firstDisplayed) {
        preferences += 1;
      }
    }
  }
  const preferenceForFirst = samples > 0 ? preferences / samples : 0;
  return {
    preferenceForFirst,
    sampleSize: samples,
    candidateThreshold,
    exceeded: preferenceForFirst > candidateThreshold,
  };
}

// ---------------------------------------------------------------------------
// §2 Verbosity bias
// ---------------------------------------------------------------------------

/** Compute verbosity bias: correlation between output length and
 *  Judge score. Uses Pearson correlation. */
export function computeVerbosityBias(
  samples: Array<{ outputLength: number; scoreNumeric: number }>,
  candidateThreshold: number,
): { correlation: number; sampleSize: number; candidateThreshold: number; exceeded: boolean } {
  const n = samples.length;
  if (n < 2) {
    return { correlation: 0, sampleSize: n, candidateThreshold, exceeded: false };
  }
  const sumX = samples.reduce((s, p) => s + p.outputLength, 0);
  const sumY = samples.reduce((s, p) => s + p.scoreNumeric, 0);
  const sumXY = samples.reduce((s, p) => s + p.outputLength * p.scoreNumeric, 0);
  const sumX2 = samples.reduce((s, p) => s + p.outputLength * p.outputLength, 0);
  const sumY2 = samples.reduce((s, p) => s + p.scoreNumeric * p.scoreNumeric, 0);
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  const correlation = denominator === 0 ? 0 : numerator / denominator;
  return {
    correlation,
    sampleSize: n,
    candidateThreshold,
    exceeded: Math.abs(correlation) > candidateThreshold,
  };
}

// ---------------------------------------------------------------------------
// §3 Same-family preference
// ---------------------------------------------------------------------------

/** Compute same-family preference: when the Judge family matches one
 *  candidate's family, fraction of trials where the Judge preferred
 *  that candidate. */
export function computeSameFamilyPreference(
  samples: Array<{
    judgeFamily: string;
    candidateAFamily: string;
    candidateBFamily: string;
    preferred: "A" | "B" | "tie";
  }>,
  candidateThreshold: number,
): {
  preferenceRate: number;
  sampleSize: number;
  candidateThreshold: number;
  exceeded: boolean;
  sameFamilyDetected: boolean;
} {
  let preferences = 0;
  let countedSamples = 0;
  let sameFamilyDetected = false;
  for (const s of samples) {
    if (s.preferred === "tie") continue;
    // Determine if the Judge family matches the preferred candidate's family.
    const preferredFamily = s.preferred === "A" ? s.candidateAFamily : s.candidateBFamily;
    if (s.judgeFamily === preferredFamily) {
      sameFamilyDetected = true;
      countedSamples += 1;
      // Always counts as a preference here (we already filtered by preferred).
      preferences += 1;
    } else if (s.judgeFamily === s.candidateAFamily || s.judgeFamily === s.candidateBFamily) {
      // Judge is same family as the non-preferred candidate.
      sameFamilyDetected = true;
      countedSamples += 1;
    }
  }
  const preferenceRate = countedSamples > 0 ? preferences / countedSamples : 0;
  return {
    preferenceRate,
    sampleSize: countedSamples,
    candidateThreshold,
    exceeded: sameFamilyDetected && preferenceRate > candidateThreshold,
    sameFamilyDetected,
  };
}

// ---------------------------------------------------------------------------
// §4 Pairwise disagreement rate
// ---------------------------------------------------------------------------

/** Compute pairwise disagreement: fraction of pairwise trials where
 *  forward and reverse order produced different verdicts. */
export function computePairwiseDisagreement(
  records: PairwiseEvaluationRecord[],
  candidateThreshold: number,
): { rate: number; sampleSize: number; candidateThreshold: number; exceeded: boolean } {
  let disagreements = 0;
  let samples = 0;
  for (const r of records) {
    if (!r.reverseRepetition) continue;
    samples += 1;
    if (r.disagreement) disagreements += 1;
  }
  const rate = samples > 0 ? disagreements / samples : 0;
  return {
    rate,
    sampleSize: samples,
    candidateThreshold,
    exceeded: rate > candidateThreshold,
  };
}

// ---------------------------------------------------------------------------
// §5 Repeated-run instability
// ---------------------------------------------------------------------------

/** Compute repeated-run instability: fraction of repeated trials
 *  where the verdict flipped across repetitions. */
export function computeRepeatedRunInstability(
  repeats: Array<{ verdict: string }[]>,
  candidateThreshold: number,
): { flipRate: number; sampleSize: number; candidateThreshold: number; exceeded: boolean } {
  let flips = 0;
  let samples = 0;
  for (const trial of repeats) {
    if (trial.length < 2) continue;
    samples += 1;
    const first = trial[0]!.verdict;
    if (trial.some((t) => t.verdict !== first)) {
      flips += 1;
    }
  }
  const flipRate = samples > 0 ? flips / samples : 0;
  return {
    flipRate,
    sampleSize: samples,
    candidateThreshold,
    exceeded: flipRate > candidateThreshold,
  };
}

// ---------------------------------------------------------------------------
// §6 Anchor ordering stability
// ---------------------------------------------------------------------------

/** Compute anchor ordering stability: fraction of anchor trials where
 *  the expected good > boundary > bad ordering was violated. */
export function computeAnchorOrderingStability(
  trials: Array<{ violationDetected: boolean }>,
  candidateThreshold: number,
): { violationRate: number; sampleSize: number; candidateThreshold: number; exceeded: boolean } {
  const samples = trials.length;
  const violations = trials.filter((t) => t.violationDetected).length;
  const violationRate = samples > 0 ? violations / samples : 0;
  return {
    violationRate,
    sampleSize: samples,
    candidateThreshold,
    exceeded: violationRate > candidateThreshold,
  };
}

// ---------------------------------------------------------------------------
// §7 Combined bias metrics
// ---------------------------------------------------------------------------

/** Compute all bias metrics from a set of pairwise records and
 *  anchor results. */
export function computeBiasMetrics(input: {
  pairwiseRecords: PairwiseEvaluationRecord[];
  verbositySamples: Array<{ outputLength: number; scoreNumeric: number }>;
  sameFamilySamples: Array<{
    judgeFamily: string;
    candidateAFamily: string;
    candidateBFamily: string;
    preferred: "A" | "B" | "tie";
  }>;
  repeatedRunTrials: Array<{ verdict: string }[]>;
  anchorOrderingTrials: Array<{ violationDetected: boolean }>;
  thresholds: {
    positionBias: number;
    verbosityBias: number;
    sameFamilyPreference: number;
    disagreementRate: number;
    repeatedRunFlipRate: number;
    anchorOrdering: number;
  };
}): JudgeBiasMetrics {
  return {
    positionBias: computePositionBias(input.pairwiseRecords, input.thresholds.positionBias),
    verbosityBias: computeVerbosityBias(input.verbositySamples, input.thresholds.verbosityBias),
    sameFamilyPreference: computeSameFamilyPreference(
      input.sameFamilySamples,
      input.thresholds.sameFamilyPreference,
    ),
    disagreementRate: computePairwiseDisagreement(
      input.pairwiseRecords,
      input.thresholds.disagreementRate,
    ),
    repeatedRunInstability: computeRepeatedRunInstability(
      input.repeatedRunTrials,
      input.thresholds.repeatedRunFlipRate,
    ),
    anchorOrderingStability: computeAnchorOrderingStability(
      input.anchorOrderingTrials,
      input.thresholds.anchorOrdering,
    ),
  };
}

/** Returns true if any bias metric exceeds its candidate threshold. */
export function anyBiasExceeded(metrics: JudgeBiasMetrics): boolean {
  return (
    metrics.positionBias.exceeded
    || metrics.verbosityBias.exceeded
    || metrics.sameFamilyPreference.exceeded
    || metrics.disagreementRate.exceeded
    || metrics.repeatedRunInstability.exceeded
    || metrics.anchorOrderingStability.exceeded
  );
}

// ---------------------------------------------------------------------------
// §8 Anchor evaluation helper
// ---------------------------------------------------------------------------

/** Build anchor evaluation trial results for bias computation. */
export function buildAnchorOrderingTrials(
  anchorResults: AnchorEvaluationResult[][],
  anchors: Array<{ anchorId: string; kind: "good" | "bad" | "boundary"; expectedOrderRank: number }>,
): Array<{ violationDetected: boolean }> {
  return anchorResults.map((results) => {
    const ranked = [...results].sort((a, b) => b.confidence - a.confidence);
    let violationDetected = false;
    for (let i = 0; i < ranked.length; i++) {
      const anchor = anchors.find((a) => a.anchorId === ranked[i]!.anchorId);
      if (anchor && anchor.expectedOrderRank !== i) {
        violationDetected = true;
        break;
      }
    }
    return { violationDetected };
  });
}

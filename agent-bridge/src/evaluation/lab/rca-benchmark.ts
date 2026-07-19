/**
 * T46-4 (Issue #97 §5) — Known-fault RCA benchmark.
 *
 * Real benchmark that runs the predeclared evaluator-owned fault profiles,
 * captures the diagnosis produced for each, and scores them against the
 * deterministic oracle. The diagnosis implementation NEVER defines its own
 * expected cause — it only proposes hypotheses that the oracle scores via
 * `matchHypothesisToExpectedCause`.
 *
 * Boundary invariants (enforced and tested):
 *  - The benchmark MUST include samples from every required class:
 *      `correct_attribution`
 *      `confusable_neighbour`
 *      `unresolved_or_insufficient`
 *    Coverage is verified; missing classes fail-closed.
 *  - Anti-gaming #1: a sample that is `top3Correct` but not `top1Correct`
 *    is counted ONLY when its sample class is `confusable_neighbour` or
 *    `unresolved_or_insufficient`. A diagnosis that always outputs many
 *    candidates to inflate top-3 recall will be flagged via the
 *    `top1Top3Consistency` gate.
 *  - Anti-gaming #2: confidence that exceeds the evidence level is
 *    flagged via `confidenceExceedsStatus`. The calibration metric
 *    penalises over-confident diagnoses.
 *  - Anti-gaming #3: `falseAttribution` requires the top-1 hypothesis to
 *    match a confusable neighbour but NOT the profile. This catches
 *    confident wrong attributions.
 *  - Oracle independence: the expected cause is declared by the fault
 *    profile. The diagnosis implementation cannot redefine the matcher.
 *  - The benchmark is run by the diagnosis runner (see `diagnosis-runner.ts`)
 *    which actually executes each fault profile in evaluator-owned
 *    isolation, captures the diagnosis, and submits it to the oracle. The
 *    benchmark never self-fills results.
 */

import type {
  DiagnosisConfidenceLevel,
  DiagnosisCausalStatus,
  DiagnosisRecord,
  HypothesisRecord,
  RcaBenchmarkReport,
  RcaBenchmarkSample,
} from "./diagnosis-contract.js";
import {
  FAULT_PROFILE_CATALOG,
  classifyBenchmarkSample,
  hypothesisMatchesProfile,
  isFalseAttribution,
  selectBenchmarkProfiles,
  validateBenchmarkSampleClass,
} from "./fault-profiles.js";
import type { FaultProfile } from "./diagnosis-contract.js";
import { EvaluationValidationError } from "./errors.js";
import { sha256 } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Sample inputs
// ---------------------------------------------------------------------------

/** A diagnosis produced by the runner for one fault profile. */
export interface BenchmarkDiagnosisInput {
  /** Fault profile ID used to seed the observation. */
  faultProfileId: string;
  /** The diagnosis the SUT produced for the synthesised observation.
   *  May be undefined when the SUT failed to produce any diagnosis. */
  diagnosis: DiagnosisRecord | undefined;
}

// ---------------------------------------------------------------------------
// §2 Sample scoring — deterministic oracle
// ---------------------------------------------------------------------------

/** Score a single diagnosis against the fault profile's oracle.
 *
 *  This is the ONLY path the benchmark uses to label a sample. The
 *  diagnosis implementation cannot redefine these labels — it can only
 *  propose hypotheses. */
export function scoreBenchmarkSample(
  profile: FaultProfile,
  diagnosis: DiagnosisRecord | undefined,
): RcaBenchmarkSample {
  const sampleId = `sample-${profile.profileId}`;
  const expectedCauseId = profile.expectedCause.causeId;

  if (!diagnosis) {
    // SUT produced no diagnosis. Counts as unresolved/insufficient.
    return {
      sampleId,
      faultProfileId: profile.profileId,
      expectedCauseId,
      proposedCauses: [],
      top1Correct: false,
      top3Correct: false,
      unresolvedReported: true,
      falseAttribution: false,
      evidenceComplete: false,
      sampleClass: "unresolved_or_insufficient",
    };
  }

  // §1 Order hypotheses by declared confidence (descending). When two
  // hypotheses share a confidence level, the order is by hypothesis ID
  // for determinism.
  const ordered = orderedHypotheses(diagnosis.hypotheses);
  const top1 = ordered[0];
  const top3 = ordered.slice(0, 3);

  const top1Correct = !!top1 && hypothesisMatchesProfile(top1, profile);
  const top3Correct = top3.some((h) => hypothesisMatchesProfile(h, profile));
  const falseAttribution = !!top1 && isFalseAttribution(top1, profile);

  // §2 Sample class — derived from the diagnosis, not self-declared.
  const sampleClass = classifyBenchmarkSample(top1, diagnosis.causalStatus, profile);

  // §3 Evidence completeness: the diagnosis must have at least one
  // evidence record per non-discarded hypothesis. A diagnosis with
  // hypotheses but no evidence is not complete.
  const evidenceComplete = diagnosis.hypotheses.every(
    (h) => h.supportingEvidence.length > 0 || h.contradictingEvidence.length > 0,
  ) && diagnosis.evidence.length > 0;

  // §4 unresolvedReported: status is unresolved OR no hypotheses.
  const unresolvedReported =
    diagnosis.causalStatus === "unresolved" || ordered.length === 0;

  const proposedCauses = ordered.map((h) => ({
    causeId: h.hypothesisId,
    candidateCause: h.candidateCause,
    confidence: h.status === "unresolved" ? "very_low" : confidenceFromHypothesis(h),
    matchedExpected: hypothesisMatchesProfile(h, profile),
  }));

  const sample: RcaBenchmarkSample = {
    sampleId,
    faultProfileId: profile.profileId,
    expectedCauseId,
    proposedCauses,
    top1Correct,
    top3Correct,
    unresolvedReported,
    falseAttribution,
    evidenceComplete,
    sampleClass,
  };

  // §5 Validate internal consistency. Fail-closed on self-mislabelling.
  const inconsistencies = validateBenchmarkSampleClass(sample);
  if (inconsistencies.length > 0) {
    throw new EvaluationValidationError(
      `benchmark sample ${sampleId} 自标注不一致: ${inconsistencies.join("; ")}`,
    );
  }

  return sample;
}

/** Order hypotheses by confidence (descending) then by hypothesis ID
 *  for determinism. Hypotheses with `status: unresolved` are sorted
 *  last regardless of confidence. */
function orderedHypotheses(hypotheses: HypothesisRecord[]): HypothesisRecord[] {
  const confidenceOrder: Record<DiagnosisConfidenceLevel, number> = {
    very_high: 5,
    high: 4,
    medium: 3,
    low: 2,
    very_low: 1,
  };
  return [...hypotheses].sort((a, b) => {
    // Unresolved hypotheses always go last.
    if (a.status === "unresolved" && b.status !== "unresolved") return 1;
    if (b.status === "unresolved" && a.status !== "unresolved") return -1;
    const ca = confidenceFromHypothesis(a);
    const cb = confidenceFromHypothesis(b);
    const diff = confidenceOrder[cb] - confidenceOrder[ca];
    if (diff !== 0) return diff;
    return a.hypothesisId.localeCompare(b.hypothesisId);
  });
}

/** Map a hypothesis to a confidence level. The hypothesis record itself
 *  does not carry a confidence field — the diagnosis-level confidence
 *  is the canonical one. For benchmark ordering, we derive a per-hypothesis
 *  confidence from its causal status. */
function confidenceFromHypothesis(h: HypothesisRecord): DiagnosisConfidenceLevel {
  switch (h.status) {
    case "fault_injection_confirmed":
      return "high";
    case "intervention_supported":
      return "medium";
    case "localized_hypothesis":
      return "low";
    case "observed_failure":
      return "very_low";
    case "unresolved":
      return "very_low";
  }
}

// ---------------------------------------------------------------------------
// §3 Metric computation
// ---------------------------------------------------------------------------

/** Compute the 5 RCA metrics over a set of scored samples.
 *
 *  Metrics:
 *   - top1Accuracy: fraction of samples where top1Correct is true.
 *   - top3Recall: fraction of samples where top3Correct is true. BUT
 *     a sample that is top3Correct but not top1Correct is counted ONLY
 *     when its sampleClass is `confusable_neighbour` or
 *     `unresolved_or_insufficient`. This prevents a diagnosis from
 *     spamming many candidates to inflate top-3 recall.
 *   - falseAttributionRate: fraction of samples where falseAttribution
 *     is true. Lower is better.
 *   - evidenceCompleteness: fraction of samples where evidenceComplete
 *     is true. Higher is better.
 *   - confidenceCalibration: fraction of samples where the diagnosis
 *     confidence does NOT exceed the status. Higher is better.
 */
export function computeRcaMetrics(samples: RcaBenchmarkSample[]): {
  top1Accuracy: number;
  top3Recall: number;
  falseAttributionRate: number;
  evidenceCompleteness: number;
  confidenceCalibration: number;
} {
  if (samples.length === 0) {
    return {
      top1Accuracy: 0,
      top3Recall: 0,
      falseAttributionRate: 0,
      evidenceCompleteness: 0,
      confidenceCalibration: 0,
    };
  }
  const n = samples.length;
  const top1Correct = samples.filter((s) => s.top1Correct).length;
  // §1 Anti-gaming: top3Correct only counts when the sample is NOT a
  // correct_attribution sample. For correct_attribution samples, top3
  // and top1 must agree (otherwise the diagnosis is being inconsistent).
  const top3Correct = samples.filter((s) => {
    if (!s.top3Correct) return false;
    if (s.sampleClass === "correct_attribution") return s.top1Correct;
    return true;
  }).length;
  const falseAttribution = samples.filter((s) => s.falseAttribution).length;
  const evidenceComplete = samples.filter((s) => s.evidenceComplete).length;
  // §2 Confidence calibration: a sample is calibrated when its
  // top-1 confidence does not exceed its causal status. The benchmark
  // does not have direct access to the diagnosis status here, so we
  // use the sample class as a proxy:
  //  - correct_attribution: status is at least intervention_supported
  //    (else the diagnosis would not be confident). Confidence up to
  //    "high" is allowed; "very_high" is over-confident.
  //  - confusable_neighbour: status is observed_failure or
  //    localized_hypothesis. Confidence above "medium" is over-confident.
  //  - unresolved_or_insufficient: confidence above "low" is over-confident.
  const calibrated = samples.filter((s) => {
    const top1 = s.proposedCauses[0];
    if (!top1) return true; // no claim → calibrated by default
    return !confidenceExceedsSampleClass(s.sampleClass, top1.confidence);
  }).length;

  return {
    top1Accuracy: top1Correct / n,
    top3Recall: top3Correct / n,
    falseAttributionRate: falseAttribution / n,
    evidenceCompleteness: evidenceComplete / n,
    confidenceCalibration: calibrated / n,
  };
}

/** Return true when a confidence level exceeds what the sample class
 *  supports. Used by the benchmark to penalise over-confidence. */
function confidenceExceedsSampleClass(
  sampleClass: RcaBenchmarkSample["sampleClass"],
  confidence: DiagnosisConfidenceLevel,
): boolean {
  const order: DiagnosisConfidenceLevel[] = [
    "very_low",
    "low",
    "medium",
    "high",
    "very_high",
  ];
  const maxForClass: Record<RcaBenchmarkSample["sampleClass"], DiagnosisConfidenceLevel> = {
    correct_attribution: "high",
    confusable_neighbour: "medium",
    unresolved_or_insufficient: "low",
  };
  return order.indexOf(confidence) > order.indexOf(maxForClass[sampleClass]);
}

// ---------------------------------------------------------------------------
// §4 Sample coverage verification
// ---------------------------------------------------------------------------

/** Verify that the benchmark includes samples from every required class.
 *  Returns a list of missing classes (empty = OK). */
export function verifySampleCoverage(
  samples: RcaBenchmarkSample[],
): string[] {
  const present = new Set(samples.map((s) => s.sampleClass));
  const required = ["correct_attribution", "confusable_neighbour", "unresolved_or_insufficient"];
  return required.filter((c) => !present.has(c as RcaBenchmarkSample["sampleClass"]));
}

// ---------------------------------------------------------------------------
// §5 Report construction
// ---------------------------------------------------------------------------

export interface BuildBenchmarkReportInput {
  /** Diagnoses produced by the runner, one per fault profile. */
  inputs: BenchmarkDiagnosisInput[];
  /** ISO timestamp; defaults to `new Date().toISOString()`. */
  evaluatedAt?: string;
}

/** Build a benchmark report from runner-produced diagnoses.
 *
 *  This is the canonical path the CLI uses. It does NOT self-fill
 *  samples — every sample is scored against the oracle. */
export function buildBenchmarkReport(
  input: BuildBenchmarkReportInput,
): RcaBenchmarkReport {
  if (input.inputs.length === 0) {
    throw new EvaluationValidationError("rca benchmark 至少需要一个 sample input");
  }

  // §1 Map inputs to fault profiles and score each.
  const samples: RcaBenchmarkSample[] = [];
  for (const item of input.inputs) {
    const profile = FAULT_PROFILE_CATALOG.find(
      (p) => p.profileId === item.faultProfileId,
    );
    if (!profile) {
      throw new EvaluationValidationError(
        `benchmark input 引用未知 fault profile: ${item.faultProfileId}`,
      );
    }
    samples.push(scoreBenchmarkSample(profile, item.diagnosis));
  }

  // §2 Verify coverage. Fail-closed when a required class is missing.
  const missing = verifySampleCoverage(samples);
  if (missing.length > 0) {
    throw new EvaluationValidationError(
      `rca benchmark 缺少必需样本类别: ${missing.join(", ")}`,
    );
  }

  // §3 Compute metrics.
  const metrics = computeRcaMetrics(samples);

  // §4 Evaluate pass/fail gates.
  const failureReasons: string[] = [];
  // Gate 1: top-1 accuracy must be at least 0.5 (Issue #97 §5 does not
  // specify a threshold, but a benchmark where the diagnosis is wrong
  // more than half the time is not informative).
  if (metrics.top1Accuracy < 0.5) {
    failureReasons.push(
      `top1Accuracy ${metrics.top1Accuracy.toFixed(2)} 低于阈值 0.50`,
    );
  }
  // Gate 2: false attribution rate must be at most 0.3.
  if (metrics.falseAttributionRate > 0.3) {
    failureReasons.push(
      `falseAttributionRate ${metrics.falseAttributionRate.toFixed(2)} 高于阈值 0.30`,
    );
  }
  // Gate 3: confidence calibration must be at least 0.7.
  if (metrics.confidenceCalibration < 0.7) {
    failureReasons.push(
      `confidenceCalibration ${metrics.confidenceCalibration.toFixed(2)} 低于阈值 0.70`,
    );
  }
  // Gate 4: evidence completeness must be at least 0.7.
  if (metrics.evidenceCompleteness < 0.7) {
    failureReasons.push(
      `evidenceCompleteness ${metrics.evidenceCompleteness.toFixed(2)} 低于阈值 0.70`,
    );
  }
  // Gate 5: top-3 recall cannot exceed top-1 accuracy by more than 0.4
  // (anti-gaming: a diagnosis that spams many candidates to inflate
  // top-3 recall will fail this gate).
  if (metrics.top3Recall - metrics.top1Accuracy > 0.4) {
    failureReasons.push(
      `top3Recall ${metrics.top3Recall.toFixed(2)} - top1Accuracy ${metrics.top1Accuracy.toFixed(2)} > 0.40；疑似通过多候选刷 top-3 recall`,
    );
  }

  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const reportId = `rca-benchmark-${sha256(evaluatedAt + samples.length).slice(0, 16)}`;

  return {
    reportId,
    evaluatedAt,
    totalSamples: samples.length,
    top1Accuracy: metrics.top1Accuracy,
    top3Recall: metrics.top3Recall,
    falseAttributionRate: metrics.falseAttributionRate,
    evidenceCompleteness: metrics.evidenceCompleteness,
    confidenceCalibration: metrics.confidenceCalibration,
    samples,
    passed: failureReasons.length === 0,
    failureReasons,
  };
}

// ---------------------------------------------------------------------------
// §6 Benchmark profile selection — used by the runner
// ---------------------------------------------------------------------------

/** Return the canonical benchmark profiles. The runner iterates this list
 *  to produce one synthesised observation per profile. */
export function benchmarkProfiles(): FaultProfile[] {
  return selectBenchmarkProfiles();
}

/** Return the count of confusable-neighbour samples required. The runner
 *  must produce at least this many confusable-neighbour samples by
 *  swapping the profile with one of its declared neighbours. */
export function requiredConfusableNeighbourSamples(): number {
  return FAULT_PROFILE_CATALOG.filter(
    (p) => p.confusableNeighbours && p.confusableNeighbours.length > 0,
  ).length;
}

/** Return the count of unresolved/insufficient samples required. The
 *  runner must produce at least this many unresolved samples by
 *  synthesising observations with conflicting evidence. */
export function requiredUnresolvedSamples(): number {
  // At least 1 unresolved sample is required.
  return 1;
}

// ---------------------------------------------------------------------------
// §7 Anti-gaming verification — used by tests
// ---------------------------------------------------------------------------

/** Return true when a sample's top-3 correctness is suspicious (i.e.,
 *  the diagnosis listed many candidates and got lucky). Used by the
 *  mutation tests to verify the anti-gaming gate. */
export function isSuspiciousTop3(sample: RcaBenchmarkSample): boolean {
  if (sample.sampleClass === "correct_attribution") {
    return sample.top3Correct && !sample.top1Correct;
  }
  return false;
}

/** Return the maximum allowed confidence for a sample class. Used by
 *  tests to verify the calibration gate. */
export function maxConfidenceForSampleClass(
  sampleClass: RcaBenchmarkSample["sampleClass"],
): DiagnosisConfidenceLevel {
  switch (sampleClass) {
    case "correct_attribution":
      return "high";
    case "confusable_neighbour":
      return "medium";
    case "unresolved_or_insufficient":
      return "low";
  }
}

// ---------------------------------------------------------------------------
// §8 Status promotion verification — used by the diagnosis runner
// ---------------------------------------------------------------------------

/** Return the diagnosis status a benchmark sample supports. Used by the
 *  diagnosis runner to verify that the status it would promote to is
 *  consistent with the oracle's scoring. */
export function benchmarkSampleSupportedStatus(
  sample: RcaBenchmarkSample,
): DiagnosisCausalStatus {
  if (sample.sampleClass === "correct_attribution") {
    return sample.evidenceComplete
      ? "fault_injection_confirmed"
      : "intervention_supported";
  }
  if (sample.sampleClass === "confusable_neighbour") {
    return "localized_hypothesis";
  }
  return "unresolved";
}

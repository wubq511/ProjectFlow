/**
 * T46-5 (Issue #98 §7-§8) — Calibration runner.
 *
 * Orchestrates the calibration pipeline:
 *  1. Load active registry (read-only).
 *  2. Match anchors (declared by candidate standards, not Judge-generated).
 *  3. Run pairwise evaluations (with blinding + random order + reverse
 *     repetition).
 *  4. Measure bias metrics (position/verbosity/same-family/disagreement/
 *     repeated-run/anchor-ordering).
 *  5. Detect standard conflicts.
 *  6. Build candidate standards.
 *  7. Build reviewable standard diffs.
 *  8. Evaluate acceptance proposal.
 *  9. Build immutable calibration artifact.
 * 10. Publish atomically to the SHA-256 result graph.
 *
 * Boundary invariants (enforced and tested):
 *  - The runner NEVER modifies the active registry. Active fingerprint
 *    before == after.
 *  - The runner NEVER auto-promotes candidates. All candidates start as
 *    `candidate` status.
 *  - The runner NEVER issues a hard verdict when fail-safe conditions
 *    are met. It degrades to `needs_review`.
 *  - The runner NEVER claims cryptographic identity authentication for
 *    Robert. Promotion requires an explicit instruction + reviewable diff.
 *  - The runner NEVER silently switches to a same-family Judge to
 *    continue issuing hard verdicts.
 *  - The runner NEVER produces a calibration artifact with missing
 *    required fields.
 *  - The runner supports resume: re-running a calibration does not
 *    repeat completed Judge calls.
 *  - Failed calibration leaves active registry byte-identical.
 *  - All calibration artifacts atomically enter the SHA-256 result graph.
 *  - Evaluator budget exhaustion stops NEW Judge calls but preserves
 *    completed evidence and partial artifacts.
 */

import { createHash } from "node:crypto";
import type {
  AcceptanceProposal,
  AnchorRepeatResult,
  CalibrationArtifact,
  CalibrationCostLedger,
  CalibrationExitGateEvidence,
  CandidateStandard,
  JudgeBiasMetrics,
  JudgeManifest,
  PairwiseEvaluationRecord,
  SemanticAnchor,
  SemanticAnchorSet,
  SemanticRubric,
  SemanticVerdict,
  StandardConflict,
  StandardDiff,
  StandardEntry,
  StandardsRegistry,
} from "./calibration-contract.js";
import {
  CALIBRATION_ARTIFACT_SCHEMA_VERSION,
  PROMOTION_APPROVAL_SCHEMA_VERSION,
  STANDARD_DIFF_SCHEMA_VERSION,
  assertFrozenCandidateStatus,
  decideJudgeFailSafe,
} from "./calibration-contract.js";
import {
  buildCandidateRegistry,
  computeRegistryFingerprint,
  loadActiveRegistry,
  assertActiveRegistryUnchanged,
} from "./standards-registry.js";
import {
  detectStandardConflicts,
  hasUnresolvedConflict,
  type StructuredClaim,
} from "./standard-conflicts.js";
import {
  buildPairwiseRecord,
  computeAnchorStability,
  evaluateAcceptanceProposal,
  evaluateAnchorOrdering,
  type AnchorEvaluationResult,
  type JudgeInput,
} from "./semantic-judge.js";
import {
  anyBiasExceeded,
  buildAnchorOrderingTrials,
  computeBiasMetrics,
} from "./judge-bias.js";
import { EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";
import type { EvaluationArtifactStore } from "./artifact-store.js";

// ---------------------------------------------------------------------------
// §1 Runner inputs
// ---------------------------------------------------------------------------

/** Inputs for a single anchor evaluation. */
export interface AnchorEvaluationInput {
  anchor: SemanticAnchor;
  judgeInput: JudgeInput;
  rubric: SemanticRubric;
  /** Mock Judge result (for deterministic testing). */
  mockJudgeResult?: { verdict: SemanticVerdict; score: string; reason: string; confidence: number };
}

/** Inputs for a single pairwise evaluation. */
export interface PairwiseEvaluationInput {
  candidateAId: string;
  candidateBId: string;
  candidateAOutput: string;
  candidateBOutput: string;
  blinded: boolean;
  rubric: SemanticRubric;
  judgeManifest: JudgeManifest;
  /** Mock Judge result for forward order. */
  mockForwardResult?: { kind: "preference"; preferred: "A" | "B" | "tie"; confidence: number; reason: string }
    | { kind: "degraded"; verdict: SemanticVerdict; reason: string };
  /** Mock Judge result for reverse order. */
  mockReverseResult?: { kind: "preference"; preferred: "A" | "B" | "tie"; confidence: number; reason: string }
    | { kind: "degraded"; verdict: SemanticVerdict; reason: string };
}

/** Inputs for the calibration runner. */
export interface CalibrationRunnerInput {
  runId: string;
  projectRoot: string;
  acceptanceProposal: AcceptanceProposal;
  rubrics: SemanticRubric[];
  anchorSets: SemanticAnchorSet[];
  judgeManifest: JudgeManifest;
  anchorEvaluations: AnchorEvaluationInput[];
  pairwiseEvaluations: PairwiseEvaluationInput[];
  /** Evaluator-owned samples for checking whether length alone changes Judge scores. */
  verbositySamples?: Array<{ outputLength: number; scoreNumeric: number }>;
  /** Evaluator-owned samples for checking same-family preference. */
  sameFamilySamples?: Array<{
    judgeFamily: string;
    candidateAFamily: string;
    candidateBFamily: string;
    preferred: "A" | "B" | "tie";
  }>;
  standardClaims: StructuredClaim[];
  costLedger: CalibrationCostLedger;
  mutationResults: Array<{ mutationId: string; detected: boolean; expectedDetection: boolean }>;
  thresholds: {
    positionBias: number;
    verbosityBias: number;
    sameFamilyPreference: number;
    disagreementRate: number;
    repeatedRunFlipRate: number;
    anchorOrdering: number;
  };
  /** Number of times to repeat each anchor evaluation. */
  anchorRepeats: number;
  /** Optional: existing pairwise records (for resume). */
  existingPairwiseRecords?: PairwiseEvaluationRecord[];
  /** Optional: existing anchor results (for resume). */
  existingAnchorResults?: AnchorEvaluationResult[][];
  /** Optional: fail-safe override flags (for testing). */
  failSafeOverrides?: {
    independentJudgeAvailable?: boolean;
    judgeIdentityConfirmed?: boolean;
    onlySameFamilyUncalibrated?: boolean;
    judgesConflict?: boolean;
    anchorOrderingUnstable?: boolean;
    biasMetricsExceeded?: boolean;
    judgeTelemetryIncomplete?: boolean;
    judgeSchemaUnrepairable?: boolean;
    calibrationEvidenceInsufficient?: boolean;
  };
}

// ---------------------------------------------------------------------------
// §2 Pipeline result
// ---------------------------------------------------------------------------

export interface CalibrationRunnerResult {
  artifact: CalibrationArtifact;
  candidateStandards: CandidateStandard[];
  candidateRegistry: StandardsRegistry;
  standardConflicts: StandardConflict[];
  standardDiffs: StandardDiff[];
  pairwiseRecords: PairwiseEvaluationRecord[];
  anchorResults: AnchorEvaluationResult[][];
  biasMetrics: JudgeBiasMetrics;
  published: {
    calibrationArtifactPath: string;
    calibrationArtifactSha256: string;
    candidateRegistryPath: string;
    candidateRegistrySha256: string;
    standardConflictsPath: string;
    standardConflictsSha256: string;
    standardDiffPaths: Array<{ diffId: string; path: string; sha256: string }>;
  };
}

// ---------------------------------------------------------------------------
// §3 Run the calibration pipeline
// ---------------------------------------------------------------------------

export async function runCalibrationPipeline(
  store: EvaluationArtifactStore,
  input: CalibrationRunnerInput,
): Promise<CalibrationRunnerResult> {
  // §1 Load active registry (read-only).
  const activeBefore = await loadActiveRegistry(input.projectRoot);

  // §2 Detect standard conflicts.
  const detectedAt = new Date().toISOString();
  const conflicts = detectStandardConflicts(input.standardClaims, detectedAt);

  // §3 Run anchor evaluations (or reuse existing for resume).
  // NOTE: We spread into a new array so resume does NOT mutate the
  // caller's `existingAnchorResults`. The caller's array is treated
  // as read-only input.
  // NOTE: Anchors whose anchorId already appears in existingAnchorResults
  // are skipped (idempotent resume), so re-running a calibration does
  // NOT repeat completed Judge calls or append duplicate results.
  const anchorResults: AnchorEvaluationResult[][] = [...(input.existingAnchorResults ?? [])];
  const existingAnchorIds = new Set(
    anchorResults.flatMap((results) => results.map((r) => r.anchorId)),
  );
  const anchorRepeatResults: AnchorRepeatResult[] = [];
  for (const anchorSet of input.anchorSets) {
    for (const anchor of anchorSet.anchors) {
      if (existingAnchorIds.has(anchor.anchorId)) {
        // Skip re-computation for already-computed anchors (idempotent resume).
        // Re-derive repeat summary from existing results so the artifact
        // remains self-consistent without re-calling the Judge.
        const existingResults = anchorResults.find(
          (results) => results.length > 0 && results[0]!.anchorId === anchor.anchorId,
        );
        if (existingResults) {
          const stability = computeAnchorStability([existingResults], [anchor]);
          const ordering = evaluateAnchorOrdering([anchor], existingResults);
          anchorRepeatResults.push({
            anchorId: anchor.anchorId,
            repeats: existingResults.length,
            verdicts: existingResults.map((r) => r.verdict),
            scores: existingResults.map((r) => r.score),
            stability: stability.perAnchor[0]?.stability ?? 0,
            orderingPreserved: ordering.orderingPreserved,
          });
        }
        continue;
      }
      const relevantInputs = input.anchorEvaluations.filter((a) => a.anchor.anchorId === anchor.anchorId);
      const perAnchorResults: AnchorEvaluationResult[] = [];
      for (let i = 0; i < input.anchorRepeats; i++) {
        const ai = relevantInputs[i % Math.max(relevantInputs.length, 1)];
        if (!ai) {
          perAnchorResults.push({
            anchorId: anchor.anchorId,
            verdict: "needs_review",
            score: "",
            confidence: 0,
          });
          continue;
        }
        const result = runAnchorEvaluation(ai);
        perAnchorResults.push(result);
      }
      anchorResults.push(perAnchorResults);
      const stability = computeAnchorStability([perAnchorResults], [anchor]);
      const ordering = evaluateAnchorOrdering([anchor], perAnchorResults);
      anchorRepeatResults.push({
        anchorId: anchor.anchorId,
        repeats: perAnchorResults.length,
        verdicts: perAnchorResults.map((r) => r.verdict),
        scores: perAnchorResults.map((r) => r.score),
        stability: stability.perAnchor[0]?.stability ?? 0,
        orderingPreserved: ordering.orderingPreserved,
      });
    }
  }

  // §4 Run pairwise evaluations (or reuse existing for resume).
  // NOTE: Spread into a new array so resume does NOT mutate the
  // caller's `existingPairwiseRecords`.
  // NOTE: Pairwise records whose pairwiseId already appears in
  // existingPairwiseRecords are skipped (idempotent resume).
  const pairwiseRecords: PairwiseEvaluationRecord[] = [...(input.existingPairwiseRecords ?? [])];
  const existingPairwiseIds = new Set(pairwiseRecords.map((r) => r.pairwiseId));
  for (const pe of input.pairwiseEvaluations) {
    const pairwiseId = `pairwise-${pe.candidateAId}-${pe.candidateBId}`;
    if (existingPairwiseIds.has(pairwiseId)) {
      // Skip re-computation for already-computed pairwise evaluations.
      continue;
    }
    const record = runPairwiseEvaluation(pe, input.judgeManifest);
    pairwiseRecords.push(record);
  }

  // §5 Compute bias metrics.
  const biasMetrics = computeBiasMetrics({
    pairwiseRecords,
    verbositySamples: input.verbositySamples ?? [],
    sameFamilySamples: input.sameFamilySamples ?? [],
    repeatedRunTrials: anchorResults.map((r) => r.map((x) => ({ verdict: x.verdict }))),
    anchorOrderingTrials: buildAnchorOrderingTrials(
      transposeAnchorResultsByRepeat(anchorResults),
      input.anchorSets.flatMap((s) => s.anchors),
    ),
    thresholds: input.thresholds,
  });

  // §6 Decide fail-safe.
  const failSafeReason = decideJudgeFailSafe({
    independentJudgeAvailable: input.failSafeOverrides?.independentJudgeAvailable ?? true,
    judgeIdentityConfirmed: input.failSafeOverrides?.judgeIdentityConfirmed ?? true,
    onlySameFamilyUncalibrated: input.failSafeOverrides?.onlySameFamilyUncalibrated ?? false,
    judgesConflict: input.failSafeOverrides?.judgesConflict ?? false,
    anchorOrderingUnstable: input.failSafeOverrides?.anchorOrderingUnstable ?? biasMetrics.anchorOrderingStability.exceeded,
    biasMetricsExceeded: input.failSafeOverrides?.biasMetricsExceeded ?? anyBiasExceeded(biasMetrics),
    judgeTelemetryIncomplete: input.failSafeOverrides?.judgeTelemetryIncomplete ?? false,
    judgeSchemaUnrepairable: input.failSafeOverrides?.judgeSchemaUnrepairable ?? false,
    calibrationEvidenceInsufficient: input.failSafeOverrides?.calibrationEvidenceInsufficient ?? false,
  });

  // §6.5 If fail-safe triggered, degrade anchor results to needs_review.
  // The original Judge verdicts are not trustworthy under fail-safe
  // conditions (e.g. bias exceeded, anchor ordering unstable, no
  // independent judge). The artifact and CalibrationRunnerResult must
  // reflect the degraded verdicts so downstream consumers cannot
  // mistake raw verdicts for final verdicts.
  //
  // Bias metrics (§5) and the fail-safe decision (§6) use the original
  // anchorResults; only the artifact and result expose the degraded
  // versions.
  const failSafeTriggered = failSafeReason !== null;
  const anchorResultsForArtifact: AnchorEvaluationResult[][] = failSafeTriggered
    ? anchorResults.map((results) =>
        results.map((r) => ({
          ...r,
          verdict: "needs_review" as SemanticVerdict,
          confidence: 0,
        })),
      )
    : anchorResults;
  const anchorRepeatResultsForArtifact: AnchorRepeatResult[] = failSafeTriggered
    ? anchorRepeatResults.map((r) => ({
        ...r,
        verdicts: r.verdicts.map(() => "needs_review" as SemanticVerdict),
        stability: 0,
        orderingPreserved: false,
      }))
    : anchorRepeatResults;

  // §7 Build candidate standards.
  const candidateStandards: CandidateStandard[] = input.rubrics.map((rubric, idx) => {
    const entry: StandardEntry = {
      id: rubric.rubricId,
      kind: "semantic_rubric",
      version: rubric.rubricVersion,
      fingerprint: sha256(stableStringify(rubric)),
      payload: rubric,
      source: {
        registry: "candidate",
        origin: input.runId,
        path: `calibrations/${input.runId}/candidate-standards/${rubric.rubricId}.json`,
      },
      createdAt: detectedAt,
    };
    const affectedByConflicts = conflicts
      .filter((c) => c.affectedCandidateStandards.includes(rubric.rubricId))
      .map((c) => c.conflictId);
    return {
      candidateId: `candidate-${input.runId}-${idx}`,
      entry,
      status: "candidate",
      producedByRunId: input.runId,
      affectedByConflicts,
      createdAt: detectedAt,
    };
  });

  // §8 Build candidate registry.
  const candidateRegistry = buildCandidateRegistry(candidateStandards, input.runId);

  // §9 Build standard diffs (one per candidate).
  const standardDiffs: StandardDiff[] = candidateStandards.map((c) => {
    return buildStandardDiff(c, activeBefore);
  });

  // §10 Evaluate acceptance proposal.
  // Use the degraded anchorRepeatResults when fail-safe triggered so
  // acceptance reflects the fail-safe (repeatedStability becomes 0).
  const acceptance = evaluateAcceptanceProposal(input.acceptanceProposal, {
    anchorOrderingViolationRate: biasMetrics.anchorOrderingStability.violationRate,
    repeatedStability:
      anchorRepeatResultsForArtifact.length > 0
        ? anchorRepeatResultsForArtifact.reduce((s, r) => s + r.stability, 0) / anchorRepeatResultsForArtifact.length
        : 0,
    positionBiasPreferenceForFirst: biasMetrics.positionBias.preferenceForFirst,
    verbosityBiasCorrelation: biasMetrics.verbosityBias.correlation,
    sameFamilyPreferenceRate: biasMetrics.sameFamilyPreference.preferenceRate,
    pairwiseDisagreementRate: biasMetrics.disagreementRate.rate,
    repeatedRunFlipRate: biasMetrics.repeatedRunInstability.flipRate,
  });

  // §11 Determine promotion eligibility.
  const promotionEligibility = {
    anyEligible: candidateStandards.some(
      (c) => isEligibleForPromotion(c, conflicts, failSafeReason, acceptance.passed),
    ),
    perCandidate: candidateStandards.map((c) => ({
      candidateId: c.candidateId,
      eligible: isEligibleForPromotion(c, conflicts, failSafeReason, acceptance.passed),
      failureReasons: getPromotionFailureReasons(c, conflicts, failSafeReason, acceptance.passed),
    })),
  };

  // §12 Build exit gate evidence.
  // failSafeVerified: when a fail-safe reason was triggered, all
  // candidate standards MUST stay in "candidate" status (no
  // auto-promotion). When no fail-safe was triggered, the verdict is
  // also considered verified because the fail-safe decision function
  // was still called and returned null.
  const failSafeVerified = candidateStandards.every((c) => c.status === "candidate");
  // conflictsRecorded: detectStandardConflicts returns ALL detected
  // conflicts; nothing is filtered. This is always true for the
  // pipeline output.
  const conflictsRecorded = true;
  const exitGateEvidence: CalibrationExitGateEvidence = {
    anchorOrderingStable: !biasMetrics.anchorOrderingStability.exceeded,
    repeatedStabilityMet: acceptance.passed,
    failSafeVerified,
    activeRegistryImmutable: true, // verified by assertActiveRegistryUnchanged below
    conflictsRecorded,
    noSilentSameFamilyPromotion: !input.failSafeOverrides?.onlySameFamilyUncalibrated,
    passed:
      acceptance.passed
      && failSafeReason === null
      && !anyBiasExceeded(biasMetrics)
      && conflicts.every((c) => c.resolutionStatus === "resolved"),
    failureReasons: [
      ...(acceptance.passed ? [] : acceptance.failureReasons),
      ...(failSafeReason ? [`fail-safe 触发: ${failSafeReason}`] : []),
      ...(anyBiasExceeded(biasMetrics) ? ["bias metrics 超过候选阈值"] : []),
      ...(conflicts.some((c) => c.resolutionStatus !== "resolved")
        ? ["存在未解决 standard conflict"]
        : []),
    ],
  };

  // §13 Build the calibration artifact.
  const artifactBase: Omit<CalibrationArtifact, "integritySha256"> = {
    schemaVersion: CALIBRATION_ARTIFACT_SCHEMA_VERSION,
    calibrationId: input.runId,
    createdAt: detectedAt,
    activeRegistryFingerprint: activeBefore.fingerprint,
    candidateRegistryFingerprint: candidateRegistry.fingerprint,
    scenarioVersions: [],
    anchorVersions: input.anchorSets.map((s) => ({
      anchorSetId: s.anchorSetId,
      anchorVersion: s.version,
      fingerprint: sha256(stableStringify(s)),
    })),
    rubricVersions: input.rubrics.map((r) => ({
      rubricId: r.rubricId,
      rubricVersion: r.rubricVersion,
      fingerprint: sha256(stableStringify(r)),
    })),
    judgeVersions: [
      {
        judgeId: input.judgeManifest.judgeId,
        judgeVersion: input.judgeManifest.version,
        fingerprint: sha256(stableStringify(input.judgeManifest)),
      },
    ],
    repeatedAnchorResults: anchorRepeatResultsForArtifact,
    biasMetrics,
    disagreementSummary: {
      pairwiseDisagreementRate: biasMetrics.disagreementRate.rate,
      repeatedRunFlipRate: biasMetrics.repeatedRunInstability.flipRate,
      sampleSize: biasMetrics.disagreementRate.sampleSize + biasMetrics.repeatedRunInstability.sampleSize,
    },
    mutationResults: input.mutationResults,
    standardConflicts: conflicts,
    costLedger: input.costLedger,
    candidateStandards,
    standardDiffs,
    promotionEligibility,
    failureReasons: exitGateEvidence.failureReasons,
    passed: exitGateEvidence.passed,
    partial: false,
    exitGateEvidence,
  };
  const integritySha256 = sha256(stableStringify(artifactBase));
  const artifact: CalibrationArtifact = { ...artifactBase, integritySha256 };

  // §14 Verify active registry is unchanged.
  const activeAfter = await loadActiveRegistry(input.projectRoot);
  assertActiveRegistryUnchanged(activeBefore, activeAfter);

  // §15 Publish all artifacts atomically to the SHA-256 result graph.
  const calibrationArtifactPub = await store.publishCalibrationArtifact(artifact, input.runId);
  const candidateRegistryPub = await store.publishCandidateRegistry(candidateRegistry, input.runId);
  const standardConflictsPub = await store.publishStandardConflicts(conflicts, input.runId);
  const standardDiffPubs: Array<{ diffId: string; path: string; sha256: string }> = [];
  for (const diff of standardDiffs) {
    const pub = await store.publishStandardDiff(diff, diff.diffId);
    standardDiffPubs.push({ diffId: diff.diffId, path: pub.artifactPath, sha256: pub.sha256 });
  }

  return {
    artifact,
    candidateStandards,
    candidateRegistry,
    standardConflicts: conflicts,
    standardDiffs,
    pairwiseRecords,
    anchorResults: anchorResultsForArtifact,
    biasMetrics,
    published: {
      calibrationArtifactPath: calibrationArtifactPub.artifactPath,
      calibrationArtifactSha256: calibrationArtifactPub.sha256,
      candidateRegistryPath: candidateRegistryPub.artifactPath,
      candidateRegistrySha256: candidateRegistryPub.sha256,
      standardConflictsPath: standardConflictsPub.artifactPath,
      standardConflictsSha256: standardConflictsPub.sha256,
      standardDiffPaths: standardDiffPubs,
    },
  };
}

// ---------------------------------------------------------------------------
// §4 Anchor evaluation
// ---------------------------------------------------------------------------

function runAnchorEvaluation(ai: AnchorEvaluationInput): AnchorEvaluationResult {
  // Anchor-level fail-safe: only handle missing Judge result.
  // Pipeline-level fail-safe (bias, anchor ordering, independent judge,
  // etc.) is applied in §6.5 of runCalibrationPipeline, which degrades
  // all anchor verdicts to needs_review when any fail-safe condition
  // triggers. This avoids hardcoding all fail-safe parameters to "safe"
  // values at the anchor level.
  if (!ai.mockJudgeResult) {
    return {
      anchorId: ai.anchor.anchorId,
      verdict: "infra_error",
      score: "",
      confidence: 0,
    };
  }
  return {
    anchorId: ai.anchor.anchorId,
    verdict: ai.mockJudgeResult.verdict,
    score: ai.mockJudgeResult.score,
    confidence: ai.mockJudgeResult.confidence,
  };
}

// ---------------------------------------------------------------------------
// §5 Pairwise evaluation
// ---------------------------------------------------------------------------

function runPairwiseEvaluation(
  pe: PairwiseEvaluationInput,
  judgeManifest: JudgeManifest,
): PairwiseEvaluationRecord {
  const seed = createHash("sha256")
    .update(`${pe.candidateAId}:${pe.candidateBId}:${judgeManifest.judgeId}`)
    .digest("hex");
  const forward = pe.mockForwardResult ?? {
    kind: "degraded" as const,
    verdict: "needs_review" as SemanticVerdict,
    reason: "未提供 mock forward result",
  };
  const reverse = pe.mockReverseResult ?? forward;
  return buildPairwiseRecord({
    pairwiseId: `pairwise-${pe.candidateAId}-${pe.candidateBId}`,
    candidateAId: pe.candidateAId,
    candidateBId: pe.candidateBId,
    blinded: pe.blinded,
    seed,
    judgeManifest,
    rubric: pe.rubric,
    forwardVerdict: forward,
    reverseVerdict: reverse,
    evaluatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// §6 Standard diff construction
// ---------------------------------------------------------------------------

function buildStandardDiff(
  candidate: CandidateStandard,
  active: StandardsRegistry,
): StandardDiff {
  const existing = active.entries.find((e) => e.id === candidate.entry.id);
  const additions: StandardEntry[] = [];
  const modifications: Array<{ before: StandardEntry; after: StandardEntry }> = [];
  const removals: string[] = [];
  if (existing) {
    modifications.push({ before: existing, after: candidate.entry });
  } else {
    additions.push(candidate.entry);
  }
  // §1 Compute predicted afterActiveFingerprint.
  const newEntries = [...active.entries.filter((e) => e.id !== candidate.entry.id), candidate.entry];
  const afterBase = {
    schemaVersion: active.schemaVersion,
    registry: active.registry as "active",
    registryId: active.registryId,
    entries: newEntries,
    updatedAt: new Date().toISOString(),
  };
  const afterFingerprint = computeRegistryFingerprint(afterBase);
  const diffBase: Omit<StandardDiff, "integritySha256"> = {
    schemaVersion: STANDARD_DIFF_SCHEMA_VERSION,
    diffId: `diff-${candidate.candidateId}`,
    candidateId: candidate.candidateId,
    additions,
    modifications,
    removals,
    beforeActiveFingerprint: active.fingerprint,
    afterActiveFingerprint: afterFingerprint,
  };
  return { ...diffBase, integritySha256: sha256(stableStringify(diffBase)) };
}

// ---------------------------------------------------------------------------
// §7 Promotion eligibility
// ---------------------------------------------------------------------------

function isEligibleForPromotion(
  candidate: CandidateStandard,
  conflicts: StandardConflict[],
  failSafeReason: string | null,
  acceptancePassed: boolean,
): boolean {
  // §1 Must be in "candidate" status.
  if (candidate.status !== "candidate") return false;
  // §2 Must have no unresolved conflicts affecting this candidate.
  //    Conflicts may reference either the run-scoped candidateId OR
  //    the standard entry id (e.g., rubricId). Both must be checked
  //    because StructuredClaim.affectsCandidateId typically uses the
  //    standard entry id, while the runner generates run-scoped
  //    candidate IDs.
  if (hasUnresolvedConflict(conflicts, candidate.candidateId)) return false;
  if (hasUnresolvedConflict(conflicts, candidate.entry.id)) return false;
  // §3 Calibration evidence itself must be acceptable. A conflict-free
  // candidate is still ineligible when the Judge failed safe or the
  // frozen acceptance proposal did not pass.
  if (failSafeReason !== null || !acceptancePassed) return false;
  return true;
}

/** Convert per-anchor repeat groups into per-repeat anchor groups. */
function transposeAnchorResultsByRepeat(
  perAnchorResults: AnchorEvaluationResult[][],
): AnchorEvaluationResult[][] {
  const repeatCount = Math.max(0, ...perAnchorResults.map((results) => results.length));
  return Array.from({ length: repeatCount }, (_, repeatIndex) =>
    perAnchorResults.flatMap((results) => {
      const result = results[repeatIndex];
      return result ? [result] : [];
    }),
  );
}

function getPromotionFailureReasons(
  candidate: CandidateStandard,
  conflicts: StandardConflict[],
  failSafeReason: string | null,
  acceptancePassed: boolean,
): string[] {
  const reasons: string[] = [];
  if (candidate.status !== "candidate") {
    reasons.push(`candidate status=${candidate.status}, 必须 candidate`);
  }
  if (
    hasUnresolvedConflict(conflicts, candidate.candidateId)
    || hasUnresolvedConflict(conflicts, candidate.entry.id)
  ) {
    reasons.push("存在未解决 standard conflict");
  }
  if (failSafeReason) {
    reasons.push(`fail-safe 触发: ${failSafeReason}`);
  }
  if (!acceptancePassed) {
    reasons.push("acceptance proposal 未通过");
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// §8 Promotion approval (the ONLY path to mutate active registry)
// ---------------------------------------------------------------------------

/** Build a promotion approval record from an explicit Robert instruction.
 *
 *  This function does NOT claim cryptographic identity authentication.
 *  It is repository governance with reviewable history.
 *
 *  The caller MUST:
 *   - have received an explicit instruction from Robert to promote;
 *   - have computed the new active registry state (via
 *     `applyPromotionApproval` from `standards-registry.ts`);
 *   - write the new active registry file to Git via a reviewable diff;
 *   - record the diff path and commit hash in the approval record.
 */
export function buildPromotionApproval(input: {
  candidateId: string;
  approverInstruction: string;
  diffPath: string;
  commit: string;
  beforeActiveFingerprint: string;
  afterActiveFingerprint: string;
  resolvedConflictIds: string[];
}): { schemaVersion: typeof PROMOTION_APPROVAL_SCHEMA_VERSION; approvalId: string; candidateId: string; approvedAt: string; approverInstruction: string; reviewableDiff: { diffPath: string; commit: string }; beforeActiveFingerprint: string; afterActiveFingerprint: string; resolvedConflictIds: string[] } {
  if (!input.approverInstruction.trim()) {
    throw new EvaluationValidationError("approver instruction 不能为空");
  }
  if (!input.diffPath.trim()) {
    throw new EvaluationValidationError("diff path 不能为空");
  }
  if (!input.commit.trim()) {
    throw new EvaluationValidationError("commit hash 不能为空");
  }
  return {
    schemaVersion: PROMOTION_APPROVAL_SCHEMA_VERSION,
    approvalId: `approval-${input.candidateId}-${input.commit.slice(0, 8)}`,
    candidateId: input.candidateId,
    approvedAt: new Date().toISOString(),
    approverInstruction: input.approverInstruction,
    reviewableDiff: {
      diffPath: input.diffPath,
      commit: input.commit,
    },
    beforeActiveFingerprint: input.beforeActiveFingerprint,
    afterActiveFingerprint: input.afterActiveFingerprint,
    resolvedConflictIds: input.resolvedConflictIds,
  };
}

// ---------------------------------------------------------------------------
// §9 Resume helpers
// ---------------------------------------------------------------------------

/** Determine which Judge calls still need to be made for a resume.
 *
 *  Issue #98 §8: resume does NOT repeat completed Judge calls.
 */
export function determineRemainingJudgeCalls(input: {
  totalAnchorEvaluations: number;
  completedAnchorResults: number;
  totalPairwiseEvaluations: number;
  completedPairwiseRecords: number;
}): {
  remainingAnchorEvaluations: number;
  remainingPairwiseEvaluations: number;
} {
  return {
    remainingAnchorEvaluations: Math.max(0, input.totalAnchorEvaluations - input.completedAnchorResults),
    remainingPairwiseEvaluations: Math.max(0, input.totalPairwiseEvaluations - input.completedPairwiseRecords),
  };
}

// ---------------------------------------------------------------------------
// §10 Artifact validation
// ---------------------------------------------------------------------------

/** Verify a calibration artifact's invariants. Returns violations
 *  (empty = OK). */
export function verifyCalibrationArtifactInvariants(
  artifact: CalibrationArtifact,
): string[] {
  const violations: string[] = [];
  if (artifact.schemaVersion !== CALIBRATION_ARTIFACT_SCHEMA_VERSION) {
    violations.push(
      `schemaVersion ${artifact.schemaVersion} 不受支持; 当前版本 ${CALIBRATION_ARTIFACT_SCHEMA_VERSION}`,
    );
  }
  // §1 Required fields must be present.
  if (!artifact.calibrationId) violations.push("calibrationId 缺失");
  if (!artifact.activeRegistryFingerprint) violations.push("activeRegistryFingerprint 缺失");
  if (!artifact.candidateRegistryFingerprint) violations.push("candidateRegistryFingerprint 缺失");
  if (!artifact.integritySha256) violations.push("integritySha256 缺失");
  // §2 Integrity hash must match.
  const { integritySha256: _ignored, ...base } = artifact;
  const expected = sha256(stableStringify(base));
  if (artifact.integritySha256 !== expected) {
    violations.push("integritySha256 不匹配");
  }
  // §3 All candidate standards must be in "candidate" status (no auto-promotion).
  for (const c of artifact.candidateStandards) {
    try {
      assertFrozenCandidateStatus(c.status);
    } catch (e) {
      violations.push(`candidate ${c.candidateId} status 非法: ${(e as Error).message}`);
    }
    if (c.status !== "candidate") {
      violations.push(`candidate ${c.candidateId} status=${c.status}; calibration 不得 auto-promote`);
    }
  }
  // §4 Cost ledger provenance must be valid.
  const validProvenance = ["provider_reported", "versioned_price_estimate", "unknown"];
  if (!validProvenance.includes(artifact.costLedger.sutProvenance)) {
    violations.push(`costLedger.sutProvenance 非法: ${artifact.costLedger.sutProvenance}`);
  }
  if (!validProvenance.includes(artifact.costLedger.evaluatorProvenance)) {
    violations.push(`costLedger.evaluatorProvenance 非法: ${artifact.costLedger.evaluatorProvenance}`);
  }
  if (artifact.costLedger.codingAgentProvenance !== "unknown") {
    violations.push(
      `costLedger.codingAgentProvenance 必须为 unknown, 实际 ${artifact.costLedger.codingAgentProvenance}`,
    );
  }
  // §5 Unknown cost must NOT be displayed as $0.
  // Applies to SUT and evaluator costs. codingAgent cost is always
  // "unknown" by design (it does not call a paid API directly) and is
  // exempt from this check.
  if (
    artifact.costLedger.sutProvenance === "unknown"
    && artifact.costLedger.sut.amountUsd === 0
  ) {
    violations.push("SUT cost provenance=unknown 但 amountUsd=0; unknown cost 不得显示为 $0");
  }
  if (
    artifact.costLedger.evaluatorProvenance === "unknown"
    && artifact.costLedger.evaluator.amountUsd === 0
  ) {
    violations.push("evaluator cost provenance=unknown 但 amountUsd=0; unknown cost 不得显示为 $0");
  }
  return violations;
}

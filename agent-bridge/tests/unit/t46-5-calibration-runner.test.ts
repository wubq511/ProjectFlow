/**
 * T46-5 (Issue #98 §7-§8) — Calibration runner integration tests.
 *
 * Verifies the end-to-end calibration pipeline:
 *  1. runCalibrationPipeline consumes mock Judge results + candidate
 *     rubrics/anchors and produces a calibration artifact, candidate
 *     registry, standard conflicts, standard diffs, and pairwise
 *     records.
 *  2. The active registry is NEVER modified by calibration.
 *     `assertActiveRegistryUnchanged` is enforced before publication.
 *  3. All candidate standards stay in "candidate" status (no
 *     auto-promotion).
 *  4. Resume: re-running a calibration with existing pairwise/anchor
 *     records does NOT repeat completed Judge calls.
 *  5. The calibration artifact satisfies all invariants required by
 *     Issue #98 §8 (17+ fields + integritySha256).
 *  6. Fail-safe triggers degrade final verdicts to needs_review.
 *  7. Bias metrics feed into promotion eligibility.
 *  8. Standard conflicts block promotion eligibility.
 *
 * All Judge results are MOCK/deterministic. No real paid model is
 * invoked. This is mandatory per Issue #98 acceptance criterion 7.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EvaluationArtifactStore } from "../../src/evaluation/lab/artifact-store.js";
import {
  runCalibrationPipeline,
  buildPromotionApproval,
  determineRemainingJudgeCalls,
  verifyCalibrationArtifactInvariants,
  type AnchorEvaluationInput,
  type PairwiseEvaluationInput,
  type CalibrationRunnerInput,
} from "../../src/evaluation/lab/calibration-runner.js";
import {
  CALIBRATE_ACCEPTANCE_PROPOSAL,
  P0_PLANNING_SPECIFICITY_ANCHOR_SET,
  P0_PLANNING_SPECIFICITY_RUBRIC,
  P0_MOCK_JUDGE_MANIFEST,
  CALIBRATE_BUDGET,
} from "../../src/evaluation/lab/presets.js";
import {
  buildCandidateRegistry,
  loadActiveRegistry,
  buildEmptyActiveRegistry,
} from "../../src/evaluation/lab/standards-registry.js";
import type {
  CalibrationCostLedger,
  CandidateStandard,
  SemanticAnchor,
  SemanticRubric,
} from "../../src/evaluation/lab/calibration-contract.js";
import { EvaluationValidationError } from "../../src/evaluation/lab/errors.js";

const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "../../../");
const createdTempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeStore(runId: string): Promise<{ store: EvaluationArtifactStore; tempProjectRoot: string }> {
  const evaluatorTemp = await mkdtemp(join(tmpdir(), `t46-5-runner-${runId}-`));
  createdTempDirs.push(evaluatorTemp);
  // Use a temp project root so loadActiveRegistry does not touch the
  // real checked-in active registry.
  const tempProjectRoot = await mkdtemp(join(tmpdir(), `t46-5-project-${runId}-`));
  createdTempDirs.push(tempProjectRoot);
  const runArtifactsDir = join(tempProjectRoot, "agent-bridge", "artifacts", runId);
  createdTempDirs.push(runArtifactsDir);
  const store = new EvaluationArtifactStore(tempProjectRoot, runId, evaluatorTemp);
  return { store, tempProjectRoot };
}

function buildMockCostLedger(): CalibrationCostLedger {
  // Use versioned_price_estimate with $0 for the SUT (mock has no real cost).
  // unknown cost MUST NOT display as $0 — that would violate the artifact
  // invariants checked by verifyCalibrationArtifactInvariants.
  return {
    sut: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true },
    evaluator: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
    codingAgent: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
    sutProvenance: "versioned_price_estimate",
    evaluatorProvenance: "versioned_price_estimate",
    codingAgentProvenance: "unknown",
  };
}

function buildMockCostLedgerWithSutCost(amountUsd: number): CalibrationCostLedger {
  return {
    sut: { amountUsd, source: "versioned_price_estimate", countedAgainstSutCap: true },
    evaluator: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
    codingAgent: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
    sutProvenance: "versioned_price_estimate",
    evaluatorProvenance: "versioned_price_estimate",
    codingAgentProvenance: "unknown",
  };
}

function buildThresholds() {
  return {
    positionBias: 0.60,
    verbosityBias: 0.30,
    sameFamilyPreference: 0.65,
    disagreementRate: 0.20,
    repeatedRunFlipRate: 0.10,
    anchorOrdering: 0.05,
  };
}

function buildAnchorEvaluationInputs(
  anchors: SemanticAnchor[],
  rubric: SemanticRubric,
): AnchorEvaluationInput[] {
  return anchors.map((anchor) => ({
    anchor,
    rubric,
    judgeInput: {
      visibleFacts: anchor.visibleFacts,
      visibleProjectFlowState: { workspaceId: "ws-1", projectId: "proj-1" },
      candidateOutput: anchor.output,
      deterministicEvidence: [],
      traceReferences: [],
      candidateBlinded: false,
    },
    mockJudgeResult: {
      verdict: anchor.expectedVerdict ?? "needs_review",
      score: anchor.expectedScore ?? "fair",
      reason: `mock judge for ${anchor.anchorId}`,
      confidence: 0.8,
    },
  }));
}

function buildHealthyPairwiseInput(
  rubric: SemanticRubric,
  judgeManifest: typeof P0_MOCK_JUDGE_MANIFEST,
  candidateAId = "cand-a",
  candidateBId = "cand-b",
): PairwiseEvaluationInput {
  return {
    candidateAId,
    candidateBId,
    candidateAOutput: "candidate A output",
    candidateBOutput: "candidate B output",
    blinded: true,
    rubric,
    judgeManifest,
    mockForwardResult: {
      kind: "preference",
      preferred: "A",
      confidence: 0.8,
      reason: "mock forward prefers A",
    },
    mockReverseResult: {
      kind: "preference",
      preferred: "A",
      confidence: 0.8,
      reason: "mock reverse also prefers A",
    },
  };
}

function buildBasicInput(
  runId: string,
  tempProjectRoot: string,
  overrides?: Partial<CalibrationRunnerInput>,
): CalibrationRunnerInput {
  const rubric = P0_PLANNING_SPECIFICITY_RUBRIC;
  const anchorSet = P0_PLANNING_SPECIFICITY_ANCHOR_SET;
  return {
    runId,
    projectRoot: tempProjectRoot,
    acceptanceProposal: CALIBRATE_ACCEPTANCE_PROPOSAL,
    rubrics: [rubric],
    anchorSets: [anchorSet],
    judgeManifest: P0_MOCK_JUDGE_MANIFEST,
    anchorEvaluations: buildAnchorEvaluationInputs(anchorSet.anchors, rubric),
    pairwiseEvaluations: [
      buildHealthyPairwiseInput(rubric, P0_MOCK_JUDGE_MANIFEST),
      buildHealthyPairwiseInput(rubric, P0_MOCK_JUDGE_MANIFEST, "cand-c", "cand-d"),
    ],
    verbositySamples: [
      { outputLength: 10, scoreNumeric: 1 },
      { outputLength: 20, scoreNumeric: 2 },
      { outputLength: 30, scoreNumeric: 2 },
      { outputLength: 40, scoreNumeric: 1 },
    ],
    sameFamilySamples: [
      {
        judgeFamily: "mock",
        candidateAFamily: "mock",
        candidateBFamily: "other",
        preferred: "A",
      },
      {
        judgeFamily: "mock",
        candidateAFamily: "mock",
        candidateBFamily: "other",
        preferred: "B",
      },
    ],
    standardClaims: [],
    costLedger: buildMockCostLedger(),
    mutationResults: [],
    thresholds: buildThresholds(),
    anchorRepeats: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T46-5 calibration runner — pipeline basics", () => {
  it("runs the full pipeline and produces all required artifacts", async () => {
    const runId = "pipeline-basic";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);

    // §1 Artifact must be produced.
    expect(result.artifact).toBeDefined();
    expect(result.artifact.calibrationId).toBe(runId);
    expect(result.artifact.schemaVersion).toBe(1);

    // §2 All 17+ required fields must be present.
    expect(result.artifact.activeRegistryFingerprint).toMatch(/^[a-f0-9]+$/);
    expect(result.artifact.candidateRegistryFingerprint).toMatch(/^[a-f0-9]+$/);
    expect(result.artifact.anchorVersions).toHaveLength(1);
    expect(result.artifact.rubricVersions).toHaveLength(1);
    expect(result.artifact.judgeVersions).toHaveLength(1);
    expect(result.artifact.repeatedAnchorResults).toHaveLength(3);
    expect(result.artifact.biasMetrics).toBeDefined();
    expect(result.artifact.disagreementSummary).toBeDefined();
    expect(result.artifact.mutationResults).toEqual([]);
    expect(result.artifact.standardConflicts).toEqual([]);
    expect(result.artifact.costLedger).toBeDefined();
    expect(result.artifact.candidateStandards).toHaveLength(1);
    expect(result.artifact.standardDiffs).toHaveLength(1);
    expect(result.artifact.promotionEligibility).toBeDefined();
    expect(result.artifact.failureReasons).toBeDefined();
    expect(result.artifact.integritySha256).toMatch(/^[a-f0-9]+$/);
    expect(result.artifact.exitGateEvidence).toBeDefined();
    expect(result.artifact.passed).toBe(true);
    expect(result.artifact.promotionEligibility.anyEligible).toBe(true);

    // §3 Published paths must be returned.
    expect(result.published.calibrationArtifactPath).toBe("calibration-artifact.json");
    expect(result.published.calibrationArtifactSha256).toMatch(/^[a-f0-9]+$/);
    expect(result.published.candidateRegistryPath).toBe("candidate-registry.json");
    expect(result.published.standardConflictsPath).toBe("standard-conflicts.json");
    expect(result.published.standardDiffPaths).toHaveLength(1);
  });

  it("all candidate standards start with status=candidate (no auto-promotion)", async () => {
    const runId = "no-auto-promote";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);

    for (const candidate of result.candidateStandards) {
      expect(candidate.status).toBe("candidate");
      expect(candidate.approvalRecord).toBeUndefined();
    }
    for (const candidate of result.artifact.candidateStandards) {
      expect(candidate.status).toBe("candidate");
    }
  });

  it("artifact invariants are satisfied", async () => {
    const runId = "invariants";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);
    const violations = verifyCalibrationArtifactInvariants(result.artifact);
    expect(violations).toEqual([]);
  });

  it("flags evaluator cost provenance=unknown with amountUsd=0 (symmetric with SUT)", async () => {
    // Regression test: verifyCalibrationArtifactInvariants previously
    // only checked SUT cost (unknown + $0), not evaluator cost. Now
    // both are checked symmetrically. codingAgent cost is exempt
    // (always "unknown" by design).
    const runId = "evaluator-cost-invariant";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      costLedger: {
        sut: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true },
        evaluator: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
        codingAgent: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
        sutProvenance: "versioned_price_estimate",
        evaluatorProvenance: "unknown",
        codingAgentProvenance: "unknown",
      },
    });
    const result = await runCalibrationPipeline(store, input);
    const violations = verifyCalibrationArtifactInvariants(result.artifact);
    expect(violations.some((v) => v.includes("evaluator cost provenance=unknown"))).toBe(true);
  });

  it("active registry fingerprint is byte-identical before and after", async () => {
    const runId = "immutable-active";
    const { store, tempProjectRoot } = await makeStore(runId);
    const beforeActive = await loadActiveRegistry(tempProjectRoot);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);
    const afterActive = await loadActiveRegistry(tempProjectRoot);
    expect(beforeActive.fingerprint).toBe(afterActive.fingerprint);
    expect(result.artifact.activeRegistryFingerprint).toBe(beforeActive.fingerprint);
  });

  it("published artifacts can be read back from disk", async () => {
    const runId = "readback";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);

    const artifactPath = join(tempProjectRoot, "agent-bridge", "artifacts", runId, "calibration-artifact.json");
    const artifactJson = await readFile(artifactPath, "utf-8");
    const artifact = JSON.parse(artifactJson);
    expect(artifact.calibrationId).toBe(runId);
    expect(artifact.integritySha256).toBe(result.artifact.integritySha256);

    const candidateRegPath = join(tempProjectRoot, "agent-bridge", "artifacts", runId, "candidate-registry.json");
    const regJson = await readFile(candidateRegPath, "utf-8");
    const reg = JSON.parse(regJson);
    expect(reg.registry).toBe("candidate");
    expect(reg.entries).toHaveLength(1);

    const conflictsPath = join(tempProjectRoot, "agent-bridge", "artifacts", runId, "standard-conflicts.json");
    const conflictsJson = await readFile(conflictsPath, "utf-8");
    const conflicts = JSON.parse(conflictsJson);
    expect(conflicts).toEqual([]);

    const diffPath = join(
      tempProjectRoot,
      "agent-bridge",
      "artifacts",
      runId,
      "standard-diffs",
      `${result.standardDiffs[0]!.diffId}.json`,
    );
    const diffJson = await readFile(diffPath, "utf-8");
    const diff = JSON.parse(diffJson);
    expect(diff.candidateId).toBe(result.standardDiffs[0]!.candidateId);
  });
});

describe("T46-5 calibration runner — fail-safe", () => {
  it("degrades to needs_review when no independent Judge is available", async () => {
    const runId = "fail-safe-no-judge";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      failSafeOverrides: { independentJudgeAvailable: false },
    });
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.exitGateEvidence.failSafeVerified).toBe(true);
    expect(result.artifact.failureReasons.some((r) => r.includes("no_independent_judge"))).toBe(true);
    expect(result.artifact.exitGateEvidence.passed).toBe(false);
  });

  it("degrades to needs_review when only same-family uncalibrated Judge is available", async () => {
    const runId = "fail-safe-same-family";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      failSafeOverrides: { onlySameFamilyUncalibrated: true },
    });
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.failureReasons.some((r) => r.includes("only_same_family_uncalibrated"))).toBe(true);
    expect(result.artifact.promotionEligibility.anyEligible).toBe(false);
    expect(result.artifact.promotionEligibility.perCandidate[0]?.eligible).toBe(false);
    expect(result.artifact.exitGateEvidence.noSilentSameFamilyPromotion).toBe(false);
  });

  it("degrades when Judges conflict", async () => {
    const runId = "fail-safe-judges-conflict";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      failSafeOverrides: { judgesConflict: true },
    });
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.failureReasons.some((r) => r.includes("judges_conflict"))).toBe(true);
  });

  it("degrades when bias metrics exceed thresholds", async () => {
    const runId = "fail-safe-bias-exceeded";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      // Set anchorOrderingUnstable=false to isolate the bias metric case.
      // Otherwise anchor_ordering_unstable would trigger first.
      failSafeOverrides: { biasMetricsExceeded: true, anchorOrderingUnstable: false },
    });
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.failureReasons.some((r) => r.includes("bias_metrics_exceeded"))).toBe(true);
  });

  it("fails the exit gate when fail-safe triggers", async () => {
    const runId = "fail-safe-exit-gate";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      failSafeOverrides: { calibrationEvidenceInsufficient: true },
    });
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.exitGateEvidence.passed).toBe(false);
    expect(result.artifact.exitGateEvidence.failSafeVerified).toBe(true);
  });

  it("degrades anchor verdicts to needs_review in artifact when fail-safe triggers", async () => {
    // Regression test: previously runAnchorEvaluation hardcoded all
    // fail-safe parameters to "safe" values, so anchor verdicts in the
    // artifact were never degraded even when the pipeline-level fail-safe
    // triggered. Now the pipeline degrades all anchor verdicts to
    // needs_review in the artifact when any fail-safe condition triggers.
    const runId = "fail-safe-anchor-degrade";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      failSafeOverrides: { biasMetricsExceeded: true, anchorOrderingUnstable: false },
    });
    const result = await runCalibrationPipeline(store, input);
    // Artifact's repeatedAnchorResults must all be needs_review.
    for (const repeat of result.artifact.repeatedAnchorResults) {
      for (const v of repeat.verdicts) {
        expect(v).toBe("needs_review");
      }
      expect(repeat.stability).toBe(0);
      expect(repeat.orderingPreserved).toBe(false);
    }
    // CalibrationRunnerResult.anchorResults must also be degraded.
    for (const results of result.anchorResults) {
      for (const r of results) {
        expect(r.verdict).toBe("needs_review");
        expect(r.confidence).toBe(0);
      }
    }
  });
});

describe("T46-5 calibration runner — standard conflicts", () => {
  it("records conflicts and blocks promotion eligibility", async () => {
    const runId = "with-conflicts";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      standardClaims: [
        {
          aspectKey: "task-status-values",
          value: "not_started/in_progress/done/blocked/cancelled",
          claim: "PRD 声明任务状态集合为 5 个",
          source: {
            type: "canonical_doc",
            version: "PRD-ProjectFlow-MVP.md@v1",
            hash: "abc123",
          },
        },
        {
          aspectKey: "task-status-values",
          value: "pending/completed",
          claim: "当前代码使用 pending/completed 两状态",
          source: {
            type: "current_code_behavior",
            version: "commit deadbeef",
            hash: "current",
          },
          affectsCandidateId: P0_PLANNING_SPECIFICITY_RUBRIC.rubricId,
        },
      ],
    });
    const result = await runCalibrationPipeline(store, input);
    expect(result.standardConflicts.length).toBeGreaterThan(0);
    const conflict = result.standardConflicts[0]!;
    expect(conflict.resolutionStatus).toBe("unresolved");
    expect(result.artifact.exitGateEvidence.passed).toBe(false);
    // The candidate should be blocked by the conflict.
    const perCandidate = result.artifact.promotionEligibility.perCandidate[0]!;
    expect(perCandidate.eligible).toBe(false);
    expect(perCandidate.failureReasons.some((r) => r.includes("conflict"))).toBe(true);
  });
});

describe("T46-5 calibration runner — resume", () => {
  it("does NOT repeat completed pairwise Judge calls when existing records provided", async () => {
    const runId = "resume-pairwise";
    const { store, tempProjectRoot } = await makeStore(runId);
    // First run.
    const input1 = buildBasicInput(runId, tempProjectRoot);
    const result1 = await runCalibrationPipeline(store, input1);
    const firstRunPairwiseCount = result1.pairwiseRecords.length;

    // Second run with the existing pairwise records passed in.
    // We use a new runId but pass existing records to simulate resume.
    const runId2 = "resume-pairwise-2";
    const { store: store2, tempProjectRoot: tempProjectRoot2 } = await makeStore(runId2);
    const input2 = buildBasicInput(runId2, tempProjectRoot2, {
      existingPairwiseRecords: result1.pairwiseRecords,
    });
    const result2 = await runCalibrationPipeline(store2, input2);
    // Idempotent resume: the same pairwise records must NOT be recomputed
    // and appended. The count must equal the first run's count, not 2x.
    expect(result2.pairwiseRecords.length).toBe(firstRunPairwiseCount);
  });

  it("does NOT repeat completed anchor Judge calls when existing results provided", async () => {
    const runId = "resume-anchor";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input1 = buildBasicInput(runId, tempProjectRoot);
    const result1 = await runCalibrationPipeline(store, input1);
    const firstRunAnchorCount = result1.anchorResults.length;

    const runId2 = "resume-anchor-2";
    const { store: store2, tempProjectRoot: tempProjectRoot2 } = await makeStore(runId2);
    const input2 = buildBasicInput(runId2, tempProjectRoot2, {
      existingAnchorResults: result1.anchorResults,
    });
    const result2 = await runCalibrationPipeline(store2, input2);
    // Idempotent resume: the same anchors must NOT be recomputed and
    // appended. The count must equal the first run's count, not 2x.
    expect(result2.anchorResults.length).toBe(firstRunAnchorCount);
    // The verdicts must be identical (no recomputation).
    for (let i = 0; i < firstRunAnchorCount; i++) {
      expect(result2.anchorResults[i]!.map((r) => r.verdict)).toEqual(
        result1.anchorResults[i]!.map((r) => r.verdict),
      );
    }
  });

  it("determineRemainingJudgeCalls computes remaining correctly", () => {
    const result = determineRemainingJudgeCalls({
      totalAnchorEvaluations: 10,
      completedAnchorResults: 4,
      totalPairwiseEvaluations: 6,
      completedPairwiseRecords: 6,
    });
    expect(result.remainingAnchorEvaluations).toBe(6);
    expect(result.remainingPairwiseEvaluations).toBe(0);
  });

  it("determineRemainingJudgeCalls never returns negative", () => {
    const result = determineRemainingJudgeCalls({
      totalAnchorEvaluations: 3,
      completedAnchorResults: 5,
      totalPairwiseEvaluations: 2,
      completedPairwiseRecords: 4,
    });
    expect(result.remainingAnchorEvaluations).toBe(0);
    expect(result.remainingPairwiseEvaluations).toBe(0);
  });

  it("resume does NOT mutate the caller's existingAnchorResults / existingPairwiseRecords arrays", async () => {
    // Regression test for a side-effect bug where runCalibrationPipeline
    // pushed new results into the caller's array when resume inputs were
    // provided. The caller's arrays must be treated as read-only inputs.
    const runId = "resume-no-mutate";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input1 = buildBasicInput(runId, tempProjectRoot);
    const result1 = await runCalibrationPipeline(store, input1);

    const runId2 = "resume-no-mutate-2";
    const { store: store2, tempProjectRoot: tempProjectRoot2 } = await makeStore(runId2);
    const existingAnchor = [...result1.anchorResults];
    const existingPairwise = [...result1.pairwiseRecords];
    const input2 = buildBasicInput(runId2, tempProjectRoot2, {
      existingAnchorResults: existingAnchor,
      existingPairwiseRecords: existingPairwise,
    });
    await runCalibrationPipeline(store2, input2);
    // Caller's arrays must NOT have been mutated by the second run.
    expect(existingAnchor.length).toBe(result1.anchorResults.length);
    expect(existingPairwise.length).toBe(result1.pairwiseRecords.length);
  });
});

describe("T46-5 calibration runner — failSafeVerified invariant", () => {
  it("failSafeVerified is true when all candidates are in 'candidate' status (no tautology)", async () => {
    // Regression test: failSafeVerified previously contained a tautology
    // `(failSafeReason === null || failSafeReason !== null)` that was
    // always true. The simplified form depends only on candidate status.
    const runId = "failsafe-verified";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);
    // All candidates must be in "candidate" status, so failSafeVerified
    // must be true regardless of whether failSafeReason was triggered.
    expect(result.artifact.exitGateEvidence.failSafeVerified).toBe(true);
    for (const c of result.artifact.candidateStandards) {
      expect(c.status).toBe("candidate");
    }
  });
});

describe("T46-5 calibration runner — artifact invariants", () => {
  it("verifyCalibrationArtifactInvariants flags missing integritySha256", async () => {
    const runId = "invariants-missing-sha";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);
    const tampered = { ...result.artifact, integritySha256: "" };
    const violations = verifyCalibrationArtifactInvariants(tampered);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("verifyCalibrationArtifactInvariants flags unknown cost displayed as $0", async () => {
    const runId = "invariants-unknown-cost";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      costLedger: {
        sut: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
        evaluator: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
        codingAgent: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
        sutProvenance: "unknown",
        evaluatorProvenance: "unknown",
        codingAgentProvenance: "unknown",
      },
    });
    const result = await runCalibrationPipeline(store, input);
    // The runner should NOT auto-fix the cost ledger; the artifact
    // records it as-is. The invariant verifier must flag it.
    const violations = verifyCalibrationArtifactInvariants(result.artifact);
    expect(violations.some((v) => v.includes("unknown cost 不得显示为 $0"))).toBe(true);
  });

  it("verifyCalibrationArtifactInvariants flags candidate not in candidate status", async () => {
    const runId = "invariants-status";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);
    // Tamper with the artifact: promote a candidate to "approved".
    const tamperedCandidate: CandidateStandard = {
      ...result.artifact.candidateStandards[0]!,
      status: "approved",
    };
    const tampered = {
      ...result.artifact,
      candidateStandards: [tamperedCandidate],
    };
    const violations = verifyCalibrationArtifactInvariants(tampered);
    expect(violations.some((v) => v.includes("不得 auto-promote"))).toBe(true);
  });

  it("verifyCalibrationArtifactInvariants flags invalid cost provenance", async () => {
    const runId = "invariants-bad-provenance";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);
    const tampered = {
      ...result.artifact,
      costLedger: {
        ...result.artifact.costLedger,
        sutProvenance: "fabricated",
      },
    };
    const violations = verifyCalibrationArtifactInvariants(tampered);
    expect(violations.some((v) => v.includes("sutProvenance 非法"))).toBe(true);
  });
});

describe("T46-5 calibration runner — promotion approval", () => {
  it("buildPromotionApproval rejects empty approver instruction", () => {
    expect(() =>
      buildPromotionApproval({
        candidateId: "candidate-1",
        approverInstruction: "",
        diffPath: "diffs/foo.patch",
        commit: "abc123",
        beforeActiveFingerprint: "fp-before",
        afterActiveFingerprint: "fp-after",
        resolvedConflictIds: [],
      }),
    ).toThrow(EvaluationValidationError);
  });

  it("buildPromotionApproval rejects empty diff path", () => {
    expect(() =>
      buildPromotionApproval({
        candidateId: "candidate-1",
        approverInstruction: "Robert approved on 2026-07-20",
        diffPath: "",
        commit: "abc123",
        beforeActiveFingerprint: "fp-before",
        afterActiveFingerprint: "fp-after",
        resolvedConflictIds: [],
      }),
    ).toThrow(EvaluationValidationError);
  });

  it("buildPromotionApproval rejects empty commit", () => {
    expect(() =>
      buildPromotionApproval({
        candidateId: "candidate-1",
        approverInstruction: "Robert approved on 2026-07-20",
        diffPath: "diffs/foo.patch",
        commit: "",
        beforeActiveFingerprint: "fp-before",
        afterActiveFingerprint: "fp-after",
        resolvedConflictIds: [],
      }),
    ).toThrow(EvaluationValidationError);
  });

  it("buildPromotionApproval builds a valid record with all fields", () => {
    const approval = buildPromotionApproval({
      candidateId: "candidate-1",
      approverInstruction: "Robert reviewed on 2026-07-20 and approved promotion",
      diffPath: "agent-bridge/standards/active/registry.json",
      commit: "abc1234",
      beforeActiveFingerprint: "fp-before",
      afterActiveFingerprint: "fp-after",
      resolvedConflictIds: ["conflict-1"],
    });
    expect(approval.candidateId).toBe("candidate-1");
    expect(approval.approverInstruction).toContain("Robert");
    expect(approval.reviewableDiff.commit).toBe("abc1234");
    expect(approval.resolvedConflictIds).toEqual(["conflict-1"]);
    expect(approval.approvalId).toContain("candidate-1");
    expect(approval.approvalId).toContain("abc1234".slice(0, 8));
  });
});

describe("T46-5 calibration runner — bias metrics", () => {
  it("computes bias metrics from anchor and pairwise results", async () => {
    const runId = "bias-metrics";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);
    expect(result.biasMetrics).toBeDefined();
    expect(result.biasMetrics.positionBias).toBeDefined();
    expect(result.biasMetrics.verbosityBias).toBeDefined();
    expect(result.biasMetrics.sameFamilyPreference).toBeDefined();
    expect(result.biasMetrics.disagreementRate).toBeDefined();
    expect(result.biasMetrics.repeatedRunInstability).toBeDefined();
    expect(result.biasMetrics.anchorOrderingStability).toBeDefined();
    // Each metric carries its candidate threshold.
    expect(result.biasMetrics.positionBias.candidateThreshold).toBe(0.60);
    expect(result.biasMetrics.verbosityBias.candidateThreshold).toBe(0.30);
    expect(result.biasMetrics.sameFamilyPreference.candidateThreshold).toBe(0.65);
    expect(result.biasMetrics.disagreementRate.candidateThreshold).toBe(0.20);
    expect(result.biasMetrics.repeatedRunInstability.candidateThreshold).toBe(0.10);
    expect(result.biasMetrics.anchorOrderingStability.candidateThreshold).toBe(0.05);
  });
});

describe("T46-5 calibration runner — cost provenance", () => {
  it("records SUT cost with versioned_price_estimate provenance", async () => {
    const runId = "cost-provenance-versioned";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      costLedger: buildMockCostLedgerWithSutCost(0.42),
    });
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.costLedger.sut.amountUsd).toBe(0.42);
    expect(result.artifact.costLedger.sutProvenance).toBe("versioned_price_estimate");
    expect(result.artifact.costLedger.codingAgentProvenance).toBe("unknown");
  });

  it("keeps Coding Agent cost as external/unknown (not counted against SUT cap)", async () => {
    const runId = "cost-provenance-coding-agent";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.costLedger.codingAgent.amountUsd).toBe(0);
    expect(result.artifact.costLedger.codingAgentProvenance).toBe("unknown");
    expect(result.artifact.costLedger.codingAgent.countedAgainstSutCap).toBe(false);
  });
});

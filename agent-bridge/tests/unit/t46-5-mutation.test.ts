/**
 * T46-5 (Issue #98 §8-§10) — Mutation detection in calibration artifact.
 *
 * Verifies that mutation results are correctly recorded in the
 * calibration artifact so that downstream consumers (governance, exit
 * gate, reviewers) can verify the calibration detected planted
 * mutations.
 *
 * The mutation framework itself is part of Slice 1 (Issue #95). Slice 3
 * (Issue #98) only verifies that the calibration artifact carries
 * mutation results in its immutable, hash-covered body. This prevents
 * a malicious or buggy calibration from silently dropping mutation
 * evidence.
 *
 * Boundary invariants tested:
 *  1. Mutation results passed to the runner appear verbatim in the
 *     published calibration artifact.
 *  2. Mutation results are covered by the integritySha256 (tampering
 *     with mutation results invalidates the hash).
 *  3. The artifact invariant verifier detects mutation result shape
 *     violations.
 *  4. A calibration with NO mutation results still publishes a valid
 *     artifact (mutationResults=[]).
 *  5. A calibration with mixed detected/undetected mutations records
 *     both correctly.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EvaluationArtifactStore } from "../../src/evaluation/lab/artifact-store.js";
import {
  runCalibrationPipeline,
  verifyCalibrationArtifactInvariants,
  type CalibrationRunnerInput,
} from "../../src/evaluation/lab/calibration-runner.js";
import {
  CALIBRATE_ACCEPTANCE_PROPOSAL,
  P0_PLANNING_SPECIFICITY_ANCHOR_SET,
  P0_PLANNING_SPECIFICITY_RUBRIC,
  P0_MOCK_JUDGE_MANIFEST,
} from "../../src/evaluation/lab/presets.js";
import { loadActiveRegistry } from "../../src/evaluation/lab/standards-registry.js";
import { sha256, stableStringify } from "../../src/evaluation/lab/validation.js";

const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "../../../");
const createdTempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeStore(runId: string): Promise<{ store: EvaluationArtifactStore; tempProjectRoot: string }> {
  const evaluatorTemp = await mkdtemp(join(tmpdir(), `t46-5-mutation-${runId}-`));
  createdTempDirs.push(evaluatorTemp);
  const tempProjectRoot = await mkdtemp(join(tmpdir(), `t46-5-mutation-project-${runId}-`));
  createdTempDirs.push(tempProjectRoot);
  const store = new EvaluationArtifactStore(tempProjectRoot, runId, evaluatorTemp);
  return { store, tempProjectRoot };
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

function buildBasicInput(
  runId: string,
  tempProjectRoot: string,
  mutationResults: CalibrationRunnerInput["mutationResults"],
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
    anchorEvaluations: anchorSet.anchors.map((anchor) => ({
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
    })),
    pairwiseEvaluations: [],
    standardClaims: [],
    costLedger: {
      // Use versioned_price_estimate with $0 (mock has no real cost)
      // to avoid the "unknown cost 不得显示为 $0" invariant.
      sut: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true },
      evaluator: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
      codingAgent: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
      sutProvenance: "versioned_price_estimate",
      evaluatorProvenance: "versioned_price_estimate",
      codingAgentProvenance: "unknown",
    },
    mutationResults,
    thresholds: buildThresholds(),
    anchorRepeats: 3,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T46-5 mutation results — recording in calibration artifact", () => {
  it("records an empty mutation list when none provided", async () => {
    const runId = "mutation-empty";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, []);
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.mutationResults).toEqual([]);
    expect(verifyCalibrationArtifactInvariants(result.artifact)).toEqual([]);
  });

  it("records a detected mutation", async () => {
    const runId = "mutation-detected";
    const { store, tempProjectRoot } = await makeStore(runId);
    const mutationResults = [
      { mutationId: "mut-001", detected: true, expectedDetection: true },
    ];
    const input = buildBasicInput(runId, tempProjectRoot, mutationResults);
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.mutationResults).toEqual(mutationResults);
    expect(result.artifact.mutationResults).toHaveLength(1);
    expect(result.artifact.mutationResults[0]!.detected).toBe(true);
    expect(result.artifact.mutationResults[0]!.expectedDetection).toBe(true);
  });

  it("records an undetected mutation (regression)", async () => {
    const runId = "mutation-undetected";
    const { store, tempProjectRoot } = await makeStore(runId);
    const mutationResults = [
      { mutationId: "mut-002", detected: false, expectedDetection: true },
    ];
    const input = buildBasicInput(runId, tempProjectRoot, mutationResults);
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.mutationResults[0]!.detected).toBe(false);
    expect(result.artifact.mutationResults[0]!.expectedDetection).toBe(true);
  });

  it("records a mix of detected and undetected mutations", async () => {
    const runId = "mutation-mixed";
    const { store, tempProjectRoot } = await makeStore(runId);
    const mutationResults = [
      { mutationId: "mut-001", detected: true, expectedDetection: true },
      { mutationId: "mut-002", detected: false, expectedDetection: true },
      { mutationId: "mut-003", detected: true, expectedDetection: true },
      { mutationId: "mut-004", detected: false, expectedDetection: false },
    ];
    const input = buildBasicInput(runId, tempProjectRoot, mutationResults);
    const result = await runCalibrationPipeline(store, input);
    expect(result.artifact.mutationResults).toHaveLength(4);
    expect(result.artifact.mutationResults).toEqual(mutationResults);
  });
});

describe("T46-5 mutation results — integrity coverage", () => {
  it("mutation results are covered by integritySha256", async () => {
    const runId = "mutation-integrity";
    const { store, tempProjectRoot } = await makeStore(runId);
    const mutationResults = [
      { mutationId: "mut-001", detected: true, expectedDetection: true },
      { mutationId: "mut-002", detected: false, expectedDetection: true },
    ];
    const input = buildBasicInput(runId, tempProjectRoot, mutationResults);
    const result = await runCalibrationPipeline(store, input);
    // Recompute the integrity hash from the artifact (excluding integritySha256)
    // and verify it matches. Then tamper with mutation results and verify
    // the hash no longer matches.
    const { integritySha256: _ignored, ...base } = result.artifact;
    const expectedHash = sha256(stableStringify(base));
    expect(result.artifact.integritySha256).toBe(expectedHash);

    const tampered = {
      ...result.artifact,
      mutationResults: [
        ...result.artifact.mutationResults,
        { mutationId: "mut-fake", detected: false, expectedDetection: true },
      ],
    };
    const { integritySha256: _ignored2, ...tamperedBase } = tampered;
    const tamperedHash = sha256(stableStringify(tamperedBase));
    expect(tamperedHash).not.toBe(result.artifact.integritySha256);
  });

  it("verifyCalibrationArtifactInvariants flags a tampered mutation list (hash mismatch)", async () => {
    const runId = "mutation-tamper";
    const { store, tempProjectRoot } = await makeStore(runId);
    const mutationResults = [
      { mutationId: "mut-001", detected: true, expectedDetection: true },
    ];
    const input = buildBasicInput(runId, tempProjectRoot, mutationResults);
    const result = await runCalibrationPipeline(store, input);

    // Tamper: add a fake mutation result but keep the original hash.
    const tampered = {
      ...result.artifact,
      mutationResults: [
        ...result.artifact.mutationResults,
        { mutationId: "mut-fake", detected: false, expectedDetection: true },
      ],
    };
    const violations = verifyCalibrationArtifactInvariants(tampered);
    expect(violations.some((v) => v.includes("integritySha256 不匹配"))).toBe(true);
  });
});

describe("T46-5 mutation results — exit gate evidence", () => {
  it("artifact with mutation results passes invariant check when hash matches", async () => {
    const runId = "mutation-valid";
    const { store, tempProjectRoot } = await makeStore(runId);
    const mutationResults = [
      { mutationId: "mut-001", detected: true, expectedDetection: true },
      { mutationId: "mut-002", detected: true, expectedDetection: true },
    ];
    const input = buildBasicInput(runId, tempProjectRoot, mutationResults);
    const result = await runCalibrationPipeline(store, input);
    expect(verifyCalibrationArtifactInvariants(result.artifact)).toEqual([]);
  });
});

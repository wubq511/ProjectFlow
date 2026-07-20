/**
 * T46-5 (Issue #98 §9-§10) — Promotion governance and hard gate
 * precedence tests.
 *
 * Verifies the central governance invariants of Slice 3:
 *  1. Promotion requires an explicit Robert instruction. No Agent,
 *     Judge or ordinary command can auto-promote.
 *  2. Semantic evidence CANNOT override ProjectFlow deterministic hard
 *     gates (state/authority/privacy/Proposal-Confirm/terminal/
 *     idempotency/forbidden side effect/frozen P0).
 *  3. Failed or unapproved calibration leaves the active registry
 *     byte-identical.
 *  4. Standard conflicts block promotion until explicitly resolved.
 *  5. `applyPromotionApproval` is the ONLY function that mutates the
 *     active registry and requires an approved candidate + matching
 *     fingerprints + all conflicts resolved.
 *  6. The approval record NEVER claims cryptographic identity
 *     authentication for Robert. It is repository governance.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPromotionApproval,
  runCalibrationPipeline,
  type CalibrationRunnerInput,
} from "../../src/evaluation/lab/calibration-runner.js";
import {
  applyPromotionApproval,
  assertActiveRegistryUnchanged,
  buildCandidateRegistry,
  buildEmptyActiveRegistry,
  computeRegistryFingerprint,
  loadActiveRegistry,
  verifyRegistryInvariants,
} from "../../src/evaluation/lab/standards-registry.js";
import {
  detectStandardConflicts,
  resolveStandardConflict,
  hasUnresolvedConflict,
} from "../../src/evaluation/lab/standard-conflicts.js";
import {
  combineHardGateWithSemantic,
  FROZEN_HARD_GATES,
  decideJudgeFailSafe,
  assertFrozenVerdict,
  assertFrozenCandidateStatus,
  assertFrozenConflictResolution,
} from "../../src/evaluation/lab/calibration-contract.js";
import {
  CALIBRATE_ACCEPTANCE_PROPOSAL,
  P0_PLANNING_SPECIFICITY_ANCHOR_SET,
  P0_PLANNING_SPECIFICITY_RUBRIC,
  P0_MOCK_JUDGE_MANIFEST,
} from "../../src/evaluation/lab/presets.js";
import { EvaluationArtifactStore } from "../../src/evaluation/lab/artifact-store.js";
import { EvaluationValidationError } from "../../src/evaluation/lab/errors.js";
import type {
  CandidateStandard,
  PromotionApprovalRecord,
  StandardEntry,
  StandardsRegistry,
} from "../../src/evaluation/lab/calibration-contract.js";

const createdTempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeTempProjectRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `t46-5-gov-${prefix}-`));
  createdTempDirs.push(dir);
  return dir;
}

async function makeStore(runId: string): Promise<{ store: EvaluationArtifactStore; tempProjectRoot: string }> {
  const evaluatorTemp = await mkdtemp(join(tmpdir(), `t46-5-gov-${runId}-`));
  createdTempDirs.push(evaluatorTemp);
  const tempProjectRoot = await mkdtemp(join(tmpdir(), `t46-5-gov-project-${runId}-`));
  createdTempDirs.push(tempProjectRoot);
  const store = new EvaluationArtifactStore(tempProjectRoot, runId, evaluatorTemp);
  return { store, tempProjectRoot };
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
    // Mock calibration uses versioned_price_estimate with $0 (no real cost).
    // unknown MUST NOT display as $0 — that would violate artifact invariants.
    costLedger: {
      sut: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true },
      evaluator: { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: false },
      codingAgent: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
      sutProvenance: "versioned_price_estimate",
      evaluatorProvenance: "versioned_price_estimate",
      codingAgentProvenance: "unknown",
    },
    mutationResults: [],
    thresholds: {
      positionBias: 0.60,
      verbosityBias: 0.30,
      sameFamilyPreference: 0.65,
      disagreementRate: 0.20,
      repeatedRunFlipRate: 0.10,
      anchorOrdering: 0.05,
    },
    anchorRepeats: 3,
    ...overrides,
  };
}

function buildSampleEntry(id: string, version: number, registry: "active" | "candidate"): StandardEntry {
  return {
    id,
    kind: "semantic_rubric",
    version,
    fingerprint: `fp-${id}-${version}`,
    payload: {
      schemaVersion: 1,
      rubricId: id,
      criterion: "planning-specificity",
      label: "规划具体性",
      description: "test",
      scoreScale: ["poor", "fair", "good", "excellent"],
      evidenceReferences: [],
      verdict: "needs_review",
      score: "",
      reason: "",
      confidence: 0,
      judgeManifestRef: { judgeId: "mock-judge", judgeVersion: 1 },
      rubricVersion: version,
      semanticHardGateEligible: false,
    },
    source: {
      registry,
      origin: registry === "active" ? "commit-abc" : "run-1",
      path: registry === "active"
        ? "agent-bridge/standards/active/registry.json"
        : "calibrations/run-1/candidate-standards/sample.json",
    },
    createdAt: "2026-07-20T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T46-5 governance — hard gate precedence", () => {
  it("FROZEN_HARD_GATES lists exactly the 8 ProjectFlow hard gates", () => {
    expect(FROZEN_HARD_GATES).toEqual([
      "state_invariant",
      "authority",
      "privacy_visibility",
      "proposal_confirm",
      "terminal_consistency",
      "idempotency",
      "forbidden_side_effect",
      "frozen_p0_gate",
    ]);
  });

  it("hard gate failure ALWAYS produces a fail verdict regardless of semantic verdict", () => {
    for (const semantic of ["pass", "needs_review", "insufficient_evidence"] as const) {
      const result = combineHardGateWithSemantic(false, semantic);
      expect(result.finalVerdict).toBe("fail");
      expect(result.rationale).toContain("hard gate");
    }
  });

  it("hard gate pass preserves the semantic verdict (no upgrade)", () => {
    // pass stays pass
    expect(combineHardGateWithSemantic(true, "pass").finalVerdict).toBe("pass");
    // needs_review stays needs_review (never upgraded to pass)
    expect(combineHardGateWithSemantic(true, "needs_review").finalVerdict).toBe("needs_review");
    // fail stays fail (never downgraded to pass either, but that's the semantic's call)
    expect(combineHardGateWithSemantic(true, "fail").finalVerdict).toBe("fail");
  });

  it("hard gate failure wins even when semantic verdict is pass", () => {
    const result = combineHardGateWithSemantic(false, "pass");
    expect(result.finalVerdict).toBe("fail");
    expect(result.rationale).toContain("不能抵消");
  });

  it("frozen verdicts reject synonyms", () => {
    expect(() => assertFrozenVerdict("ok")).toThrow();
    expect(() => assertFrozenVerdict("uncertain")).toThrow();
    expect(() => assertFrozenVerdict("skipped")).toThrow();
    expect(() => assertFrozenVerdict("")).toThrow();
  });

  it("frozen candidate statuses reject synonyms", () => {
    expect(() => assertFrozenCandidateStatus("promoted")).toThrow();
    expect(() => assertFrozenCandidateStatus("pending")).toThrow();
    expect(() => assertFrozenCandidateStatus("active")).toThrow();
  });

  it("frozen conflict resolutions reject synonyms", () => {
    expect(() => assertFrozenConflictResolution("fixed")).toThrow();
    expect(() => assertFrozenConflictResolution("closed")).toThrow();
    expect(() => assertFrozenConflictResolution("wontfix")).toThrow();
  });
});

describe("T46-5 governance — fail-safe degradation", () => {
  it("decideJudgeFailSafe returns null when everything is healthy", () => {
    expect(
      decideJudgeFailSafe({
        independentJudgeAvailable: true,
        judgeIdentityConfirmed: true,
        onlySameFamilyUncalibrated: false,
        judgesConflict: false,
        anchorOrderingUnstable: false,
        biasMetricsExceeded: false,
        judgeTelemetryIncomplete: false,
        judgeSchemaUnrepairable: false,
        calibrationEvidenceInsufficient: false,
      }),
    ).toBeNull();
  });

  it("decideJudgeFailSafe returns the FIRST triggered reason (priority order)", () => {
    // Trigger multiple fail-safe conditions; the first one in the
    // priority order must win.
    expect(
      decideJudgeFailSafe({
        independentJudgeAvailable: false,
        judgeIdentityConfirmed: false,
        onlySameFamilyUncalibrated: true,
        judgesConflict: true,
        anchorOrderingUnstable: true,
        biasMetricsExceeded: true,
        judgeTelemetryIncomplete: true,
        judgeSchemaUnrepairable: true,
        calibrationEvidenceInsufficient: true,
      }),
    ).toBe("no_independent_judge");
  });

  it("decideJudgeFailSafe returns judges_conflict only when earlier conditions are healthy", () => {
    expect(
      decideJudgeFailSafe({
        independentJudgeAvailable: true,
        judgeIdentityConfirmed: true,
        onlySameFamilyUncalibrated: false,
        judgesConflict: true,
        anchorOrderingUnstable: false,
        biasMetricsExceeded: false,
        judgeTelemetryIncomplete: false,
        judgeSchemaUnrepairable: false,
        calibrationEvidenceInsufficient: false,
      }),
    ).toBe("judges_conflict");
  });

  it("decideJudgeFailSafe returns calibration_evidence_insufficient for the lowest priority", () => {
    expect(
      decideJudgeFailSafe({
        independentJudgeAvailable: true,
        judgeIdentityConfirmed: true,
        onlySameFamilyUncalibrated: false,
        judgesConflict: false,
        anchorOrderingUnstable: false,
        biasMetricsExceeded: false,
        judgeTelemetryIncomplete: false,
        judgeSchemaUnrepairable: false,
        calibrationEvidenceInsufficient: true,
      }),
    ).toBe("calibration_evidence_insufficient");
  });
});

describe("T46-5 governance — active registry immutability", () => {
  it("calibration leaves active registry byte-identical (no fail-safe, no approval)", async () => {
    const runId = "immutable-basic";
    const { store, tempProjectRoot } = await makeStore(runId);
    const beforeActive = await loadActiveRegistry(tempProjectRoot);
    const input = buildBasicInput(runId, tempProjectRoot);
    await runCalibrationPipeline(store, input);
    const afterActive = await loadActiveRegistry(tempProjectRoot);
    expect(afterActive.fingerprint).toBe(beforeActive.fingerprint);
  });

  it("failed calibration (fail-safe triggered) leaves active registry byte-identical", async () => {
    const runId = "immutable-fail-safe";
    const { store, tempProjectRoot } = await makeStore(runId);
    const beforeActive = await loadActiveRegistry(tempProjectRoot);
    const input = buildBasicInput(runId, tempProjectRoot, {
      failSafeOverrides: { independentJudgeAvailable: false },
    });
    await runCalibrationPipeline(store, input);
    const afterActive = await loadActiveRegistry(tempProjectRoot);
    expect(afterActive.fingerprint).toBe(beforeActive.fingerprint);
  });

  it("calibration with conflicts leaves active registry byte-identical", async () => {
    const runId = "immutable-conflicts";
    const { store, tempProjectRoot } = await makeStore(runId);
    const beforeActive = await loadActiveRegistry(tempProjectRoot);
    const input = buildBasicInput(runId, tempProjectRoot, {
      standardClaims: [
        {
          aspectKey: "task-status",
          value: "five-status",
          claim: "PRD says 5 statuses",
          source: { type: "canonical_doc", version: "v1", hash: "h1" },
        },
        {
          aspectKey: "task-status",
          value: "two-status",
          claim: "Code uses 2 statuses",
          source: { type: "current_code_behavior", version: "commit-x", hash: "current" },
          affectsCandidateId: P0_PLANNING_SPECIFICITY_RUBRIC.rubricId,
        },
      ],
    });
    await runCalibrationPipeline(store, input);
    const afterActive = await loadActiveRegistry(tempProjectRoot);
    expect(afterActive.fingerprint).toBe(beforeActive.fingerprint);
  });

  it("assertActiveRegistryUnchanged throws when fingerprint changes", () => {
    const before = buildEmptyActiveRegistry();
    const after: StandardsRegistry = {
      ...before,
      entries: [buildSampleEntry("new-entry", 1, "active")],
    };
    after.fingerprint = computeRegistryFingerprint(after);
    expect(() => assertActiveRegistryUnchanged(before, after)).toThrow(EvaluationValidationError);
  });
});

describe("T46-5 governance — applyPromotionApproval is the ONLY active mutation path", () => {
  it("rejects a candidate that is not approved", () => {
    const active = buildEmptyActiveRegistry();
    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: buildSampleEntry("rubric-1", 1, "candidate"),
      status: "candidate", // NOT approved
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00Z",
    };
    const approval: PromotionApprovalRecord = {
      schemaVersion: 1,
      approvalId: "approval-1",
      candidateId: "candidate-1",
      approvedAt: "2026-07-20T00:00:00Z",
      approverInstruction: "Robert approved",
      reviewableDiff: { diffPath: "diffs/x.patch", commit: "abc" },
      beforeActiveFingerprint: active.fingerprint,
      afterActiveFingerprint: "fp-after",
      resolvedConflictIds: [],
    };
    expect(() =>
      applyPromotionApproval(active, candidate, approval, []),
    ).toThrow(EvaluationValidationError);
  });

  it("rejects when approval record references a different candidate", () => {
    const active = buildEmptyActiveRegistry();
    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: buildSampleEntry("rubric-1", 1, "candidate"),
      status: "approved",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00Z",
    };
    const approval: PromotionApprovalRecord = {
      schemaVersion: 1,
      approvalId: "approval-1",
      candidateId: "candidate-OTHER",
      approvedAt: "2026-07-20T00:00:00Z",
      approverInstruction: "Robert approved",
      reviewableDiff: { diffPath: "diffs/x.patch", commit: "abc" },
      beforeActiveFingerprint: active.fingerprint,
      afterActiveFingerprint: "fp-after",
      resolvedConflictIds: [],
    };
    expect(() =>
      applyPromotionApproval(active, candidate, approval, []),
    ).toThrow(EvaluationValidationError);
  });

  it("rejects when there are unresolved conflicts", () => {
    const active = buildEmptyActiveRegistry();
    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: buildSampleEntry("rubric-1", 1, "candidate"),
      status: "approved",
      producedByRunId: "run-1",
      affectedByConflicts: ["conflict-1"],
      createdAt: "2026-07-20T00:00:00Z",
    };
    const approval: PromotionApprovalRecord = {
      schemaVersion: 1,
      approvalId: "approval-1",
      candidateId: "candidate-1",
      approvedAt: "2026-07-20T00:00:00Z",
      approverInstruction: "Robert approved",
      reviewableDiff: { diffPath: "diffs/x.patch", commit: "abc" },
      beforeActiveFingerprint: active.fingerprint,
      afterActiveFingerprint: "fp-after",
      resolvedConflictIds: [], // empty — conflict not resolved
    };
    expect(() =>
      applyPromotionApproval(active, candidate, approval, []),
    ).toThrow(EvaluationValidationError);
  });

  it("rejects when beforeActiveFingerprint does not match current active", () => {
    const active = buildEmptyActiveRegistry();
    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: buildSampleEntry("rubric-1", 1, "candidate"),
      status: "approved",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00Z",
    };
    const approval: PromotionApprovalRecord = {
      schemaVersion: 1,
      approvalId: "approval-1",
      candidateId: "candidate-1",
      approvedAt: "2026-07-20T00:00:00Z",
      approverInstruction: "Robert approved",
      reviewableDiff: { diffPath: "diffs/x.patch", commit: "abc" },
      beforeActiveFingerprint: "fp-WRONG",
      afterActiveFingerprint: "fp-after",
      resolvedConflictIds: [],
    };
    expect(() =>
      applyPromotionApproval(active, candidate, approval, []),
    ).toThrow(EvaluationValidationError);
  });

  it("rejects when afterActiveFingerprint does not match the computed new fingerprint", () => {
    const active = buildEmptyActiveRegistry();
    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: buildSampleEntry("rubric-1", 1, "candidate"),
      status: "approved",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00Z",
    };
    const approval: PromotionApprovalRecord = {
      schemaVersion: 1,
      approvalId: "approval-1",
      candidateId: "candidate-1",
      approvedAt: "2026-07-20T00:00:00Z",
      approverInstruction: "Robert approved",
      reviewableDiff: { diffPath: "diffs/x.patch", commit: "abc" },
      beforeActiveFingerprint: active.fingerprint,
      afterActiveFingerprint: "fp-WRONG",
      resolvedConflictIds: [],
    };
    expect(() =>
      applyPromotionApproval(active, candidate, approval, []),
    ).toThrow(EvaluationValidationError);
  });

  it("computes the new active registry when all conditions are met (addition)", () => {
    const active = buildEmptyActiveRegistry();
    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: buildSampleEntry("rubric-1", 1, "candidate"),
      status: "approved",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00Z",
    };
    // Compute what the new active should be so we can build a matching
    // approval record. Use a FIXED timestamp passed to applyPromotionApproval
    // to avoid flakiness from `new Date().toISOString()` being called at
    // different milliseconds in the test and the function.
    const fixedNow = "2026-07-20T00:00:00.000Z";
    const expectedNewEntries = [
      { ...candidate.entry, source: { registry: "active" as const, origin: "abc", path: "diffs/x.patch" } },
    ];
    const expectedBase = {
      schemaVersion: active.schemaVersion,
      registry: "active" as const,
      registryId: active.registryId,
      entries: expectedNewEntries,
      updatedAt: fixedNow,
    };
    const expectedFingerprint = computeRegistryFingerprint(expectedBase);

    const approval: PromotionApprovalRecord = {
      schemaVersion: 1,
      approvalId: "approval-1",
      candidateId: "candidate-1",
      approvedAt: "2026-07-20T00:00:00Z",
      approverInstruction: "Robert approved",
      reviewableDiff: { diffPath: "diffs/x.patch", commit: "abc" },
      beforeActiveFingerprint: active.fingerprint,
      afterActiveFingerprint: expectedFingerprint,
      resolvedConflictIds: [],
    };
    const { newActive, diffSummary } = applyPromotionApproval(active, candidate, approval, [], fixedNow);
    expect(newActive.fingerprint).toBe(expectedFingerprint);
    expect(newActive.entries).toHaveLength(1);
    expect(newActive.entries[0]!.source.registry).toBe("active");
    expect(diffSummary.additions).toBe(1);
    expect(diffSummary.modifications).toBe(0);
  });

  it("computes the new active registry when entry already exists (modification)", () => {
    // Active already has rubric-1 v1; candidate proposes rubric-1 v2.
    const oldEntry = buildSampleEntry("rubric-1", 1, "active");
    const activeBase = {
      schemaVersion: 1,
      registry: "active" as const,
      registryId: "projectflow-active-v1",
      entries: [oldEntry],
      updatedAt: "2026-07-20T00:00:00Z",
    };
    const active: StandardsRegistry = {
      ...activeBase,
      fingerprint: computeRegistryFingerprint(activeBase),
    };

    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: buildSampleEntry("rubric-1", 2, "candidate"),
      status: "approved",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00Z",
    };

    const expectedNewEntries = [
      { ...candidate.entry, source: { registry: "active" as const, origin: "abc", path: "diffs/x.patch" } },
    ];
    const fixedNow = "2026-07-20T00:00:00.000Z";
    const expectedBase = {
      schemaVersion: active.schemaVersion,
      registry: "active" as const,
      registryId: active.registryId,
      entries: expectedNewEntries,
      updatedAt: fixedNow,
    };
    const expectedFingerprint = computeRegistryFingerprint(expectedBase);

    const approval: PromotionApprovalRecord = {
      schemaVersion: 1,
      approvalId: "approval-1",
      candidateId: "candidate-1",
      approvedAt: "2026-07-20T00:00:00Z",
      approverInstruction: "Robert approved",
      reviewableDiff: { diffPath: "diffs/x.patch", commit: "abc" },
      beforeActiveFingerprint: active.fingerprint,
      afterActiveFingerprint: expectedFingerprint,
      resolvedConflictIds: [],
    };
    const { newActive, diffSummary } = applyPromotionApproval(active, candidate, approval, [], fixedNow);
    expect(newActive.fingerprint).toBe(expectedFingerprint);
    expect(newActive.entries).toHaveLength(1);
    expect(newActive.entries[0]!.version).toBe(2);
    expect(diffSummary.modifications).toBe(1);
    expect(diffSummary.additions).toBe(0);
  });
});

describe("T46-5 governance — standard conflicts block promotion", () => {
  it("unresolved conflict keeps hasUnresolvedConflict=true", () => {
    const conflicts = detectStandardConflicts(
      [
        {
          aspectKey: "task-status",
          value: "5-status",
          claim: "PRD says 5",
          source: { type: "canonical_doc", version: "v1", hash: "h1" },
        },
        {
          aspectKey: "task-status",
          value: "2-status",
          claim: "Code uses 2",
          source: { type: "current_code_behavior", version: "commit-x", hash: "current" },
          affectsCandidateId: "cand-1",
        },
      ],
      "2026-07-20T00:00:00Z",
    );
    expect(conflicts.length).toBeGreaterThan(0);
    expect(hasUnresolvedConflict(conflicts, "cand-1")).toBe(true);
  });

  it("resolved conflict makes hasUnresolvedConflict=false", () => {
    const conflicts = detectStandardConflicts(
      [
        {
          aspectKey: "task-status",
          value: "5-status",
          claim: "PRD says 5",
          source: { type: "canonical_doc", version: "v1", hash: "h1" },
        },
        {
          aspectKey: "task-status",
          value: "2-status",
          claim: "Code uses 2",
          source: { type: "current_code_behavior", version: "commit-x", hash: "current" },
          affectsCandidateId: "cand-1",
        },
      ],
      "2026-07-20T00:00:00Z",
    );
    const resolved = resolveStandardConflict(conflicts[0]!, "resolved", "ADR-007 已更新，PRD 为准");
    expect(hasUnresolvedConflict([resolved], "cand-1")).toBe(false);
  });

  it("deferred conflict still blocks promotion", () => {
    const conflicts = detectStandardConflicts(
      [
        {
          aspectKey: "task-status",
          value: "5-status",
          claim: "PRD says 5",
          source: { type: "canonical_doc", version: "v1", hash: "h1" },
        },
        {
          aspectKey: "task-status",
          value: "2-status",
          claim: "Code uses 2",
          source: { type: "current_code_behavior", version: "commit-x", hash: "current" },
          affectsCandidateId: "cand-1",
        },
      ],
      "2026-07-20T00:00:00Z",
    );
    const deferred = resolveStandardConflict(conflicts[0]!, "deferred", "等待下个迭代处理");
    expect(hasUnresolvedConflict([deferred], "cand-1")).toBe(true);
  });
});

describe("T46-5 governance — promotion approval record", () => {
  it("buildPromotionApproval rejects empty approver instruction", () => {
    expect(() =>
      buildPromotionApproval({
        candidateId: "candidate-1",
        approverInstruction: "   ",
        diffPath: "diffs/x.patch",
        commit: "abc123",
        beforeActiveFingerprint: "fp-before",
        afterActiveFingerprint: "fp-after",
        resolvedConflictIds: [],
      }),
    ).toThrow(EvaluationValidationError);
  });

  it("buildPromotionApproval records approver instruction verbatim (no crypto identity claim)", () => {
    const instruction = "Robert reviewed calibration artifact on 2026-07-20 and approved promotion to active";
    const approval = buildPromotionApproval({
      candidateId: "candidate-1",
      approverInstruction: instruction,
      diffPath: "diffs/x.patch",
      commit: "abc123",
      beforeActiveFingerprint: "fp-before",
      afterActiveFingerprint: "fp-after",
      resolvedConflictIds: [],
    });
    expect(approval.approverInstruction).toBe(instruction);
    // No field claims cryptographic authentication.
    expect(JSON.stringify(approval)).not.toContain("cryptographic");
    expect(JSON.stringify(approval)).not.toContain("identity-authenticated");
  });

  it("buildPromotionApproval records reviewable diff path and commit", () => {
    const approval = buildPromotionApproval({
      candidateId: "candidate-1",
      approverInstruction: "Robert approved",
      diffPath: "agent-bridge/standards/active/registry.json.diff",
      commit: "abc123def456",
      beforeActiveFingerprint: "fp-before",
      afterActiveFingerprint: "fp-after",
      resolvedConflictIds: ["conflict-1", "conflict-2"],
    });
    expect(approval.reviewableDiff.diffPath).toBe("agent-bridge/standards/active/registry.json.diff");
    expect(approval.reviewableDiff.commit).toBe("abc123def456");
    expect(approval.resolvedConflictIds).toEqual(["conflict-1", "conflict-2"]);
  });
});

describe("T46-5 governance — auto-promotion forbidden", () => {
  it("calibration NEVER promotes a candidate automatically", async () => {
    const runId = "no-auto-promote";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot);
    const result = await runCalibrationPipeline(store, input);
    // All candidates must remain in "candidate" status.
    for (const c of result.candidateStandards) {
      expect(c.status).toBe("candidate");
      expect(c.approvalRecord).toBeUndefined();
    }
    // Promotion eligibility must NOT have anyEligible=true unless all
    // conditions are met (no conflicts, no fail-safe). In this basic
    // case there are no conflicts and no fail-safe, so the candidate
    // is *eligible* but still NOT auto-promoted.
    for (const c of result.artifact.candidateStandards) {
      expect(c.status).toBe("candidate");
    }
  });

  it("calibration with fail-safe does NOT promote", async () => {
    const runId = "no-auto-promote-fail-safe";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      failSafeOverrides: { independentJudgeAvailable: false },
    });
    const result = await runCalibrationPipeline(store, input);
    for (const c of result.candidateStandards) {
      expect(c.status).toBe("candidate");
    }
  });

  it("calibration with conflicts does NOT promote", async () => {
    const runId = "no-auto-promote-conflict";
    const { store, tempProjectRoot } = await makeStore(runId);
    const input = buildBasicInput(runId, tempProjectRoot, {
      standardClaims: [
        {
          aspectKey: "task-status",
          value: "5-status",
          claim: "PRD says 5",
          source: { type: "canonical_doc", version: "v1", hash: "h1" },
        },
        {
          aspectKey: "task-status",
          value: "2-status",
          claim: "Code uses 2",
          source: { type: "current_code_behavior", version: "commit-x", hash: "current" },
          affectsCandidateId: P0_PLANNING_SPECIFICITY_RUBRIC.rubricId,
        },
      ],
    });
    const result = await runCalibrationPipeline(store, input);
    for (const c of result.candidateStandards) {
      expect(c.status).toBe("candidate");
    }
    // Promotion eligibility must be false due to conflicts.
    expect(result.artifact.promotionEligibility.anyEligible).toBe(false);
  });
});

describe("T46-5 governance — registry invariants", () => {
  it("buildEmptyActiveRegistry produces a valid active registry", () => {
    const registry = buildEmptyActiveRegistry();
    expect(verifyRegistryInvariants(registry)).toEqual([]);
  });

  it("buildCandidateRegistry produces a valid candidate registry", () => {
    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: buildSampleEntry("rubric-1", 1, "candidate"),
      status: "candidate",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00Z",
    };
    const registry = buildCandidateRegistry([candidate], "run-1");
    expect(registry.registry).toBe("candidate");
    expect(registry.registryId).toBe("projectflow-candidate-run-1");
    expect(verifyRegistryInvariants(registry)).toEqual([]);
  });

  it("verifyRegistryInvariants detects duplicate (id, version)", () => {
    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: buildSampleEntry("rubric-1", 1, "candidate"),
      status: "candidate",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00Z",
    };
    const registry = buildCandidateRegistry([candidate, candidate], "run-1");
    const violations = verifyRegistryInvariants(registry);
    expect(violations.some((v) => v.includes("重复 entry"))).toBe(true);
  });

  it("verifyRegistryInvariants detects source.registry mismatch", () => {
    const candidate: CandidateStandard = {
      candidateId: "candidate-1",
      entry: {
        ...buildSampleEntry("rubric-1", 1, "candidate"),
        source: {
          registry: "active", // Wrong! Should be "candidate"
          origin: "run-1",
          path: "x",
        },
      },
      status: "candidate",
      producedByRunId: "run-1",
      affectedByConflicts: [],
      createdAt: "2026-07-20T00:00:00Z",
    };
    const registry = buildCandidateRegistry([candidate], "run-1");
    // buildCandidateRegistry uses the entries as-is, so the mismatch is preserved.
    const violations = verifyRegistryInvariants(registry);
    expect(violations.some((v) => v.includes("source.registry") && v.includes("不一致"))).toBe(true);
  });

  it("verifyRegistryInvariants detects fingerprint mismatch", () => {
    const registry: StandardsRegistry = {
      schemaVersion: 1,
      registry: "active",
      registryId: "projectflow-active-v1",
      entries: [],
      updatedAt: "2026-07-20T00:00:00Z",
      fingerprint: "WRONG-FINGERPRINT",
    };
    const violations = verifyRegistryInvariants(registry);
    expect(violations.some((v) => v.includes("fingerprint 不匹配"))).toBe(true);
  });
});

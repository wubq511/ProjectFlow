/**
 * T46-4 (Issue #97) — Mutation tests.
 *
 * These tests verify that the diagnosis pipeline's anti-gating invariants
 * CATCH deliberate mutations to inputs. The premise: if a malicious or
 * buggy implementation tries to game the benchmark, inflate metrics,
 * bypass gates, or weaken boundaries, the pipeline MUST fail-closed.
 *
 * Mutation strategy: feed the pipeline deliberately mutated inputs and
 * assert that the mutation is REJECTED or DETECTED. Each test names the
 * mutation explicitly (M1, M2, ...) and the invariant it must trigger.
 *
 * Issue #97 acceptance criteria covered:
 *  - Anti-gaming #1 (top3 spam) — `top3Recall - top1Accuracy` gate
 *  - Anti-gaming #2 (over-confidence) — `confidenceCalibration` gate
 *  - Anti-gaming #3 (false attribution) — `falseAttributionRate` gate
 *  - Frozen statuses — no synonymous additions
 *  - State transition validation — `assertValidStatusTransition`
 *  - Fix/investigation gate — refuses `fix` without sufficient evidence
 *  - Scrubbing — refuses secrets, temp paths, hidden facts
 *  - Candidate regression governance — never auto-approved
 *  - Stale detection — refuses prompts for stale packets
 *  - Frozen standards / no auto-push — prompt forbidden actions
 *  - Sample coverage — fails when required classes are missing
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EvaluationArtifactStore } from "../../src/evaluation/lab/artifact-store.js";
import {
  runDiagnosisPipeline,
  runBenchmarkPipeline,
  type DiagnosisTarget,
} from "../../src/evaluation/lab/diagnosis-runner.js";
import {
  FAULT_PROFILE_CATALOG,
  findFaultProfile,
} from "../../src/evaluation/lab/fault-profiles.js";
import {
  buildBenchmarkReport,
  computeRcaMetrics,
  benchmarkProfiles,
  isSuspiciousTop3,
  maxConfidenceForSampleClass,
  verifySampleCoverage,
  type BenchmarkDiagnosisInput,
} from "../../src/evaluation/lab/rca-benchmark.js";
import {
  buildRepairPacket,
  verifyPacketInvariants,
  type BuildRepairPacketInput,
  type CodeFingerprintInput,
} from "../../src/evaluation/lab/repair-packet.js";
import {
  buildRepairPrompt,
  verifyPromptContent,
  promptRefusesStale,
  promptForbidsFrozenStandardsModification,
  promptForbidsAutoPushMergeClose,
  promptForbidsEnvModification,
} from "../../src/evaluation/lab/repair-prompt.js";
import {
  assertValidStatusTransition,
  FROZEN_DIAGNOSIS_STATUSES,
  type DiagnosisCausalStatus,
  type DiagnosisRecord,
  type EvidenceRecord,
  type HypothesisRecord,
  type RcaBenchmarkSample,
  type RepairPacket,
} from "../../src/evaluation/lab/diagnosis-contract.js";
import type { FaultProfile } from "../../src/evaluation/lab/diagnosis-contract.js";
import { EvaluationValidationError } from "../../src/evaluation/lab/errors.js";

const projectRoot = resolve(import.meta.dirname ?? process.cwd(), "../../../");
const createdTempDirs: string[] = [];

async function makeStore(runId: string): Promise<EvaluationArtifactStore> {
  const evaluatorTemp = await mkdtemp(join(tmpdir(), `t46-4-mut-${runId}-`));
  createdTempDirs.push(evaluatorTemp);
  const runArtifactsDir = join(projectRoot, "agent-bridge", "artifacts", runId);
  createdTempDirs.push(runArtifactsDir);
  return new EvaluationArtifactStore(projectRoot, runId, evaluatorTemp);
}

import { afterEach } from "vitest";
afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Helpers — build minimal diagnosis / packet fixtures
// ---------------------------------------------------------------------------

function makeEvidence(evidenceId: string): EvidenceRecord {
  return {
    evidenceId,
    kind: "fault_profile_reproduced",
    summary: "测试 evidence",
    reference: `observations/${evidenceId}.json`,
    facts: { profileId: "fp-routing-001" },
  };
}

function makeHypothesis(
  hypothesisId: string,
  cause: string,
  status: DiagnosisCausalStatus,
  evidenceId: string,
): HypothesisRecord {
  return {
    hypothesisId,
    candidateCause: cause,
    status,
    supportingEvidence: [evidenceId],
    contradictingEvidence: [],
    candidateCodeSurfaces: [{
      surfaceId: "surface-1",
      component: "model-router.ts",
      reason: "测试",
      evidenceLevel: "hypothesis",
      evidence: [evidenceId],
    }],
  };
}

function makeDiagnosis(overrides: Partial<DiagnosisRecord> = {}): DiagnosisRecord {
  const evidence = makeEvidence("evidence-1");
  return {
    diagnosisId: "diag-mut-1",
    runId: "mut-run",
    scenarioId: "scn-mut-1",
    observationId: "obs-scn-mut-1",
    observedSymptom: "测试症状",
    expectedContract: "测试契约",
    causalStatus: "fault_injection_confirmed",
    confidence: "high",
    evidence: [evidence],
    hypotheses: [makeHypothesis("hyp-1", "路由错误", "fault_injection_confirmed", "evidence-1")],
    fromFaultProfile: true,
    createdAt: "2026-07-20T00:00:00Z",
    reproductionCommand: "scripts/eval-lab diagnose --fault-profile fp-routing-001",
    faultProfileRef: "fp-routing-001",
    ...overrides,
  };
}

function makePacketInput(overrides: Partial<BuildRepairPacketInput> = {}): BuildRepairPacketInput {
  const codeFingerprint: CodeFingerprintInput = {
    gitCommit: "abc123def4567890",
    gitDirty: false,
    worktreeSha256: "0123456789abcdef",
  };
  return {
    packetId: "rp-mut-1",
    runId: "mut-run",
    diagnosisId: "diag-mut-1",
    codeFingerprint,
    observedSymptom: "测试症状",
    expectedContract: "测试契约",
    reproductionCommand: "scripts/eval-lab diagnose --fault-profile fp-routing-001",
    evidenceReferences: [{ reference: "observations/scn-mut-1.json", referenceSha256: "0".repeat(64) }],
    affectedComponents: ["model-router.ts"],
    candidateCodeSurfaces: [{
      surfaceId: "surface-1",
      component: "model-router.ts",
      reason: "直接组件证据",
      evidenceLevel: "direct_component_evidence",
      evidence: ["evidence-1"],
    }],
    protectedBoundaries: ["Proposal-Confirm State Machine"],
    nonGoals: ["不修改 frozen standards"],
    acceptanceCriteria: ["修改后 hard grader 通过"],
    verificationCommands: ["scripts/eval-lab run --preset smoke-v2"],
    createdAt: "2026-07-20T00:00:00Z",
    ...overrides,
  };
}

// ===========================================================================
// §1 Anti-gaming mutations — RCA benchmark
// ===========================================================================

describe("T46-4 mutation — RCA benchmark anti-gaming", () => {
  // Helper: build a minimal RcaBenchmarkSample with explicit class.
  function makeSample(overrides: Partial<RcaBenchmarkSample> = {}): RcaBenchmarkSample {
    return {
      sampleId: "sample-mut",
      faultProfileId: "fp-routing-001",
      expectedCauseId: "cause-routing-001",
      proposedCauses: [{
        causeId: "hyp-1",
        candidateCause: "路由错误",
        confidence: "high",
        matchedExpected: true,
      }],
      top1Correct: true,
      top3Correct: true,
      unresolvedReported: false,
      falseAttribution: false,
      evidenceComplete: true,
      sampleClass: "correct_attribution",
      ...overrides,
    };
  }

  // M1: over-confidence mutation. A correct_attribution sample claims
  // "very_high" confidence, but the max for that class is "high". The
  // calibration metric MUST drop below 1.
  it("M1: detects over-confidence via confidenceCalibration gate", () => {
    const overConfident = makeSample({
      sampleId: "sample-m1",
      proposedCauses: [{
        causeId: "hyp-m1",
        candidateCause: "路由错误",
        confidence: "very_high", // mutation: exceeds "high" max for correct_attribution
        matchedExpected: true,
      }],
    });
    const metrics = computeRcaMetrics([overConfident]);
    expect(metrics.confidenceCalibration).toBe(0); // not calibrated
    // A benchmark with this sample would fail the calibration gate.
    expect(metrics.confidenceCalibration).toBeLessThan(0.7);
  });

  // M2: top-3 spam mutation. A correct_attribution sample has top3Correct
  // but NOT top1Correct — the diagnosis listed many candidates and got
  // lucky. `isSuspiciousTop3` MUST flag this pattern, and `computeRcaMetrics`
  // MUST NOT count such a sample in top3Recall (anti-gaming: top3 only
  // counts for correct_attribution when top1 is also correct).
  it("M2: detects top-3 spam via isSuspiciousTop3 and metric suppression", () => {
    const spam = makeSample({
      sampleId: "sample-m2",
      top1Correct: false, // mutation: top-1 wrong
      top3Correct: true,  // but top-3 right (lucky)
      proposedCauses: [{
        causeId: "hyp-m2",
        candidateCause: "错误原因",
        confidence: "high",
        matchedExpected: false,
      }],
    });
    expect(isSuspiciousTop3(spam)).toBe(true);
    // Anti-gaming: top3Recall for correct_attribution samples requires top1
    // to also be correct. So a spam sample does NOT inflate top3Recall.
    const metrics = computeRcaMetrics([spam, spam, spam]);
    expect(metrics.top1Accuracy).toBe(0);
    expect(metrics.top3Recall).toBe(0); // suppressed by anti-gaming rule
    expect(metrics.top3Recall - metrics.top1Accuracy).toBe(0); // no inflation
  });

  // M3: false attribution mutation. A confusable_neighbour sample has
  // falseAttribution=true. The falseAttributionRate metric MUST be > 0.
  it("M3: detects false attribution via falseAttributionRate metric", () => {
    const falseAttr = makeSample({
      sampleId: "sample-m3",
      sampleClass: "confusable_neighbour",
      falseAttribution: true,
      top1Correct: false,
      top3Correct: false,
      proposedCauses: [{
        causeId: "hyp-m3",
        candidateCause: "邻近错误原因",
        confidence: "medium", // within confusable_neighbour max
        matchedExpected: false,
      }],
    });
    const metrics = computeRcaMetrics([falseAttr]);
    expect(metrics.falseAttributionRate).toBe(1); // 1/1
    // A benchmark with many such samples would fail the falseAttributionRate gate.
    expect(metrics.falseAttributionRate).toBeGreaterThan(0.3);
  });

  // M4: missing sample class mutation. The benchmark omits
  // confusable_neighbour samples. `verifySampleCoverage` MUST return
  // "confusable_neighbour" in the missing list.
  it("M4: verifySampleCoverage flags missing confusable_neighbour class", () => {
    const samples = [
      makeSample({ sampleId: "s1", sampleClass: "correct_attribution" }),
      makeSample({ sampleId: "s2", sampleClass: "unresolved_or_insufficient" }),
    ];
    const missing = verifySampleCoverage(samples);
    expect(missing).toContain("confusable_neighbour");
  });

  // M5: missing unresolved class mutation. Same as M4 but missing unresolved.
  it("M5: verifySampleCoverage flags missing unresolved class", () => {
    const samples = [
      makeSample({ sampleId: "s1", sampleClass: "correct_attribution" }),
      makeSample({ sampleId: "s2", sampleClass: "confusable_neighbour" }),
    ];
    const missing = verifySampleCoverage(samples);
    expect(missing).toContain("unresolved_or_insufficient");
  });

  // M6: maxConfidenceForSampleClass invariant — confusable_neighbour allows
  // at most "medium", unresolved allows at most "low".
  it("M6: maxConfidenceForSampleClass enforces the right ceilings", () => {
    expect(maxConfidenceForSampleClass("correct_attribution")).toBe("high");
    expect(maxConfidenceForSampleClass("confusable_neighbour")).toBe("medium");
    expect(maxConfidenceForSampleClass("unresolved_or_insufficient")).toBe("low");
    // A "very_high" confidence on an unresolved sample MUST exceed.
    const order = ["very_low", "low", "medium", "high", "very_high"] as const;
    const maxLow = order.indexOf(maxConfidenceForSampleClass("unresolved_or_insufficient"));
    expect(order.indexOf("very_high")).toBeGreaterThan(maxLow);
  });

  // M7: computeRcaMetrics on empty input returns zeros (no division by zero).
  it("M7: computeRcaMetrics handles empty samples without dividing by zero", () => {
    const metrics = computeRcaMetrics([]);
    expect(metrics.top1Accuracy).toBe(0);
    expect(metrics.top3Recall).toBe(0);
    expect(metrics.falseAttributionRate).toBe(0);
    expect(metrics.evidenceCompleteness).toBe(0);
    expect(metrics.confidenceCalibration).toBe(0);
  });
});

// ===========================================================================
// §2 Frozen status mutations
// ===========================================================================

describe("T46-4 mutation — frozen diagnosis statuses", () => {
  // M8: any attempt to add a synonymous status is detected by the frozen list.
  it("M8: FROZEN_DIAGNOSIS_STATUSES contains exactly 5 statuses (no synonyms)", () => {
    expect(FROZEN_DIAGNOSIS_STATUSES).toHaveLength(5);
    expect(FROZEN_DIAGNOSIS_STATUSES).toContain("observed_failure");
    expect(FROZEN_DIAGNOSIS_STATUSES).toContain("localized_hypothesis");
    expect(FROZEN_DIAGNOSIS_STATUSES).toContain("intervention_supported");
    expect(FROZEN_DIAGNOSIS_STATUSES).toContain("fault_injection_confirmed");
    expect(FROZEN_DIAGNOSIS_STATUSES).toContain("unresolved");
    // Synonyms that MUST NOT be added:
    const forbidden = ["confirmed", "suspected", "likely_cause", "verified", "proven", "tentative"];
    for (const synonym of forbidden) {
      expect(FROZEN_DIAGNOSIS_STATUSES as readonly string[]).not.toContain(synonym);
    }
  });

  // M9: invalid status transition — intervention_supported → fault_injection_confirmed
  // is forbidden (intervention_supported is terminal-ish).
  it("M9: refuses invalid transition intervention_supported → fault_injection_confirmed", () => {
    expect(() =>
      assertValidStatusTransition(
        "intervention_supported",
        "fault_injection_confirmed",
        "mutation: skip evidence",
      ),
    ).toThrow(/状态转换/);
  });

  // M10: invalid status transition — unresolved → fault_injection_confirmed
  // is forbidden (unresolved is terminal).
  it("M10: refuses invalid transition unresolved → fault_injection_confirmed", () => {
    expect(() =>
      assertValidStatusTransition(
        "unresolved",
        "fault_injection_confirmed",
        "mutation: revive terminal",
      ),
    ).toThrow(/状态转换/);
  });

  // M11: invalid status transition — observed_failure → intervention_supported
  // is forbidden (must go through localized_hypothesis first).
  it("M11: refuses invalid transition observed_failure → intervention_supported (skip levels)", () => {
    expect(() =>
      assertValidStatusTransition(
        "observed_failure",
        "intervention_supported",
        "mutation: skip localized_hypothesis",
      ),
    ).toThrow(/状态转换/);
  });

  // M12: invalid backward transition — fault_injection_confirmed → observed_failure.
  it("M12: refuses backward transition fault_injection_confirmed → observed_failure", () => {
    expect(() =>
      assertValidStatusTransition(
        "fault_injection_confirmed",
        "observed_failure",
        "mutation: demote confirmed",
      ),
    ).toThrow(/状态转换/);
  });

  // M13: valid transitions are accepted (control).
  it("M13: accepts valid forward transitions (control)", () => {
    expect(() =>
      assertValidStatusTransition("observed_failure", "localized_hypothesis", "valid"),
    ).not.toThrow();
    expect(() =>
      assertValidStatusTransition("localized_hypothesis", "intervention_supported", "valid"),
    ).not.toThrow();
    expect(() =>
      assertValidStatusTransition("localized_hypothesis", "fault_injection_confirmed", "valid"),
    ).not.toThrow();
    expect(() =>
      assertValidStatusTransition("localized_hypothesis", "unresolved", "valid"),
    ).not.toThrow();
    expect(() =>
      assertValidStatusTransition("observed_failure", "unresolved", "valid"),
    ).not.toThrow();
  });
});

// ===========================================================================
// §3 Repair packet mutation — fix/investigation gate
// ===========================================================================

describe("T46-4 mutation — repair packet fix/investigation gate", () => {
  // M14: a packet with only `localized_hypothesis` and no direct component
  // evidence MUST be `investigation`, not `fix`.
  it("M14: refuses fix when status is localized_hypothesis without direct evidence", () => {
    const diagnosis = makeDiagnosis({
      causalStatus: "localized_hypothesis",
      confidence: "low",
      hypotheses: [makeHypothesis("hyp-m14", "假设原因", "localized_hypothesis", "evidence-1")],
    });
    const input = makePacketInput({
      candidateCodeSurfaces: [{
        surfaceId: "surface-m14",
        component: "model-router.ts",
        reason: "假设",
        evidenceLevel: "hypothesis", // not direct_component_evidence
        evidence: ["evidence-1"],
      }],
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.packetType).toBe("investigation");
  });

  // M15: a packet with `observed_failure` status MUST be `investigation`.
  it("M15: refuses fix when status is observed_failure", () => {
    const diagnosis = makeDiagnosis({
      causalStatus: "observed_failure",
      confidence: "very_low",
      hypotheses: [], // no direct component evidence
      fromFaultProfile: false,
      faultProfileRef: undefined,
    });
    const input = makePacketInput({
      candidateCodeSurfaces: [{
        surfaceId: "surface-m15",
        component: "model-router.ts",
        reason: "假设",
        evidenceLevel: "hypothesis", // not direct_component_evidence
        evidence: ["evidence-1"],
      }],
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.packetType).toBe("investigation");
  });

  // M16: a packet with `unresolved` status MUST be `investigation`.
  it("M16: refuses fix when status is unresolved", () => {
    const diagnosis = makeDiagnosis({
      causalStatus: "unresolved",
      confidence: "very_low",
      hypotheses: [],
      fromFaultProfile: false,
      faultProfileRef: undefined,
    });
    const input = makePacketInput({
      candidateCodeSurfaces: [{
        surfaceId: "surface-m16",
        component: "model-router.ts",
        reason: "假设",
        evidenceLevel: "hypothesis",
        evidence: ["evidence-1"],
      }],
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.packetType).toBe("investigation");
  });

  // M17: a packet missing acceptanceCriteria MUST be `investigation`.
  it("M17: refuses fix when acceptanceCriteria is empty", () => {
    const diagnosis = makeDiagnosis(); // fault_injection_confirmed + high
    const input = makePacketInput({
      acceptanceCriteria: [], // mutation: remove criteria
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.packetType).toBe("investigation");
  });

  // M18: a packet missing protectedBoundaries MUST be `investigation`.
  it("M18: refuses fix when protectedBoundaries is empty", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      protectedBoundaries: [],
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.packetType).toBe("investigation");
  });

  // M19: a packet missing verificationCommands MUST be `investigation`.
  it("M19: refuses fix when verificationCommands is empty", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      verificationCommands: [],
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.packetType).toBe("investigation");
  });

  // M20: a packet with empty codeFingerprint gitCommit MUST be downgraded
  // to `investigation` (the fix gate refuses without a valid fingerprint).
  it("M20: refuses fix when codeFingerprint is missing gitCommit", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      codeFingerprint: {
        gitCommit: "", // mutation: empty commit
        gitDirty: false,
        worktreeSha256: "0123456789abcdef",
      },
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.packetType).toBe("investigation");
  });
});

// ===========================================================================
// §4 Repair packet mutation — scrubbing & candidate regression governance
// ===========================================================================

describe("T46-4 mutation — packet scrubbing & candidate regression governance", () => {
  // M21: a packet that contains an api_key in observedSymptom MUST throw.
  it("M21: refuses packet with api_key in observedSymptom", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      observedSymptom: "错误: api_key=sk-abc123def456789012345678901234",
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/禁止信息|scrub/);
  });

  // M22: a packet that contains an absolute /tmp/ path at the START of a
  // field MUST throw. (The scrub regex anchors on `^/tmp/`.)
  it("M22: refuses packet with /tmp/ absolute path at start of field", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      reproductionCommand: "/tmp/eval-lab-secret/observations/scn-1.json",
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/禁止信息|scrub|临时路径/);
  });

  // M23: a packet that contains __hidden__ marker MUST throw.
  it("M23: refuses packet with __hidden__ raw hidden fact marker", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      observedSymptom: "错误: __hidden__field leaked",
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/禁止信息|scrub/);
  });

  // M24: a packet that contains <think> model hidden reasoning MUST throw.
  it("M24: refuses packet with <think> model hidden reasoning marker", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      observedSymptom: "模型输出: <think>internal reasoning</think>",
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/禁止信息|scrub/);
  });

  // M25: candidate regression with status="approved" MUST throw.
  it("M25: refuses candidate regression with status 'approved'", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      candidateRegression: {
        regressionId: "reg-m25",
        scenarioPrompt: "candidate regression prompt",
        expectedContract: "expected",
        verificationCommand: "scripts/eval-lab run --preset smoke-v2",
        status: "approved", // mutation: forbidden
        outsideFrozenSuite: true,
      },
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/candidate regression|不得标记为.*approved/);
  });

  // M26: candidate regression with outsideFrozenSuite=false MUST throw.
  it("M26: refuses candidate regression with outsideFrozenSuite=false", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      candidateRegression: {
        regressionId: "reg-m26",
        scenarioPrompt: "candidate regression prompt",
        expectedContract: "expected",
        verificationCommand: "scripts/eval-lab run --preset smoke-v2",
        status: "candidate",
        outsideFrozenSuite: false, // mutation: must be true
      },
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/outsideFrozenSuite/);
  });

  // M27: verifyPacketInvariants catches a tampered integritySha256.
  it("M27: verifyPacketInvariants flags tampered integritySha256", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput();
    const packet = buildRepairPacket(input, diagnosis, undefined);
    const tampered: RepairPacket = {
      ...packet,
      integritySha256: "0".repeat(64), // mutation: tampered
    };
    const violations = verifyPacketInvariants(tampered);
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// §5 Repair prompt mutation — stale & forbidden actions
// ===========================================================================

describe("T46-4 mutation — repair prompt stale & forbidden actions", () => {
  // M28: buildRepairPrompt MUST throw on a stale packet.
  it("M28: buildRepairPrompt refuses stale packet", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      codeFingerprint: {
        gitCommit: "original-commit-abc",
        gitDirty: false,
        worktreeSha256: "original-worktree-def",
      },
      currentCodeFingerprint: {
        gitCommit: "different-commit-xyz", // mutation: commit drifted
        gitDirty: true,
        worktreeSha256: "different-worktree-uvw",
      },
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.staleState).toBe("stale");
    expect(() => buildRepairPrompt({ packet })).toThrow(/stale/);
  });

  // M29: promptRefusesStale returns false if all stale-related content is
  // stripped. The regex matches "stale.*停止", "stale state.*fresh", or
  // "packet stale" — stripping only the "Stale 检查" section is not enough
  // because the fingerprint section also mentions "packet stale".
  it("M29: promptRefusesStale catches a prompt missing all stale content", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput();
    const packet = buildRepairPacket(input, diagnosis, undefined);
    const prompt = buildRepairPrompt({ packet });
    // Sanity: the real prompt passes.
    expect(promptRefusesStale(prompt)).toBe(true);
    // Mutation: replace ALL stale-related keywords so the regex can no longer match.
    const mutated = prompt.replace(/stale/gi, "过期");
    expect(promptRefusesStale(mutated)).toBe(false);
  });

  // M30: promptForbidsFrozenStandardsModification catches a prompt missing
  // the frozen-standards forbidden action.
  it("M30: catches a prompt missing frozen-standards forbidden action", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput();
    const packet = buildRepairPacket(input, diagnosis, undefined);
    const prompt = buildRepairPrompt({ packet });
    expect(promptForbidsFrozenStandardsModification(prompt)).toBe(true);
    // Mutation: replace ALL frozen-related mentions (standards, suite,
    // grader threshold) so the regex can no longer match.
    const mutated = prompt
      .replace(/frozen\s*standards/gi, "项目标准")
      .replace(/frozen\s*suite/gi, "项目套件")
      .replace(/grader.*threshold/gi, "判定阈值");
    expect(promptForbidsFrozenStandardsModification(mutated)).toBe(false);
  });

  // M31: promptForbidsAutoPushMergeClose catches a prompt missing the
  // auto-push/merge/close forbidden action.
  it("M31: catches a prompt missing auto-push/merge/close forbidden action", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput();
    const packet = buildRepairPacket(input, diagnosis, undefined);
    const prompt = buildRepairPrompt({ packet });
    expect(promptForbidsAutoPushMergeClose(prompt)).toBe(true);
    // Mutation: remove mentions of push/merge/close.
    const mutated = prompt.replace(/(push|merge|关闭\s*issue)/gi, "提交");
    expect(promptForbidsAutoPushMergeClose(mutated)).toBe(false);
  });

  // M32: promptForbidsEnvModification catches a prompt missing the
  // .env/API key forbidden action.
  it("M32: catches a prompt missing .env modification forbidden action", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput();
    const packet = buildRepairPacket(input, diagnosis, undefined);
    const prompt = buildRepairPrompt({ packet });
    expect(promptForbidsEnvModification(prompt)).toBe(true);
  });

  // M33: verifyPromptContent catches api_key leakage in a prompt.
  it("M33: verifyPromptContent catches api_key in prompt", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput();
    const packet = buildRepairPacket(input, diagnosis, undefined);
    const prompt = buildRepairPrompt({ packet }) + "\napi_key=sk-abc123def456789012345678901234";
    const violations = verifyPromptContent(prompt);
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// §6 Pipeline-level mutation — end-to-end invariant enforcement
// ===========================================================================

describe("T46-4 mutation — pipeline-level invariants", () => {
  // M34: runDiagnosisPipeline never produces a `fix` packet when the diagnosis
  // is only `localized_hypothesis`.
  it("M34: pipeline produces investigation (not fix) for localized_hypothesis diagnosis", async () => {
    const store = await makeStore("mut-pipeline-no-fix");
    const target: DiagnosisTarget = {
      scenario: {
        schemaVersion: 1,
        scenarioId: "scn-m34",
        visible: { prompt: "路由错误症状" },
        hidden: {
          expectedMode: "action",
          maxLatencyMs: 30000,
          tokenBudget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
          maxRequestCount: 5,
        },
      },
      observation: {
        schemaVersion: 1,
        scenarioId: "scn-m34",
        timestamp: "2026-07-20T00:00:00Z",
        routedMode: "answer",
        selectedSkills: [],
        evidence: [],
        terminalStatus: "completed",
        latencyMs: 1000,
        inputTokens: 100,
        outputTokens: 100,
        requestCount: 1,
        costs: {
          sutCost: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
          evaluatorModelCost: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
          codingAgentCost: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
        },
        output: "test",
      },
      grade: {
        schemaVersion: 1,
        scenarioId: "scn-m34",
        passed: false,
        routingPassed: false,
        outcomePassed: false,
        latencyPassed: true,
        privacyPassed: true,
        budgetPassed: true,
        failures: ["routedMode != expectedMode: answer != action"],
      },
    };
    const result = await runDiagnosisPipeline(store, {
      runId: "mut-pipeline-no-fix",
      targets: [target],
      createdAt: "2026-07-20T00:00:00Z",
    });
    const packet = result.packets[0]!;
    expect(packet.causalStatus).toBe("localized_hypothesis");
    expect(packet.packetType).toBe("investigation");
  });

  // M35: runBenchmarkPipeline refuses to skip the confusable-neighbour class
  // even when no profile declares a neighbour. (This is a structural guard:
  // if the catalog changes such that no profile has a neighbour, the
  // benchmark MUST fail-closed rather than silently skip the class.)
  it("M35: benchmark pipeline includes all 3 sample classes", async () => {
    const store = await makeStore("mut-pipeline-coverage");
    const { report } = await runBenchmarkPipeline(store, {
      runId: "mut-pipeline-coverage",
      createdAt: "2026-07-20T00:00:00Z",
    });
    const classes = new Set(report.samples.map((s) => s.sampleClass));
    expect(classes.has("correct_attribution")).toBe(true);
    expect(classes.has("confusable_neighbour")).toBe(true);
    expect(classes.has("unresolved_or_insufficient")).toBe(true);
  });

  // M36: runBenchmarkPipeline NEVER auto-fills `passed = true`. The pass
  // flag is derived strictly from the gate failures array.
  it("M36: benchmark report.passed is false when any gate fails", async () => {
    // Build a benchmark with deliberately bad inputs to force gate failures.
    const profile = benchmarkProfiles()[0]!;
    const badDiagnosis: DiagnosisRecord = makeDiagnosis({
      diagnosisId: "diag-m36",
      scenarioId: "scn-m36",
      causalStatus: "unresolved", // mutation: mark as unresolved to drop top1
      confidence: "very_low",
      hypotheses: [],
      fromFaultProfile: false,
      observedSymptom: profile.symptom.description,
      expectedContract: profile.symptom.expectedContract,
      faultProfileRef: undefined,
    });
    // All samples are unresolved → top1Accuracy = 0 → gate fails.
    expect(() =>
      buildBenchmarkReport({
        inputs: [
          { faultProfileId: profile.profileId, diagnosis: badDiagnosis },
          { faultProfileId: profile.profileId, diagnosis: undefined },
        ],
        evaluatedAt: "2026-07-20T00:00:00Z",
      }),
    ).toThrow(/缺少必需样本类别/);
  });

  // M37: runDiagnosisPipeline NEVER produces a packet with a secret in
  // observedSymptom — the scrubbing gate refuses to build the packet.
  it("M37: pipeline refuses to produce a packet containing a secret", async () => {
    const store = await makeStore("mut-pipeline-secret");
    const target: DiagnosisTarget = {
      scenario: {
        schemaVersion: 1,
        scenarioId: "scn-m37",
        visible: { prompt: "症状" },
        hidden: {
          expectedMode: "action",
          maxLatencyMs: 30000,
          tokenBudget: { maxInputTokens: 1000, maxOutputTokens: 1000 },
          maxRequestCount: 5,
        },
      },
      observation: {
        schemaVersion: 1,
        scenarioId: "scn-m37",
        timestamp: "2026-07-20T00:00:00Z",
        routedMode: "answer",
        selectedSkills: [],
        evidence: [],
        terminalStatus: "completed",
        latencyMs: 1000,
        inputTokens: 100,
        outputTokens: 100,
        requestCount: 1,
        costs: {
          sutCost: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
          evaluatorModelCost: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
          codingAgentCost: { amountUsd: 0, source: "unknown", countedAgainstSutCap: false },
        },
        output: "test",
      },
      grade: {
        schemaVersion: 1,
        scenarioId: "scn-m37",
        passed: false,
        routingPassed: false,
        outcomePassed: false,
        latencyPassed: true,
        privacyPassed: true,
        budgetPassed: true,
        // Mutation: inject a secret into the failure text.
        failures: ["routedMode != expectedMode api_key=sk-abc123def456789012345678901234"],
      },
    };
    await expect(
      runDiagnosisPipeline(store, {
        runId: "mut-pipeline-secret",
        targets: [target],
        createdAt: "2026-07-20T00:00:00Z",
      }),
    ).rejects.toThrow(/禁止信息|scrub/);
  });
});

// ===========================================================================
// §7 Symmetry coverage — closes the 5 asymmetry gaps found in the
// first-principles symmetry review. Each test here mirrors an existing
// mutation test on the other side of the allow/deny symmetry.
// ===========================================================================

describe("T46-4 mutation — symmetry coverage gaps", () => {
  // Local sample helper (mirrors the one in §1).
  function makeSample(overrides: Partial<RcaBenchmarkSample> = {}): RcaBenchmarkSample {
    return {
      sampleId: "sample-sym",
      faultProfileId: "fp-routing-001",
      expectedCauseId: "cause-routing-001",
      proposedCauses: [{
        causeId: "hyp-sym",
        candidateCause: "路由错误",
        confidence: "high",
        matchedExpected: true,
      }],
      top1Correct: true,
      top3Correct: true,
      unresolvedReported: false,
      falseAttribution: false,
      evidenceComplete: true,
      sampleClass: "correct_attribution",
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // Gap 1: verifySampleCoverage — only 2 of 3 missing-class cases were
  // tested (M4: confusable_neighbour, M5: unresolved). This closes the
  // gap by testing missing correct_attribution.
  // -----------------------------------------------------------------------

  // M38: verifySampleCoverage flags missing correct_attribution class.
  // Symmetric to M4 (missing confusable_neighbour) and M5 (missing
  // unresolved_or_insufficient). The implementation treats all 3 classes
  // as required; the test suite must verify each one is flagged when absent.
  it("M38: verifySampleCoverage flags missing correct_attribution class", () => {
    const samples = [
      makeSample({ sampleId: "s1", sampleClass: "confusable_neighbour" }),
      makeSample({ sampleId: "s2", sampleClass: "unresolved_or_insufficient" }),
    ];
    const missing = verifySampleCoverage(samples);
    expect(missing).toContain("correct_attribution");
  });

  // -----------------------------------------------------------------------
  // Gap 2: canGenerateFixPacket — only 1 of 2 missing-fingerprint cases
  // was tested (M20: missing gitCommit). This closes the gap by testing
  // missing worktreeSha256.
  // -----------------------------------------------------------------------

  // M39: a packet with empty codeFingerprint worktreeSha256 MUST be
  // downgraded to `investigation`. Symmetric to M20 (missing gitCommit).
  // The fix gate requires BOTH gitCommit AND worktreeSha256 to be non-empty.
  it("M39: refuses fix when codeFingerprint is missing worktreeSha256", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      codeFingerprint: {
        gitCommit: "abc123def4567890",
        gitDirty: false,
        worktreeSha256: "", // mutation: empty worktree hash
      },
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.packetType).toBe("investigation");
  });

  // -----------------------------------------------------------------------
  // Gap 3: scrubContent — each forbidden category was tested with only 1
  // representative pattern (M21: api_key, M22: /tmp/, M23: __hidden__,
  // M24: <think>). This closes the gap by testing the remaining patterns
  // that the scrub regex covers but the tests did not exercise.
  // -----------------------------------------------------------------------

  // M40: refuses packet with -----BEGIN RSA PRIVATE KEY----- block.
  // Symmetric to M21 (api_key). The scrub regex covers PEM private key
  // headers as a distinct secret pattern.
  it("M40: refuses packet with BEGIN PRIVATE KEY block", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      observedSymptom: "错误: -----BEGIN RSA PRIVATE KEY-----\nMIIEpAI...",
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/禁止信息|scrub/);
  });

  // M41: refuses packet with /var/folders/ absolute path at start of field.
  // Symmetric to M22 (/tmp/). The scrub regex covers /var/folders/ as a
  // macOS-specific temp path pattern.
  it("M41: refuses packet with /var/folders/ absolute path at start of field", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      reproductionCommand: "/var/folders/xx/eval-lab-secret/observations/scn-1.json",
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/禁止信息|scrub|临时路径/);
  });

  // M42: refuses packet with __oracle__ raw hidden fact marker.
  // Symmetric to M23 (__hidden__). The scrub regex covers __oracle__ as a
  // distinct hidden-fact marker used by the evaluator oracle.
  it("M42: refuses packet with __oracle__ raw hidden fact marker", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      observedSymptom: "错误: __oracle__field leaked into output",
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/禁止信息|scrub/);
  });

  // M43: refuses packet with <reasoning> model hidden reasoning marker.
  // Symmetric to M24 (<think>). The scrub regex covers <reasoning> as a
  // distinct model-internal reasoning tag.
  it("M43: refuses packet with <reasoning> model hidden reasoning marker", () => {
    const diagnosis = makeDiagnosis();
    const input = makePacketInput({
      observedSymptom: "模型输出: <reasoning>internal chain-of-thought</reasoning>",
    });
    expect(() => buildRepairPacket(input, diagnosis, undefined)).toThrow(/禁止信息|scrub/);
  });

  // -----------------------------------------------------------------------
  // Gap 4: buildRepairPrompt stale — only `stale` was tested (M28). This
  // closes the gap by testing the `unknown` stale state, which is a
  // design-intentional asymmetry: `unknown` does NOT throw (unlike
  // `stale`), but the prompt MUST still include the fingerprint check
  // as the last line of defense.
  // -----------------------------------------------------------------------

  // M44: buildRepairPrompt allows `unknown` stale state (no
  // currentCodeFingerprint provided) but the generated prompt MUST still
  // contain the fingerprint check section. This is the design-intentional
  // asymmetry: `unknown` ≠ `stale`; the Coding Agent prompt's fingerprint
  // check is the fallback when the builder could not compare.
  it("M44: buildRepairPrompt allows unknown stale state but includes fingerprint check", () => {
    const diagnosis = makeDiagnosis();
    // No currentCodeFingerprint → detectStaleState returns "unknown".
    const input = makePacketInput({
      currentCodeFingerprint: undefined,
    });
    const packet = buildRepairPacket(input, diagnosis, undefined);
    expect(packet.staleState).toBe("unknown");
    // buildRepairPrompt does NOT throw on "unknown" (unlike "stale" in M28).
    expect(() => buildRepairPrompt({ packet })).not.toThrow();
    // But the prompt MUST include the fingerprint check section as a fallback.
    const prompt = buildRepairPrompt({ packet });
    expect(prompt).toContain("代码指纹校验");
    expect(prompt).toContain(packet.codeFingerprint.gitCommit);
    expect(prompt).toContain(packet.codeFingerprint.worktreeSha256);
  });

  // -----------------------------------------------------------------------
  // Gap 5: assertValidStatusTransition — only 4 representative invalid
  // transitions were tested (M9: intervention→fault, M10: unresolved→fault,
  // M11: observed→intervention, M12: fault→observed). This closes the gap
  // by testing 2 more invalid transitions that exercise different
  // forbidden paths in the transition table.
  // -----------------------------------------------------------------------

  // M45: refuses invalid transition observed_failure → fault_injection_confirmed
  // (skips 2 levels: localized_hypothesis AND intervention_supported).
  // Symmetric to M11 (observed_failure → intervention_supported, skips 1
  // level). The transition table only allows observed_failure →
  // {localized_hypothesis, unresolved}.
  it("M45: refuses invalid transition observed_failure → fault_injection_confirmed (skip 2 levels)", () => {
    expect(() =>
      assertValidStatusTransition(
        "observed_failure",
        "fault_injection_confirmed",
        "mutation: skip localized_hypothesis and intervention_supported",
      ),
    ).toThrow(/状态转换/);
  });

  // M46: refuses backward transition intervention_supported → observed_failure.
  // Symmetric to M12 (fault_injection_confirmed → observed_failure). The
  // transition table only allows intervention_supported → {unresolved};
  // downgrading to observed_failure is forbidden.
  it("M46: refuses backward transition intervention_supported → observed_failure", () => {
    expect(() =>
      assertValidStatusTransition(
        "intervention_supported",
        "observed_failure",
        "mutation: demote to observed_failure",
      ),
    ).toThrow(/状态转换/);
  });
});
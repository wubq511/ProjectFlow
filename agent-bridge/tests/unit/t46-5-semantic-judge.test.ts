/**
 * T46-5 (Issue #98 §3-§6) — Semantic Judge tests.
 *
 * Verifies:
 *  1. Criterion-scoped rubric: ONE criterion at a time.
 *  2. Judge input scrubbing rejects forbidden content (hidden CoT,
 *     oracle, secrets, private transcripts, API keys).
 *  3. Blinding + random order: the seed determines A/B display order
 *     deterministically; the same seed always produces the same order.
 *  4. Reverse-order repetition is recorded; disagreement is detected.
 *  5. `applyFailSafe` degrades to `needs_review` for all 9 fail-safe
 *     classes and to `infra_error` when the Judge itself fails.
 *  6. `parseJudgeOutput` validates schema; `attemptJudgeSchemaRepair`
 *     coerces synonymous verdicts but rejects unrepairable output.
 *  7. `evaluateAcceptanceProposal` checks all 7 thresholds.
 *  8. `computeFinalVerdict` always lets hard-gate failure win.
 *  9. Hard gate precedence: semantic evidence cannot offset hard gates.
 * 10. `evaluateAnchorOrdering` detects good > boundary > bad violations.
 */

import { describe, expect, it } from "vitest";
import {
  scrubJudgeInput,
  validateJudgeInputScrubbing,
  buildJudgePromptPayload,
  randomizeDisplayOrder,
  buildPairwiseRecord,
  evaluateAnchorOrdering,
  computeAnchorStability,
  applyFailSafe,
  parseJudgeOutput,
  attemptJudgeSchemaRepair,
  evaluateAcceptanceProposal,
  computeFinalVerdict,
  HARD_GATES_THAT_OUTRANK_SEMANTICS,
  computeRubricIntegritySha256,
  type JudgeInput,
  type AnchorEvaluationResult,
} from "../../src/evaluation/lab/semantic-judge.js";
import type {
  AcceptanceProposal,
  JudgeManifest,
  PairwiseVerdict,
  SemanticAnchor,
  SemanticAnchorSet,
  SemanticRubric,
} from "../../src/evaluation/lab/calibration-contract.js";
import { EvaluationValidationError } from "../../src/evaluation/lab/errors.js";

function buildMockRubric(): SemanticRubric {
  return {
    schemaVersion: 1,
    rubricId: "p0-planning-specificity-rubric",
    criterion: "planning-specificity",
    label: "规划具体性",
    description: "评估阶段计划是否具体可执行",
    scoreScale: ["poor", "fair", "good", "excellent"],
    evidenceReferences: [],
    verdict: "needs_review",
    score: "",
    reason: "",
    confidence: 0,
    judgeManifestRef: { judgeId: "mock-judge-v1", judgeVersion: 1 },
    rubricVersion: 1,
    semanticHardGateEligible: false,
  };
}

function buildMockJudgeManifest(): JudgeManifest {
  return {
    schemaVersion: 1,
    judgeId: "mock-judge-v1",
    version: 1,
    provider: "mock",
    modelName: "mock-judge",
    family: "mock",
    promptVersion: 1,
    rubricVersionRef: { rubricId: "p0-planning-specificity-rubric", rubricVersion: 1 },
    anchorVersionRef: { anchorSetId: "p0-planning-specificity-anchors", anchorVersion: 1 },
    independentOfSut: true,
    identityConfirmed: true,
  };
}

function buildBaselineJudgeInput(): JudgeInput {
  return {
    visibleFacts: ["项目目标: 完成 ProjectFlow MVP", "团队规模: 3 人"],
    visibleProjectFlowState: "Project: demo-project, Stage: planning",
    candidateOutput: "建议第一阶段聚焦后端 API 设计与数据模型。",
    deterministicEvidence: ["hard grade passed", "milestone dag matched"],
    traceReferences: ["trace-event-001", "trace-event-002"],
    candidateBlinded: true,
  };
}

describe("T46-5 semantic judge — input scrubbing", () => {
  it("scrubJudgeInput flags hidden CoT patterns", () => {
    expect(scrubJudgeInput("some __hidden_cot__ content")).toHaveLength(1);
  });

  it("scrubJudgeInput flags hidden oracle patterns", () => {
    expect(scrubJudgeInput("some __hidden_oracle__ content")).toHaveLength(1);
  });

  it("scrubJudgeInput flags secret patterns", () => {
    expect(scrubJudgeInput("some __secret__ content")).toHaveLength(1);
  });

  it("scrubJudgeInput flags private transcript patterns", () => {
    expect(scrubJudgeInput("some __private_transcript__ content")).toHaveLength(1);
  });

  it("scrubJudgeInput flags API key patterns", () => {
    expect(scrubJudgeInput("sk-1234567890abcdefghijklmnopqrstuv")).toHaveLength(1);
  });

  it("scrubJudgeInput flags Bearer token patterns", () => {
    expect(scrubJudgeInput("Bearer abc.def.ghi-jkl_mno")).toHaveLength(1);
  });

  it("scrubJudgeInput returns empty for clean input", () => {
    expect(scrubJudgeInput("这是一个干净的输入，没有禁止内容")).toEqual([]);
  });

  it("validateJudgeInputScrubbing checks all string fields", () => {
    const input: JudgeInput = {
      ...buildBaselineJudgeInput(),
      visibleFacts: ["__hidden_cot__ leak"],
    };
    const violations = validateJudgeInputScrubbing(input);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatch(/visibleFacts/);
  });

  it("buildJudgePromptPayload throws when input contains forbidden content", () => {
    const input: JudgeInput = {
      ...buildBaselineJudgeInput(),
      candidateOutput: "contains __hidden_oracle__",
    };
    expect(() => buildJudgePromptPayload(input, buildMockRubric())).toThrow(
      /Judge input scrubbing 失败/,
    );
  });

  it("buildJudgePromptPayload does not include candidate identity when blinded", () => {
    const input = buildBaselineJudgeInput();
    const payload = buildJudgePromptPayload(input, buildMockRubric());
    expect(payload.candidateBlinded).toBe(true);
    expect(payload).not.toHaveProperty("candidateIdentity");
  });
});

describe("T46-5 semantic judge — blinding + random order", () => {
  it("randomizeDisplayOrder is deterministic for the same seed", () => {
    const seed = "test-seed-1";
    const candidates: [unknown, unknown] = [{ id: "A" }, { id: "B" }];
    const r1 = randomizeDisplayOrder(seed, candidates);
    const r2 = randomizeDisplayOrder(seed, candidates);
    expect(r1.displayOrder).toEqual(r2.displayOrder);
  });

  it("randomizeDisplayOrder returns one of ['A','B'] or ['B','A']", () => {
    const candidates: [unknown, unknown] = [{ id: "A" }, { id: "B" }];
    for (let i = 0; i < 20; i++) {
      const result = randomizeDisplayOrder(`seed-${i}`, candidates);
      expect(result.displayOrder).toHaveLength(2);
      expect(result.displayOrder).toContain("A");
      expect(result.displayOrder).toContain("B");
    }
  });

  it("randomizeDisplayOrder swaps the candidates array when order is ['B','A']", () => {
    const candidates: [unknown, unknown] = [{ id: "A" }, { id: "B" }];
    // Find a seed that produces ['B','A'].
    let swapSeed: string | null = null;
    for (let i = 0; i < 50; i++) {
      const seed = `swap-seed-${i}`;
      const result = randomizeDisplayOrder(seed, candidates);
      if (result.displayOrder[0] === "B") {
        swapSeed = seed;
        break;
      }
    }
    expect(swapSeed).not.toBeNull();
    if (swapSeed !== null) {
      const result = randomizeDisplayOrder(swapSeed, candidates);
      expect(result.displayCandidates[0]).toEqual({ id: "B" });
      expect(result.displayCandidates[1]).toEqual({ id: "A" });
    }
  });

  it("buildPairwiseRecord records seed, displayOrder, reverseRepetition and disagreement", () => {
    const manifest = buildMockJudgeManifest();
    const rubric = buildMockRubric();
    const forward: PairwiseVerdict = {
      kind: "preference",
      preferred: "A",
      confidence: 0.8,
      reason: "A 更具体",
    };
    const reverse: PairwiseVerdict = {
      kind: "preference",
      preferred: "B",
      confidence: 0.7,
      reason: "B 更具体",
    };
    const record = buildPairwiseRecord({
      pairwiseId: "pairwise-1",
      candidateAId: "candidate-A",
      candidateBId: "candidate-B",
      blinded: true,
      seed: "test-seed",
      judgeManifest: manifest,
      rubric,
      forwardVerdict: forward,
      reverseVerdict: reverse,
      evaluatedAt: "2026-07-20T00:00:00.000Z",
    });
    expect(record.seed).toBe("test-seed");
    expect(record.displayOrder).toContain("A");
    expect(record.displayOrder).toContain("B");
    expect(record.reverseRepetition).toBe(true);
    expect(record.disagreement).toBe(true);
    expect(record.judgeManifestRef.judgeId).toBe("mock-judge-v1");
    expect(record.rubricVersionRef.rubricId).toBe("p0-planning-specificity-rubric");
  });

  it("buildPairwiseRecord marks disagreement=false when forward and reverse agree", () => {
    const manifest = buildMockJudgeManifest();
    const rubric = buildMockRubric();
    const verdict: PairwiseVerdict = {
      kind: "preference",
      preferred: "A",
      confidence: 0.8,
      reason: "A 更具体",
    };
    const record = buildPairwiseRecord({
      pairwiseId: "pairwise-1",
      candidateAId: "candidate-A",
      candidateBId: "candidate-B",
      blinded: true,
      seed: "test-seed",
      judgeManifest: manifest,
      rubric,
      forwardVerdict: verdict,
      reverseVerdict: verdict,
      evaluatedAt: "2026-07-20T00:00:00.000Z",
    });
    expect(record.disagreement).toBe(false);
  });
});

describe("T46-5 semantic judge — anchor ordering evaluation", () => {
  function buildAnchors(): SemanticAnchor[] {
    return [
      {
        anchorId: "good",
        kind: "good",
        output: "good output",
        visibleFacts: [],
        expectedOrderRank: 0,
      },
      {
        anchorId: "boundary",
        kind: "boundary",
        output: "boundary output",
        visibleFacts: [],
        expectedOrderRank: 1,
      },
      {
        anchorId: "bad",
        kind: "bad",
        output: "bad output",
        visibleFacts: [],
        expectedOrderRank: 2,
      },
    ];
  }

  it("evaluateAnchorOrdering preserves ordering when good > boundary > bad by confidence", () => {
    const anchors = buildAnchors();
    const results: AnchorEvaluationResult[] = [
      { anchorId: "good", verdict: "pass", score: "excellent", confidence: 0.9 },
      { anchorId: "boundary", verdict: "needs_review", score: "fair", confidence: 0.5 },
      { anchorId: "bad", verdict: "fail", score: "poor", confidence: 0.1 },
    ];
    const eval_ = evaluateAnchorOrdering(anchors, results);
    expect(eval_.orderingPreserved).toBe(true);
    expect(eval_.violations).toEqual([]);
  });

  it("evaluateAnchorOrdering detects violation when bad has higher confidence than good", () => {
    const anchors = buildAnchors();
    const results: AnchorEvaluationResult[] = [
      { anchorId: "good", verdict: "pass", score: "excellent", confidence: 0.3 },
      { anchorId: "boundary", verdict: "needs_review", score: "fair", confidence: 0.5 },
      { anchorId: "bad", verdict: "fail", score: "poor", confidence: 0.9 },
    ];
    const eval_ = evaluateAnchorOrdering(anchors, results);
    expect(eval_.orderingPreserved).toBe(false);
    expect(eval_.violations.length).toBeGreaterThan(0);
  });

  it("computeAnchorStability returns 1.0 when all repeats produce the expected verdict", () => {
    const anchors = buildAnchors();
    const repeats: AnchorEvaluationResult[][] = [
      [
        { anchorId: "good", verdict: "pass", score: "excellent", confidence: 0.9 },
        { anchorId: "boundary", verdict: "needs_review", score: "fair", confidence: 0.5 },
        { anchorId: "bad", verdict: "fail", score: "poor", confidence: 0.1 },
      ],
      [
        { anchorId: "good", verdict: "pass", score: "excellent", confidence: 0.9 },
        { anchorId: "boundary", verdict: "needs_review", score: "fair", confidence: 0.5 },
        { anchorId: "bad", verdict: "fail", score: "poor", confidence: 0.1 },
      ],
    ];
    const stability = computeAnchorStability(repeats, anchors);
    expect(stability.overallStability).toBe(1);
  });

  it("computeAnchorStability detects flips across repeats", () => {
    const anchors = buildAnchors();
    const repeats: AnchorEvaluationResult[][] = [
      [
        { anchorId: "good", verdict: "pass", score: "excellent", confidence: 0.9 },
      ],
      [
        { anchorId: "good", verdict: "fail", score: "poor", confidence: 0.1 },
      ],
    ];
    const stability = computeAnchorStability(repeats, anchors);
    const goodStability = stability.perAnchor.find((a) => a.anchorId === "good");
    expect(goodStability?.stability).toBe(0.5);
  });
});

describe("T46-5 semantic judge — fail-safe decision", () => {
  function buildBaselineFailSafeInput() {
    return {
      judgeResult: { verdict: "pass" as const, reason: "good output", score: "excellent", confidence: 0.9 },
      hardGatePassed: true,
      independentJudgeAvailable: true,
      judgeIdentityConfirmed: true,
      onlySameFamilyUncalibrated: false,
      judgesConflict: false,
      anchorOrderingUnstable: false,
      biasMetricsExceeded: false,
      judgeTelemetryIncomplete: false,
      judgeSchemaUnrepairable: false,
      calibrationEvidenceInsufficient: false,
    };
  }

  it("returns the Judge verdict when all conditions are healthy", () => {
    const result = applyFailSafe(buildBaselineFailSafeInput());
    expect(result.finalVerdict).toBe("pass");
    expect(result.failSafeReason).toBeNull();
  });

  it("degrades to fail when hard gate failed (semantic cannot offset)", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), hardGatePassed: false });
    expect(result.finalVerdict).toBe("fail");
    expect(result.rationale).toMatch(/hard gate 失败/);
  });

  it("degrades to needs_review when no independent Judge is available", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), independentJudgeAvailable: false });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.failSafeReason).toBe("no_independent_judge");
  });

  it("degrades to needs_review when Judge identity is unconfirmed", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), judgeIdentityConfirmed: false });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.failSafeReason).toBe("judge_identity_unconfirmed");
  });

  it("degrades to needs_review when only same-family uncalibrated Judge is available", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), onlySameFamilyUncalibrated: true });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.failSafeReason).toBe("only_same_family_uncalibrated");
  });

  it("degrades to needs_review when Judges conflict", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), judgesConflict: true });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.failSafeReason).toBe("judges_conflict");
  });

  it("degrades to needs_review when anchor ordering is unstable", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), anchorOrderingUnstable: true });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.failSafeReason).toBe("anchor_ordering_unstable");
  });

  it("degrades to needs_review when bias metrics exceeded", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), biasMetricsExceeded: true });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.failSafeReason).toBe("bias_metrics_exceeded");
  });

  it("degrades to needs_review when Judge telemetry is incomplete", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), judgeTelemetryIncomplete: true });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.failSafeReason).toBe("judge_telemetry_incomplete");
  });

  it("degrades to needs_review when Judge schema is unrepairable", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), judgeSchemaUnrepairable: true });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.failSafeReason).toBe("judge_schema_unrepairable");
  });

  it("degrades to needs_review when calibration evidence is insufficient", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), calibrationEvidenceInsufficient: true });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.failSafeReason).toBe("calibration_evidence_insufficient");
  });

  it("returns infra_error when Judge itself returns null", () => {
    const result = applyFailSafe({ ...buildBaselineFailSafeInput(), judgeResult: null });
    expect(result.finalVerdict).toBe("infra_error");
    expect(result.rationale).toMatch(/Judge 调用失败/);
  });

  it("returns infra_error when Judge returns an invalid verdict", () => {
    const result = applyFailSafe({
      ...buildBaselineFailSafeInput(),
      judgeResult: { verdict: "invalid" as "pass", reason: "x", score: "x", confidence: 0.5 },
    });
    expect(result.finalVerdict).toBe("infra_error");
  });

  it("hard gate failure takes precedence over fail-safe (still returns fail)", () => {
    // Even with all fail-safe conditions triggered, hard-gate failure wins.
    const result = applyFailSafe({
      ...buildBaselineFailSafeInput(),
      hardGatePassed: false,
      independentJudgeAvailable: false,
      judgesConflict: true,
    });
    expect(result.finalVerdict).toBe("fail");
    expect(result.failSafeReason).toBeNull();
  });
});

describe("T46-5 semantic judge — schema validation and repair", () => {
  it("parseJudgeOutput accepts a well-formed output", () => {
    const result = parseJudgeOutput({
      verdict: "pass",
      score: "excellent",
      reason: "good output",
      confidence: 0.9,
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.verdict).toBe("pass");
      expect(result.score).toBe("excellent");
    }
  });

  it("parseJudgeOutput rejects non-object input", () => {
    const result = parseJudgeOutput("not an object");
    expect(result.kind).toBe("schema_invalid");
  });

  it("parseJudgeOutput rejects an invalid verdict", () => {
    const result = parseJudgeOutput({
      verdict: "invalid",
      score: "x",
      reason: "x",
      confidence: 0.5,
    });
    expect(result.kind).toBe("schema_invalid");
  });

  it("parseJudgeOutput rejects an out-of-range confidence", () => {
    const result = parseJudgeOutput({
      verdict: "pass",
      score: "x",
      reason: "x",
      confidence: 1.5,
    });
    expect(result.kind).toBe("schema_invalid");
  });

  it("parseJudgeOutput rejects a missing score", () => {
    const result = parseJudgeOutput({
      verdict: "pass",
      reason: "x",
      confidence: 0.5,
    });
    expect(result.kind).toBe("schema_invalid");
  });

  it("attemptJudgeSchemaRepair coerces synonymous verdicts", () => {
    expect(attemptJudgeSchemaRepair({ verdict: "ok", score: "good", reason: "x", confidence: 0.5 })?.verdict).toBe("pass");
    expect(attemptJudgeSchemaRepair({ verdict: "no", score: "bad", reason: "x", confidence: 0.5 })?.verdict).toBe("fail");
    expect(attemptJudgeSchemaRepair({ verdict: "uncertain", score: "x", reason: "x", confidence: 0.5 })?.verdict).toBe("needs_review");
    expect(attemptJudgeSchemaRepair({ verdict: "error", score: "x", reason: "x", confidence: 0.5 })?.verdict).toBe("infra_error");
    expect(attemptJudgeSchemaRepair({ verdict: "insufficient", score: "x", reason: "x", confidence: 0.5 })?.verdict).toBe("insufficient_evidence");
  });

  it("attemptJudgeSchemaRepair returns null for unrepairable output", () => {
    expect(attemptJudgeSchemaRepair({ verdict: "garbage", score: "x", reason: "x", confidence: 0.5 })).toBeNull();
    expect(attemptJudgeSchemaRepair(null)).toBeNull();
    expect(attemptJudgeSchemaRepair("string")).toBeNull();
  });

  it("attemptJudgeSchemaRepair defaults missing fields", () => {
    const repaired = attemptJudgeSchemaRepair({ verdict: "pass" });
    expect(repaired?.score).toBe("unknown");
    expect(repaired?.reason).toBe("schema repair applied");
    expect(repaired?.confidence).toBe(0);
  });
});

describe("T46-5 semantic judge — acceptance proposal evaluation", () => {
  function buildBaselineProposal(): AcceptanceProposal {
    return {
      proposalId: "test-proposal",
      version: 1,
      anchorOrderingThreshold: 0.05,
      repeatedStabilityThreshold: 0.90,
      positionBiasThreshold: 0.60,
      verbosityBiasThreshold: 0.30,
      sameFamilyPreferenceThreshold: 0.65,
      disagreementRateThreshold: 0.20,
      repeatedRunFlipRateThreshold: 0.10,
      frozenAt: "2026-07-20T00:00:00.000Z",
      description: "test",
    };
  }

  it("passes when all metrics are within thresholds", () => {
    const proposal = buildBaselineProposal();
    const result = evaluateAcceptanceProposal(proposal, {
      anchorOrderingViolationRate: 0.01,
      repeatedStability: 0.95,
      positionBiasPreferenceForFirst: 0.50,
      verbosityBiasCorrelation: 0.10,
      sameFamilyPreferenceRate: 0.40,
      pairwiseDisagreementRate: 0.10,
      repeatedRunFlipRate: 0.05,
    });
    expect(result.passed).toBe(true);
    expect(result.failureReasons).toEqual([]);
  });

  it("fails when anchor ordering violation rate exceeds threshold", () => {
    const proposal = buildBaselineProposal();
    const result = evaluateAcceptanceProposal(proposal, {
      anchorOrderingViolationRate: 0.10,
      repeatedStability: 0.95,
      positionBiasPreferenceForFirst: 0.50,
      verbosityBiasCorrelation: 0.10,
      sameFamilyPreferenceRate: 0.40,
      pairwiseDisagreementRate: 0.10,
      repeatedRunFlipRate: 0.05,
    });
    expect(result.passed).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("anchor ordering"))).toBe(true);
  });

  it("fails when repeated stability is below threshold", () => {
    const proposal = buildBaselineProposal();
    const result = evaluateAcceptanceProposal(proposal, {
      anchorOrderingViolationRate: 0.01,
      repeatedStability: 0.80,
      positionBiasPreferenceForFirst: 0.50,
      verbosityBiasCorrelation: 0.10,
      sameFamilyPreferenceRate: 0.40,
      pairwiseDisagreementRate: 0.10,
      repeatedRunFlipRate: 0.05,
    });
    expect(result.passed).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("repeated stability"))).toBe(true);
  });

  it("fails when position bias exceeds threshold", () => {
    const proposal = buildBaselineProposal();
    const result = evaluateAcceptanceProposal(proposal, {
      anchorOrderingViolationRate: 0.01,
      repeatedStability: 0.95,
      positionBiasPreferenceForFirst: 0.80,
      verbosityBiasCorrelation: 0.10,
      sameFamilyPreferenceRate: 0.40,
      pairwiseDisagreementRate: 0.10,
      repeatedRunFlipRate: 0.05,
    });
    expect(result.passed).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("position bias"))).toBe(true);
  });

  it("fails when verbosity bias correlation exceeds threshold", () => {
    const proposal = buildBaselineProposal();
    const result = evaluateAcceptanceProposal(proposal, {
      anchorOrderingViolationRate: 0.01,
      repeatedStability: 0.95,
      positionBiasPreferenceForFirst: 0.50,
      verbosityBiasCorrelation: 0.50,
      sameFamilyPreferenceRate: 0.40,
      pairwiseDisagreementRate: 0.10,
      repeatedRunFlipRate: 0.05,
    });
    expect(result.passed).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("verbosity bias"))).toBe(true);
  });

  it("fails when same-family preference exceeds threshold", () => {
    const proposal = buildBaselineProposal();
    const result = evaluateAcceptanceProposal(proposal, {
      anchorOrderingViolationRate: 0.01,
      repeatedStability: 0.95,
      positionBiasPreferenceForFirst: 0.50,
      verbosityBiasCorrelation: 0.10,
      sameFamilyPreferenceRate: 0.80,
      pairwiseDisagreementRate: 0.10,
      repeatedRunFlipRate: 0.05,
    });
    expect(result.passed).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("same-family preference"))).toBe(true);
  });

  it("fails when disagreement rate exceeds threshold", () => {
    const proposal = buildBaselineProposal();
    const result = evaluateAcceptanceProposal(proposal, {
      anchorOrderingViolationRate: 0.01,
      repeatedStability: 0.95,
      positionBiasPreferenceForFirst: 0.50,
      verbosityBiasCorrelation: 0.10,
      sameFamilyPreferenceRate: 0.40,
      pairwiseDisagreementRate: 0.30,
      repeatedRunFlipRate: 0.05,
    });
    expect(result.passed).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("pairwise disagreement"))).toBe(true);
  });

  it("fails when repeated-run flip rate exceeds threshold", () => {
    const proposal = buildBaselineProposal();
    const result = evaluateAcceptanceProposal(proposal, {
      anchorOrderingViolationRate: 0.01,
      repeatedStability: 0.95,
      positionBiasPreferenceForFirst: 0.50,
      verbosityBiasCorrelation: 0.10,
      sameFamilyPreferenceRate: 0.40,
      pairwiseDisagreementRate: 0.10,
      repeatedRunFlipRate: 0.20,
    });
    expect(result.passed).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("repeated run flip"))).toBe(true);
  });
});

describe("T46-5 semantic judge — hard gate precedence", () => {
  it("HARD_GATES_THAT_OUTRANK_SEMANTICS lists exactly the 8 frozen gates", () => {
    expect(HARD_GATES_THAT_OUTRANK_SEMANTICS).toEqual([
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

  it("computeFinalVerdict returns fail when any hard gate fails", () => {
    const result = computeFinalVerdict({
      hardGateResults: {
        state_invariant: true,
        authority: false, // fails
        privacy_visibility: true,
        proposal_confirm: true,
        terminal_consistency: true,
        idempotency: true,
        forbidden_side_effect: true,
        frozen_p0_gate: true,
      },
      semanticVerdict: "pass",
    });
    expect(result.finalVerdict).toBe("fail");
    expect(result.hardGateFailed).toContain("authority");
  });

  it("computeFinalVerdict preserves semantic verdict when all hard gates pass", () => {
    const result = computeFinalVerdict({
      hardGateResults: {
        state_invariant: true,
        authority: true,
        privacy_visibility: true,
        proposal_confirm: true,
        terminal_consistency: true,
        idempotency: true,
        forbidden_side_effect: true,
        frozen_p0_gate: true,
      },
      semanticVerdict: "needs_review",
    });
    expect(result.finalVerdict).toBe("needs_review");
    expect(result.hardGateFailed).toEqual([]);
  });

  it("computeFinalVerdict lists ALL failed hard gates", () => {
    const result = computeFinalVerdict({
      hardGateResults: {
        state_invariant: false,
        authority: false,
        privacy_visibility: true,
        proposal_confirm: false,
        terminal_consistency: true,
        idempotency: true,
        forbidden_side_effect: true,
        frozen_p0_gate: true,
      },
      semanticVerdict: "pass",
    });
    expect(result.hardGateFailed).toEqual([
      "state_invariant",
      "authority",
      "proposal_confirm",
    ]);
  });
});

describe("T46-5 semantic judge — rubric integrity hash", () => {
  it("computeRubricIntegritySha256 is deterministic for the same rubric", () => {
    const rubric = buildMockRubric();
    const { semanticHardGateEligible: _ignored, ...rest } = rubric;
    const h1 = computeRubricIntegritySha256(rest);
    const h2 = computeRubricIntegritySha256(rest);
    expect(h1).toBe(h2);
  });

  it("computeRubricIntegritySha256 changes when the rubric changes", () => {
    const rubric = buildMockRubric();
    const { semanticHardGateEligible: _ignored1, ...rest1 } = rubric;
    const { semanticHardGateEligible: _ignored2, ...rest2 } = { ...rubric, criterion: "different" };
    expect(computeRubricIntegritySha256(rest1)).not.toBe(computeRubricIntegritySha256(rest2));
  });
});

/**
 * T46-5 (Issue #98 §3-§6) — Semantic Judge.
 *
 * Implements:
 *  - Criterion-scoped rubric evaluation (ONE criterion at a time).
 *  - Blinding + random order + provenance for pairwise evaluation.
 *  - Fail-safe decision: 9 classes of degradation to `needs_review`.
 *  - Anchor stability verification (good > boundary > bad ordering,
 *    A/B swap consistency, verbosity, same-family preference,
 *    repeated-run stability, disagreement, schema-invalid handling).
 *
 * Boundary invariants (enforced and tested):
 *  - The Judge input ONLY contains: visible task facts, visible
 *    ProjectFlow state, candidate output, computed deterministic
 *    evidence, and scrubbed trace/evidence references.
 *  - The Judge input NEVER contains: hidden chain-of-thought,
 *    evaluator hidden oracle, raw private transcript, secrets/tokens,
 *    candidate model identity (when blindable), or ProjectMemory/
 *    conversation content outside the scenario viewer.
 *  - Semantic results CANNOT offset hard-gate failures (state/invariant,
 *    authority, privacy/visibility, Proposal-Confirm, terminal
 *    consistency, idempotency, forbidden side effect, frozen P0 gate).
 *  - `semantic_hard_gate_eligible` defaults to `false`. Only `true`
 *    when ALL stability tests pass AND the candidate standard has been
 *    promoted to active via explicit Robert instruction.
 *  - A single successful Judge call NEVER qualifies as stability evidence.
 *  - Switching to a same-family Judge and continuing to issue a hard
 *    verdict is FORBIDDEN.
 */

import { createHash } from "node:crypto";
import type {
  AcceptanceProposal,
  JudgeManifest,
  PairwiseEvaluationRecord,
  PairwiseVerdict,
  SemanticAnchor,
  SemanticAnchorSet,
  SemanticRubric,
  SemanticVerdict,
} from "./calibration-contract.js";
import {
  assertFrozenVerdict,
  combineHardGateWithSemantic,
  decideJudgeFailSafe,
  FROZEN_SEMANTIC_VERDICTS,
} from "./calibration-contract.js";
import { EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Judge input scrubbing
// ---------------------------------------------------------------------------

/** Forbidden content patterns in Judge input. */
const FORBIDDEN_INPUT_PATTERNS = [
  /__hidden_cot__/,
  /__hidden_oracle__/,
  /__secret__/,
  /__private_transcript__/,
  /sk-[A-Za-z0-9]{20,}/, // OpenAI-style API key
  /Bearer\s+[A-Za-z0-9._-]+/i,
];

/** Scrub a Judge input string. Returns violations found (empty = OK). */
export function scrubJudgeInput(value: string): string[] {
  const violations: string[] = [];
  for (const pattern of FORBIDDEN_INPUT_PATTERNS) {
    if (pattern.test(value)) {
      violations.push(`Judge input 包含禁止内容: ${pattern.source}`);
    }
  }
  return violations;
}

/** Validate that all string fields in a Judge input are scrubbed. */
export function validateJudgeInputScrubbing(input: {
  visibleFacts: string[];
  candidateOutput: string;
  deterministicEvidence: string[];
  traceReferences: string[];
}): string[] {
  const violations: string[] = [];
  for (const [i, fact] of input.visibleFacts.entries()) {
    const v = scrubJudgeInput(fact);
    for (const msg of v) violations.push(`visibleFacts[${i}]: ${msg}`);
  }
  for (const msg of scrubJudgeInput(input.candidateOutput)) {
    violations.push(`candidateOutput: ${msg}`);
  }
  for (const [i, ev] of input.deterministicEvidence.entries()) {
    const v = scrubJudgeInput(ev);
    for (const msg of v) violations.push(`deterministicEvidence[${i}]: ${msg}`);
  }
  for (const [i, ref] of input.traceReferences.entries()) {
    const v = scrubJudgeInput(ref);
    for (const msg of v) violations.push(`traceReferences[${i}]: ${msg}`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// §2 Judge input construction
// ---------------------------------------------------------------------------

/** Construct the Judge input for a criterion-scoped rubric evaluation. */
export interface JudgeInput {
  /** Visible task facts (no hidden CoT, no oracle). */
  visibleFacts: string[];
  /** Visible ProjectFlow state (no private conversation/memory outside viewer). */
  visibleProjectFlowState: string;
  /** The candidate output to evaluate. */
  candidateOutput: string;
  /** Already-computed deterministic evidence (e.g., hard grade results). */
  deterministicEvidence: string[];
  /** Scrubbed trace/evidence references (no raw transcripts). */
  traceReferences: string[];
  /** Whether candidate identity is blinded. */
  candidateBlinded: boolean;
  /** Optional blinding limitation note. */
  blindingLimitation?: string;
}

/** Build the prompt payload sent to the Judge. */
export function buildJudgePromptPayload(
  input: JudgeInput,
  rubric: SemanticRubric,
): Record<string, unknown> {
  // §1 Scrub all inputs.
  const violations = validateJudgeInputScrubbing(input);
  if (violations.length > 0) {
    throw new EvaluationValidationError(
      `Judge input scrubbing 失败: ${violations.join("; ")}`,
    );
  }
  // §2 Build the payload. The candidate identity is NOT included when
  //    blinded.
  return {
    rubric: {
      rubricId: rubric.rubricId,
      criterion: rubric.criterion,
      label: rubric.label,
      description: rubric.description,
      scoreScale: rubric.scoreScale,
      rubricVersion: rubric.rubricVersion,
    },
    visibleFacts: input.visibleFacts,
    visibleProjectFlowState: input.visibleProjectFlowState,
    candidateOutput: input.candidateOutput,
    deterministicEvidence: input.deterministicEvidence,
    traceReferences: input.traceReferences,
    candidateBlinded: input.candidateBlinded,
    blindingLimitation: input.blindingLimitation ?? null,
  };
}

// ---------------------------------------------------------------------------
// §3 Pairwise blinding + random order
// ---------------------------------------------------------------------------

/** Randomize A/B display order using a recorded seed. */
export function randomizeDisplayOrder(
  seed: string,
  candidates: [unknown, unknown],
): { displayOrder: ["A", "B"] | ["B", "A"]; displayCandidates: [unknown, unknown] } {
  // §1 Hash the seed to a 32-bit integer.
  const hash = createHash("sha256").update(seed).digest();
  const bits = hash.readUInt32BE(0);
  // §2 Use the lowest bit to decide order.
  if ((bits & 1) === 0) {
    return { displayOrder: ["A", "B"], displayCandidates: candidates };
  }
  return {
    displayOrder: ["B", "A"],
    displayCandidates: [candidates[1], candidates[0]],
  };
}

/** Build a pairwise evaluation record with full provenance. */
export function buildPairwiseRecord(input: {
  pairwiseId: string;
  candidateAId: string;
  candidateBId: string;
  blinded: boolean;
  seed: string;
  judgeManifest: JudgeManifest;
  rubric: SemanticRubric;
  anchorSet?: SemanticAnchorSet;
  forwardVerdict: PairwiseVerdict;
  reverseVerdict?: PairwiseVerdict;
  blindingLimitation?: string;
  evaluatedAt: string;
}): PairwiseEvaluationRecord {
  const { displayOrder } = randomizeDisplayOrder(input.seed, [
    input.candidateAId,
    input.candidateBId,
  ]);
  const disagreement =
    input.reverseVerdict !== undefined
    && !verdictsEqual(input.forwardVerdict, input.reverseVerdict);
  return {
    pairwiseId: input.pairwiseId,
    candidates: [
      {
        candidateLabel: displayOrder[0],
        candidateId: input.candidateAId,
        blinded: input.blinded,
      },
      {
        candidateLabel: displayOrder[1],
        candidateId: input.candidateBId,
        blinded: input.blinded,
      },
    ],
    seed: input.seed,
    displayOrder,
    reverseRepetition: input.reverseVerdict !== undefined,
    forwardVerdict: input.forwardVerdict,
    reverseVerdict: input.reverseVerdict,
    disagreement,
    judgeManifestRef: {
      judgeId: input.judgeManifest.judgeId,
      judgeVersion: input.judgeManifest.version,
    },
    rubricVersionRef: {
      rubricId: input.rubric.rubricId,
      rubricVersion: input.rubric.rubricVersion,
    },
    anchorVersionRef: input.anchorSet
      ? { anchorSetId: input.anchorSet.anchorSetId, anchorVersion: input.anchorSet.version }
      : undefined,
    blindingLimitation: input.blindingLimitation,
    evaluatedAt: input.evaluatedAt,
  };
}

function verdictsEqual(a: PairwiseVerdict, b: PairwiseVerdict): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "preference" && b.kind === "preference") {
    return a.preferred === b.preferred && a.confidence === b.confidence;
  }
  if (a.kind === "degraded" && b.kind === "degraded") {
    return a.verdict === b.verdict;
  }
  return false;
}

// ---------------------------------------------------------------------------
// §4 Anchor stability evaluation
// ---------------------------------------------------------------------------

/** Result of evaluating an anchor against a Judge. */
export interface AnchorEvaluationResult {
  anchorId: string;
  verdict: SemanticVerdict;
  score: string;
  confidence: number;
}

/** Evaluate an anchor set against a Judge. Returns per-anchor results
 *  and whether the expected good > boundary > bad ordering is preserved. */
export function evaluateAnchorOrdering(
  anchors: SemanticAnchor[],
  results: AnchorEvaluationResult[],
): {
  orderingPreserved: boolean;
  violations: string[];
} {
  const byAnchor = new Map(results.map((r) => [r.anchorId, r]));
  const violations: string[] = [];
  // §1 Each anchor's expectedOrderRank must match the rank inferred from
  //    the Judge's confidence.
  const ranked = [...results].sort((a, b) => b.confidence - a.confidence);
  for (let i = 0; i < ranked.length; i++) {
    const anchor = anchors.find((a) => a.anchorId === ranked[i]!.anchorId);
    if (anchor && anchor.expectedOrderRank !== i) {
      violations.push(
        `anchor ${anchor.anchorId} 期望 rank ${anchor.expectedOrderRank}, 实际 ${i}`,
      );
    }
  }
  // §2 Good > Boundary > Bad: good anchors should have higher confidence
  //    than boundary, which should be higher than bad.
  const maxConfidence = (kind: "good" | "bad" | "boundary"): number => {
    const ids = anchors.filter((a) => a.kind === kind).map((a) => a.anchorId);
    const confs = ids
      .map((id) => byAnchor.get(id)?.confidence ?? -1)
      .filter((c) => c >= 0);
    return confs.length > 0 ? Math.max(...confs) : -1;
  };
  const goodMax = maxConfidence("good");
  const boundaryMax = maxConfidence("boundary");
  const badMax = maxConfidence("bad");
  if (goodMax >= 0 && boundaryMax >= 0 && goodMax <= boundaryMax) {
    violations.push(
      `good anchor 最大 confidence ${goodMax} 未高于 boundary ${boundaryMax}`,
    );
  }
  if (boundaryMax >= 0 && badMax >= 0 && boundaryMax <= badMax) {
    violations.push(
      `boundary anchor 最大 confidence ${boundaryMax} 未高于 bad ${badMax}`,
    );
  }
  return {
    orderingPreserved: violations.length === 0,
    violations,
  };
}

/** Repeated anchor evaluation: compute stability across repeats. */
export function computeAnchorStability(
  repeats: AnchorEvaluationResult[][],
  anchors: SemanticAnchor[],
): {
  perAnchor: Array<{
    anchorId: string;
    stability: number;
    verdicts: SemanticVerdict[];
    scores: string[];
  }>;
  overallStability: number;
} {
  const perAnchor = anchors.map((anchor) => {
    const verdicts = repeats.map((r) => {
      const found = r.find((x) => x.anchorId === anchor.anchorId);
      return found ? found.verdict : "needs_review";
    });
    const scores = repeats.map((r) => {
      const found = r.find((x) => x.anchorId === anchor.anchorId);
      return found ? found.score : "";
    });
    // Derive the expected verdict from the anchor kind when not explicitly
    // set: good→pass, bad→fail, boundary→needs_review. A Judge is stable
    // when it consistently produces the verdict the anchor was designed
    // to elicit.
    const expectedVerdict: SemanticVerdict =
      anchor.expectedVerdict
      ?? (anchor.kind === "good"
        ? "pass"
        : anchor.kind === "bad"
          ? "fail"
          : "needs_review");
    const matches = verdicts.filter((v) => v === expectedVerdict).length;
    return {
      anchorId: anchor.anchorId,
      stability: verdicts.length > 0 ? matches / verdicts.length : 0,
      verdicts,
      scores,
    };
  });
  const overallStability =
    perAnchor.length > 0
      ? perAnchor.reduce((sum, a) => sum + a.stability, 0) / perAnchor.length
      : 0;
  return { perAnchor, overallStability };
}

// ---------------------------------------------------------------------------
// §5 Fail-safe decision
// ---------------------------------------------------------------------------

/** Decide the final verdict for a Judge invocation, applying all
 *  fail-safe rules. */
export function applyFailSafe(input: {
  judgeResult: { verdict: SemanticVerdict; reason: string } | null;
  hardGatePassed: boolean;
  independentJudgeAvailable: boolean;
  judgeIdentityConfirmed: boolean;
  onlySameFamilyUncalibrated: boolean;
  judgesConflict: boolean;
  anchorOrderingUnstable: boolean;
  biasMetricsExceeded: boolean;
  judgeTelemetryIncomplete: boolean;
  judgeSchemaUnrepairable: boolean;
  calibrationEvidenceInsufficient: boolean;
}): { finalVerdict: SemanticVerdict; rationale: string; failSafeReason: string | null } {
  // §1 If hard gate failed, semantic cannot offset.
  if (!input.hardGatePassed) {
    return {
      finalVerdict: "fail",
      rationale: "hard gate 失败，semantic 证据不能抵消",
      failSafeReason: null,
    };
  }
  // §2 Check fail-safe conditions.
  const failSafeReason = decideJudgeFailSafe({
    independentJudgeAvailable: input.independentJudgeAvailable,
    judgeIdentityConfirmed: input.judgeIdentityConfirmed,
    onlySameFamilyUncalibrated: input.onlySameFamilyUncalibrated,
    judgesConflict: input.judgesConflict,
    anchorOrderingUnstable: input.anchorOrderingUnstable,
    biasMetricsExceeded: input.biasMetricsExceeded,
    judgeTelemetryIncomplete: input.judgeTelemetryIncomplete,
    judgeSchemaUnrepairable: input.judgeSchemaUnrepairable,
    calibrationEvidenceInsufficient: input.calibrationEvidenceInsufficient,
  });
  if (failSafeReason) {
    return {
      finalVerdict: "needs_review",
      rationale: `fail-safe 触发: ${failSafeReason}`,
      failSafeReason,
    };
  }
  // §3 If the Judge itself failed, return infra_error.
  if (!input.judgeResult) {
    return {
      finalVerdict: "infra_error",
      rationale: "Judge 调用失败或返回 null",
      failSafeReason: null,
    };
  }
  // §4 Validate verdict.
  try {
    assertFrozenVerdict(input.judgeResult.verdict);
  } catch {
    return {
      finalVerdict: "infra_error",
      rationale: `Judge 返回非法 verdict: ${input.judgeResult.verdict}`,
      failSafeReason: null,
    };
  }
  // §5 Combine with hard gate (which already passed at this point).
  const combined = combineHardGateWithSemantic(true, input.judgeResult.verdict);
  return {
    finalVerdict: combined.finalVerdict,
    rationale: combined.rationale,
    failSafeReason: null,
  };
}

// ---------------------------------------------------------------------------
// §6 Schema validation
// ---------------------------------------------------------------------------

/** Validate a Judge's raw output. Returns the parsed verdict or a
 *  degradation reason. */
export function parseJudgeOutput(
  raw: unknown,
): { kind: "ok"; verdict: SemanticVerdict; score: string; reason: string; confidence: number }
| { kind: "schema_invalid"; reason: string }
| { kind: "unrepairable"; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { kind: "schema_invalid", reason: "Judge output 不是 JSON 对象" };
  }
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  if (typeof verdict !== "string" || !FROZEN_SEMANTIC_VERDICTS.includes(verdict as SemanticVerdict)) {
    return {
      kind: "schema_invalid",
      reason: `Judge output verdict 非法: ${String(verdict)}`,
    };
  }
  if (typeof obj.score !== "string" || !obj.score.trim()) {
    return {
      kind: "schema_invalid",
      reason: "Judge output score 缺失或非字符串",
    };
  }
  if (typeof obj.reason !== "string" || !obj.reason.trim()) {
    return {
      kind: "schema_invalid",
      reason: "Judge output reason 缺失或非字符串",
    };
  }
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
    return {
      kind: "schema_invalid",
      reason: "Judge output confidence 必须在 [0, 1] 区间内",
    };
  }
  return {
    kind: "ok",
    verdict: verdict as SemanticVerdict,
    score: obj.score,
    reason: obj.reason,
    confidence: obj.confidence,
  };
}

/** Attempt to repair a schema-invalid Judge output. Returns null when
 *  unrepairable. */
export function attemptJudgeSchemaRepair(
  raw: unknown,
): { verdict: SemanticVerdict; score: string; reason: string; confidence: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  // §1 Try to coerce verdict string.
  let verdict: SemanticVerdict | null = null;
  if (typeof obj.verdict === "string") {
    const v = obj.verdict.toLowerCase();
    if (v === "pass" || v === "ok" || v === "yes") verdict = "pass";
    else if (v === "fail" || v === "no" || v === "bad") verdict = "fail";
    else if (v === "needs_review" || v === "uncertain") verdict = "needs_review";
    else if (v === "infra_error" || v === "error") verdict = "infra_error";
    else if (v === "insufficient_evidence" || v === "insufficient") verdict = "insufficient_evidence";
  }
  if (!verdict) return null;
  // §2 Default missing fields.
  const score = typeof obj.score === "string" && obj.score.trim() ? obj.score : "unknown";
  const reason = typeof obj.reason === "string" && obj.reason.trim()
    ? obj.reason
    : "schema repair applied";
  const confidence = typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
    ? obj.confidence
    : 0;
  return { verdict, score, reason, confidence };
}

// ---------------------------------------------------------------------------
// §7 Acceptance proposal evaluation
// ---------------------------------------------------------------------------

/** Evaluate whether the calibration results meet the acceptance proposal. */
export function evaluateAcceptanceProposal(
  proposal: AcceptanceProposal,
  metrics: {
    anchorOrderingViolationRate: number;
    repeatedStability: number;
    positionBiasPreferenceForFirst: number;
    verbosityBiasCorrelation: number;
    sameFamilyPreferenceRate: number;
    pairwiseDisagreementRate: number;
    repeatedRunFlipRate: number;
  },
): { passed: boolean; failureReasons: string[] } {
  const failures: string[] = [];
  if (metrics.anchorOrderingViolationRate > proposal.anchorOrderingThreshold) {
    failures.push(
      `anchor ordering violation rate ${metrics.anchorOrderingViolationRate} 超过阈值 ${proposal.anchorOrderingThreshold}`,
    );
  }
  if (metrics.repeatedStability < proposal.repeatedStabilityThreshold) {
    failures.push(
      `repeated stability ${metrics.repeatedStability} 低于阈值 ${proposal.repeatedStabilityThreshold}`,
    );
  }
  if (metrics.positionBiasPreferenceForFirst > proposal.positionBiasThreshold) {
    failures.push(
      `position bias ${metrics.positionBiasPreferenceForFirst} 超过阈值 ${proposal.positionBiasThreshold}`,
    );
  }
  if (Math.abs(metrics.verbosityBiasCorrelation) > proposal.verbosityBiasThreshold) {
    failures.push(
      `verbosity bias correlation ${metrics.verbosityBiasCorrelation} 超过阈值 ${proposal.verbosityBiasThreshold}`,
    );
  }
  if (metrics.sameFamilyPreferenceRate > proposal.sameFamilyPreferenceThreshold) {
    failures.push(
      `same-family preference ${metrics.sameFamilyPreferenceRate} 超过阈值 ${proposal.sameFamilyPreferenceThreshold}`,
    );
  }
  if (metrics.pairwiseDisagreementRate > proposal.disagreementRateThreshold) {
    failures.push(
      `pairwise disagreement rate ${metrics.pairwiseDisagreementRate} 超过阈值 ${proposal.disagreementRateThreshold}`,
    );
  }
  if (metrics.repeatedRunFlipRate > proposal.repeatedRunFlipRateThreshold) {
    failures.push(
      `repeated run flip rate ${metrics.repeatedRunFlipRate} 超过阈值 ${proposal.repeatedRunFlipRateThreshold}`,
    );
  }
  return { passed: failures.length === 0, failureReasons: failures };
}

// ---------------------------------------------------------------------------
// §8 Hard gate precedence helpers
// ---------------------------------------------------------------------------

/** The list of ProjectFlow hard gates that semantic evidence cannot offset. */
export const HARD_GATES_THAT_OUTRANK_SEMANTICS = [
  "state_invariant",
  "authority",
  "privacy_visibility",
  "proposal_confirm",
  "terminal_consistency",
  "idempotency",
  "forbidden_side_effect",
  "frozen_p0_gate",
] as const;

/** Compute the final verdict given hard-gate results and semantic verdicts. */
export function computeFinalVerdict(input: {
  hardGateResults: Record<string, boolean>;
  semanticVerdict: SemanticVerdict;
}): { finalVerdict: SemanticVerdict; rationale: string; hardGateFailed: string[] } {
  const failed: string[] = [];
  for (const gate of HARD_GATES_THAT_OUTRANK_SEMANTICS) {
    if (input.hardGateResults[gate] === false) {
      failed.push(gate);
    }
  }
  if (failed.length > 0) {
    return {
      finalVerdict: "fail",
      rationale: `hard gate 失败: ${failed.join(", ")}; semantic 证据不能抵消`,
      hardGateFailed: failed,
    };
  }
  return {
    finalVerdict: input.semanticVerdict,
    rationale: "所有 hard gate 通过，semantic verdict 生效",
    hardGateFailed: [],
  };
}

// ---------------------------------------------------------------------------
// §9 Integrity hash for rubric
// ---------------------------------------------------------------------------

/** Compute the integrity SHA-256 of a rubric (excluding the
 *  `semanticHardGateEligible` field, since that is set by the registry,
 *  not the Judge). */
export function computeRubricIntegritySha256(
  rubric: Omit<SemanticRubric, "semanticHardGateEligible">,
): string {
  return sha256(stableStringify(rubric));
}

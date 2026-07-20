/**
 * T46-6 (Issue #99 §5) — Robustness variant governance.
 *
 * Robustness variants test that the Agent's behavior is stable under
 * semantic-preserving prompt modifications. Variants attach to a
 * canonical scenario and do NOT count toward the canonical total.
 *
 * Supported variant kinds (6):
 *  - semantic-paraphrase: rephrase the prompt without changing meaning
 *  - distraction-injection: add irrelevant context
 *  - description-weakening: make the prompt less specific
 *  - irrelevant-context: reference unrelated prior conversation
 *  - order-variation: reorder multi-part instructions
 *  - bounded-adversarial-wording: use slightly adversarial phrasing
 *
 * Each variant MUST:
 *  - inherit the parent's hidden-goal fingerprint
 *  - NOT change Golden Constraints
 *  - NOT change Reference Program
 *  - NOT count toward canonical scenario total
 *  - be reported separately with robustness delta
 *  - be rejected with `goalChanged: true` if it changes task meaning
 */

import type {
  GoldenCoreScenarioEntry,
  RobustnessVariant,
  RobustnessVariantKind,
} from "./golden-core-contract.js";
import { ROBUSTNESS_VARIANT_KINDS } from "./golden-core-contract.js";
import { EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Hidden-goal fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute the hidden-goal fingerprint for a scenario.
 *
 * The fingerprint is over the scenario's hidden oracle (expectedMode,
 * requiredEvidence, hardGrader constraints). Two scenarios with the
 * same hidden-goal fingerprint have the same oracle.
 *
 * Variants MUST inherit the parent's hidden-goal fingerprint. If a
 * variant's own hidden-goal fingerprint differs, `goalChanged` is set
 * to true and the variant is rejected.
 */
export function computeHiddenGoalFingerprint(
  entry: Pick<GoldenCoreScenarioEntry, "scenario">,
): string {
  const scenario = entry.scenario;
  const hiddenGoal = {
    expectedMode: scenario.hidden.expectedMode,
    expectedSkill: scenario.hidden.expectedSkill ?? null,
    requiredEvidence: scenario.hidden.requiredEvidence ?? [],
    requiredAnyEvidence: (scenario.hidden as { requiredAnyEvidence?: string[] }).requiredAnyEvidence ?? [],
    forbiddenOutputPatterns: scenario.hidden.forbiddenOutputPatterns ?? [],
    forbidRawIds: scenario.hidden.forbidRawIds ?? false,
    maxLatencyMs: scenario.hidden.maxLatencyMs,
    maxRequestCount: scenario.hidden.maxRequestCount,
    hardGrader: scenario.hardGrader ?? null,
  };
  // Use stableStringify (not JSON.stringify) so the fingerprint is
  // deterministic across processes: JSON.stringify field order follows
  // insertion order, which can vary when the same object is constructed
  // by different code paths. stableStringify sorts keys lexicographically.
  return sha256(stableStringify(hiddenGoal));
}

// ---------------------------------------------------------------------------
// §2 Variant builder
// ---------------------------------------------------------------------------

export interface BuildVariantInput {
  parentScenarioId: string;
  parentEntry: GoldenCoreScenarioEntry;
  kind: RobustnessVariantKind;
  variantId: string;
  description: string;
  promptOverride: string;
}

/**
 * Build a robustness variant from a canonical scenario.
 *
 * The variant inherits the parent's hidden-goal fingerprint. If the
 * variant's promptOverride would change the task's true meaning, the
 * caller MUST set `goalChanged: true` and the variant is rejected.
 *
 * This function does NOT automatically detect goal changes — the caller
 * is responsible for verifying the promptOverride preserves the task
 * meaning. The function does verify that the variant's kind is valid
 * and the parent exists.
 */
export function buildRobustnessVariant(input: BuildVariantInput): RobustnessVariant {
  if (!ROBUSTNESS_VARIANT_KINDS.includes(input.kind)) {
    throw new EvaluationValidationError(
      `invalid robustness variant kind: ${input.kind}`,
    );
  }
  if (input.parentEntry.scenarioId !== input.parentScenarioId) {
    throw new EvaluationValidationError(
      `parentScenarioId mismatch: ${input.parentEntry.scenarioId} !== ${input.parentScenarioId}`,
    );
  }
  if (!input.promptOverride.trim()) {
    throw new EvaluationValidationError("promptOverride 不能为空");
  }

  const inheritedHiddenGoalFingerprint = computeHiddenGoalFingerprint(input.parentEntry);

  return {
    variantId: input.variantId,
    parentScenarioId: input.parentScenarioId,
    kind: input.kind,
    description: input.description,
    promptOverride: input.promptOverride,
    inheritedHiddenGoalFingerprint,
    goalChanged: false,
    verified: true,
  };
}

// ---------------------------------------------------------------------------
// §3 Verify variant preserves hidden goal
// ---------------------------------------------------------------------------

/**
 * Verify that a robustness variant preserves the parent's hidden goal.
 *
 * A variant preserves the hidden goal when its parent's hidden-goal
 * fingerprint matches the variant's inherited fingerprint AND the
 * variant's promptOverride does not introduce new oracle-relevant
 * keywords that would change the task meaning.
 *
 * This function does NOT call an LLM — it uses deterministic checks:
 *  - fingerprint match
 *  - keyword overlap between original prompt and variant prompt
 *
 * If the deterministic check fails, `goalChanged` is set to true.
 */
export function verifyVariantPreservesGoal(
  variant: RobustnessVariant,
  parentEntry: GoldenCoreScenarioEntry,
): {
  preserved: boolean;
  reason: string;
  updatedVariant: RobustnessVariant;
} {
  const parentFingerprint = computeHiddenGoalFingerprint(parentEntry);

  if (variant.inheritedHiddenGoalFingerprint !== parentFingerprint) {
    const updated = { ...variant, goalChanged: true, verified: false };
    return {
      preserved: false,
      reason: `hidden-goal fingerprint 不匹配: variant=${variant.inheritedHiddenGoalFingerprint}, parent=${parentFingerprint}`,
      updatedVariant: updated,
    };
  }

  // Deterministic keyword overlap check: the variant prompt should
  // share at least 20% of significant words with the original prompt.
  // This catches cases where the variant prompt is completely unrelated.
  // (The fingerprint check above is authoritative; this is a secondary
  // heuristic for detecting prompt substitution.)
  const originalWords = extractSignificantWords(parentEntry.scenario.visible.prompt);
  const variantWords = extractSignificantWords(variant.promptOverride);
  if (originalWords.size === 0) {
    // Cannot compute overlap; accept (the fingerprint check is authoritative).
    return {
      preserved: true,
      reason: "fingerprint 匹配且原 prompt 无显著关键词",
      updatedVariant: variant,
    };
  }
  const overlap = [...variantWords].filter((w) => originalWords.has(w)).length;
  const overlapRatio = overlap / originalWords.size;
  if (overlapRatio < 0.20) {
    const updated = { ...variant, goalChanged: true, verified: false };
    return {
      preserved: false,
      reason: `prompt 关键词重叠率 ${overlapRatio.toFixed(2)} 低于 0.20 阈值，疑似任务真义已变`,
      updatedVariant: updated,
    };
  }

  return {
    preserved: true,
    reason: `fingerprint 匹配且关键词重叠率 ${overlapRatio.toFixed(2)}`,
    updatedVariant: variant,
  };
}

function extractSignificantWords(text: string): Set<string> {
  // Split on non-word characters (works for both Chinese and English).
  // For Chinese, individual characters are "words"; for English, words
  // separated by spaces/punctuation are words.
  const words = text
    .toLowerCase()
    .split(/[\s,。.!！?？;；:：""''\"'`()（）\[\]{}]+/)
    .filter((w) => w.length >= 2); // filter single chars (noise)
  return new Set(words);
}

// ---------------------------------------------------------------------------
// §4 Variant result reporting
// ---------------------------------------------------------------------------

export interface VariantResult {
  variantId: string;
  parentScenarioId: string;
  kind: RobustnessVariantKind;
  passed: boolean;
  /** Difference between the parent's hard grade and the variant's. */
  robustnessDelta: {
    hardGradeChanged: boolean;
    failureMessagesAdded: string[];
    failureMessagesRemoved: string[];
  };
  goalChanged: boolean;
  verified: boolean;
}

/**
 * Compute the robustness delta between a parent's hard grade and a
 * variant's hard grade.
 *
 * A negative delta (new failures) indicates the variant broke behavior
 * that the parent satisfied. A positive delta (fewer failures) is
 * suspicious — it may indicate the variant is easier than the parent.
 */
export function computeRobustnessDelta(
  parentFailures: string[],
  variantFailures: string[],
): VariantResult["robustnessDelta"] {
  const parentSet = new Set(parentFailures);
  const variantSet = new Set(variantFailures);
  return {
    hardGradeChanged: parentFailures.length !== variantFailures.length
      || !parentFailures.every((f) => variantSet.has(f)),
    failureMessagesAdded: variantFailures.filter((f) => !parentSet.has(f)),
    failureMessagesRemoved: parentFailures.filter((f) => !variantSet.has(f)),
  };
}

// ---------------------------------------------------------------------------
// §5 Variant kind validation
// ---------------------------------------------------------------------------

export function isValidVariantKind(kind: string): kind is RobustnessVariantKind {
  return ROBUSTNESS_VARIANT_KINDS.includes(kind as RobustnessVariantKind);
}

export function listVariantKinds(): readonly RobustnessVariantKind[] {
  return ROBUSTNESS_VARIANT_KINDS;
}

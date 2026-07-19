/**
 * T46-4 (Issue #97 §4) — Single-variable counterfactual.
 *
 * A counterfactual run changes EXACTLY ONE declared factor between a
 * baseline and an intervention. Both sides use isolated runtime, state,
 * artifact, and aligned scenario/seed/standards/model/manifest.
 *
 * Boundary invariants (enforced and tested):
 *  - Only ONE factor may change. Multi-variable changes MUST NOT
 *    promote to `intervention_supported`.
 *  - The resolved model identity MUST be confirmed on both sides. When
 *    it cannot be confirmed (or the two sides resolved to different
 *    models), the result MUST set `modelDriftPossible: true` and
 *    `supportsIntervention: false`.
 *  - Paired manifest SHA-256 captures the alignment (scenario, seed,
 *    standards, evaluator version). The two sides MUST align.
 *  - `changedFactor` and `unchangedFactors` are explicitly recorded.
 *  - When `outcomeChanged` is false (the intervention did not change
 *    the outcome), `supportsIntervention` MUST be false.
 *  - The counterfactual record is stored as immutable evidence in the
 *    SHA-256 result graph.
 *
 * This module owns construction and validation; the actual paired
 * execution reuses the existing `runPairedComparison` isolation
 * primitives from `paired-runner.ts`.
 */

import { createHash } from "node:crypto";
import type {
  CounterfactualFactor,
  CounterfactualOutcome,
  CounterfactualRecord,
  DiagnosisCausalStatus,
} from "./diagnosis-contract.js";
import { EvaluationValidationError } from "./errors.js";
import { sha256 } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Construction
// ---------------------------------------------------------------------------

export interface BuildCounterfactualInput {
  /** Stable counterfactual ID. */
  counterfactualId: string;
  baselineRunId: string;
  interventionRunId: string;
  /** The single factor that was changed. Exactly one. */
  changedFactor: CounterfactualFactor;
  /** Factors that were held unchanged. */
  unchangedFactors: CounterfactualFactor[];
  /** Resolved model identity confirmation. */
  resolvedModelConfirmed: boolean;
  /** Whether model drift is possible. */
  modelDriftPossible: boolean;
  /** Paired manifest SHA-256 (proves scenario/seed/standards alignment). */
  pairedManifestSha256: string;
  /** Baseline outcome. */
  baselineOutcome: CounterfactualOutcome;
  /** Intervention outcome. */
  interventionOutcome: CounterfactualOutcome;
  /** ISO timestamp; defaults to `new Date().toISOString()`. */
  createdAt?: string;
}

/** Construct a counterfactual record. Enforces:
 *  - changedFactor is exactly one factor (the array is one element).
 *  - unchangedFactors do not include the changed factor.
 *  - When model drift is possible, supportsIntervention is false.
 *  - When outcome did not change, supportsIntervention is false.
 *  - pairedManifestSha256 is non-empty.
 */
export function buildCounterfactualRecord(
  input: BuildCounterfactualInput,
): CounterfactualRecord {
  // §1 Validate that exactly one factor changed.
  // The `changedFactor` is a single object by type, but we verify that
  // it is not also listed in `unchangedFactors`.
  const conflict = input.unchangedFactors.find(
    (f) => f.name === input.changedFactor.name,
  );
  if (conflict) {
    throw new EvaluationValidationError(
      `counterfactual 因素 ${input.changedFactor.name} 同时出现在 changedFactor 与 unchangedFactors 中`,
    );
  }
  if (!input.pairedManifestSha256) {
    throw new EvaluationValidationError("counterfactual 缺少 pairedManifestSha256");
  }
  if (input.baselineRunId === input.interventionRunId) {
    throw new EvaluationValidationError(
      "counterfactual baseline 与 intervention 共享 run id；必须使用隔离 runtime",
    );
  }
  if (
    input.baselineOutcome.observationSha256 === input.interventionOutcome.observationSha256
    && input.baselineOutcome.scenarioId === input.interventionOutcome.scenarioId
  ) {
    throw new EvaluationValidationError(
      "counterfactual baseline 与 intervention observation SHA-256 相同；干预未产生可观察差异或未真正执行",
    );
  }
  // §2 outcomeChanged: did the intervention change the outcome?
  const outcomeChanged = outcomesDiffer(input.baselineOutcome, input.interventionOutcome);

  // §3 supportsIntervention: only when ALL conditions hold.
  const rejectionReasons: string[] = [];
  if (!input.resolvedModelConfirmed) {
    rejectionReasons.push("resolved model identity 未确认");
  }
  if (input.modelDriftPossible) {
    rejectionReasons.push("model drift possible");
  }
  if (!outcomeChanged) {
    rejectionReasons.push("intervention 未改变 outcome");
  }
  const supportsIntervention = rejectionReasons.length === 0;
  return {
    counterfactualId: input.counterfactualId,
    baselineRunId: input.baselineRunId,
    interventionRunId: input.interventionRunId,
    changedFactor: input.changedFactor,
    unchangedFactors: [...input.unchangedFactors],
    resolvedModelConfirmed: input.resolvedModelConfirmed,
    modelDriftPossible: input.modelDriftPossible,
    pairedManifestSha256: input.pairedManifestSha256,
    baselineOutcome: input.baselineOutcome,
    interventionOutcome: input.interventionOutcome,
    outcomeChanged,
    supportsIntervention,
    createdAt: input.createdAt ?? new Date().toISOString(),
    rejectionReason: supportsIntervention
      ? undefined
      : rejectionReasons.join("; "),
  };
}

// ---------------------------------------------------------------------------
// §2 Outcome comparison
// ---------------------------------------------------------------------------

/** Return true when the two outcomes differ in a way that supports
 *  causal attribution. Two outcomes that differ only in
 *  `observationSha256` but have the same finalStatus / hardGradePassed
 *  / sideEffectCount are NOT considered different enough to support
 *  causality — the difference must be observable in the grading
 *  dimensions. */
export function outcomesDiffer(
  baseline: CounterfactualOutcome,
  intervention: CounterfactualOutcome,
): boolean {
  if (baseline.finalStatus !== intervention.finalStatus) return true;
  if (baseline.hardGradePassed !== intervention.hardGradePassed) return true;
  if (baseline.sideEffectCount !== intervention.sideEffectCount) return true;
  // Observation SHA-256 differing alone is not enough: the runner may
  // produce slightly different timestamps or non-deterministic field
  // ordering without changing the grading dimensions. We require a
  // grading-relevant difference.
  return false;
}

// ---------------------------------------------------------------------------
// §3 Paired manifest — alignment proof
// ---------------------------------------------------------------------------

export interface PairedManifestAlignment {
  scenarioManifestSha256: string;
  seedManifestSha256: string;
  frozenStandardsVersion: string;
  evaluatorVersion: string;
  /** The declared changed factor (recorded in the manifest so the
   *  alignment proof captures the experiment design, not just the
   *  outcome). */
  changedFactorName: string;
  /** The declared unchanged factors. */
  unchangedFactorNames: string[];
}

/** Compute the paired manifest SHA-256 from the alignment inputs. The
 *  two sides of a counterfactual MUST produce the same manifest SHA-256;
 *  otherwise the experiment is not aligned. */
export function computePairedManifestSha256(
  alignment: PairedManifestAlignment,
): string {
  return sha256(JSON.stringify(alignment));
}

// ---------------------------------------------------------------------------
// §4 Multi-variable guard
// ---------------------------------------------------------------------------

/** Assert that a counterfactual changed exactly one factor. Throws when
 *  multiple factors changed.
 *
 *  This guard is the explicit defence against multi-variable
 *  counterfactuals being silently promoted to `intervention_supported`.
 *  It is also tested directly in the mutation tests. */
export function assertSingleVariable(
  changedFactor: CounterfactualFactor,
  unchangedFactors: CounterfactualFactor[],
  declaredBaseline: Record<string, string>,
  declaredIntervention: Record<string, string>,
): void {
  const changedNames = new Set<string>([changedFactor.name]);
  for (const factor of unchangedFactors) {
    changedNames.add(factor.name);
  }
  // Walk every declared factor in baseline/intervention and verify that
  // only `changedFactor.name` differs.
  const allKeys = new Set<string>([
    ...Object.keys(declaredBaseline),
    ...Object.keys(declaredIntervention),
  ]);
  for (const key of allKeys) {
    const baseline = declaredBaseline[key] ?? "";
    const intervention = declaredIntervention[key] ?? "";
    if (baseline === intervention) continue;
    if (key === changedFactor.name) continue;
    throw new EvaluationValidationError(
      `counterfactual 改变了多个因素: ${key} 也从 "${baseline}" 变为 "${intervention}"；禁止多变量升级`,
    );
  }
  // Verify the changed factor is in the declared set.
  if (!allKeys.has(changedFactor.name)) {
    throw new EvaluationValidationError(
      `counterfactual changedFactor ${changedFactor.name} 未出现在声明的因素集合中`,
    );
  }
}

// ---------------------------------------------------------------------------
// §5 Status promotion guard
// ---------------------------------------------------------------------------

/** Return the diagnosis status that a counterfactual supports.
 *  - `supportsIntervention === true` → `intervention_supported`
 *  - `supportsIntervention === false` AND outcome changed but model
 *    drift → keep `localized_hypothesis` (multi-factor alternative
 *    cannot be separated).
 *  - `supportsIntervention === false` AND outcome did not change →
 *    `unresolved` (the intervention does not support the hypothesis).
 */
export function counterfactualSupportedStatus(
  record: CounterfactualRecord,
): DiagnosisCausalStatus {
  if (record.supportsIntervention) return "intervention_supported";
  if (record.outcomeChanged) return "localized_hypothesis";
  return "unresolved";
}

// ---------------------------------------------------------------------------
// §6 Stable ID helper
// ---------------------------------------------------------------------------

/** Generate a stable counterfactual ID from the inputs. Used so the
 *  immutable artifact hash is reproducible. */
export function stableCounterfactualId(
  baselineRunId: string,
  interventionRunId: string,
  changedFactorName: string,
): string {
  const hash = createHash("sha256")
    .update(`${baselineRunId}|${interventionRunId}|${changedFactorName}`)
    .digest("hex")
    .slice(0, 16);
  return `cf-${hash}`;
}
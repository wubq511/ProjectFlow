/**
 * T46-6 (Issue #99 §7) — Golden Core preset definitions.
 *
 * This module is separated from `presets.ts` to break a circular import:
 *
 *   presets.ts → golden-core-registry.ts → golden-core-scenarios.ts → presets.ts
 *
 * Moving the Golden Core preset definitions here breaks the cycle because
 * `presets.ts` no longer imports from `golden-core-registry.ts`. The
 * `golden-core-scenarios.ts` module continues to import the base
 * `FULL_SCENARIOS` and `SMOKE_V2_REFERENCE_PROGRAMS` from `presets.ts`,
 * which are now initialized before the Golden Core registry is built.
 *
 * Boundary invariants (Issue #99 §7):
 *  - `full` SUT ceiling stays at $1.00.
 *  - `calibrate` SUT ceiling stays at $3.00.
 *  - These numbers only count the ProjectFlow Agent (SUT). Evaluator
 *    Judge/simulator cost lives under its OWN ceiling. Coding Agent cost
 *    stays external/unknown.
 *  - Budget exhaustion stops new observations but retains completed
 *    evidence and partial artifact.
 *  - Unknown cost must NOT be reported as $0.
 *  - Normal CI only runs deterministic/mock presets.
 *  - Paid models are never invoked automatically.
 */

import type { EvaluationBudget } from "./contract.js";
import type {
  AcceptanceProposal,
  CalibrateBudget,
  SemanticAnchorSet,
  SemanticRubric,
  JudgeManifest,
} from "./calibration-contract.js";
import type { ScenarioContract } from "./contract.js";
import {
  GOLDEN_CORE_BUDGET_INVARIANTS,
  type P0ScopeFilterVerification,
} from "./golden-core-contract.js";
import {
  GOLDEN_CORE_REGISTRY,
  GOLDEN_CORE_SCENARIOS,
  GOLDEN_CORE_REFERENCE_PROGRAMS,
  GOLDEN_CORE_P0_SCENARIO_IDS,
  verifyP0ScopeFilter,
} from "./golden-core-registry.js";
import type { GoldenCoreRegistry } from "./golden-core-contract.js";
import { PRESETS_WITH_CALIBRATE } from "./presets.js";

/**
 * The golden-core budget. SUT cap = $1.00 (per Issue #99 §7, same as
 * `full`). Evaluator has its own ceiling. Coding Agent stays external/unknown.
 *
 * `maxObservations` = 60 to allow each of the 52 canonical scenarios to
 * be observed at least once, plus a buffer for robustness variant runs.
 * Budget exhaustion stops new observations but retains completed evidence.
 */
export const GOLDEN_CORE_BUDGET: EvaluationBudget = {
  maxSutCostUsd: GOLDEN_CORE_BUDGET_INVARIANTS.full.maxSutCostUsd,
  maxInputTokens: 3_000_000, // 52 scenarios × ~50k input + buffer
  maxOutputTokens: 480_000,  // 52 scenarios × ~8k output + buffer
  maxRequestCount: 260,      // 52 scenarios × 4 requests + buffer
  maxWallTimeMs: 3_600_000,  // 60 minutes for full canonical suite
  maxObservations: 60,
};

/**
 * Verify that the golden-core preset's budget respects the frozen
 * invariants. Fail-closed if the SUT cost ceiling is raised.
 */
export function verifyGoldenCoreBudgetInvariant(budget: EvaluationBudget): {
  passed: boolean;
  failureReason?: string;
} {
  if (budget.maxSutCostUsd > GOLDEN_CORE_BUDGET_INVARIANTS.full.maxSutCostUsd) {
    return {
      passed: false,
      failureReason: `golden-core budget maxSutCostUsd=${budget.maxSutCostUsd} 超过冻结上限 ${GOLDEN_CORE_BUDGET_INVARIANTS.full.maxSutCostUsd}`,
    };
  }
  if (budget.maxObservations < 52) {
    return {
      passed: false,
      failureReason: `golden-core budget maxObservations=${budget.maxObservations} 不足以覆盖 52 个 canonical scenarios`,
    };
  }
  return { passed: true };
}

/**
 * Verify that a scope filter (e.g., `--scenario`, `--exclude`) does not
 * silently remove P0 mandatory scenarios from the golden-core preset.
 *
 * This is the runtime entry point for Issue #99 §4 P0 scope filter protection.
 * The CLI calls this before running scenarios to ensure P0 coverage is intact.
 */
export function verifyGoldenCoreScopeFilter(
  selectedScenarioIds: string[],
): P0ScopeFilterVerification {
  return verifyP0ScopeFilter(GOLDEN_CORE_REGISTRY, selectedScenarioIds);
}

/**
 * The golden-core preset entry. Uses the 52 canonical scenarios from the
 * TS Golden Core registry. The registry's fingerprint is verified at
 * runtime against the checked-in JSON snapshot (see `verifyRegistry`).
 */
export const GOLDEN_CORE_PRESET_ENTRY = {
  scenarios: GOLDEN_CORE_SCENARIOS,
  budget: GOLDEN_CORE_BUDGET,
  goldenCoreRegistry: GOLDEN_CORE_REGISTRY,
  goldenCoreReferencePrograms: GOLDEN_CORE_REFERENCE_PROGRAMS,
  goldenCoreP0ScenarioIds: GOLDEN_CORE_P0_SCENARIO_IDS,
};

/**
 * Extended preset catalog including golden-core.
 *
 * This merges `PRESETS_WITH_CALIBRATE` (from `presets.ts`) with the
 * `golden-core` preset. The merge happens at module load time, after
 * `presets.ts` has fully initialized — no circular dependency.
 */
export const PRESETS_WITH_GOLDEN_CORE: Record<string, {
  scenarios: ScenarioContract[];
  budget: EvaluationBudget;
  calibrateBudget?: CalibrateBudget;
  acceptanceProposal?: AcceptanceProposal;
  anchorSets?: SemanticAnchorSet[];
  rubrics?: SemanticRubric[];
  judgeManifest?: JudgeManifest;
  goldenCoreRegistry?: GoldenCoreRegistry;
  goldenCoreReferencePrograms?: typeof GOLDEN_CORE_REFERENCE_PROGRAMS;
  goldenCoreP0ScenarioIds?: typeof GOLDEN_CORE_P0_SCENARIO_IDS;
}> = {
  ...PRESETS_WITH_CALIBRATE,
  "golden-core": GOLDEN_CORE_PRESET_ENTRY,
};

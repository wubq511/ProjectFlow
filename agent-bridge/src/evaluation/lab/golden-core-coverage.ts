/**
 * T46-6 (Issue #99 §2) — Golden Core coverage matrix report.
 *
 * Generates a comprehensive coverage report from the Golden Core registry.
 * The report is NOT a single coverage percentage — it shows:
 *  - canonical scenario count
 *  - capability × class coverage matrix
 *  - P0/P1/P2 distribution
 *  - normal/negative/boundary etc. class distribution
 *  - hard-gate coverage (which graders are exercised by which scenarios)
 *  - mutation coverage (declared vs detected per scenario)
 *  - reference solvability
 *  - exclusions, skips, errors
 *  - missing coverage and duplicate risks
 */

import {
  GOLDEN_CORE_SCHEMA_VERSION,
  GOLDEN_CORE_SUITE_VERSION,
  type GoldenCoreRegistry,
  type CoverageMatrixReport,
  type CoverageCell,
  type CoverageGap,
  type DuplicateRisk,
} from "./golden-core-contract.js";
import {
  CAPABILITY_DOMAINS,
  SCENARIO_CLASSES,
  P0_MANDATORY_CATEGORIES,
} from "./golden-core-contract.js";
import { detectDuplicateRisks } from "./golden-core-registry.js";
import { stableStringify } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Hard grader → scenario coverage
// ---------------------------------------------------------------------------

/**
 * Map each hard grader to the scenarios that exercise it.
 *
 * A scenario "exercises" a grader when its HardGraderContract declares
 * the relevant constraint (e.g., a scenario with `proposalConfirm`
 * exercises the `proposalConfirm` grader).
 */
function computeHardGateCoverage(registry: GoldenCoreRegistry): CoverageMatrixReport["hardGateCoverage"] {
  const graderToScenarios = new Map<string, string[]>();

  function add(graderName: string, scenarioId: string): void {
    const list = graderToScenarios.get(graderName) ?? [];
    if (!list.includes(scenarioId)) list.push(scenarioId);
    graderToScenarios.set(graderName, list);
  }

  for (const entry of registry.canonical) {
    const hg = entry.scenario.hardGrader;
    if (!hg) continue;
    const sid = entry.scenarioId;

    if (hg.run) add("finalOutcome", sid);
    if (hg.stateConstraints) add("stateConstraints", sid);
    if (hg.milestoneDag) add("milestoneDag", sid);
    if (hg.authoritySafety?.proposalConfirm) add("proposalConfirm", sid);
    if (hg.authoritySafety?.prohibitedCommitEffectTools?.length) add("prohibitedCommitEffects", sid);
    if (hg.authoritySafety?.allowedSideEffectTypes?.length) add("unknownSideEffects", sid);
    if (hg.idempotency) add("idempotency", sid);
    if (hg.readOnlyStatePurity) add("readOnlyStatePurity", sid);
    if (hg.run) add("terminalEventConsistency", sid);
    if (hg.privacy?.adversaryCannotSeeConversationIds || hg.privacy?.subjectAndOwnerHiddenFromAdversary) {
      add("privateConversationVisibility", sid);
    }
    if (hg.viewer?.adversaryUserId && hg.privacy) add("teamHistoryVisibility", sid);
    if (hg.viewer?.adversaryUserId && hg.privacy) add("projectMemoryVisibility", sid);
    if (hg.privacy?.subjectAndOwnerHiddenFromAdversary || hg.privacy?.adversaryCannotSeeMemoryIds) {
      add("subjectAndOwnerPrivacy", sid);
    }
    if (hg.privacy?.forbidRawIdsInOutput) add("rawIdLeakage", sid);
    if (hg.privacy?.hiddenFieldTokens?.length) add("hiddenFieldLeakage", sid);
  }

  return [...graderToScenarios.entries()]
    .map(([graderName, scenarioIds]) => ({
      graderName,
      scenarioIds: [...scenarioIds].sort(),
      count: scenarioIds.length,
    }))
    .sort((a, b) => a.graderName.localeCompare(b.graderName));
}

// ---------------------------------------------------------------------------
// §2 Mutation coverage
// ---------------------------------------------------------------------------

function computeMutationCoverage(registry: GoldenCoreRegistry): CoverageMatrixReport["mutationCoverage"] {
  return registry.canonical.map((entry) => {
    const ev = entry.entryConditions.mutationDetectionEvidence;
    return {
      scenarioId: entry.scenarioId,
      declared: ev.declared,
      detected: ev.detected,
      missedMutationIds: [...ev.missedMutationIds],
      fullyDetected: ev.declared === ev.detected,
    };
  });
}

// ---------------------------------------------------------------------------
// §3 Reference solvability
// ---------------------------------------------------------------------------

function computeReferenceSolvability(registry: GoldenCoreRegistry): CoverageMatrixReport["referenceSolvability"] {
  return registry.canonical.map((entry) => ({
    scenarioId: entry.scenarioId,
    referenceProgramId: entry.referenceProgram.id,
    solvable: true, // TS-declared; actual solvability verified by running the reference
    hardFalseFailures: 0, // Populated by the runner when a real run is executed
  }));
}

// ---------------------------------------------------------------------------
// §4 Coverage gaps
// ---------------------------------------------------------------------------

function computeCoverageGaps(registry: GoldenCoreRegistry): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  // §4.1 Missing capability × class cells.
  const matrix = computeCapabilityClassMatrix(registry);
  for (const cell of matrix) {
    if (cell.count === 0) {
      gaps.push({
        kind: "missing-capability-class",
        description: `capability "${cell.capability}" × class "${cell.scenarioClass}" 无覆盖场景`,
        affected: [],
      });
    }
  }

  // §4.2 Missing P0 mandatory categories.
  const p0Covered = new Set<string>();
  for (const entry of registry.canonical) {
    for (const cat of entry.p0Categories) p0Covered.add(cat);
  }
  for (const cat of P0_MANDATORY_CATEGORIES) {
    if (!p0Covered.has(cat)) {
      gaps.push({
        kind: "missing-p0-category",
        description: `P0 必需类别 "${cat}" 无覆盖场景`,
        affected: [],
      });
    }
  }

  // §4.3 Low mutation detection.
  for (const entry of registry.canonical) {
    const ev = entry.entryConditions.mutationDetectionEvidence;
    if (ev.declared > 0 && ev.detected < ev.declared) {
      gaps.push({
        kind: "low-mutation-detection",
        description: `场景 ${entry.scenarioId} 的 mutation 检测率 ${ev.detected}/${ev.declared}`,
        affected: [entry.scenarioId],
      });
    }
  }

  // §4.4 Unsolvable references.
  for (const entry of registry.canonical) {
    if (!entry.referenceProgram?.id) {
      gaps.push({
        kind: "unsolvable-reference",
        description: `场景 ${entry.scenarioId} 缺少 Reference Program`,
        affected: [entry.scenarioId],
      });
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// §5 Capability × class matrix
// ---------------------------------------------------------------------------

function computeCapabilityClassMatrix(registry: GoldenCoreRegistry): CoverageCell[] {
  const cells: CoverageCell[] = [];
  for (const capability of CAPABILITY_DOMAINS) {
    for (const scenarioClass of SCENARIO_CLASSES) {
      const scenarioIds = registry.canonical
        .filter(
          (e) => e.capability === capability && e.scenarioClass === scenarioClass,
        )
        .map((e) => e.scenarioId)
        .sort();
      cells.push({
        capability,
        scenarioClass,
        scenarioIds,
        count: scenarioIds.length,
      });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// §6 Main report generator
// ---------------------------------------------------------------------------

/**
 * Generate the full coverage matrix report from the Golden Core registry.
 *
 * The report is deterministic: the same registry always produces the same
 * report. The report is suitable for machine-readable artifact publishing.
 */
export function generateCoverageReport(
  registry: GoldenCoreRegistry,
  options: {
    generatedAt?: string;
    exclusions?: Array<{ scenarioId: string; reason: string }>;
    skips?: Array<{ scenarioId: string; reason: string }>;
    errors?: Array<{ scenarioId: string; code: string; message: string }>;
  } = {},
): CoverageMatrixReport {
  const canonical = registry.canonical;

  // Capability distribution.
  const capabilityDistribution = CAPABILITY_DOMAINS.map((capability) => {
    const scenarioIds = canonical
      .filter((e) => e.capability === capability)
      .map((e) => e.scenarioId)
      .sort();
    return { capability, scenarioIds, count: scenarioIds.length };
  });

  // Class distribution.
  const classDistribution = SCENARIO_CLASSES.map((scenarioClass) => {
    const scenarioIds = canonical
      .filter((e) => e.scenarioClass === scenarioClass)
      .map((e) => e.scenarioId)
      .sort();
    return { scenarioClass, scenarioIds, count: scenarioIds.length };
  });

  // Priority distribution.
  const priorityDistribution = {
    P0: canonical.filter((e) => e.priority === "P0").length,
    P1: canonical.filter((e) => e.priority === "P1").length,
    P2: canonical.filter((e) => e.priority === "P2").length,
  };

  // P0 category coverage.
  const p0CategoryCoverage = P0_MANDATORY_CATEGORIES.map((category) => {
    const scenarioIds = canonical
      .filter((e) => e.p0Categories.includes(category))
      .map((e) => e.scenarioId)
      .sort();
    return { category, scenarioIds, covered: scenarioIds.length > 0 };
  });

  // Robustness variant count.
  const robustnessVariantCount = canonical.reduce(
    (sum, e) => sum + e.robustnessVariants.length,
    0,
  );

  // Duplicate risks.
  const duplicateRisks: DuplicateRisk[] = detectDuplicateRisks(canonical);

  return {
    schemaVersion: GOLDEN_CORE_SCHEMA_VERSION,
    suiteVersion: GOLDEN_CORE_SUITE_VERSION,
    registryFingerprint: registry.fingerprint,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    canonicalCount: canonical.length,
    candidateCount: registry.candidates.length,
    rejectedCount: registry.rejected.length,
    robustnessVariantCount,
    capabilityClassMatrix: computeCapabilityClassMatrix(registry),
    capabilityDistribution,
    classDistribution,
    priorityDistribution,
    p0CategoryCoverage,
    hardGateCoverage: computeHardGateCoverage(registry),
    mutationCoverage: computeMutationCoverage(registry),
    referenceSolvability: computeReferenceSolvability(registry),
    gaps: computeCoverageGaps(registry),
    duplicateRisks,
    exclusions: options.exclusions ?? [],
    skips: options.skips ?? [],
    errors: options.errors ?? [],
  };
}

// ---------------------------------------------------------------------------
// §7 Coverage report fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute a stable fingerprint over the coverage report.
 *
 * This is used to detect report drift: if the registry changes, the
 * report fingerprint changes. The report fingerprint is part of the
 * immutable artifact.
 */
export function computeCoverageReportFingerprint(report: CoverageMatrixReport): string {
  // Exclude generatedAt (non-deterministic) and dynamic arrays that are
  // already captured by the registry fingerprint.
  const stable = {
    schemaVersion: report.schemaVersion,
    suiteVersion: report.suiteVersion,
    registryFingerprint: report.registryFingerprint,
    canonicalCount: report.canonicalCount,
    candidateCount: report.candidateCount,
    rejectedCount: report.rejectedCount,
    robustnessVariantCount: report.robustnessVariantCount,
    capabilityClassMatrix: report.capabilityClassMatrix,
    capabilityDistribution: report.capabilityDistribution,
    classDistribution: report.classDistribution,
    priorityDistribution: report.priorityDistribution,
    p0CategoryCoverage: report.p0CategoryCoverage,
    hardGateCoverage: report.hardGateCoverage,
    mutationCoverage: report.mutationCoverage,
    referenceSolvability: report.referenceSolvability,
    gaps: report.gaps,
    duplicateRisks: report.duplicateRisks,
  };
  return stableStringify(stable);
}

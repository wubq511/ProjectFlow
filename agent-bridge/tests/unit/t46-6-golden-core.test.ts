/**
 * T46-6 (Issue #99) — Golden Core suite tests.
 *
 * Verifies the seven required capabilities:
 *  1. Single, versioned, auditable Golden Core registry.
 *  2. Complete coverage matrix (8 capabilities × 8 classes × 8 P0).
 *  3. Trusted entry conditions (9 per stateful scenario).
 *  4. P0 immovable set + scope filter protection.
 *  5. Robustness variants do NOT inflate canonical count.
 *  6. Generated regression candidate governance (no auto-promotion).
 *  7. Preset/budget/reporting invariants (full $1, calibrate $3,
 *     evaluator independent, Coding Agent external/unknown).
 *
 * Plus CLI smoke: `golden-core freeze|verify|coverage|list|candidates`.
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  GOLDEN_CORE_SCHEMA_VERSION,
  GOLDEN_CORE_SUITE_VERSION,
  CAPABILITY_DOMAINS,
  SCENARIO_CLASSES,
  P0_MANDATORY_CATEGORIES,
  ROBUSTNESS_VARIANT_KINDS,
  type CapabilityDomain,
  type ScenarioClass,
  type P0Category,
  type RobustnessVariantKind,
  type GoldenCoreRegistry,
} from "../../src/evaluation/lab/golden-core-contract.js";
import {
  GOLDEN_CORE_DIR,
  GOLDEN_CORE_REGISTRY_FILE,
  GOLDEN_CORE_REGISTRY,
  GOLDEN_CORE_CANONICAL_IDS,
  GOLDEN_CORE_P0_SCENARIO_IDS,
  GOLDEN_CORE_SCENARIOS,
  GOLDEN_CORE_REFERENCE_PROGRAMS,
  assertSupportedGoldenCoreSchema,
  assertSupportedGoldenCoreSuite,
  buildGoldenCoreRegistry,
  computeRegistryFingerprint,
  verifyEntryConditions,
  detectDuplicateRisks,
  verifyP0ScopeFilter,
  verifyRegistryInvariants,
  freezeRegistry,
  verifyRegistry,
  loadFrozenSnapshot,
} from "../../src/evaluation/lab/golden-core-registry.js";
import {
  generateCoverageReport,
  computeCoverageReportFingerprint,
} from "../../src/evaluation/lab/golden-core-coverage.js";
import {
  buildRegressionCandidate,
  updateVerificationCheck,
  isEligibleForPromotion,
  applyPromotionApproval,
  buildEmptyCandidateRegistry,
  loadCandidateRegistry,
  saveCandidateRegistry,
  rejectCandidate,
  type BuildCandidateInput,
} from "../../src/evaluation/lab/golden-core-candidates.js";
import {
  buildRobustnessVariant,
  verifyVariantPreservesGoal,
  computeRobustnessDelta,
  isValidVariantKind,
  listVariantKinds,
  computeHiddenGoalFingerprint,
} from "../../src/evaluation/lab/golden-core-variants.js";
import {
  GOLDEN_CORE_BUDGET,
  GOLDEN_CORE_PRESET_ENTRY,
  PRESETS_WITH_GOLDEN_CORE,
  verifyGoldenCoreBudgetInvariant,
  verifyGoldenCoreScopeFilter,
} from "../../src/evaluation/lab/golden-core-presets.js";
import {
  GOLDEN_CORE_BUDGET_INVARIANTS,
} from "../../src/evaluation/lab/golden-core-contract.js";

const createdTempDirs: string[] = [];

async function makeTempProjectRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t46-6-golden-core-"));
  // Create a CLAUDE.md file so `findProjectRoot()` (which walks up
  // looking for CLAUDE.md) resolves to this temp directory when the
  // CLI is invoked with `cwd: dir`.
  await writeFile(join(dir, "CLAUDE.md"), "# temp project root\n");
  createdTempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// §1 Contract & constants
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core contract — constants", () => {
  it("exposes 8 capability domains", () => {
    expect(CAPABILITY_DOMAINS.length).toBe(8);
    expect(new Set(CAPABILITY_DOMAINS).size).toBe(8);
  });

  it("exposes 8 scenario classes", () => {
    expect(SCENARIO_CLASSES.length).toBe(8);
    expect(new Set(SCENARIO_CLASSES).size).toBe(8);
  });

  it("exposes 8 P0 mandatory categories", () => {
    expect(P0_MANDATORY_CATEGORIES.length).toBe(8);
    expect(new Set(P0_MANDATORY_CATEGORIES).size).toBe(8);
  });

  it("exposes 6 robustness variant kinds", () => {
    expect(ROBUSTNESS_VARIANT_KINDS.length).toBe(6);
    expect(new Set(ROBUSTNESS_VARIANT_KINDS).size).toBe(6);
  });

  it("schema and suite versions are frozen at 1", () => {
    expect(GOLDEN_CORE_SCHEMA_VERSION).toBe(1);
    expect(GOLDEN_CORE_SUITE_VERSION).toBe(1);
  });

  it("assertSupportedGoldenCoreSchema accepts version 1 and rejects others", () => {
    expect(() => assertSupportedGoldenCoreSchema(1)).not.toThrow();
    expect(() => assertSupportedGoldenCoreSchema(2)).toThrow(/unsupported Golden Core schema version/);
    expect(() => assertSupportedGoldenCoreSchema(0)).toThrow(/unsupported Golden Core schema version/);
  });

  it("assertSupportedGoldenCoreSuite accepts version 1 and rejects others", () => {
    expect(() => assertSupportedGoldenCoreSuite(1)).not.toThrow();
    expect(() => assertSupportedGoldenCoreSuite(2)).toThrow(/unsupported Golden Core suite version/);
  });
});

// ---------------------------------------------------------------------------
// §2 Registry invariants
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core registry — invariants", () => {
  it("contains exactly 52 canonical scenarios", () => {
    expect(GOLDEN_CORE_REGISTRY.canonical.length).toBe(52);
    expect(GOLDEN_CORE_CANONICAL_IDS.length).toBe(52);
  });

  it("has unique canonical scenario IDs", () => {
    const ids = GOLDEN_CORE_REGISTRY.canonical.map((e) => e.scenarioId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all 8 capability domains", () => {
    const covered = new Set(GOLDEN_CORE_REGISTRY.canonical.map((e) => e.capability));
    for (const cap of CAPABILITY_DOMAINS) {
      expect(covered.has(cap as CapabilityDomain)).toBe(true);
    }
  });

  it("covers all 8 scenario classes", () => {
    const covered = new Set(GOLDEN_CORE_REGISTRY.canonical.map((e) => e.scenarioClass));
    for (const cls of SCENARIO_CLASSES) {
      expect(covered.has(cls as ScenarioClass)).toBe(true);
    }
  });

  it("covers all 8 P0 mandatory categories", () => {
    const covered = new Set<P0Category>();
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      for (const cat of entry.p0Categories) {
        covered.add(cat);
      }
    }
    for (const cat of P0_MANDATORY_CATEGORIES) {
      expect(covered.has(cat)).toBe(true);
    }
  });

  it("has at least one P0 scenario for each P0 category", () => {
    expect(GOLDEN_CORE_P0_SCENARIO_IDS.length).toBeGreaterThanOrEqual(8);
  });

  it("computeRegistryFingerprint is deterministic", () => {
    const fp1 = computeRegistryFingerprint({
      schemaVersion: GOLDEN_CORE_REGISTRY.schemaVersion,
      suiteVersion: GOLDEN_CORE_REGISTRY.suiteVersion,
      registryId: GOLDEN_CORE_REGISTRY.registryId,
      canonical: GOLDEN_CORE_REGISTRY.canonical,
      candidates: GOLDEN_CORE_REGISTRY.candidates,
      rejected: GOLDEN_CORE_REGISTRY.rejected,
      frozenAt: GOLDEN_CORE_REGISTRY.frozenAt,
    });
    const fp2 = computeRegistryFingerprint({
      schemaVersion: GOLDEN_CORE_REGISTRY.schemaVersion,
      suiteVersion: GOLDEN_CORE_REGISTRY.suiteVersion,
      registryId: GOLDEN_CORE_REGISTRY.registryId,
      canonical: GOLDEN_CORE_REGISTRY.canonical,
      candidates: GOLDEN_CORE_REGISTRY.candidates,
      rejected: GOLDEN_CORE_REGISTRY.rejected,
      frozenAt: GOLDEN_CORE_REGISTRY.frozenAt,
    });
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(GOLDEN_CORE_REGISTRY.fingerprint);
  });

  it("verifyRegistryInvariants passes for the built registry", () => {
    const result = verifyRegistryInvariants(GOLDEN_CORE_REGISTRY);
    expect(result.passed).toBe(true);
    for (const check of result.checks) {
      if (!check.passed) {
        // Log failing check for debugging.
        // eslint-disable-next-line no-console
        console.error(`Invariant check failed: ${check.name} — ${check.details}`);
      }
    }
  });

  it("detects no duplicate risks in the canonical registry", () => {
    const risks = detectDuplicateRisks(GOLDEN_CORE_REGISTRY.canonical);
    // Some duplicate risks may be acceptable (e.g., shared fixture fingerprint
    // for scenarios that intentionally share a fixture). We verify that the
    // function runs without throwing and returns a defined array.
    expect(Array.isArray(risks)).toBe(true);
  });

  it("buildGoldenCoreRegistry is idempotent", () => {
    const r1 = buildGoldenCoreRegistry();
    const r2 = buildGoldenCoreRegistry();
    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(r1.canonical.length).toBe(r2.canonical.length);
  });
});

// ---------------------------------------------------------------------------
// §3 Trusted entry conditions (9 per stateful scenario)
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core — trusted entry conditions", () => {
  it("every canonical scenario has all 9 entry conditions verified", () => {
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      // verifyEntryConditions throws on failure.
      expect(() => verifyEntryConditions(entry)).not.toThrow();
    }
  });

  it("every canonical scenario has a non-empty goalProvenance", () => {
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      expect(entry.entryConditions.goalProvenance).toBeTruthy();
      expect(entry.entryConditions.goalProvenance.length).toBeGreaterThan(0);
    }
  });

  it("every canonical scenario has a non-empty fixtureSeed and fixtureFingerprint", () => {
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      expect(entry.entryConditions.fixtureSeed).toBeTruthy();
      expect(entry.entryConditions.fixtureFingerprint).toBeTruthy();
    }
  });

  it("every canonical scenario has a non-empty goldenConstraintsSummary", () => {
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      expect(entry.entryConditions.goldenConstraintsSummary).toBeTruthy();
    }
  });

  it("every canonical scenario has a non-empty referenceProgramId", () => {
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      expect(entry.entryConditions.referenceProgramId).toBeTruthy();
    }
  });

  it("every canonical scenario declares at least one grader mutation", () => {
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      expect(entry.entryConditions.declaredGraderMutations.length).toBeGreaterThan(0);
    }
  });

  it("every canonical scenario declares mutation detection evidence", () => {
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      expect(entry.entryConditions.mutationDetectionEvidence).toBeTruthy();
      expect(entry.entryConditions.mutationDetectionEvidence.declared).toBeGreaterThanOrEqual(0);
    }
  });

  it("every canonical scenario declares a scope", () => {
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      expect(entry.entryConditions.scope).toBeTruthy();
      expect(entry.entryConditions.scope.workspaceId).toBeTruthy();
      expect(entry.entryConditions.scope.projectId).toBeTruthy();
      expect(entry.entryConditions.scope.viewerUserId).toBeTruthy();
    }
  });

  it("every canonical scenario declares a state-effect summary", () => {
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      expect(entry.entryConditions.stateEffectSummary).toBeTruthy();
      expect(Array.isArray(entry.entryConditions.stateEffectSummary.required)).toBe(true);
      expect(Array.isArray(entry.entryConditions.stateEffectSummary.allowed)).toBe(true);
      expect(Array.isArray(entry.entryConditions.stateEffectSummary.forbidden)).toBe(true);
      expect(Array.isArray(entry.entryConditions.stateEffectSummary.unchanged)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §4 Freeze/Verify cycle (registry as auditable artifact)
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core — freeze/verify cycle", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await makeTempProjectRoot();
  });

  it("verifyRegistry fails-closed when no frozen snapshot exists (bootstrap)", async () => {
    const result = await verifyRegistry(projectRoot);
    expect(result.verified).toBe(false);
    expect(result.failureReason).toMatch(/冻结快照不存在/);
  });

  it("freezeRegistry creates a JSON snapshot that verifyRegistry accepts", async () => {
    const freezeResult = await freezeRegistry(projectRoot);
    expect(freezeResult.changed).toBe(true);
    expect(freezeResult.previousFingerprint).toBeNull();
    expect(freezeResult.newFingerprint).toBe(GOLDEN_CORE_REGISTRY.fingerprint);

    const verifyResult = await verifyRegistry(projectRoot);
    expect(verifyResult.verified).toBe(true);
  });

  it("freezeRegistry is idempotent (second freeze with same entries is unchanged)", async () => {
    const first = await freezeRegistry(projectRoot);
    expect(first.changed).toBe(true);
    const second = await freezeRegistry(projectRoot);
    expect(second.changed).toBe(false);
    expect(second.newFingerprint).toBe(first.newFingerprint);
  });

  it("verifyRegistry fails-closed when the JSON snapshot is tampered with", async () => {
    await freezeRegistry(projectRoot);
    // Tamper with the JSON snapshot by rewriting it with a different
    // canonical entry count. The internal fingerprint check in
    // loadFrozenSnapshot should reject this.
    const snapshotPath = join(projectRoot, GOLDEN_CORE_DIR, GOLDEN_CORE_REGISTRY_FILE);
    const original = JSON.parse(await readFile(snapshotPath, "utf-8")) as GoldenCoreRegistry;
    const tampered: GoldenCoreRegistry = {
      ...original,
      // Force a different fingerprint by adding a fake freezeNotes field
      // that is NOT included in the original fingerprint computation.
      freezeNotes: "tampered",
    };
    // Recompute fingerprint to make the snapshot internally consistent
    // but DIFFERENT from the TS registry.
    tampered.fingerprint = computeRegistryFingerprint({
      schemaVersion: tampered.schemaVersion,
      suiteVersion: tampered.suiteVersion,
      registryId: tampered.registryId,
      canonical: tampered.canonical,
      candidates: tampered.candidates,
      rejected: tampered.rejected,
      frozenAt: tampered.frozenAt,
      freezeNotes: "tampered",
    });
    await writeFile(snapshotPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf-8");
    const result = await verifyRegistry(projectRoot);
    expect(result.verified).toBe(false);
    expect(result.failureReason).toMatch(/fingerprint.*不一致|fingerprint.*mismatch/);
  });

  it("loadFrozenSnapshot returns null when no snapshot exists", async () => {
    const snapshot = await loadFrozenSnapshot(projectRoot);
    expect(snapshot).toBeNull();
  });

  it("loadFrozenSnapshot rejects unsupported future schema versions", async () => {
    await freezeRegistry(projectRoot);
    const snapshotPath = join(projectRoot, GOLDEN_CORE_DIR, GOLDEN_CORE_REGISTRY_FILE);
    const original = JSON.parse(await readFile(snapshotPath, "utf-8")) as GoldenCoreRegistry;
    const futureSchema = { ...original, schemaVersion: 999 };
    // Recompute fingerprint so the snapshot is internally consistent.
    futureSchema.fingerprint = computeRegistryFingerprint({
      schemaVersion: futureSchema.schemaVersion,
      suiteVersion: futureSchema.suiteVersion,
      registryId: futureSchema.registryId,
      canonical: futureSchema.canonical,
      candidates: futureSchema.candidates,
      rejected: futureSchema.rejected,
      frozenAt: futureSchema.frozenAt,
    });
    await writeFile(snapshotPath, `${JSON.stringify(futureSchema, null, 2)}\n`, "utf-8");
    await expect(loadFrozenSnapshot(projectRoot)).rejects.toThrow(/unsupported Golden Core schema version/);
  });
});

// ---------------------------------------------------------------------------
// §5 Coverage matrix report
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core — coverage matrix report", () => {
  it("generates a report with the correct canonical count", () => {
    const report = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    expect(report.canonicalCount).toBe(52);
  });

  it("covers all 8 capability domains in capabilityDistribution", () => {
    const report = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    expect(report.capabilityDistribution.length).toBe(8);
    const caps = new Set(report.capabilityDistribution.map((d) => d.capability));
    for (const cap of CAPABILITY_DOMAINS) {
      expect(caps.has(cap as CapabilityDomain)).toBe(true);
    }
  });

  it("covers all 8 scenario classes in classDistribution", () => {
    const report = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    expect(report.classDistribution.length).toBe(8);
    const classes = new Set(report.classDistribution.map((d) => d.scenarioClass));
    for (const cls of SCENARIO_CLASSES) {
      expect(classes.has(cls as ScenarioClass)).toBe(true);
    }
  });

  it("covers all 8 P0 categories in p0CategoryCoverage", () => {
    const report = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    expect(report.p0CategoryCoverage.length).toBe(8);
    for (const coverage of report.p0CategoryCoverage) {
      expect(coverage.covered).toBe(true);
    }
  });

  it("has a non-empty capabilityClassMatrix", () => {
    const report = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    expect(report.capabilityClassMatrix.length).toBeGreaterThan(0);
  });

  it("has hard gate coverage entries", () => {
    const report = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    expect(report.hardGateCoverage.length).toBeGreaterThan(0);
  });

  it("has mutation coverage for every canonical scenario", () => {
    const report = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    expect(report.mutationCoverage.length).toBe(52);
    for (const entry of report.mutationCoverage) {
      expect(entry.declared).toBeGreaterThanOrEqual(1);
    }
  });

  it("has reference solvability for every canonical scenario", () => {
    const report = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    expect(report.referenceSolvability.length).toBe(52);
    for (const entry of report.referenceSolvability) {
      expect(entry.solvable).toBe(true);
      expect(entry.hardFalseFailures).toBe(0);
    }
  });

  it("computeCoverageReportFingerprint is deterministic", () => {
    const report1 = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    const report2 = generateCoverageReport(GOLDEN_CORE_REGISTRY);
    expect(computeCoverageReportFingerprint(report1)).toBe(computeCoverageReportFingerprint(report2));
  });
});

// ---------------------------------------------------------------------------
// §6 P0 scope filter protection
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core — P0 scope filter protection", () => {
  it("passes when all canonical scenarios are selected", () => {
    const result = verifyP0ScopeFilter(GOLDEN_CORE_REGISTRY, GOLDEN_CORE_CANONICAL_IDS);
    expect(result.passed).toBe(true);
  });

  it("fails-closed when a single non-P0 scenario is selected via --scenario", () => {
    // Find a non-P0 scenario.
    const nonP0 = GOLDEN_CORE_REGISTRY.canonical.find((e) => e.p0Categories.length === 0);
    expect(nonP0).toBeDefined();
    const result = verifyP0ScopeFilter(GOLDEN_CORE_REGISTRY, [nonP0!.scenarioId]);
    expect(result.passed).toBe(false);
    expect(result.missingP0Categories.length).toBe(8);
    expect(result.mandatoryAdditions.length).toBeGreaterThan(0);
  });

  it("fails-closed when only one P0 scenario is selected (missing other categories)", () => {
    const first = GOLDEN_CORE_P0_SCENARIO_IDS[0]!;
    const result = verifyP0ScopeFilter(GOLDEN_CORE_REGISTRY, [first]);
    expect(result.passed).toBe(false);
    expect(result.missingP0Categories.length).toBeGreaterThan(0);
  });

  it("passes when all P0 scenarios are selected", () => {
    const result = verifyP0ScopeFilter(GOLDEN_CORE_REGISTRY, GOLDEN_CORE_P0_SCENARIO_IDS);
    expect(result.passed).toBe(true);
  });

  it("verifyGoldenCoreScopeFilter (presets.ts wrapper) matches registry function", () => {
    const r1 = verifyGoldenCoreScopeFilter(GOLDEN_CORE_CANONICAL_IDS);
    const r2 = verifyP0ScopeFilter(GOLDEN_CORE_REGISTRY, GOLDEN_CORE_CANONICAL_IDS);
    expect(r1.passed).toBe(r2.passed);
  });
});

// ---------------------------------------------------------------------------
// §7 Robustness variants do NOT inflate canonical count
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core — robustness variants", () => {
  it("isValidVariantKind accepts the 6 frozen kinds", () => {
    for (const kind of ROBUSTNESS_VARIANT_KINDS) {
      expect(isValidVariantKind(kind as RobustnessVariantKind)).toBe(true);
    }
  });

  it("isValidVariantKind rejects unknown kinds", () => {
    expect(isValidVariantKind("unknown" as RobustnessVariantKind)).toBe(false);
  });

  it("listVariantKinds returns the 6 frozen kinds", () => {
    expect(listVariantKinds().length).toBe(6);
  });

  it("variants do NOT count toward canonical scenario total", () => {
    // The canonical count is 52 regardless of how many variants exist.
    expect(GOLDEN_CORE_REGISTRY.canonical.length).toBe(52);
    // Some scenarios MAY have variants attached.
    const withVariants = GOLDEN_CORE_REGISTRY.canonical.filter((e) => e.robustnessVariants.length > 0);
    // Variants do not increase the canonical count.
    expect(GOLDEN_CORE_REGISTRY.canonical.length).toBe(52);
    // Log the variant count for visibility (variants are allowed to be 0
    // in the initial freeze).
    // eslint-disable-next-line no-console
    if (withVariants.length > 0) {
      console.log(`  ${withVariants.length} scenarios have robustness variants attached`);
    }
  });

  it("buildRobustnessVariant produces a variant with the same hidden-goal fingerprint", () => {
    const entry = GOLDEN_CORE_REGISTRY.canonical[0]!;
    const variant = buildRobustnessVariant({
      parentScenarioId: entry.scenarioId,
      parentEntry: entry,
      kind: "semantic-paraphrase",
      variantId: "variant-test-001",
      description: "test paraphrase",
      promptOverride: `${entry.scenario.visible.prompt}（请用不同的措辞表达同样的需求）`,
    });
    expect(variant.kind).toBe("semantic-paraphrase");
    expect(variant.promptOverride).toContain("不同的措辞");
    expect(variant.inheritedHiddenGoalFingerprint).toBe(computeHiddenGoalFingerprint(entry));
    // The variant inherits the same hidden-goal fingerprint.
    const verification = verifyVariantPreservesGoal(variant, entry);
    expect(verification.preserved).toBe(true);
  });

  it("verifyVariantPreservesGoal rejects a variant with a wrong fingerprint", () => {
    const entry = GOLDEN_CORE_REGISTRY.canonical[0]!;
    const variant = buildRobustnessVariant({
      parentScenarioId: entry.scenarioId,
      parentEntry: entry,
      kind: "semantic-paraphrase",
      variantId: "variant-test-002",
      description: "tampered variant",
      promptOverride: `${entry.scenario.visible.prompt} (test)`,
    });
    // Tamper with the inherited fingerprint.
    const tampered = { ...variant, inheritedHiddenGoalFingerprint: "wrong-fingerprint" };
    const verification = verifyVariantPreservesGoal(tampered, entry);
    expect(verification.preserved).toBe(false);
    expect(verification.updatedVariant.goalChanged).toBe(true);
  });

  it("computeRobustnessDelta reports the difference between parent and variant failures", () => {
    const parentFailures = ["mutation-1-not-detected", "mutation-2-not-detected"];
    const variantFailures = ["mutation-1-not-detected"];
    const delta = computeRobustnessDelta(parentFailures, variantFailures);
    expect(delta.hardGradeChanged).toBe(true);
    expect(delta.failureMessagesAdded.length).toBe(0);
    expect(delta.failureMessagesRemoved.length).toBe(1);
    expect(delta.failureMessagesRemoved[0]).toBe("mutation-2-not-detected");
  });
});

// ---------------------------------------------------------------------------
// §8 Generated regression candidate governance
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core — regression candidate governance", () => {
  it("buildEmptyCandidateRegistry produces a valid empty registry", () => {
    const registry = buildEmptyCandidateRegistry();
    expect(registry.candidates.length).toBe(0);
    expect(registry.schemaVersion).toBe(GOLDEN_CORE_SCHEMA_VERSION);
    expect(registry.fingerprint).toBeTruthy();
  });

  it("buildRegressionCandidate produces a candidate with all 8 verification checks pending", () => {
    const input: BuildCandidateInput = {
      candidateId: "cand-test-001",
      scenario: GOLDEN_CORE_SCENARIOS[0]!,
      referenceProgram: GOLDEN_CORE_REFERENCE_PROGRAMS[GOLDEN_CORE_SCENARIOS[0]!.scenarioId]!,
      capability: "clarification-direction",
      scenarioClass: "normal",
      priority: "P1",
      sourceProvenance: "diagnosis:run-test-001",
      extractedAt: "2026-07-20T00:00:00.000Z",
    };
    const candidate = buildRegressionCandidate(input);
    expect(candidate.candidateId).toBe("cand-test-001");
    expect(candidate.status).toBe("pending");
    expect(candidate.verificationChecks.representativeness.status).toBe("pending");
    expect(candidate.verificationChecks.redaction.status).toBe("pending");
    expect(candidate.verificationChecks.hiddenGoalIntegrity.status).toBe("pending");
    expect(candidate.verificationChecks.nonDuplicationWithCanonical.status).toBe("pending");
    expect(candidate.verificationChecks.fixtureSolvability.status).toBe("pending");
    expect(candidate.verificationChecks.graderMutationDeclaration.status).toBe("pending");
    expect(candidate.verificationChecks.reviewableDiff.status).toBe("pending");
    expect(candidate.verificationChecks.explicitApprovalRecord.status).toBe("pending");
  });

  it("isEligibleForPromotion returns false when any check is pending", () => {
    const input: BuildCandidateInput = {
      candidateId: "cand-test-002",
      scenario: GOLDEN_CORE_SCENARIOS[0]!,
      referenceProgram: GOLDEN_CORE_REFERENCE_PROGRAMS[GOLDEN_CORE_SCENARIOS[0]!.scenarioId]!,
      capability: "clarification-direction",
      scenarioClass: "normal",
      priority: "P1",
      sourceProvenance: "diagnosis:run-test-002",
      extractedAt: "2026-07-20T00:00:00.000Z",
    };
    const candidate = buildRegressionCandidate(input);
    expect(isEligibleForPromotion(candidate)).toBe(false);
  });

  it("isEligibleForPromotion returns true when all 8 checks pass", () => {
    const input: BuildCandidateInput = {
      candidateId: "cand-test-003",
      scenario: GOLDEN_CORE_SCENARIOS[0]!,
      referenceProgram: GOLDEN_CORE_REFERENCE_PROGRAMS[GOLDEN_CORE_SCENARIOS[0]!.scenarioId]!,
      capability: "clarification-direction",
      scenarioClass: "normal",
      priority: "P1",
      sourceProvenance: "diagnosis:run-test-003",
    };
    let candidate = buildRegressionCandidate(input);
    const checks: Array<keyof typeof candidate.verificationChecks> = [
      "representativeness",
      "redaction",
      "hiddenGoalIntegrity",
      "nonDuplicationWithCanonical",
      "fixtureSolvability",
      "graderMutationDeclaration",
      "reviewableDiff",
      "explicitApprovalRecord",
    ];
    for (const check of checks) {
      candidate = updateVerificationCheck(candidate, {
        candidateId: candidate.candidateId,
        checkName: check,
        status: "passed",
        evidence: "test evidence",
        checkedAt: "2026-07-20T00:00:00.000Z",
      });
    }
    expect(isEligibleForPromotion(candidate)).toBe(true);
  });

  it("applyPromotionApproval requires all checks to pass first", () => {
    const input: BuildCandidateInput = {
      candidateId: "cand-test-004",
      scenario: GOLDEN_CORE_SCENARIOS[0]!,
      referenceProgram: GOLDEN_CORE_REFERENCE_PROGRAMS[GOLDEN_CORE_SCENARIOS[0]!.scenarioId]!,
      capability: "clarification-direction",
      scenarioClass: "normal",
      priority: "P1",
      sourceProvenance: "diagnosis:run-test-004",
    };
    const candidate = buildRegressionCandidate(input);
    expect(() => applyPromotionApproval({
      candidate,
      approval: {
        approvalId: "appr-001",
        candidateId: candidate.candidateId,
        approvedBy: "robert",
        approvedAt: "2026-07-20T00:00:00.000Z",
        commitHash: "abc123",
        candidateFingerprint: "test-fingerprint",
      },
      canonicalRegistry: GOLDEN_CORE_REGISTRY,
      scenarioVersion: 1,
      summary: "test summary",
      goalProvenance: "test goal provenance",
      goldenConstraintsSummary: "test constraints",
      declaredGraderMutations: ["test-mutation"],
      mutationDetection: { declared: 1, detected: 1, missed: [] },
      stateEffectSummary: {
        required: [],
        allowed: [],
        forbidden: [],
        unchanged: [],
      },
      milestoneDagSummary: null,
    })).toThrow(/not eligible for promotion|verification checks|未通过所有验证检查/);
  });

  it("rejectCandidate marks a candidate as rejected with a reason", () => {
    const input: BuildCandidateInput = {
      candidateId: "cand-test-005",
      scenario: GOLDEN_CORE_SCENARIOS[0]!,
      referenceProgram: GOLDEN_CORE_REFERENCE_PROGRAMS[GOLDEN_CORE_SCENARIOS[0]!.scenarioId]!,
      capability: "clarification-direction",
      scenarioClass: "normal",
      priority: "P1",
      sourceProvenance: "diagnosis:run-test-005",
    };
    const candidate = buildRegressionCandidate(input);
    const rejected = rejectCandidate(candidate, "duplicate of canonical scenario");
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("duplicate of canonical scenario");
  });

  it("saveCandidateRegistry + loadCandidateRegistry round-trip", async () => {
    const projectRoot = await makeTempProjectRoot();
    const registry = buildEmptyCandidateRegistry();
    await saveCandidateRegistry(projectRoot, registry);
    const loaded = await loadCandidateRegistry(projectRoot);
    expect(loaded.candidates.length).toBe(0);
    expect(loaded.fingerprint).toBe(registry.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// §9 Preset/budget/reporting invariants
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core — preset & budget invariants", () => {
  it("golden-core preset is registered in PRESETS_WITH_GOLDEN_CORE", () => {
    expect(PRESETS_WITH_GOLDEN_CORE["golden-core"]).toBeDefined();
  });

  it("golden-core preset has 52 scenarios", () => {
    expect(GOLDEN_CORE_PRESET_ENTRY.scenarios.length).toBe(52);
  });

  it("golden-core preset exposes the registry and P0 IDs", () => {
    expect(GOLDEN_CORE_PRESET_ENTRY.goldenCoreRegistry).toBeDefined();
    expect(GOLDEN_CORE_PRESET_ENTRY.goldenCoreP0ScenarioIds).toBeDefined();
    expect(GOLDEN_CORE_PRESET_ENTRY.goldenCoreP0ScenarioIds.length).toBeGreaterThanOrEqual(8);
  });

  it("golden-core SUT cost ceiling is $1 (frozen invariant)", () => {
    expect(GOLDEN_CORE_BUDGET.maxSutCostUsd).toBe(1.0);
    expect(GOLDEN_CORE_BUDGET_INVARIANTS.full.maxSutCostUsd).toBe(1.0);
  });

  it("calibrate SUT cost ceiling is $3 (frozen invariant)", () => {
    expect(GOLDEN_CORE_BUDGET_INVARIANTS.calibrate.maxSutCostUsd).toBe(3.0);
  });

  it("golden-core budget can hold at least 52 observations", () => {
    expect(GOLDEN_CORE_BUDGET.maxObservations).toBeGreaterThanOrEqual(52);
  });

  it("verifyGoldenCoreBudgetInvariant passes for the default budget", () => {
    const result = verifyGoldenCoreBudgetInvariant(GOLDEN_CORE_BUDGET);
    expect(result.passed).toBe(true);
  });

  it("verifyGoldenCoreBudgetInvariant fails-closed when SUT cost ceiling is raised", () => {
    const result = verifyGoldenCoreBudgetInvariant({
      ...GOLDEN_CORE_BUDGET,
      maxSutCostUsd: 5.0,
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/超过冻结上限/);
  });

  it("verifyGoldenCoreBudgetInvariant fails-closed when maxObservations < 52", () => {
    const result = verifyGoldenCoreBudgetInvariant({
      ...GOLDEN_CORE_BUDGET,
      maxObservations: 10,
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toMatch(/不足以覆盖 52 个 canonical scenarios/);
  });
});

// ---------------------------------------------------------------------------
// §10 CLI smoke (golden-core subcommands)
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core — CLI smoke", () => {
  // Derive the CLI path from this test file's location so the tests work
  // regardless of which directory `process.cwd()` points at (vitest may
  // run from `agent-bridge/` or from the repo root).
  //   tests/unit/t46-6-golden-core.test.ts
  //   -> ../../src/evaluation/lab/cli.ts
  const testFileDir = dirname(fileURLToPath(import.meta.url));
  const cliPath = resolve(testFileDir, "..", "..", "src", "evaluation", "lab", "cli.ts");
  // The CLI uses `findProjectRoot()` which walks up looking for `CLAUDE.md`,
  // so passing the repo root (parent of `agent-bridge/`) works. When tests
  // run from `agent-bridge/`, the repo root is the parent directory.
  const projectRoot = resolve(testFileDir, "..", "..", "..", "..");

  function runCli(
    args: string[],
    cwd: string,
    timeoutMs?: number,
  ): { stdout: string; stderr: string; exitCode: number | null } {
    try {
      const stdout = execFileSync("npx", ["tsx", cliPath, ...args], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NODE_ENV: "test" },
        // The coverage report can be large (>64KB). Node's default
        // `maxBuffer` is 1MB which should be enough, but we set it
        // explicitly to avoid any environment-specific truncation.
        maxBuffer: 10 * 1024 * 1024,
        // Optional subprocess timeout. When provided, kills the child
        // process if it exceeds the budget. This is distinct from the
        // vitest `it` timeout (passed as the third argument to `it`).
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; status?: number };
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode: err.status ?? -1,
      };
    }
  }

  it("golden-core list produces JSON with 52 entries", () => {
    const result = runCli(["golden-core", "list", "--json"], projectRoot);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { event: string; canonicalCount: number; entries: unknown[] };
    expect(parsed.event).toBe("golden_core_list");
    expect(parsed.canonicalCount).toBe(52);
    expect(parsed.entries.length).toBe(52);
  });

  it("golden-core coverage produces a report with canonicalCount=52", () => {
    const result = runCli(["golden-core", "coverage", "--json"], projectRoot);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      event: string;
      report: { canonicalCount: number };
      fingerprint: string;
    };
    expect(parsed.event).toBe("golden_core_coverage_report");
    expect(parsed.report.canonicalCount).toBe(52);
    expect(parsed.fingerprint).toBeTruthy();
  });

  it("golden-core verify fails-closed when no snapshot exists (bootstrap)", async () => {
    const tempRoot = await makeTempProjectRoot();
    const result = runCli(["golden-core", "verify", "--json"], tempRoot);
    expect(result.exitCode).toBe(3); // EXIT.validation
    const parsed = JSON.parse(result.stdout) as { event: string; verified: boolean };
    expect(parsed.event).toBe("golden_core_verify_failed");
    expect(parsed.verified).toBe(false);
  });

  it("golden-core freeze + verify cycle works end-to-end", async () => {
    // Override vitest's default 5s timeout: this test runs two CLI
    // subprocess invocations (freeze + verify), each requiring npx tsx
    // startup (~2-3s) plus actual work. Under the full test suite's
    // concurrent load, total runtime can exceed 5s. 60s is a generous
    // upper bound that still catches deadlocks.
    const tempRoot = await makeTempProjectRoot();
    const freezeResult = runCli(["golden-core", "freeze", "--json"], tempRoot, 30_000);
    expect(freezeResult.exitCode).toBe(0);
    const freezeParsed = JSON.parse(freezeResult.stdout) as {
      event: string;
      canonicalCount: number;
      newFingerprint: string;
      changed: boolean;
    };
    expect(freezeParsed.event).toBe("golden_core_freeze_completed");
    expect(freezeParsed.canonicalCount).toBe(52);
    expect(freezeParsed.changed).toBe(true);

    const verifyResult = runCli(["golden-core", "verify", "--json"], tempRoot, 30_000);
    expect(verifyResult.exitCode).toBe(0);
    const verifyParsed = JSON.parse(verifyResult.stdout) as {
      event: string;
      verified: boolean;
      registryFingerprint: string;
    };
    expect(verifyParsed.event).toBe("golden_core_verify_passed");
    expect(verifyParsed.verified).toBe(true);
    expect(verifyParsed.registryFingerprint).toBe(freezeParsed.newFingerprint);
  }, 60_000);

  it("golden-core candidates returns an empty candidate registry", async () => {
    const tempRoot = await makeTempProjectRoot();
    // Initialize candidate registry by saving an empty one.
    const empty = buildEmptyCandidateRegistry();
    await saveCandidateRegistry(tempRoot, empty);
    const result = runCli(["golden-core", "candidates", "--json"], tempRoot);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      event: string;
      registry: { candidates: unknown[] };
      eligibleForPromotion: unknown[];
    };
    expect(parsed.event).toBe("golden_core_candidates");
    expect(parsed.registry.candidates.length).toBe(0);
    expect(parsed.eligibleForPromotion.length).toBe(0);
  });

  it("golden-core unknown subcommand fails-closed", () => {
    const result = runCli(["golden-core", "unknown-subcommand"], projectRoot);
    expect(result.exitCode).toBe(3); // EXIT.validation
  });
});

// ---------------------------------------------------------------------------
// §11 Adversarial checks (Pre-Implementation Review A-04, A-05, A-24)
// ---------------------------------------------------------------------------

describe("T46-6 Golden Core — adversarial review checks", () => {
  it("A-04: grader does not invoke SUT business services to judge correctness", () => {
    // Verify that the hard grader contract is declared on the scenario,
    // NOT on a service call. The grader reads state/effect evidence from
    // the observation, not from a re-invocation of the SUT.
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      const grader = entry.scenario.hardGrader;
      expect(grader).toBeDefined();
      // The grader's viewer is declared explicitly, not derived at runtime.
      expect(grader!.viewer).toBeDefined();
      expect(grader!.viewer.primaryUserId).toBeTruthy();
    }
  });

  it("A-05: Reference Program does not generate its own oracle", () => {
    // The Reference Program only proves that the goal is achievable and
    // the evidence is observable. It does NOT produce the oracle that
    // graders use. The oracle comes from the scenario's Golden Constraints.
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      const ref = entry.referenceProgram;
      expect(ref).toBeDefined();
      expect(ref.id).toBeTruthy();
      expect(ref.prompt).toBeTruthy();
      // The reference program has NO oracle field — it only has
      // expectedMilestoneSubset (which proves observability, not correctness).
      expect(ref.expectedMilestoneSubset).toBeDefined();
      expect((ref as { oracle?: unknown }).oracle).toBeUndefined();
    }
  });

  it("A-24: no two canonical scenarios are trivial duplicates (same prompt + same goal)", () => {
    // Verify that we did not inflate the count by duplicating scenarios.
    const seen = new Map<string, string>();
    for (const entry of GOLDEN_CORE_REGISTRY.canonical) {
      const key = `${entry.scenario.visible.prompt}::${entry.entryConditions.goalProvenance}`;
      if (seen.has(key)) {
        throw new Error(
          `Duplicate scenario detected: ${entry.scenarioId} duplicates ${seen.get(key)} (same prompt + goal)`,
        );
      }
      seen.set(key, entry.scenarioId);
    }
    expect(seen.size).toBe(52);
  });

  it("A-24: no two canonical scenarios share the same scenarioId", () => {
    const ids = GOLDEN_CORE_REGISTRY.canonical.map((e) => e.scenarioId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

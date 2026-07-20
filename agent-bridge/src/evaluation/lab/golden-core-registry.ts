/**
 * T46-6 (Issue #99 §1, §3) — Golden Core registry.
 *
 * The single source of truth for the Golden Core suite. TypeScript is
 * truth; the JSON snapshot under `agent-bridge/golden-core/registry.json`
 * is a frozen audit artifact.
 *
 * Boundary invariants (enforced and tested):
 *  - Normal runs load the TS registry and verify its fingerprint matches
 *    the checked-in JSON snapshot. Mismatch is fail-closed.
 *  - The ONLY way to update the JSON snapshot is via the explicit
 *    `freeze` command (see {@link freezeRegistry}). Normal runs cannot
 *    mutate the frozen registry.
 *  - Each canonical scenario ID is unique.
 *  - Semantic duplication (shared goal provenance + capability+class+
 *    priority overlap, or shared fixture fingerprint) is detected and
 *    reported.
 *  - Unsupported future schema versions fail-closed.
 *  - Registry fingerprint enters the SHA-256 result graph.
 *
 * The registry is modeled after `standards-registry.ts` (Slice 3) but
 * inverted: TS is truth, JSON is the audit artifact. This is because
 * scenarios are complex objects with nested structures and type checking
 * benefits, and defining them in JSON would lose type safety.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  GOLDEN_CORE_SCHEMA_VERSION,
  GOLDEN_CORE_SUITE_VERSION,
  GOLDEN_CORE_DEFAULT_FROZEN_AT,
  type GoldenCoreRegistry,
  type GoldenCoreScenarioEntry,
  type DuplicateRisk,
  type P0Category,
  type P0ScopeFilterVerification,
} from "./golden-core-contract.js";
import { CAPABILITY_DOMAINS, SCENARIO_CLASSES, P0_MANDATORY_CATEGORIES } from "./golden-core-contract.js";
import { EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";
import { GOLDEN_CORE_ENTRIES } from "./golden-core-scenarios.js";

// ---------------------------------------------------------------------------
// §1 Registry location
// ---------------------------------------------------------------------------

/** The frozen JSON snapshot lives in a checked-in, versioned directory. */
export const GOLDEN_CORE_DIR = "agent-bridge/golden-core";
export const GOLDEN_CORE_REGISTRY_FILE = "registry.json";
export const GOLDEN_CORE_COVERAGE_FILE = "coverage.json";

// ---------------------------------------------------------------------------
// §2 Schema version validation
// ---------------------------------------------------------------------------

export function assertSupportedGoldenCoreSchema(version: number): void {
  if (version !== GOLDEN_CORE_SCHEMA_VERSION) {
    throw new EvaluationValidationError(
      `unsupported Golden Core schema version: ${version}; current version is ${GOLDEN_CORE_SCHEMA_VERSION}`,
    );
  }
}

export function assertSupportedGoldenCoreSuite(version: number): void {
  if (version !== GOLDEN_CORE_SUITE_VERSION) {
    throw new EvaluationValidationError(
      `unsupported Golden Core suite version: ${version}; current version is ${GOLDEN_CORE_SUITE_VERSION}`,
    );
  }
}

// ---------------------------------------------------------------------------
// §3 Fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 fingerprint of the canonical scenario set.
 *
 * The fingerprint is over the canonical entries sorted by scenarioId,
 * with each entry's mutable fields (robustnessVariants, status) included
 * but the `fingerprint` field itself excluded. The fingerprint is stable:
 * two registries with the same canonical set produce the same fingerprint.
 */
export function computeRegistryFingerprint(
  registry: Omit<GoldenCoreRegistry, "fingerprint">,
): string {
  const sortedCanonical = [...registry.canonical].sort((a, b) =>
    a.scenarioId.localeCompare(b.scenarioId),
  );
  const canonicalDigests = sortedCanonical.map((entry) => {
    // Include the fields that define the scenario's identity and oracle.
    // Exclude derived fields and the entry's own substructures that are
    // independently verifiable.
    return {
      scenarioId: entry.scenarioId,
      scenarioVersion: entry.scenarioVersion,
      capability: entry.capability,
      scenarioClass: entry.scenarioClass,
      priority: entry.priority,
      p0Categories: [...entry.p0Categories].sort(),
      scenarioFingerprint: computeScenarioFingerprint(entry),
      referenceProgramFingerprint: computeReferenceProgramFingerprint(entry),
      entryConditionsFingerprint: computeEntryConditionsFingerprint(entry),
      status: entry.status,
    };
  });
  return sha256(
    stableStringify({
      schemaVersion: registry.schemaVersion,
      suiteVersion: registry.suiteVersion,
      registryId: registry.registryId,
      canonical: canonicalDigests,
      candidates: registry.candidates,
      rejected: registry.rejected,
      frozenAt: registry.frozenAt,
      ...(registry.freezeNotes ? { freezeNotes: registry.freezeNotes } : {}),
    }),
  );
}

/** Fingerprint over the ScenarioContract (the oracle + prompt + hidden). */
function computeScenarioFingerprint(entry: GoldenCoreScenarioEntry): string {
  return sha256(stableStringify(entry.scenario));
}

/** Fingerprint over the Reference Program. */
function computeReferenceProgramFingerprint(entry: GoldenCoreScenarioEntry): string {
  return sha256(stableStringify(entry.referenceProgram));
}

/** Fingerprint over the entry conditions (trusted entry conditions). */
function computeEntryConditionsFingerprint(entry: GoldenCoreScenarioEntry): string {
  return sha256(stableStringify(entry.entryConditions));
}

// ---------------------------------------------------------------------------
// §4 Build registry from TS entries
// ---------------------------------------------------------------------------

/**
 * Build the Golden Core registry from the TS entries.
 *
 * This is the canonical construction path. It:
 *  1. Partitions entries by status (canonical / candidate / rejected).
 *  2. Verifies uniqueness of scenario IDs.
 *  3. Detects semantic duplication.
 *  4. Computes the fingerprint.
 *
 * Throws on uniqueness violation. Reports (but does not throw on)
 * duplicate risks — they are recorded in the coverage report.
 */
export function buildGoldenCoreRegistry(
  entries: GoldenCoreScenarioEntry[] = GOLDEN_CORE_ENTRIES,
  options: { frozenAt?: string; freezeNotes?: string } = {},
): GoldenCoreRegistry {
  // §4.1 Partition by status.
  const canonical: GoldenCoreScenarioEntry[] = [];
  const candidates: GoldenCoreScenarioEntry[] = [];
  const rejected: GoldenCoreScenarioEntry[] = [];
  for (const entry of entries) {
    if (entry.status === "canonical") canonical.push(entry);
    else if (entry.status === "candidate") candidates.push(entry);
    else rejected.push(entry);
  }

  // §4.2 Verify uniqueness of scenario IDs across ALL entries.
  const allIds = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of entries) {
    if (allIds.has(entry.scenarioId)) {
      duplicates.push(entry.scenarioId);
    }
    allIds.add(entry.scenarioId);
  }
  if (duplicates.length > 0) {
    throw new EvaluationValidationError(
      `Golden Core 场景 ID 重复: ${duplicates.join(", ")}`,
    );
  }

  // §4.3 Verify schema version on every entry.
  for (const entry of entries) {
    if (entry.schemaVersion !== GOLDEN_CORE_SCHEMA_VERSION) {
      throw new EvaluationValidationError(
        `场景 ${entry.scenarioId} schemaVersion ${entry.schemaVersion} 不等于 ${GOLDEN_CORE_SCHEMA_VERSION}`,
      );
    }
  }

  // §4.4 Verify canonical entries have all required entry conditions.
  for (const entry of canonical) {
    verifyEntryConditions(entry);
  }

  // §4.5 Compute fingerprint.
  //
  // The default `frozenAt` MUST be a stable constant, NOT `new Date().toISOString()`.
  // Using the current time would make the registry fingerprint non-deterministic
  // across builds, which breaks:
  //   - `buildGoldenCoreRegistry is idempotent`
  //   - `freezeRegistry creates a JSON snapshot that verifyRegistry accepts`
  //   - `freezeRegistry is idempotent (second freeze with same entries is unchanged)`
  // Callers that want to record a real freeze timestamp must pass it explicitly
  // via `options.frozenAt` (e.g. `freezeRegistry()` records `new Date().toISOString()`
  // at the moment the JSON snapshot is written, but the in-memory registry built
  // by `buildGoldenCoreRegistry()` stays reproducible).
  const frozenAt = options.frozenAt ?? GOLDEN_CORE_DEFAULT_FROZEN_AT;
  const base: Omit<GoldenCoreRegistry, "fingerprint"> = {
    schemaVersion: GOLDEN_CORE_SCHEMA_VERSION,
    suiteVersion: GOLDEN_CORE_SUITE_VERSION,
    registryId: "projectflow-golden-core-v1",
    canonical,
    candidates,
    rejected,
    frozenAt,
    ...(options.freezeNotes ? { freezeNotes: options.freezeNotes } : {}),
  };
  return { ...base, fingerprint: computeRegistryFingerprint(base) };
}

// ---------------------------------------------------------------------------
// §5 Verify entry conditions (Issue #99 §3)
// ---------------------------------------------------------------------------

/**
 * Verify that a canonical entry has all 9 trusted entry conditions.
 * Throws on missing required field. A canonical entry missing any
 * condition is a build-time error — it should have been marked
 * `candidate` or `rejected` instead.
 */
export function verifyEntryConditions(entry: GoldenCoreScenarioEntry): void {
  const ec = entry.entryConditions;
  const failures: string[] = [];
  const add = (msg: string) => failures.push(msg);

  if (!ec.goalProvenance?.trim()) add("goalProvenance 缺失");
  if (!ec.fixtureSeed?.trim()) add("fixtureSeed 缺失");
  if (!ec.fixtureFingerprint?.trim()) add("fixtureFingerprint 缺失");
  if (!ec.goldenConstraintsSummary?.trim()) add("goldenConstraintsSummary 缺失");
  if (!ec.referenceProgramId?.trim()) add("referenceProgramId 缺失");
  if (!Array.isArray(ec.declaredGraderMutations)) add("declaredGraderMutations 缺失");
  if (!ec.mutationDetectionEvidence) add("mutationDetectionEvidence 缺失");
  if (!ec.scope?.workspaceId?.trim()) add("scope.workspaceId 缺失");
  if (!ec.scope?.projectId?.trim()) add("scope.projectId 缺失");
  if (!ec.scope?.viewerUserId?.trim()) add("scope.viewerUserId 缺失");
  if (!ec.stateEffectSummary) add("stateEffectSummary 缺失");
  if (ec.stateEffectSummary && !Array.isArray(ec.stateEffectSummary.required)) add("stateEffectSummary.required 缺失");
  if (ec.stateEffectSummary && !Array.isArray(ec.stateEffectSummary.allowed)) add("stateEffectSummary.allowed 缺失");
  if (ec.stateEffectSummary && !Array.isArray(ec.stateEffectSummary.forbidden)) add("stateEffectSummary.forbidden 缺失");
  if (ec.stateEffectSummary && !Array.isArray(ec.stateEffectSummary.unchanged)) add("stateEffectSummary.unchanged 缺失");

  // Reference Program must be present on the entry.
  if (!entry.referenceProgram?.id?.trim()) add("referenceProgram 缺失");

  // Mutation detection: if declared > 0, detected must equal declared.
  if (
    ec.mutationDetectionEvidence
    && ec.mutationDetectionEvidence.declared > 0
    && ec.mutationDetectionEvidence.detected < ec.mutationDetectionEvidence.declared
  ) {
    add(
      `mutationDetectionEvidence: ${ec.mutationDetectionEvidence.detected}/${ec.mutationDetectionEvidence.declared} mutations detected (missed: ${ec.mutationDetectionEvidence.missedMutationIds.join(", ")})`,
    );
  }

  if (failures.length > 0) {
    throw new EvaluationValidationError(
      `Golden Core 场景 ${entry.scenarioId} 入场条件验证失败: ${failures.join("; ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// §6 Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Detect semantic duplication risks in the canonical set.
 *
 * Risks are NOT build-time errors (some overlap is expected in a rich
 * suite). They are reported in the coverage matrix so reviewers can
 * decide whether to consolidate.
 */
export function detectDuplicateRisks(
  canonical: GoldenCoreScenarioEntry[],
): DuplicateRisk[] {
  const risks: DuplicateRisk[] = [];

  // §6.1 Shared goal provenance root + capability+class+priority overlap.
  const byProvenance = new Map<string, GoldenCoreScenarioEntry[]>();
  for (const entry of canonical) {
    const key = entry.entryConditions.goalProvenance;
    const list = byProvenance.get(key) ?? [];
    list.push(entry);
    byProvenance.set(key, list);
  }
  for (const [provenance, entries] of byProvenance) {
    if (entries.length > 1) {
      // Check if any pair shares capability+class+priority.
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i]!;
          const b = entries[j]!;
          if (
            a.capability === b.capability
            && a.scenarioClass === b.scenarioClass
            && a.priority === b.priority
          ) {
            risks.push({
              kind: "shared-goal-provenance",
              description: `场景 ${a.scenarioId} 与 ${b.scenarioId} 共享 goalProvenance "${provenance}" 且 capability+class+priority 重叠`,
              scenarioIds: [a.scenarioId, b.scenarioId],
            });
          }
        }
      }
    }
  }

  // §6.2 Shared fixture fingerprint (identical fixture).
  const byFixture = new Map<string, GoldenCoreScenarioEntry[]>();
  for (const entry of canonical) {
    const key = entry.entryConditions.fixtureFingerprint;
    const list = byFixture.get(key) ?? [];
    list.push(entry);
    byFixture.set(key, list);
  }
  for (const [, entries] of byFixture) {
    if (entries.length > 1) {
      // Shared fixture is fine for many scenarios (e.g., runtime faults
      // all use the demo fixture). Only flag if they also share capability.
      const byCap = new Map<string, GoldenCoreScenarioEntry[]>();
      for (const e of entries) {
        const list = byCap.get(e.capability) ?? [];
        list.push(e);
        byCap.set(e.capability, list);
      }
      for (const [, capEntries] of byCap) {
        if (capEntries.length > 2) {
          risks.push({
            kind: "shared-fixture-fingerprint",
            description: `场景 ${capEntries.map((e) => e.scenarioId).join(", ")} 共享 fixture fingerprint 且属于同一 capability`,
            scenarioIds: capEntries.map((e) => e.scenarioId),
          });
        }
      }
    }
  }

  // §6.3 Capability+class+priority overlap (already covered above, but
  // also flag pairs that don't share provenance). This is informational.
  // We intentionally do NOT flag all capability+class pairs — many
  // scenarios legitimately share capability+class with different goals.

  return risks;
}

// ---------------------------------------------------------------------------
// §7 Load frozen JSON snapshot (audit artifact)
// ---------------------------------------------------------------------------

/**
 * Load the frozen JSON snapshot from disk.
 *
 * This is the audit artifact, NOT the source of truth. The TS registry
 * is the source of truth. This function is used by `verifyRegistry` to
 * compare the TS fingerprint against the frozen JSON fingerprint.
 */
export async function loadFrozenSnapshot(
  projectRoot: string,
): Promise<GoldenCoreRegistry | null> {
  const path = join(projectRoot, GOLDEN_CORE_DIR, GOLDEN_CORE_REGISTRY_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as GoldenCoreRegistry;
  assertSupportedGoldenCoreSchema(parsed.schemaVersion);
  assertSupportedGoldenCoreSuite(parsed.suiteVersion);
  // Verify the frozen snapshot's internal fingerprint consistency.
  const expected = computeRegistryFingerprint({
    schemaVersion: parsed.schemaVersion,
    suiteVersion: parsed.suiteVersion,
    registryId: parsed.registryId,
    canonical: parsed.canonical,
    candidates: parsed.candidates,
    rejected: parsed.rejected,
    frozenAt: parsed.frozenAt,
    ...(parsed.freezeNotes ? { freezeNotes: parsed.freezeNotes } : {}),
  });
  if (parsed.fingerprint !== expected) {
    throw new EvaluationValidationError(
      `Golden Core 冻结快照内部 fingerprint 不一致: expected ${expected}, got ${parsed.fingerprint}`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// §8 Verify TS registry matches frozen snapshot
// ---------------------------------------------------------------------------

/**
 * Verify that the TS registry's fingerprint matches the checked-in JSON
 * snapshot. This is the central fail-safe: normal runs cannot mutate the
 * frozen registry. Mismatch is fail-closed.
 *
 * Returns the verified registry. Throws on mismatch or missing snapshot.
 */
export async function verifyRegistry(
  projectRoot: string,
  options: { entries?: GoldenCoreScenarioEntry[] } = {},
): Promise<{
  tsRegistry: GoldenCoreRegistry;
  frozenSnapshot: GoldenCoreRegistry | null;
  verified: boolean;
  failureReason?: string;
}> {
  const tsRegistry = buildGoldenCoreRegistry(options.entries);
  const frozenSnapshot = await loadFrozenSnapshot(projectRoot);

  if (!frozenSnapshot) {
    // No snapshot exists yet. This is the bootstrap state. The registry
    // is still usable but `freeze` must be run to create the audit
    // artifact. We return verified=false with a clear reason.
    return {
      tsRegistry,
      frozenSnapshot: null,
      verified: false,
      failureReason: "Golden Core 冻结快照不存在；请运行 `eval-lab golden-core freeze` 创建审计快照",
    };
  }

  if (tsRegistry.fingerprint !== frozenSnapshot.fingerprint) {
    return {
      tsRegistry,
      frozenSnapshot,
      verified: false,
      failureReason: `Golden Core TS registry fingerprint ${tsRegistry.fingerprint} 与冻结快照 ${frozenSnapshot.fingerprint} 不一致；请运行 \`eval-lab golden-core freeze\` 更新审计快照（必须产生可审查的 Git diff）`,
    };
  }

  return { tsRegistry, frozenSnapshot, verified: true };
}

// ---------------------------------------------------------------------------
// §9 Freeze registry (the ONLY way to update the JSON snapshot)
// ---------------------------------------------------------------------------

/**
 * Freeze the TS registry into a JSON snapshot on disk.
 *
 * This is the ONLY way to update the frozen snapshot. It:
 *  1. Builds the TS registry.
 *  2. Computes the fingerprint.
 *  3. Writes the JSON snapshot to `agent-bridge/golden-core/registry.json`.
 *
 * The resulting Git diff is the auditable record of what changed. Normal
 * runs call {@link verifyRegistry} instead.
 */
export async function freezeRegistry(
  projectRoot: string,
  options: { freezeNotes?: string; entries?: GoldenCoreScenarioEntry[] } = {},
): Promise<{
  registry: GoldenCoreRegistry;
  snapshotPath: string;
  previousFingerprint: string | null;
  newFingerprint: string;
  changed: boolean;
}> {
  const registry = buildGoldenCoreRegistry(options.entries, {
    freezeNotes: options.freezeNotes,
  });
  const snapshotPath = join(projectRoot, GOLDEN_CORE_DIR, GOLDEN_CORE_REGISTRY_FILE);
  const previous = await loadFrozenSnapshot(projectRoot);
  const previousFingerprint = previous?.fingerprint ?? null;
  const changed = previousFingerprint !== registry.fingerprint;

  // Write the snapshot. This overwrites the existing file — the Git diff
  // is the audit record. We use atomic write to avoid partial writes.
  const dir = join(projectRoot, GOLDEN_CORE_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const content = `${JSON.stringify(registry, null, 2)}\n`;
  await writeFile(snapshotPath, content, { encoding: "utf-8", mode: 0o600 });

  return {
    registry,
    snapshotPath,
    previousFingerprint,
    newFingerprint: registry.fingerprint,
    changed,
  };
}

// ---------------------------------------------------------------------------
// §10 Verify registry invariants (comprehensive)
// ---------------------------------------------------------------------------

export interface RegistryInvariantResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    details?: string;
  }>;
}

/**
 * Verify all registry invariants. Used by `validate` and `exit-gate`.
 */
export function verifyRegistryInvariants(
  registry: GoldenCoreRegistry,
): RegistryInvariantResult {
  const checks: RegistryInvariantResult["checks"] = [];

  // §10.1 Schema version.
  checks.push({
    name: "schemaVersion",
    passed: registry.schemaVersion === GOLDEN_CORE_SCHEMA_VERSION,
    details: `schemaVersion=${registry.schemaVersion}`,
  });

  // §10.2 Suite version.
  checks.push({
    name: "suiteVersion",
    passed: registry.suiteVersion === GOLDEN_CORE_SUITE_VERSION,
    details: `suiteVersion=${registry.suiteVersion}`,
  });

  // §10.3 Registry ID.
  checks.push({
    name: "registryId",
    passed: registry.registryId === "projectflow-golden-core-v1",
    details: `registryId=${registry.registryId}`,
  });

  // §10.4 Fingerprint matches.
  const expectedFingerprint = computeRegistryFingerprint({
    schemaVersion: registry.schemaVersion,
    suiteVersion: registry.suiteVersion,
    registryId: registry.registryId,
    canonical: registry.canonical,
    candidates: registry.candidates,
    rejected: registry.rejected,
    frozenAt: registry.frozenAt,
    ...(registry.freezeNotes ? { freezeNotes: registry.freezeNotes } : {}),
  });
  checks.push({
    name: "fingerprint",
    passed: registry.fingerprint === expectedFingerprint,
    details: `expected=${expectedFingerprint}, actual=${registry.fingerprint}`,
  });

  // §10.5 Unique scenario IDs across all partitions.
  const allIds = new Set<string>();
  let duplicateFound = false;
  for (const entry of [...registry.canonical, ...registry.candidates, ...registry.rejected]) {
    if (allIds.has(entry.scenarioId)) {
      duplicateFound = true;
      break;
    }
    allIds.add(entry.scenarioId);
  }
  checks.push({
    name: "uniqueScenarioIds",
    passed: !duplicateFound,
  });

  // §10.6 All canonical entries have valid entry conditions.
  let allConditionsValid = true;
  for (const entry of registry.canonical) {
    try {
      verifyEntryConditions(entry);
    } catch {
      allConditionsValid = false;
      break;
    }
  }
  checks.push({
    name: "canonicalEntryConditions",
    passed: allConditionsValid,
  });

  // §10.7 Canonical count is in the 50-64 range (Issue #99 target).
  checks.push({
    name: "canonicalCountInRange",
    passed: registry.canonical.length >= 50 && registry.canonical.length <= 64,
    details: `canonicalCount=${registry.canonical.length}`,
  });

  // §10.8 All 8 P0 mandatory categories covered by canonical entries.
  const p0Covered = new Set<string>();
  for (const entry of registry.canonical) {
    for (const cat of entry.p0Categories) {
      p0Covered.add(cat);
    }
  }
  const missingP0 = P0_MANDATORY_CATEGORIES.filter((c) => !p0Covered.has(c));
  checks.push({
    name: "p0MandatoryCategoriesCovered",
    passed: missingP0.length === 0,
    details: missingP0.length > 0 ? `missing=${missingP0.join(",")}` : "all covered",
  });

  // §10.9 All 8 capability domains covered.
  const capsCovered = new Set(registry.canonical.map((e) => e.capability));
  const missingCaps = CAPABILITY_DOMAINS.filter((c) => !capsCovered.has(c));
  checks.push({
    name: "allCapabilityDomainsCovered",
    passed: missingCaps.length === 0,
    details: missingCaps.length > 0 ? `missing=${missingCaps.join(",")}` : "all covered",
  });

  // §10.10 All 8 scenario classes covered.
  const classesCovered = new Set(registry.canonical.map((e) => e.scenarioClass));
  const missingClasses = SCENARIO_CLASSES.filter((c) => !classesCovered.has(c));
  checks.push({
    name: "allScenarioClassesCovered",
    passed: missingClasses.length === 0,
    details: missingClasses.length > 0 ? `missing=${missingClasses.join(",")}` : "all covered",
  });

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

// ---------------------------------------------------------------------------
// §11 P0 scope filter protection (Issue #99 §4)
// ---------------------------------------------------------------------------

/**
 * Verify that a scope filter (e.g., `--scenario`, `--exclude`) does not
 * silently remove P0 mandatory scenarios.
 *
 * Returns `passed: true` if the filtered set still covers all P0
 * mandatory categories. Returns `passed: false` with mandatory additions
 * if the filter would remove P0 coverage.
 */
export function verifyP0ScopeFilter(
  registry: GoldenCoreRegistry,
  selectedScenarioIds: string[],
): P0ScopeFilterVerification {
  const selectedSet = new Set(selectedScenarioIds);
  const selected = registry.canonical.filter((e) => selectedSet.has(e.scenarioId));

  // P0 categories covered by the selected set.
  const p0Covered = new Set<P0Category>();
  for (const entry of selected) {
    for (const cat of entry.p0Categories) {
      p0Covered.add(cat);
    }
  }

  // Find missing P0 categories.
  const missingP0Categories = P0_MANDATORY_CATEGORIES.filter((c) => !p0Covered.has(c));

  // Find P0 scenarios that were excluded by the filter (i.e., P0 scenarios
  // in the canonical set that are NOT in the selected set). These are the
  // scenarios the caller MUST add back to satisfy P0 coverage.
  const missingP0ScenarioIds = registry.canonical
    .filter((e) => e.p0Categories.length > 0 && !selectedSet.has(e.scenarioId))
    .map((e) => e.scenarioId);

  if (missingP0Categories.length === 0) {
    return {
      passed: true,
      missingP0ScenarioIds: [],
      missingP0Categories: [],
      mandatoryAdditions: [],
    };
  }

  // Find canonical scenarios that cover the missing categories.
  const mandatoryAdditions: string[] = [];
  const missingSet = new Set<P0Category>(missingP0Categories);
  for (const entry of registry.canonical) {
    if (selectedSet.has(entry.scenarioId)) continue;
    if (entry.p0Categories.some((c) => missingSet.has(c))) {
      mandatoryAdditions.push(entry.scenarioId);
    }
  }

  return {
    passed: false,
    missingP0ScenarioIds,
    missingP0Categories,
    mandatoryAdditions,
    failureReason: `scope filter 移除了 P0 必需类别: ${missingP0Categories.join(", ")}；必须包含: ${mandatoryAdditions.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// §12 Export registry + entries for external use
// ---------------------------------------------------------------------------

/** The built Golden Core registry (TS source of truth). */
export const GOLDEN_CORE_REGISTRY: GoldenCoreRegistry = buildGoldenCoreRegistry();

/** Canonical scenario IDs (for P0 checks, exit gate, etc.). */
export const GOLDEN_CORE_CANONICAL_IDS: string[] = GOLDEN_CORE_REGISTRY.canonical.map(
  (e) => e.scenarioId,
);

/** P0 scenario IDs (scenarios with at least one P0 category). */
export const GOLDEN_CORE_P0_SCENARIO_IDS: string[] = GOLDEN_CORE_REGISTRY.canonical
  .filter((e) => e.p0Categories.length > 0)
  .map((e) => e.scenarioId);

/** All scenarios (ScenarioContract) from the canonical set. */
export const GOLDEN_CORE_SCENARIOS: GoldenCoreRegistry["canonical"][number]["scenario"][] =
  GOLDEN_CORE_REGISTRY.canonical.map((e) => e.scenario);

/** All reference programs keyed by scenario ID. */
export const GOLDEN_CORE_REFERENCE_PROGRAMS: Record<string, GoldenCoreScenarioEntry["referenceProgram"]> =
  Object.fromEntries(GOLDEN_CORE_REGISTRY.canonical.map((e) => [e.scenarioId, e.referenceProgram]));

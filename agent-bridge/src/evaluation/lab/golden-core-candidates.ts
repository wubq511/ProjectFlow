/**
 * T46-6 (Issue #99 §6) — Generated regression candidate governance.
 *
 * Generated regression candidates (extracted from failures, diagnoses,
 * or auto-generation) live in a SEPARATE candidate registry and CANNOT
 * be auto-promoted to the canonical Golden Core.
 *
 * Promotion requires ALL 8 verification checks to pass AND an explicit
 * {@link RegressionPromotionApproval} record (mirrors the Slice 3
 * `applyPromotionApproval` pattern).
 *
 * Boundary invariants:
 *  - Auto-promotion is FORBIDDEN.
 *  - The candidate registry is separate from the canonical registry.
 *  - Promotion does NOT modify Slice 3 active standards.
 *  - Historical badcase count is NOT directly counted as coverage.
 *  - The 8 verification checks are: representativeness, redaction,
 *    hidden goal integrity, non-duplication with canonical, fixture
 *    solvability, grader mutation declaration, reviewable diff,
 *    explicit approval record.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GOLDEN_CORE_SCHEMA_VERSION,
  type RegressionCandidate,
  type RegressionCandidateVerificationChecks,
  type RegressionPromotionApproval,
  type VerificationCheckResult,
  type CapabilityDomain,
  type ScenarioClass,
  type ScenarioPriority,
  type GoldenCoreScenarioEntry,
  type GoldenCoreRegistry,
} from "./golden-core-contract.js";
import type { ScenarioContract } from "./contract.js";
import type { ReferenceProgram } from "./contract-v2.js";
import { CAPABILITY_DOMAINS, SCENARIO_CLASSES } from "./golden-core-contract.js";
import { EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Candidate registry location
// ---------------------------------------------------------------------------

export const CANDIDATE_REGISTRY_DIR = "agent-bridge/golden-core";
export const CANDIDATE_REGISTRY_FILE = "candidates.json";

// ---------------------------------------------------------------------------
// §2 Build a new candidate
// ---------------------------------------------------------------------------

export interface BuildCandidateInput {
  candidateId: string;
  scenario: ScenarioContract;
  referenceProgram: ReferenceProgram;
  capability: CapabilityDomain;
  scenarioClass: ScenarioClass;
  priority: ScenarioPriority;
  sourceProvenance: string;
}

/**
 * Build a new regression candidate with all verification checks pending.
 *
 * The candidate starts with `status: "pending"` and all checks set to
 * `status: "pending"`. Promotion requires all checks to pass and an
 * explicit approval record.
 */
export function buildRegressionCandidate(
  input: BuildCandidateInput,
): RegressionCandidate {
  // Validate capability and class.
  if (!CAPABILITY_DOMAINS.includes(input.capability)) {
    throw new EvaluationValidationError(
      `invalid capability: ${input.capability}`,
    );
  }
  if (!SCENARIO_CLASSES.includes(input.scenarioClass)) {
    throw new EvaluationValidationError(
      `invalid scenarioClass: ${input.scenarioClass}`,
    );
  }

  const pendingCheck: VerificationCheckResult = { status: "pending" };

  const verificationChecks: RegressionCandidateVerificationChecks = {
    representativeness: pendingCheck,
    redaction: pendingCheck,
    hiddenGoalIntegrity: pendingCheck,
    nonDuplicationWithCanonical: pendingCheck,
    fixtureSolvability: pendingCheck,
    graderMutationDeclaration: pendingCheck,
    reviewableDiff: pendingCheck,
    explicitApprovalRecord: pendingCheck,
  };

  return {
    candidateId: input.candidateId,
    schemaVersion: GOLDEN_CORE_SCHEMA_VERSION,
    scenario: input.scenario,
    referenceProgram: input.referenceProgram,
    capability: input.capability,
    scenarioClass: input.scenarioClass,
    priority: input.priority,
    sourceProvenance: input.sourceProvenance,
    extractedAt: new Date().toISOString(),
    verificationChecks,
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// §3 Run verification checks
// ---------------------------------------------------------------------------

export interface VerificationCheckInput {
  candidateId: string;
  checkName: keyof RegressionCandidateVerificationChecks;
  status: "passed" | "failed";
  evidence?: string;
  failureReason?: string;
  checkedAt?: string;
}

/**
 * Update a single verification check on a candidate.
 *
 * The check must transition from "pending" to "passed" or "failed".
 * Once a check is "passed", it cannot be reverted to "pending".
 */
export function updateVerificationCheck(
  candidate: RegressionCandidate,
  input: VerificationCheckInput,
): RegressionCandidate {
  if (candidate.candidateId !== input.candidateId) {
    throw new EvaluationValidationError(
      `candidateId mismatch: ${candidate.candidateId} !== ${input.candidateId}`,
    );
  }
  const check = candidate.verificationChecks[input.checkName];
  if (!check) {
    throw new EvaluationValidationError(
      `unknown verification check: ${input.checkName}`,
    );
  }
  if (check.status === "passed" && input.status !== "passed") {
    throw new EvaluationValidationError(
      `verification check ${input.checkName} 已通过，不能回退到 ${input.status}`,
    );
  }
  const updatedCheck: VerificationCheckResult = {
    status: input.status,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
  return {
    ...candidate,
    verificationChecks: {
      ...candidate.verificationChecks,
      [input.checkName]: updatedCheck,
    },
  };
}

// ---------------------------------------------------------------------------
// §4 Check if a candidate is eligible for promotion
// ---------------------------------------------------------------------------

/**
 * Check if a candidate is eligible for promotion.
 *
 * A candidate is eligible when ALL 8 verification checks have passed.
 * Eligibility does NOT auto-promote — an explicit approval record is
 * still required.
 */
export function isEligibleForPromotion(candidate: RegressionCandidate): boolean {
  const checks = candidate.verificationChecks;
  return (
    checks.representativeness.status === "passed"
    && checks.redaction.status === "passed"
    && checks.hiddenGoalIntegrity.status === "passed"
    && checks.nonDuplicationWithCanonical.status === "passed"
    && checks.fixtureSolvability.status === "passed"
    && checks.graderMutationDeclaration.status === "passed"
    && checks.reviewableDiff.status === "passed"
    && checks.explicitApprovalRecord.status === "passed"
  );
}

// ---------------------------------------------------------------------------
// §5 Apply promotion approval (the ONLY path to canonical)
// ---------------------------------------------------------------------------

export interface ApplyPromotionInput {
  candidate: RegressionCandidate;
  approval: RegressionPromotionApproval;
  canonicalRegistry: GoldenCoreRegistry;
  scenarioVersion: number;
  summary: string;
  goalProvenance: string;
  goldenConstraintsSummary: string;
  declaredGraderMutations: string[];
  mutationDetection: { declared: number; detected: number; missed: string[] };
  stateEffectSummary: {
    required: string[];
    allowed: string[];
    forbidden: string[];
    unchanged: string[];
  };
  milestoneDagSummary: string | null;
}

/**
 * Apply a promotion approval to a candidate, producing a canonical
 * GoldenCoreScenarioEntry.
 *
 * This is the ONLY function that converts a candidate to a canonical
 * entry. It requires:
 *  - ALL 8 verification checks passed.
 *  - An explicit {@link RegressionPromotionApproval} record.
 *  - The candidate ID matches the approval record.
 *  - The candidate is not already promoted or rejected.
 *
 * This function does NOT modify the registry. The caller is responsible
 * for adding the returned entry to the canonical set via a reviewable
 * Git diff (re-freezing the registry).
 *
 * This function does NOT claim cryptographic identity authentication.
 * The approval record is based on repository governance, same as
 * Slice 3's `applyPromotionApproval`.
 */
export function applyPromotionApproval(
  input: ApplyPromotionInput,
): {
  entry: GoldenCoreScenarioEntry;
  promotedCandidate: RegressionCandidate;
} {
  const { candidate, approval, canonicalRegistry } = input;

  // §5.1 Verify candidate ID matches approval.
  if (candidate.candidateId !== approval.candidateId) {
    throw new EvaluationValidationError(
      `candidateId mismatch: candidate=${candidate.candidateId}, approval=${approval.candidateId}`,
    );
  }

  // §5.2 Verify candidate is eligible.
  if (!isEligibleForPromotion(candidate)) {
    const failedChecks = Object.entries(candidate.verificationChecks)
      .filter(([, v]) => v.status !== "passed")
      .map(([k]) => k);
    throw new EvaluationValidationError(
      `candidate ${candidate.candidateId} 未通过所有验证检查: ${failedChecks.join(", ")}`,
    );
  }

  // §5.3 Verify candidate is not already promoted or rejected.
  if (candidate.status === "promoted") {
    throw new EvaluationValidationError(
      `candidate ${candidate.candidateId} 已经 promoted`,
    );
  }
  if (candidate.status === "rejected") {
    throw new EvaluationValidationError(
      `candidate ${candidate.candidateId} 已经 rejected`,
    );
  }

  // §5.4 Verify non-duplication with canonical.
  const canonicalIds = new Set(canonicalRegistry.canonical.map((e) => e.scenarioId));
  if (canonicalIds.has(candidate.scenario.scenarioId)) {
    throw new EvaluationValidationError(
      `candidate ${candidate.candidateId} 的 scenarioId ${candidate.scenario.scenarioId} 已存在于 canonical registry`,
    );
  }

  // §5.5 Verify matching fingerprint.
  const candidateFingerprint = computeCandidateFingerprint(candidate);
  if (approval.candidateFingerprint !== candidateFingerprint) {
    throw new EvaluationValidationError(
      `candidate fingerprint mismatch: approval=${approval.candidateFingerprint}, actual=${candidateFingerprint}`,
    );
  }

  // §5.6 Build the canonical entry.
  const entry: GoldenCoreScenarioEntry = {
    scenarioId: candidate.scenario.scenarioId,
    schemaVersion: GOLDEN_CORE_SCHEMA_VERSION,
    scenarioVersion: input.scenarioVersion,
    scenario: candidate.scenario,
    capability: candidate.capability,
    scenarioClass: candidate.scenarioClass,
    priority: candidate.priority,
    p0Categories: [], // Promoted candidates start with no P0 categories.
    referenceProgram: candidate.referenceProgram,
    entryConditions: {
      goalProvenance: input.goalProvenance,
      fixtureSeed: JSON.stringify({
        workspaceId: "demo-workspace-001",
        projectId: "demo-project-001",
      }),
      fixtureFingerprint: sha256(
        stableStringify({
          workspaceId: "demo-workspace-001",
          projectId: "demo-project-001",
        }),
      ),
      goldenConstraintsSummary: input.goldenConstraintsSummary,
      referenceProgramId: candidate.referenceProgram.id,
      declaredGraderMutations: input.declaredGraderMutations,
      mutationDetectionEvidence: {
        declared: input.mutationDetection.declared,
        detected: input.mutationDetection.detected,
        missedMutationIds: input.mutationDetection.missed,
      },
      scope: {
        workspaceId: "demo-workspace-001",
        projectId: "demo-project-001",
        viewerUserId: "demo-user-001",
      },
      stateEffectSummary: input.stateEffectSummary,
      milestoneDagSummary: input.milestoneDagSummary,
    },
    robustnessVariants: [],
    status: "canonical",
    summary: input.summary,
  };

  const promotedCandidate: RegressionCandidate = {
    ...candidate,
    status: "promoted",
    promotionApproval: approval,
  };

  return { entry, promotedCandidate };
}

// ---------------------------------------------------------------------------
// §6 Candidate fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 fingerprint of a candidate.
 *
 * The fingerprint is over the candidate's scenario, reference program,
 * capability, class, and priority. It is used to verify the approval
 * record matches the candidate at approval time.
 */
export function computeCandidateFingerprint(candidate: RegressionCandidate): string {
  return sha256(
    stableStringify({
      candidateId: candidate.candidateId,
      scenario: candidate.scenario,
      referenceProgram: candidate.referenceProgram,
      capability: candidate.capability,
      scenarioClass: candidate.scenarioClass,
      priority: candidate.priority,
    }),
  );
}

// ---------------------------------------------------------------------------
// §7 Candidate registry load/save
// ---------------------------------------------------------------------------

export interface CandidateRegistry {
  schemaVersion: typeof GOLDEN_CORE_SCHEMA_VERSION;
  registryId: string;
  candidates: RegressionCandidate[];
  updatedAt: string;
  fingerprint: string;
}

export function computeCandidateRegistryFingerprint(
  registry: Omit<CandidateRegistry, "fingerprint">,
): string {
  const sorted = [...registry.candidates].sort((a, b) =>
    a.candidateId.localeCompare(b.candidateId),
  );
  return sha256(
    stableStringify({
      schemaVersion: registry.schemaVersion,
      registryId: registry.registryId,
      candidates: sorted.map((c) => ({
        candidateId: c.candidateId,
        scenarioId: c.scenario.scenarioId,
        status: c.status,
        fingerprint: computeCandidateFingerprint(c),
      })),
      updatedAt: registry.updatedAt,
    }),
  );
}

export function buildEmptyCandidateRegistry(): CandidateRegistry {
  const base: Omit<CandidateRegistry, "fingerprint"> = {
    schemaVersion: GOLDEN_CORE_SCHEMA_VERSION,
    registryId: "projectflow-golden-core-candidates-v1",
    candidates: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
  return { ...base, fingerprint: computeCandidateRegistryFingerprint(base) };
}

export async function loadCandidateRegistry(
  projectRoot: string,
): Promise<CandidateRegistry> {
  const path = join(projectRoot, CANDIDATE_REGISTRY_DIR, CANDIDATE_REGISTRY_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return buildEmptyCandidateRegistry();
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as CandidateRegistry;
  if (parsed.schemaVersion !== GOLDEN_CORE_SCHEMA_VERSION) {
    throw new EvaluationValidationError(
      `unsupported candidate registry schema version: ${parsed.schemaVersion}`,
    );
  }
  const expected = computeCandidateRegistryFingerprint({
    schemaVersion: parsed.schemaVersion,
    registryId: parsed.registryId,
    candidates: parsed.candidates,
    updatedAt: parsed.updatedAt,
  });
  if (parsed.fingerprint !== expected) {
    throw new EvaluationValidationError(
      `candidate registry fingerprint mismatch: expected ${expected}, got ${parsed.fingerprint}`,
    );
  }
  return parsed;
}

export async function saveCandidateRegistry(
  projectRoot: string,
  registry: CandidateRegistry,
): Promise<void> {
  const path = join(projectRoot, CANDIDATE_REGISTRY_DIR, CANDIDATE_REGISTRY_FILE);
  const dir = join(projectRoot, CANDIDATE_REGISTRY_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(registry, null, 2)}\n`;
  await writeFile(path, content, { encoding: "utf-8", mode: 0o600 });
}

// ---------------------------------------------------------------------------
// §8 Reject a candidate
// ---------------------------------------------------------------------------

export function rejectCandidate(
  candidate: RegressionCandidate,
  reason: string,
): RegressionCandidate {
  if (candidate.status === "promoted") {
    throw new EvaluationValidationError(
      `candidate ${candidate.candidateId} 已经 promoted, 不能 reject`,
    );
  }
  if (!reason.trim()) {
    throw new EvaluationValidationError("reject reason 不能为空");
  }
  return {
    ...candidate,
    status: "rejected",
    rejectionReason: reason,
  };
}

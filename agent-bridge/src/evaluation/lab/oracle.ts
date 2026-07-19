/**
 * T46-2 (Issue #95 §3) — Oracle authoring helpers and independence checks.
 *
 * The oracle is the {@link HardGraderContract} block: it declares the goal
 * state and invariants the scenario must satisfy. It is authored by the
 * evaluator from the scenario goal and invariants alone.
 *
 * Oracle independence (Issue #95 §3, adversarial review A-05):
 * - The oracle MUST NOT be derived from the Reference Program or from the
 *   observed Agent output. Doing so creates circular self-justification:
 *   if the reference is wrong, the wrongness becomes the gold standard.
 * - The helpers in this module enforce the *structural* preconditions for
 *   independence at scenario-registration time. They cannot, on their own,
 *   prove that a human author did not copy values from a reference run;
 *   that property is established by code review and by the
 *   `oracle-independence.test.ts` regression suite, which proves that
 *   mutating the Reference Program does not mutate the oracle, and that
 *   the oracle can pass/fail independently of any specific Agent output.
 *
 * Two layered checks are provided:
 * - {@link assertOracleIndependence}: structural — the oracle must not
 *   reference the Reference Program by ID, and the Reference Program must
 *   not embed oracle constraint fields verbatim.
 * - {@link deriveOracleFingerprint}: returns a stable SHA-256 of the oracle
 *   block alone. Tests compare this to the Reference Program's fingerprint
 *   to prove the two evolve independently.
 */

import { createHash } from "node:crypto";
import type {
  HardGraderContract,
  ReferenceProgram,
} from "./contract-v2.js";
import { stableStringify } from "./validation.js";

/**
 * Assert that the oracle is structurally independent of the reference program.
 *
 * Structural checks enforced:
 * 1. The {@link HardGraderContract} must not carry a `referenceProgramId`
 *    field. (The contract type does not declare one; this guard prevents
 *    future schema additions from silently introducing a dependency.)
 * 2. The {@link ReferenceProgram} must not carry `stateConstraints`,
 *    `milestoneDag`, `authoritySafety`, `privacy`, `readOnlyStatePurity`
 *    or `idempotency` fields. It may only declare `expectedMilestoneSubset`,
 *    which is explicitly a sanity hint, not an oracle.
 *
 * @throws Error if any structural coupling is detected.
 */
export function assertOracleIndependence(
  oracle: HardGraderContract,
  reference: ReferenceProgram,
): void {
  // Check 1: HardGraderContract must not embed reference program identity.
  // We inspect the raw object so future schema additions are caught even
  // before the type is updated.
  const oracleRecord = oracle as unknown as Record<string, unknown>;
  const forbiddenOracleKeys = new Set([
    "referenceProgramId",
    "referenceProgramFingerprint",
    "referenceObservationSha",
    "referenceOutputSha",
  ]);
  for (const key of Object.keys(oracleRecord)) {
    if (forbiddenOracleKeys.has(key)) {
      throw new Error(
        `oracle 不独立: HardGraderContract 引用了参考程序字段 ${key}`,
      );
    }
  }

  // Check 2: ReferenceProgram must not embed oracle constraint fields.
  // Note: `viewer` is NOT in this list because ReferenceProgram declares
  // its own `viewer` field (the scope the reference runs as). The
  // reference's viewer is expected to match the oracle's viewer for the
  // reference to prove the same observable surface, but that equality
  // check is a scenario-authoring concern, not an independence violation.
  const refRecord = reference as unknown as Record<string, unknown>;
  const forbiddenReferenceKeys = new Set([
    "stateConstraints",
    "milestoneDag",
    "authoritySafety",
    "privacy",
    "readOnlyStatePurity",
    "idempotency",
    "run",
  ]);
  for (const key of Object.keys(refRecord)) {
    if (forbiddenReferenceKeys.has(key)) {
      throw new Error(
        `oracle 不独立: ReferenceProgram 携带了 oracle 约束字段 ${key}`,
      );
    }
  }

  // Check 3: ReferenceProgram.expectedMilestoneSubset must not equal the
  // oracle's milestoneDag.milestones exactly. Equality would mean the
  // reference has copied the oracle's trajectory constraint verbatim,
  // collapsing the two into a single source of truth.
  if (
    reference.expectedMilestoneSubset
    && oracle.milestoneDag
    && Array.isArray(oracle.milestoneDag.milestones)
  ) {
    const refSet = JSON.stringify(reference.expectedMilestoneSubset);
    const oracleSet = JSON.stringify(oracle.milestoneDag.milestones);
    if (refSet === oracleSet) {
      throw new Error(
        "oracle 不独立: ReferenceProgram.expectedMilestoneSubset 与 oracle.milestoneDag.milestones 完全相同",
      );
    }
  }
}

/**
 * Compute a stable SHA-256 fingerprint of the oracle block alone.
 *
 * Used by tests to prove that mutating the Reference Program does not
 * change the oracle's identity, and that two oracles authored from
 * different goal states produce different fingerprints.
 */
export function deriveOracleFingerprint(oracle: HardGraderContract): string {
  // Strip the version field before hashing so a schema bump alone does not
  // change the oracle's semantic identity. The version is a contract
  // compatibility marker, not a part of the goal state.
  const { version: _version, ...rest } = oracle;
  void _version;
  return createHash("sha256").update(stableStringify(rest)).digest("hex");
}

/**
 * Compute a stable SHA-256 fingerprint of the reference program alone.
 *
 * Used by tests to prove that mutating the oracle does not change the
 * reference program's identity.
 */
export function deriveReferenceFingerprint(reference: ReferenceProgram): string {
  return createHash("sha256").update(stableStringify(reference)).digest("hex");
}

/**
 * Result of an independence mutation probe.
 *
 * Mutation tests use this to prove that changing one of {oracle, reference}
 * does not change the fingerprint of the other.
 */
export interface IndependenceProbeResult {
  oracleFingerprintBefore: string;
  oracleFingerprintAfter: string;
  referenceFingerprintBefore: string;
  referenceFingerprintAfter: string;
  /** True if the oracle fingerprint did NOT change when the reference was mutated. */
  oracleStableUnderReferenceMutation: boolean;
  /** True if the reference fingerprint did NOT change when the oracle was mutated. */
  referenceStableUnderOracleMutation: boolean;
}

/**
 * Run a two-way independence probe.
 *
 * The caller provides:
 * - the original oracle and reference program
 * - a function that returns a mutated copy of the reference program
 *   (the mutation must not touch the oracle)
 * - a function that returns a mutated copy of the oracle
 *   (the mutation must not touch the reference program)
 *
 * The probe verifies that each fingerprint changes only when its own
 * artifact is mutated.
 */
export function probeIndependence(
  oracle: HardGraderContract,
  reference: ReferenceProgram,
  mutateReference: (ref: ReferenceProgram) => ReferenceProgram,
  mutateOracle: (o: HardGraderContract) => HardGraderContract,
): IndependenceProbeResult {
  const oracleFingerprintBefore = deriveOracleFingerprint(oracle);
  const referenceFingerprintBefore = deriveReferenceFingerprint(reference);

  const mutatedReference = mutateReference(reference);
  const oracleFingerprintAfterReferenceMutation = deriveOracleFingerprint(oracle);

  const mutatedOracle = mutateOracle(oracle);
  const referenceFingerprintAfterOracleMutation = deriveReferenceFingerprint(reference);

  const oracleFingerprintAfter = deriveOracleFingerprint(mutatedOracle);
  const referenceFingerprintAfter = deriveReferenceFingerprint(mutatedReference);

  return {
    oracleFingerprintBefore,
    oracleFingerprintAfter,
    referenceFingerprintBefore,
    referenceFingerprintAfter,
    oracleStableUnderReferenceMutation:
      oracleFingerprintBefore === oracleFingerprintAfterReferenceMutation,
    referenceStableUnderOracleMutation:
      referenceFingerprintBefore === referenceFingerprintAfterOracleMutation,
  };
}

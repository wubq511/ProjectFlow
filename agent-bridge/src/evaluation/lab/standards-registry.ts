/**
 * T46-5 (Issue #98 §1) — Standards Registry (active vs candidate).
 *
 * Enforces strict separation between the active and candidate registries:
 *  - Active registry: checked-in, versioned, read-only for normal eval.
 *  - Candidate registry: produced by calibration runs, lives in a
 *    separate namespace, never auto-promoted.
 *
 * Boundary invariants (enforced and tested):
 *  - Normal run, diagnose, repair-packet and Judge paths have NO active
 *    write path. They may only READ the active registry.
 *  - Calibration writes ONLY to the candidate namespace.
 *  - Failed or unapproved calibration MUST leave the active registry
 *    byte-identical. This is verified by comparing fingerprints before
 *    and after calibration.
 *  - Unsupported future schema versions fail-closed.
 *  - Registry fingerprints enter the SHA-256 result graph.
 *  - Auto-promotion by an Agent, Judge or ordinary command is FORBIDDEN.
 *    The ONLY way to modify the active registry is via an explicit
 *    Robert instruction + reviewable Git diff + approval record (see
 *    {@link applyPromotionApproval}).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  STANDARDS_REGISTRY_SCHEMA_VERSION,
  type CandidateStandard,
  type PromotionApprovalRecord,
  type StandardEntry,
  type StandardsRegistry,
} from "./calibration-contract.js";
import { EvaluationValidationError } from "./errors.js";
import { sha256, stableStringify } from "./validation.js";

// ---------------------------------------------------------------------------
// §1 Active registry location
// ---------------------------------------------------------------------------

/**
 * The active registry lives in a checked-in, versioned directory.
 * Default: `agent-bridge/standards/active/`.
 *
 * The path is FIXED and CANNOT be overridden by env vars or CLI args.
 * This prevents an evaluator from silently pointing at a different
 * active registry.
 */
export const ACTIVE_REGISTRY_DIR = "agent-bridge/standards/active";
export const ACTIVE_REGISTRY_FILE = "registry.json";

export const CANDIDATE_REGISTRY_DIR = "agent-bridge/standards/candidate";

// ---------------------------------------------------------------------------
// §2 Schema version validation
// ---------------------------------------------------------------------------

/** Assert that a registry's schema version is supported. Fail-closed. */
export function assertSupportedRegistrySchema(version: number): void {
  if (version !== STANDARDS_REGISTRY_SCHEMA_VERSION) {
    throw new EvaluationValidationError(
      `unsupported standards registry schema version: ${version}; current version is ${STANDARDS_REGISTRY_SCHEMA_VERSION}`,
    );
  }
}

// ---------------------------------------------------------------------------
// §3 Fingerprint
// ---------------------------------------------------------------------------

/** Compute the SHA-256 fingerprint of a registry.
 *
 *  The fingerprint is over the canonical form of the registry: entries
 *  sorted by (id, version), payload stable-stringified. The fingerprint
 *  field itself is excluded.
 */
export function computeRegistryFingerprint(
  registry: Omit<StandardsRegistry, "fingerprint">,
): string {
  const sortedEntries = [...registry.entries].sort((a, b) => {
    if (a.id !== b.id) return a.id.localeCompare(b.id);
    return a.version - b.version;
  });
  return sha256(
    stableStringify({
      schemaVersion: registry.schemaVersion,
      registry: registry.registry,
      registryId: registry.registryId,
      entries: sortedEntries,
      updatedAt: registry.updatedAt,
    }),
  );
}

// ---------------------------------------------------------------------------
// §4 Load active registry
// ---------------------------------------------------------------------------

/** Load the active registry from the checked-in file.
 *
 *  This is the ONLY function that returns the active registry to normal
 *  eval / diagnose / repair-packet / Judge paths. It is READ-ONLY.
 */
export async function loadActiveRegistry(
  projectRoot: string,
): Promise<StandardsRegistry> {
  const path = join(projectRoot, ACTIVE_REGISTRY_DIR, ACTIVE_REGISTRY_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    // If the active registry file does not exist, return an empty
    // registry. This is the bootstrap state.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return buildEmptyActiveRegistry();
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as StandardsRegistry;
  assertSupportedRegistrySchema(parsed.schemaVersion);
  if (parsed.registry !== "active") {
    throw new EvaluationValidationError(
      `active registry file has registry="${parsed.registry}", expected "active"`,
    );
  }
  // Verify fingerprint matches.
  const expected = computeRegistryFingerprint({
    schemaVersion: parsed.schemaVersion,
    registry: parsed.registry,
    registryId: parsed.registryId,
    entries: parsed.entries,
    updatedAt: parsed.updatedAt,
  });
  if (parsed.fingerprint !== expected) {
    throw new EvaluationValidationError(
      `active registry fingerprint mismatch: expected ${expected}, got ${parsed.fingerprint}`,
    );
  }
  return parsed;
}

/** Build an empty active registry (bootstrap state).
 *
 *  Uses a STABLE timestamp so two calls return byte-identical
 *  registries. This is critical for `assertActiveRegistryUnchanged`:
 *  when the active registry file does not exist, `loadActiveRegistry`
 *  returns this bootstrap registry both before and after calibration,
 *  and the fingerprints MUST match.
 */
export function buildEmptyActiveRegistry(): StandardsRegistry {
  const BOOTSTRAP_TIMESTAMP = "1970-01-01T00:00:00.000Z";
  const base: Omit<StandardsRegistry, "fingerprint"> = {
    schemaVersion: STANDARDS_REGISTRY_SCHEMA_VERSION,
    registry: "active",
    registryId: "projectflow-active-v1",
    entries: [],
    updatedAt: BOOTSTRAP_TIMESTAMP,
  };
  return { ...base, fingerprint: computeRegistryFingerprint(base) };
}

// ---------------------------------------------------------------------------
// §5 Build candidate registry
// ---------------------------------------------------------------------------

/** Build a candidate registry from a list of candidate standards.
 *
 *  This is the ONLY path the calibration runner uses to construct a
 *  candidate registry. The candidate registry is published as an
 *  immutable artifact and NEVER touches the active namespace.
 */
export function buildCandidateRegistry(
  candidates: CandidateStandard[],
  runId: string,
): StandardsRegistry {
  const now = new Date().toISOString();
  const entries = candidates.map((c) => c.entry);
  const base: Omit<StandardsRegistry, "fingerprint"> = {
    schemaVersion: STANDARDS_REGISTRY_SCHEMA_VERSION,
    registry: "candidate",
    registryId: `projectflow-candidate-${runId}`,
    entries,
    updatedAt: now,
  };
  return { ...base, fingerprint: computeRegistryFingerprint(base) };
}

// ---------------------------------------------------------------------------
// §6 Verify active registry immutability
// ---------------------------------------------------------------------------

/** Verify that the active registry fingerprint did NOT change during
 *  calibration. This is the central fail-safe: failed or unapproved
 *  calibration MUST leave the active registry byte-identical.
 */
export function assertActiveRegistryUnchanged(
  before: StandardsRegistry,
  after: StandardsRegistry,
): void {
  if (before.fingerprint !== after.fingerprint) {
    throw new EvaluationValidationError(
      `active registry 被修改: before=${before.fingerprint}, after=${after.fingerprint}; calibration 不得修改 active registry`,
    );
  }
}

// ---------------------------------------------------------------------------
// §7 Apply promotion approval (the ONLY active mutation path)
// ---------------------------------------------------------------------------

/**
 * Apply a promotion approval to an active registry.
 *
 *  This is the ONLY function that mutates the active registry. It
 *  requires:
 *   - an explicit {@link PromotionApprovalRecord} from a Robert instruction;
 *   - all affected standard conflicts resolved;
 *   - the candidate entry to add/replace.
 *
 *  The function does NOT write to disk. The caller is responsible for
 *  writing the new registry to the active registry file via Git, so
 *  the change is reviewable. This function only computes the new
 *  registry state and verifies invariants.
 *
 *  This function does NOT claim cryptographic identity authentication.
 *  It is repository governance with reviewable history.
 */
export function applyPromotionApproval(
  active: StandardsRegistry,
  candidate: CandidateStandard,
  approval: PromotionApprovalRecord,
  resolvedConflictIds: string[],
  /** Optional timestamp for testability. Defaults to `new Date().toISOString()`. */
  now: string = new Date().toISOString(),
): { newActive: StandardsRegistry; diffSummary: { additions: number; modifications: number; removals: number } } {
  // §1 The candidate must be approved.
  if (candidate.status !== "approved") {
    throw new EvaluationValidationError(
      `candidate ${candidate.candidateId} status=${candidate.status}; 仅 approved candidate 可被 promotion`,
    );
  }
  // §2 The approval record must reference this candidate.
  if (approval.candidateId !== candidate.candidateId) {
    throw new EvaluationValidationError(
      `approval record 引用 candidateId=${approval.candidateId}, 实际 candidate=${candidate.candidateId}`,
    );
  }
  // §3 All affected conflicts must be resolved.
  const unresolved = candidate.affectedByConflicts.filter(
    (id) => !resolvedConflictIds.includes(id),
  );
  if (unresolved.length > 0) {
    throw new EvaluationValidationError(
      `candidate ${candidate.candidateId} 有未解决 conflict: ${unresolved.join(", ")}`,
    );
  }
  // §4 The approval record's beforeActiveFingerprint must match.
  if (approval.beforeActiveFingerprint !== active.fingerprint) {
    throw new EvaluationValidationError(
      `approval record 的 beforeActiveFingerprint 与当前 active 不一致; 可能 approval 已过期`,
    );
  }
  // §5 Apply the entry. If an entry with the same id exists, replace it
  //    (modification). Otherwise, add it (addition). The new entry's
  //    source is rewritten to point at the active registry + approval
  //    commit so the provenance is reviewable in Git history.
  const existingIdx = active.entries.findIndex((e) => e.id === candidate.entry.id);
  const newEntry: StandardEntry = {
    ...candidate.entry,
    source: {
      registry: "active",
      origin: approval.reviewableDiff.commit,
      path: approval.reviewableDiff.diffPath,
    },
  };
  let newEntries: StandardEntry[];
  let additions = 0;
  let modifications = 0;
  let removals = 0;
  if (existingIdx < 0) {
    newEntries = [...active.entries, newEntry];
    additions = 1;
  } else {
    newEntries = [...active.entries];
    newEntries[existingIdx] = newEntry;
    modifications = 1;
  }
  const base: Omit<StandardsRegistry, "fingerprint"> = {
    schemaVersion: active.schemaVersion,
    registry: "active",
    registryId: active.registryId,
    entries: newEntries,
    updatedAt: now,
  };
  const newActive: StandardsRegistry = {
    ...base,
    fingerprint: computeRegistryFingerprint(base),
  };
  // §7 The new fingerprint must match the approval record's afterActiveFingerprint.
  if (approval.afterActiveFingerprint !== newActive.fingerprint) {
    throw new EvaluationValidationError(
      `approval record 的 afterActiveFingerprint 与计算结果不一致; approval 可能已被篡改或冲突未完全解决`,
    );
  }
  return {
    newActive,
    diffSummary: { additions, modifications, removals },
  };
}

// ---------------------------------------------------------------------------
// §8 Verify registry invariants
// ---------------------------------------------------------------------------

/** Verify a registry's invariants. Returns violations (empty = OK). */
export function verifyRegistryInvariants(registry: StandardsRegistry): string[] {
  const violations: string[] = [];
  // §1 Schema version.
  if (registry.schemaVersion !== STANDARDS_REGISTRY_SCHEMA_VERSION) {
    violations.push(
      `schemaVersion ${registry.schemaVersion} 不受支持; 当前版本 ${STANDARDS_REGISTRY_SCHEMA_VERSION}`,
    );
  }
  // §2 Registry kind must match the registry field.
  if (registry.registry !== "active" && registry.registry !== "candidate") {
    violations.push(`registry kind 非法: ${registry.registry}`);
  }
  // §3 No duplicate (id, version) entries.
  const seen = new Set<string>();
  for (const entry of registry.entries) {
    const key = `${entry.id}@v${entry.version}`;
    if (seen.has(key)) {
      violations.push(`重复 entry: ${key}`);
    }
    seen.add(key);
  }
  // §4 Each entry's source.registry must match the registry kind.
  for (const entry of registry.entries) {
    if (entry.source.registry !== registry.registry) {
      violations.push(
        `entry ${entry.id}@v${entry.version} source.registry=${entry.source.registry} 与 registry kind=${registry.registry} 不一致`,
      );
    }
  }
  // §5 Fingerprint must match.
  const expected = computeRegistryFingerprint({
    schemaVersion: registry.schemaVersion,
    registry: registry.registry,
    registryId: registry.registryId,
    entries: registry.entries,
    updatedAt: registry.updatedAt,
  });
  if (registry.fingerprint !== expected) {
    violations.push(`fingerprint 不匹配: expected ${expected}, got ${registry.fingerprint}`);
  }
  return violations;
}

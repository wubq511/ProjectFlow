/**
 * T46-5 (Issue #98 §2) — Standard conflict detection.
 *
 * Detects and records conflicts between:
 *  - canonical product/spec docs (PRD, TECH-DESIGN, CONTEXT.md, TDD docs);
 *  - ADR entries (docs/adr/);
 *  - Pydantic schemas (backend/app/schemas/);
 *  - TypeScript schemas (agent-bridge/src/ and frontend/src/lib/types.ts);
 *  - public behavior contracts (docs/api/, documented HTTP/SSE behavior);
 *  - current code behavior (observed in the running system);
 *  - frozen scenarios/standards (ScenarioContract, HardGraderContract,
 *    SemanticRubric, SemanticAnchor, etc.).
 *
 * Boundary invariants (enforced and tested):
 *  - Standard conflicts MUST be detected and recorded. They cannot be
 *    silently ignored.
 *  - Promotion is BLOCKED while any `standard_conflict` affecting the
 *    candidate is `unresolved`.
 *  - Current code behavior NEVER becomes truth merely because it exists.
 *    A conflict between code and spec is recorded; the human resolves it.
 *  - Calibration MUST NOT silently choose one side of a conflict. Both
 *    claims are recorded with source type/version/hash.
 *  - Unresolved conflicts MUST be preserved and explicitly displayed.
 */

import { createHash } from "node:crypto";
import type {
  CandidateStandard,
  StandardConflict,
  StandardConflictResolution,
  StandardConflictSeverity,
  StandardSourceType,
} from "./calibration-contract.js";
import { assertFrozenConflictResolution } from "./calibration-contract.js";

// ---------------------------------------------------------------------------
// §1 Conflict ID generation
// ---------------------------------------------------------------------------

/** Generate a stable conflict ID from the conflicting claim hashes. */
export function generateConflictId(
  claims: Array<{ claim: string; source: { hash: string } }>,
): string {
  const hash = createHash("sha256");
  for (const c of [...claims].sort((a, b) => a.source.hash.localeCompare(b.source.hash))) {
    hash.update(c.source.hash);
    hash.update(":");
    hash.update(c.claim);
    hash.update("|");
  }
  return `conflict_${hash.digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// §2 Conflict severity inference
// ---------------------------------------------------------------------------

/** Infer severity from the conflict type and source types involved.
 *
 *  Higher severity when canonical/ADR/frozen_scenario conflicts with
 *  current_code_behavior (because that means the implementation may
 *  be wrong). Lower severity when two docs disagree.
 */
export function inferSeverity(
  sourceTypes: StandardSourceType[],
): StandardConflictSeverity {
  const has = (t: StandardSourceType) => sourceTypes.includes(t);
  // Current code behavior conflicting with any authoritative source is high.
  if (has("current_code_behavior") && (
    has("canonical_doc")
    || has("adr")
    || has("pydantic_schema")
    || has("typescript_schema")
    || has("public_behavior_contract")
    || has("frozen_scenario")
    || has("frozen_standard")
  )) {
    return "high";
  }
  // Two authoritative sources disagreeing is medium-high.
  const authoritative: StandardSourceType[] = [
    "canonical_doc",
    "adr",
    "pydantic_schema",
    "typescript_schema",
    "public_behavior_contract",
  ];
  const authoritativeCount = sourceTypes.filter((t) => authoritative.includes(t)).length;
  if (authoritativeCount >= 2) {
    return "medium";
  }
  // Frozen standard/scenario conflicts with anything is at least medium.
  if (has("frozen_standard") || has("frozen_scenario")) {
    return "medium";
  }
  return "low";
}

// ---------------------------------------------------------------------------
// §3 Conflict detection input
// ---------------------------------------------------------------------------

/** A standard claim from a specific source. */
export interface StandardClaim {
  claim: string;
  source: {
    type: StandardSourceType;
    version: string;
    /** SHA-256 of the source artifact, or "current" for live code behavior. */
    hash: string;
  };
  /** Optional candidate standard ID affected by this claim. */
  affectsCandidateId?: string;
}

// ---------------------------------------------------------------------------
// §4 Conflict detection
// ---------------------------------------------------------------------------

/**
 * Detect conflicts among a set of standard claims.
 *
 *  Two claims conflict when they make contradictory statements about
 *  the SAME aspect. The detector uses a simple predicate: if two
 *  claims reference the same `aspectKey` and have different `value`
 *  fields, they conflict.
 *
 *  This is intentionally conservative: it does NOT try to semantically
 *  parse claims. The caller must provide structured claims with
 *  `aspectKey` and `value` fields.
 */
export interface StructuredClaim extends StandardClaim {
  /** The aspect being claimed (e.g., "proposal-confirm.required"). */
  aspectKey: string;
  /** The value claimed (stringified). */
  value: string;
}

/** Detect conflicts among structured claims. */
export function detectStandardConflicts(
  claims: StructuredClaim[],
  detectedAt: string,
): StandardConflict[] {
  // Group claims by aspectKey.
  const byAspect = new Map<string, StructuredClaim[]>();
  for (const claim of claims) {
    const list = byAspect.get(claim.aspectKey) ?? [];
    list.push(claim);
    byAspect.set(claim.aspectKey, list);
  }
  const conflicts: StandardConflict[] = [];
  for (const [, group] of byAspect.entries()) {
    // Group by value; if more than one distinct value, there is a conflict.
    const byValue = new Map<string, StructuredClaim[]>();
    for (const c of group) {
      const list = byValue.get(c.value) ?? [];
      list.push(c);
      byValue.set(c.value, list);
    }
    if (byValue.size < 2) continue;
    // Conflict: collect all claims.
    const conflictingClaims = group.map((c) => ({
      claim: c.claim,
      source: c.source,
    }));
    const sourceTypes = group.map((c) => c.source.type);
    const severity = inferSeverity(sourceTypes);
    const conflictId = generateConflictId(conflictingClaims);
    const affectedCandidateStandards = group
      .map((c) => c.affectsCandidateId)
      .filter((id): id is string => typeof id === "string");
    conflicts.push({
      conflictId,
      conflictingClaims,
      severity,
      resolutionStatus: "unresolved",
      affectedCandidateStandards: [...new Set(affectedCandidateStandards)],
      detectedAt,
    });
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// §5 Conflict resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a standard conflict. Only an explicit Robert instruction
 *  may resolve a conflict. The resolution rationale is recorded.
 *
 *  This function does NOT claim cryptographic identity authentication.
 *  It is repository governance with reviewable history.
 */
export function resolveStandardConflict(
  conflict: StandardConflict,
  resolution: StandardConflictResolution,
  rationale: string,
): StandardConflict {
  assertFrozenConflictResolution(resolution);
  if (!rationale.trim()) {
    throw new Error("resolution rationale 不能为空");
  }
  return {
    ...conflict,
    resolutionStatus: resolution,
    resolutionRationale: rationale,
  };
}

/**
 * Returns true if any conflict affecting the candidate is unresolved.
 *
 *  Both `unresolved` and `deferred` block promotion. `deferred` is
 *  not an actual resolution — it just defers the decision. Only
 *  `resolved` unblocks promotion.
 */
export function hasUnresolvedConflict(
  conflicts: StandardConflict[],
  candidateId: string,
): boolean {
  return conflicts.some(
    (c) =>
      c.resolutionStatus !== "resolved"
      && c.affectedCandidateStandards.includes(candidateId),
  );
}

/**
 * Get all unresolved conflicts affecting any of the candidates.
 *
 *  Both `unresolved` and `deferred` are returned. Only `resolved`
 *  unblocks promotion.
 */
export function getUnresolvedConflicts(
  conflicts: StandardConflict[],
  candidates: CandidateStandard[],
): StandardConflict[] {
  const ids = new Set(candidates.map((c) => c.candidateId));
  return conflicts.filter(
    (c) =>
      c.resolutionStatus !== "resolved"
      && c.affectedCandidateStandards.some((id) => ids.has(id)),
  );
}

// ---------------------------------------------------------------------------
// §6 Conflict catalog (frozen, evaluator-owned)
// ---------------------------------------------------------------------------

/**
 * The frozen conflict catalog. Each entry is a known conflict pattern
 *  the calibration runner should detect. This is evaluator-owned and
 *  cannot be modified by the SUT or Judge.
 *
 *  Issue #98 §2 requires conflict detection across 6 source type
 *  combinations. The catalog below enumerates them so tests can verify
 *  each is covered.
 */
export interface ConflictPattern {
  patternId: string;
  description: string;
  sourceTypes: [StandardSourceType, StandardSourceType];
  aspectKey: string;
}

export const FROZEN_CONFLICT_PATTERNS: readonly ConflictPattern[] = [
  {
    patternId: "canonical-vs-adr",
    description: "canonical 文档与 ADR 对同一 aspect 描述不一致",
    sourceTypes: ["canonical_doc", "adr"],
    aspectKey: "any",
  },
  {
    patternId: "canonical-vs-schema",
    description: "canonical 文档与 Pydantic/TypeScript schema 不一致",
    sourceTypes: ["canonical_doc", "pydantic_schema"],
    aspectKey: "any",
  },
  {
    patternId: "canonical-vs-public-behavior",
    description: "canonical 文档与 public behavior contract 不一致",
    sourceTypes: ["canonical_doc", "public_behavior_contract"],
    aspectKey: "any",
  },
  {
    patternId: "schema-vs-code",
    description: "Pydantic/TypeScript schema 与 current code behavior 不一致",
    sourceTypes: ["pydantic_schema", "current_code_behavior"],
    aspectKey: "any",
  },
  {
    patternId: "frozen-scenario-vs-code",
    description: "frozen scenario/standard 与 current code behavior 不一致",
    sourceTypes: ["frozen_scenario", "current_code_behavior"],
    aspectKey: "any",
  },
  {
    patternId: "frozen-standard-vs-candidate",
    description: "frozen standard 与 candidate standard 不一致",
    sourceTypes: ["frozen_standard", "frozen_standard"],
    aspectKey: "any",
  },
] as const;

/** Verify the conflict catalog is complete. */
export function verifyConflictCatalog(): {
  complete: boolean;
  missingPatterns: string[];
} {
  const requiredPatterns = [
    "canonical-vs-adr",
    "canonical-vs-schema",
    "canonical-vs-public-behavior",
    "schema-vs-code",
    "frozen-scenario-vs-code",
    "frozen-standard-vs-candidate",
  ];
  const present = new Set(FROZEN_CONFLICT_PATTERNS.map((p) => p.patternId));
  const missing = requiredPatterns.filter((p) => !present.has(p));
  return { complete: missing.length === 0, missingPatterns: missing };
}

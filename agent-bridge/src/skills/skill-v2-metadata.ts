/**
 * Skills V2 metadata — additive extension to SkillMetadata.
 *
 * All fields are optional for backward compatibility with v1 skills.
 * V2 adds structured trigger/prerequisite/effect metadata for deterministic routing.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Skills V2
 */

/**
 * Effect ceiling a skill is allowed to use.
 * Mirrors OutcomeContract.effectCeiling but per-skill.
 */
export type SkillEffectCeiling = "none" | "advisory_only" | "proposal_only" | "full";

const EFFECT_CEILING_RANK: Record<SkillEffectCeiling, number> = {
  none: 0,
  advisory_only: 1,
  proposal_only: 2,
  full: 3,
};

/** Return the strictest effect ceiling. Empty inputs fail closed to the fallback. */
export function combineEffectCeilings(
  ceilings: SkillEffectCeiling[],
  fallback: SkillEffectCeiling = "proposal_only",
): SkillEffectCeiling {
  if (ceilings.length === 0) return fallback;
  return ceilings.reduce((strictest, ceiling) =>
    EFFECT_CEILING_RANK[ceiling] < EFFECT_CEILING_RANK[strictest]
      ? ceiling
      : strictest,
  );
}

/**
 * Outcome type the skill produces.
 */
export type SkillOutcomeType =
  | "answer"       // text response only
  | "proposal"     // creates proposal(s)
  | "advisory"     // creates risk/actioncard
  | "analysis"     // read-only analysis
  | "checkin"      // check-in flow
  | "negotiation"; // assignment negotiation

/**
 * Verification level required for this skill's output.
 */
export type SkillVerificationLevel = "none" | "deterministic" | "semantic";

/**
 * V2 metadata fields — additive to v1 SkillMetadata.
 */
export interface SkillV2Metadata {
  /** Schema version for the metadata itself */
  version: number;
  /** Example phrases that should trigger this skill */
  triggerExamples: string[];
  /** Phrases that should NOT trigger this skill (negative triggers) */
  negativeTriggers: string[];
  /** Prerequisites that must be true for this skill to activate */
  prerequisites: SkillPrerequisite[];
  /** What type of outcome this skill produces */
  outcomeType: SkillOutcomeType;
  /** Maximum effect ceiling this skill can use */
  allowedEffects: SkillEffectCeiling;
  /** Verification level required */
  requiredVerification: SkillVerificationLevel;
  /** Compatibility range (e.g., ">=1.0.0 <2.0.0") */
  compatibilityRange?: string;
  /** Eval fixtures for testing (paths relative to skill dir) */
  evalFixtures?: string[];
}

/**
 * Prerequisite for a skill to activate.
 */
export interface SkillPrerequisite {
  /** What must be true */
  type: "has_direction_card" | "has_stages" | "has_tasks" | "has_members" | "has_pending_proposals" | "no_pending_proposals";
  /** Human-readable description */
  description: string;
}

/**
 * Extended metadata combining v1 and v2.
 */
export interface SkillMetadataV2 {
  // V1 fields (existing)
  name: string;
  description: string;
  location: string;
  allowedTools: string[];
  references: string[];
  // V2 fields (additive)
  v2?: SkillV2Metadata;
}

/**
 * Default v2 metadata for skills that don't declare it.
 * Conservative defaults: no negative triggers, no prerequisites, minimal effects.
 */
export function defaultV2Metadata(): SkillV2Metadata {
  return {
    version: 2,
    triggerExamples: [],
    negativeTriggers: [],
    prerequisites: [],
    outcomeType: "proposal",
    allowedEffects: "proposal_only",
    requiredVerification: "deterministic",
  };
}

/**
 * Shared request preparation — used by both /runs and /runs/stream.
 *
 * Validates the wire request, resolves skill context (using deterministic
 * router when no explicit skill), and classifies the Outcome Contract
 * BEFORE any durable/HTTP effects. Both routes call prepareRunRequest()
 * first and use the result to decide how to proceed.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Phase 1-2
 */

import type { WireRunStartRequest } from "@/types/wire.js";
import { parseRunStartRequest } from "@/types/wire.js";
import type { SkillLoader } from "@/skills/skill-loader.js";
import type { SkillIndex } from "@/skills/skill-index.js";
import type { SkillContext } from "./context-builder.js";
import { prepareSkillContext } from "@/skills/skill-resolver.js";
import { classifyRequest, type OutcomeContract, type EffectCeiling } from "./outcome-contract.js";
import { routeSkills } from "@/skills/skill-router.js";
import type { SkillMetadataV2 } from "@/skills/skill-v2-metadata.js";

/**
 * Result of preparing a run request.
 * Discriminated union — exactly one case.
 */
export type PreparedRunRequest =
  | { status: "invalid"; error: string; message: string }
  | { status: "unknown-skill"; skillName: string }
  | { status: "skill-load-error"; skillName: string; error: string }
  | {
      status: "ready";
      /** Validated wire request */
      wireRequest: WireRunStartRequest;
      /** Resolved skill context(s) (undefined = answer mode, array = composition) */
      skillContext: SkillContext | undefined;
      /** All resolved skill contexts (for multi-skill composition) */
      allSkillContexts: SkillContext[];
      /** Draft Outcome Contract */
      outcomeContract: OutcomeContract;
      /** Router decision reason (for tracing) */
      routingReason: string;
    };

/**
 * Prepare a run request — validate, resolve skill, classify intent.
 *
 * MUST be called BEFORE creating a FastAPI run, registering session state,
 * or writing HTTP/SSE headers. This ensures:
 * - Invalid requests are rejected early
 * - Unknown skills fail closed
 * - Skill load failures don't create orphan runs
 * - The Outcome Contract is available for context building and tracing
 *
 * Skill resolution priority:
 * 1. Explicit runtime_config.skill (highest — direct lookup)
 * 2. Deterministic router (when no explicit skill)
 * 3. Answer mode fallback (when no match)
 *
 * @param wireRequest - The parsed wire request body
 * @param skillLoader - Skill loader for loading SKILL.md body
 * @param skillIndex - Optional injected SkillIndex (defaults to singleton)
 * @param options - Additional context for classification
 */
export async function prepareRunRequest(
  wireRequest: unknown,
  skillLoader: SkillLoader,
  skillIndex?: SkillIndex,
  options?: {
    hasPendingProposals?: boolean;
    hasDirectionCard?: boolean;
    workspaceState?: unknown;
  },
): Promise<PreparedRunRequest> {
  // Step 1: Validate wire request using the canonical parser from types/wire.ts.
  const validated = parseRunStartRequest(wireRequest);
  if (!validated) {
    return {
      status: "invalid",
      error: "validation_error",
      message: "请求体格式无效: 缺少必要字段 (conversation_id, workspace_id, project_id)",
    };
  }

  // Step 2: Resolve skill context
  let skillContext: SkillContext | undefined;
  let allSkillContexts: SkillContext[] = [];
  let routingReason = "";

  const explicitSkill = validated.runtime_config?.skill;

  if (explicitSkill) {
    // Explicit skill — direct lookup (highest priority)
    const skillResult = await prepareSkillContext(
      { skillName: explicitSkill },
      skillLoader,
      skillIndex,
    );

    if (skillResult.status === "unknown-skill") {
      return { status: "unknown-skill", skillName: skillResult.skillName };
    }

    if (skillResult.status === "load-error") {
      return {
        status: "skill-load-error",
        skillName: skillResult.skillName,
        error: skillResult.error,
      };
    }

    if (skillResult.status === "resolved") {
      skillContext = skillResult.context;
      allSkillContexts = [skillContext];
      routingReason = `explicit skill: ${explicitSkill}`;
    }
  } else {
    // No explicit skill — use deterministic router
    const index = skillIndex ?? (await import("@/skills/skill-index.js")).getSkillIndex();
    const allSkills = index.getAll() as SkillMetadataV2[];

    const routeResult = routeSkills(allSkills, {
      userContent: validated.user_content ?? "",
      workspaceState: options?.workspaceState,
      hasPendingProposals: options?.hasPendingProposals,
    });

    routingReason = routeResult.reason;

    if (routeResult.selected.length > 0) {
      // Load skill bodies for selected skills
      const loadedContexts: SkillContext[] = [];
      for (const selected of routeResult.selected) {
        const skillResult = await prepareSkillContext(
          { skillName: selected.name },
          skillLoader,
          skillIndex,
        );
        if (skillResult.status === "resolved") {
          loadedContexts.push(skillResult.context);
        }
      }

      if (loadedContexts.length > 0) {
        allSkillContexts = loadedContexts;
        // Primary skill is the first one (highest priority)
        skillContext = loadedContexts[0];
      }
    }
    // If router returns no selected skills, skillContext remains undefined (answer mode)
  }

  // Step 3: Classify Outcome Contract
  // Use the primary skill context for classification
  const outcomeContract = classifyRequest({
    userContent: validated.user_content ?? "",
    skillContext,
    hasPendingProposals: options?.hasPendingProposals,
    hasDirectionCard: options?.hasDirectionCard,
  });

  // Step 4: Update effect ceiling based on router's combined result
  // (overrides the per-skill classification from classifyRequest)
  if (allSkillContexts.length > 1) {
    // Multi-skill composition — use the most restrictive effect ceiling
    const combinedCeiling = computeCombinedEffectCeiling(allSkillContexts);
    outcomeContract.effectCeiling = combinedCeiling;
  }

  return {
    status: "ready",
    wireRequest: validated,
    skillContext,
    allSkillContexts,
    outcomeContract,
    routingReason,
  };
}

/**
 * Compute combined effect ceiling for multi-skill composition.
 * Takes the most restrictive ceiling from all skills.
 */
function computeCombinedEffectCeiling(skills: SkillContext[]): EffectCeiling {
  const rank: Record<EffectCeiling, number> = {
    none: 0,
    advisory_only: 1,
    proposal_only: 2,
    full: 3,
  };

  // Default to proposal_only if skill doesn't specify
  const ceilings: EffectCeiling[] = skills.map(() => "proposal_only");
  const minRank = Math.min(...ceilings.map((c) => rank[c]));
  return (Object.entries(rank).find(([, r]) => r === minRank)?.[0] ?? "none") as EffectCeiling;
}

/**
 * Prompt kernel version — used for tracing and reproducibility.
 * Increment when the system prompt TEMPLATE STRUCTURE changes.
 * Dynamic content (time, workspace, skill, memory) does NOT affect this version.
 */
export const PROMPT_KERNEL_VERSION = "1.0.0";

/**
 * Static kernel signature — identifies the prompt template structure.
 * This is STABLE across different dynamic contexts (workspace, skill, memory).
 * Change this when the prompt sections, ordering, or rules change.
 */
const KERNEL_SIGNATURE = `v${PROMPT_KERNEL_VERSION}:answer-action-split:id-mapping:memory-rules`;

import { createHash } from "node:crypto";

/**
 * Stable hash of the prompt kernel template.
 * Deterministic: same version → same hash, regardless of dynamic content.
 * Uses SHA-256 for reproducibility, truncated to 16 hex chars.
 */
export function hashPromptKernel(): string {
  const hash = createHash("sha256").update(KERNEL_SIGNATURE).digest("hex");
  return `pk_${hash.slice(0, 16)}`;
}

/**
 * Hash of the fully assembled system prompt (including dynamic content).
 * NOT stable across different contexts — use only for debug/trace.
 * Uses SHA-256, truncated to 16 hex chars.
 */
export function hashAssembledPrompt(systemPrompt: string): string {
  const hash = createHash("sha256").update(systemPrompt).digest("hex");
  return `ap_${hash.slice(0, 16)}`;
}

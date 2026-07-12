/**
 * Skill router — two-stage deterministic skill selection.
 *
 * Stage 1: Narrow candidates using explicit/deterministic signals
 *   (explicit skill name, exact quick-reply match, prerequisite check)
 * Stage 2: Score and rank candidates, apply negative triggers, conflict detection
 *
 * No LLM classifier — all selection is deterministic.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Skills V2
 */

import type { SkillMetadataV2, SkillEffectCeiling, SkillV2Metadata } from "./skill-v2-metadata.js";
import { defaultV2Metadata } from "./skill-v2-metadata.js";
import type { SkillContext } from "@/runtime/context-builder.js";

/**
 * Input for skill routing.
 */
export interface SkillRouteInput {
  /** User message content */
  userContent: string;
  /** Explicit skill name from runtime_config (highest priority) */
  explicitSkill?: string;
  /** Workspace state for prerequisite checking */
  workspaceState?: unknown;
  /** Whether there are pending proposals */
  hasPendingProposals?: boolean;
}

/**
 * A scored skill candidate.
 */
export interface SkillCandidate {
  /** Skill metadata (v2 extended) */
  metadata: SkillMetadataV2;
  /** Match score (higher = better match) */
  score: number;
  /** Reason for this score */
  reasons: string[];
  /** Whether this candidate was rejected (and why) */
  rejected?: string;
}

/**
 * Result of skill routing.
 */
export interface SkillRouteResult {
  /** Selected skills (0 = answer mode, 1 = single skill, 2+ = composition) */
  selected: SkillMetadataV2[];
  /** All candidates considered */
  candidates: SkillCandidate[];
  /** Combined effect ceiling (most restrictive) */
  combinedEffectCeiling: SkillEffectCeiling;
  /** Combined allowed tools (union) */
  combinedAllowedTools: string[];
  /** Routing reason */
  reason: string;
}

/**
 * Route skills deterministically.
 */
export function routeSkills(
  allSkills: SkillMetadataV2[],
  input: SkillRouteInput,
): SkillRouteResult {
  // Stage 1: Narrow candidates
  const candidates = narrowCandidates(allSkills, input);

  // Stage 2: Score, rank, check conflicts
  const { selected, combinedEffectCeiling, combinedAllowedTools, reason } =
    selectAndCombine(candidates);

  return {
    selected,
    candidates,
    combinedEffectCeiling,
    combinedAllowedTools,
    reason,
  };
}

/**
 * Stage 1: Narrow candidates using deterministic signals.
 */
function narrowCandidates(
  allSkills: SkillMetadataV2[],
  input: SkillRouteInput,
): SkillCandidate[] {
  const candidates: SkillCandidate[] = [];

  for (const skill of allSkills) {
    const v2 = skill.v2 ?? defaultV2Metadata();
    const reasons: string[] = [];
    let score = 0;

    // Explicit skill name — highest priority
    if (input.explicitSkill === skill.name) {
      score += 100;
      reasons.push("explicit skill name");
    }

    // Check negative triggers FIRST — if matched, reject immediately
    if (v2.negativeTriggers.length > 0) {
      const negMatch = v2.negativeTriggers.some((neg) =>
        input.userContent.includes(neg),
      );
      if (negMatch) {
        candidates.push({
          metadata: skill,
          score: 0,
          reasons: ["negative trigger matched"],
          rejected: "negative trigger",
        });
        continue;
      }
    }

    // Check trigger examples
    if (v2.triggerExamples.length > 0) {
      const triggerMatch = v2.triggerExamples.some((trigger) =>
        input.userContent.includes(trigger),
      );
      if (triggerMatch) {
        score += 30;
        reasons.push("trigger example matched");
      }
    }

    // Check prerequisites
    const prereqResult = checkPrerequisites(v2, input);
    if (!prereqResult.passed) {
      candidates.push({
        metadata: skill,
        score: 0,
        reasons: [`prerequisite failed: ${prereqResult.reason}`],
        rejected: `prerequisite: ${prereqResult.reason}`,
      });
      continue;
    }
    if (prereqResult.passed && prereqResult.matched) {
      score += 10;
      reasons.push("prerequisites matched");
    }

    // Description keyword matching (existing v1 behavior, preserved)
    const descMatch = matchDescription(skill.description, input.userContent);
    if (descMatch > 0) {
      score += descMatch;
      reasons.push("description keyword match");
    }

    candidates.push({ metadata: skill, score, reasons });
  }

  return candidates;
}

/**
 * Stage 2: Select and combine candidates.
 */
function selectAndCombine(
  candidates: SkillCandidate[],
): {
  selected: SkillMetadataV2[];
  combinedEffectCeiling: SkillEffectCeiling;
  combinedAllowedTools: string[];
  reason: string;
} {
  // Filter out rejected candidates
  const valid = candidates.filter((c) => !c.rejected);

  if (valid.length === 0) {
    return {
      selected: [],
      combinedEffectCeiling: "none",
      combinedAllowedTools: [],
      reason: "no matching skills — answer mode",
    };
  }

  // Sort by score descending
  valid.sort((a, b) => b.score - a.score);

  // Take top-scoring candidates (max 2 for composition)
  const topScore = valid[0]!.score;

  // If top score is 0, no meaningful match — answer mode
  if (topScore === 0) {
    return {
      selected: [],
      combinedEffectCeiling: "none",
      combinedAllowedTools: [],
      reason: "no meaningful match — answer mode",
    };
  }

  const topCandidates = valid.filter((c) => c.score === topScore);

  // Check for conflicts between top candidates
  if (topCandidates.length > 1) {
    const conflict = detectConflicts(topCandidates);
    if (conflict) {
      return {
        selected: [],
        combinedEffectCeiling: "none",
        combinedAllowedTools: [],
        reason: `conflict between skills: ${conflict} — fail closed to answer mode`,
      };
    }
  }

  // Select top candidates (max 2)
  const selected = topCandidates.slice(0, 2).map((c) => c.metadata);

  // Compute combined effect ceiling (most restrictive)
  const combinedEffectCeiling = computeCombinedEffectCeiling(
    selected.map((s) => s.v2?.allowedEffects ?? "proposal_only"),
  );

  // Compute combined allowed tools (union)
  const combinedAllowedTools = [
    ...new Set(selected.flatMap((s) => s.allowedTools)),
  ];

  // Filter out any confirm/reject/commit tools (safety)
  const safeTools = combinedAllowedTools.filter(
    (t) =>
      !t.includes("confirm_proposal") &&
      !t.includes("reject_proposal") &&
      !t.includes("commit_proposal"),
  );

  const reason =
    selected.length === 1
      ? `single skill: ${selected[0]!.name}`
      : `composed: ${selected.map((s) => s.name).join(" + ")}`;

  return {
    selected,
    combinedEffectCeiling,
    combinedAllowedTools: safeTools,
    reason,
  };
}

/**
 * Check prerequisites for a skill.
 */
function checkPrerequisites(
  v2: SkillV2Metadata,
  input: SkillRouteInput,
): { passed: boolean; matched: boolean; reason?: string } {
  if (v2.prerequisites.length === 0) {
    return { passed: true, matched: false };
  }

  const ws = input.workspaceState as Record<string, unknown> | undefined;
  const project = ws?.project as Record<string, unknown> | undefined;

  for (const prereq of v2.prerequisites) {
    switch (prereq.type) {
      case "has_direction_card":
        if (!project?.direction_card) {
          return { passed: false, matched: false, reason: "no direction card" };
        }
        break;
      case "has_stages":
        if (!Array.isArray(project?.stages) || project.stages.length === 0) {
          return { passed: false, matched: false, reason: "no stages" };
        }
        break;
      case "has_tasks":
        if (!Array.isArray(project?.tasks) || project.tasks.length === 0) {
          return { passed: false, matched: false, reason: "no tasks" };
        }
        break;
      case "has_members":
        if (!Array.isArray(ws?.members) || (ws.members as unknown[]).length === 0) {
          return { passed: false, matched: false, reason: "no members" };
        }
        break;
      case "has_pending_proposals":
        if (!input.hasPendingProposals) {
          return { passed: false, matched: false, reason: "no pending proposals" };
        }
        break;
      case "no_pending_proposals":
        if (input.hasPendingProposals) {
          return { passed: false, matched: false, reason: "has pending proposals" };
        }
        break;
    }
  }

  return { passed: true, matched: true };
}

/**
 * Detect conflicts between selected skills.
 * Returns conflict description or null if compatible.
 */
function detectConflicts(candidates: SkillCandidate[]): string | null {
  // Check for incompatible effect ceilings
  const effects = candidates.map(
    (c) => c.metadata.v2?.allowedEffects ?? "proposal_only",
  );

  // If any skill requires "full" and another requires "none", that's a conflict
  if (effects.includes("full") && effects.includes("none")) {
    return "incompatible effect ceilings (full vs none)";
  }

  // Check for overlapping tool requirements that can't coexist
  const toolSets = candidates.map((c) => new Set(c.metadata.allowedTools));
  for (let i = 0; i < toolSets.length; i++) {
    for (let j = i + 1; j < toolSets.length; j++) {
      // If both skills need the same proposal-creating tool, that's a conflict
      for (const tool of toolSets[i]!) {
        if (toolSets[j]!.has(tool) && tool.includes("proposal")) {
          return `both skills require proposal tool: ${tool}`;
        }
      }
    }
  }

  return null;
}

/**
 * Compute combined effect ceiling (most restrictive wins).
 */
function computeCombinedEffectCeiling(
  ceilings: SkillEffectCeiling[],
): SkillEffectCeiling {
  const rank: Record<SkillEffectCeiling, number> = {
    none: 0,
    advisory_only: 1,
    proposal_only: 2,
    full: 3,
  };

  const minRank = Math.min(...ceilings.map((c) => rank[c]));
  return (Object.entries(rank).find(([, r]) => r === minRank)?.[0] ?? "none") as SkillEffectCeiling;
}

/**
 * Match description keywords (preserved from v1 selector).
 */
function matchDescription(description: string, userContent: string): number {
  const desc = description.toLowerCase();
  const msg = userContent.toLowerCase();
  let score = 0;

  // Simple keyword matching
  const keywords = [
    { pattern: /计划|阶段|规划/, skill: "planning", score: 5 },
    { pattern: /拆分|任务|分解/, skill: "breakdown", score: 5 },
    { pattern: /分工|分配|谁做/, skill: "assignment", score: 5 },
    { pattern: /风险|阻塞|延期/, skill: "risk", score: 5 },
    { pattern: /进展|状态|进度/, skill: "status", score: 5 },
    { pattern: /想法|方向|目标/, skill: "intake", score: 5 },
  ];

  for (const kw of keywords) {
    if (kw.pattern.test(msg) && desc.includes(kw.skill)) {
      score += kw.score;
    }
  }

  return score;
}

/**
 * Build a SkillContext from a SkillMetadataV2 for use in context builder.
 * Does NOT load references (lazy loading only when explicitly needed).
 */
export function skillMetadataToContext(skill: SkillMetadataV2): SkillContext {
  return {
    name: skill.name,
    description: skill.description,
    body: "", // body is loaded separately by SkillLoader
    allowedTools: skill.allowedTools,
  };
}

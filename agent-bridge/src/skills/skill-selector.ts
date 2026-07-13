/**
 * Skill selector — matches user messages and WorkspaceState to skills.
 * Uses the description's trigger conditions for matching.
 */

import type { SkillMetadata } from "./skill-index.js";
import type { SkillLoader } from "./skill-loader.js";
import type { SkillContext } from "@/runtime/context-builder.js";
import { defaultV2Metadata } from "./skill-v2-metadata.js";

export interface SkillMatchInput {
  userMessage: string;
  workspaceState?: unknown;
  currentStage?: string;
  hasDirectionCard?: boolean;
  hasPendingProposals?: boolean;
  hasBlockedTasks?: boolean;
}

export interface SkillMatchResult {
  skill: SkillMetadata;
  confidence: number; // 0-1
  reason: string;
}

/**
 * Select the best matching skill based on user message and workspace state.
 */
export function selectSkill(
  skills: SkillMetadata[],
  input: SkillMatchInput,
): SkillMatchResult | null {
  const candidates: SkillMatchResult[] = [];

  for (const skill of skills) {
    const match = evaluateSkillMatch(skill, input);
    if (match.confidence > 0) {
      candidates.push(match);
    }
  }

  if (candidates.length === 0) return null;

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0] ?? null;
}

function evaluateSkillMatch(skill: SkillMetadata, input: SkillMatchInput): SkillMatchResult {
  const desc = skill.description.toLowerCase();
  const msg = input.userMessage.toLowerCase();

  let confidence = 0;
  const reasons: string[] = [];

  // project-intake: direction card missing or goals unclear
  if (skill.name === "project-intake") {
    if (!input.hasDirectionCard || desc.includes("目标模糊")) {
      confidence += 0.6;
      reasons.push("缺少方向卡");
    }
    if (msg.includes("想法") || msg.includes("方向") || msg.includes("目标")) {
      confidence += 0.3;
      reasons.push("用户提到目标/方向");
    }
  }

  // project-planning: needs stage plan
  if (skill.name === "project-planning") {
    if (msg.includes("计划") || msg.includes("阶段") || msg.includes("规划")) {
      confidence += 0.7;
      reasons.push("用户提到计划/阶段");
    }
    if (input.currentStage === "clarification") {
      confidence += 0.2;
      reasons.push("当前处于澄清阶段");
    }
  }

  // task-breakdown: needs task decomposition
  if (skill.name === "task-breakdown") {
    if (msg.includes("拆分") || msg.includes("任务") || msg.includes("分解")) {
      confidence += 0.7;
      reasons.push("用户提到任务拆分");
    }
  }

  // assignment-planning: needs assignment
  if (skill.name === "assignment-planning") {
    if (msg.includes("分工") || msg.includes("分配") || msg.includes("谁做")) {
      confidence += 0.7;
      reasons.push("用户提到分工/分配");
    }
  }

  // risk-replan: blocked tasks or risks
  if (skill.name === "risk-replan") {
    if (input.hasBlockedTasks) {
      confidence += 0.5;
      reasons.push("有阻塞任务");
    }
    if (msg.includes("风险") || msg.includes("阻塞") || msg.includes("重新规划") || msg.includes("延期")) {
      confidence += 0.6;
      reasons.push("用户提到风险/阻塞/重新规划");
    }
  }

  // project-status: progress query
  if (skill.name === "project-status") {
    if (msg.includes("进展") || msg.includes("状态") || msg.includes("进度")) {
      confidence += 0.7;
      reasons.push("用户询问进展/状态");
    }
  }

  return {
    skill,
    confidence: Math.min(confidence, 1),
    reason: reasons.join(", ") || "无匹配条件",
  };
}

/**
 * Build a SkillContext from a matched skill for use in context builder.
 */
export async function buildSkillContext(
  skill: SkillMetadata,
  loader: SkillLoader,
): Promise<SkillContext> {
  const loaded = await loader.loadSkill(skill);

  // Load references on demand (one at a time)
  const referenceContents: string[] = [];
  for (const ref of skill.references) {
    const content = await loader.loadReference(loaded, ref);
    referenceContents.push(content);
  }

  return {
    name: skill.name,
    description: skill.description,
    body: loaded.body,
    allowedTools: skill.allowedTools,
    references: referenceContents.length > 0 ? referenceContents : undefined,
    effectCeiling: skill.v2?.allowedEffects ?? defaultV2Metadata().allowedEffects,
  };
}

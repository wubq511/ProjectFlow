/**
 * Policy engine — allow/deny/block decisions for tool calls.
 *
 * Rules:
 * - read_only → allow
 * - analysis → allow (parallel if no write, else sequential)
 * - draft_only → allow proposal creation only (no commit)
 * - advisory_write → allow advisory records
 * - internal_write → allow only if sidecarOnly
 * - destructive → block
 * - open_world → block (disabled)
 * - human_triggered_only → block (model cannot call)
 *
 * The policy engine NEVER pauses a run to wait for human approval.
 * The only human confirmation boundary is proposal confirmation via FastAPI public API.
 */

import type { ProjectFlowToolManifest, RiskCategory } from "@/types/tool-manifest.js";
import type { SkillEffectCeiling } from "@/skills/skill-v2-metadata.js";

export type PolicyDecision = "allow" | "deny" | "block";

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

/**
 * Evaluate whether a tool call is allowed by policy.
 */
export function evaluatePolicy(
  manifest: ProjectFlowToolManifest,
  effectCeiling?: SkillEffectCeiling,
): PolicyResult {
  // Human-only actions are always blocked for model calls
  if (manifest.humanTriggeredOnly || !manifest.modelCallable) {
    return {
      decision: "block",
      reason: `工具 ${manifest.name} 仅限人工触发，模型不可调用`,
    };
  }

  const policyResult = evaluateByRiskCategory(manifest.riskCategory, manifest);
  if (policyResult.decision !== "allow" || !effectCeiling) return policyResult;

  if (!isWithinEffectCeiling(manifest.riskCategory, effectCeiling)) {
    return {
      decision: "block",
      reason: `工具 ${manifest.name} 的风险类别 ${manifest.riskCategory} 超出当前效果上限 ${effectCeiling}`,
    };
  }

  return policyResult;
}

/** Enforce the ordered ceiling: none < advisory_only < proposal_only < full. */
export function isWithinEffectCeiling(
  riskCategory: RiskCategory,
  ceiling: SkillEffectCeiling,
): boolean {
  if (riskCategory === "destructive" || riskCategory === "open_world") return false;

  switch (ceiling) {
    case "none":
      return riskCategory === "read_only";
    case "advisory_only":
      return riskCategory === "read_only" || riskCategory === "analysis" || riskCategory === "advisory_write";
    case "proposal_only":
      return riskCategory === "read_only" || riskCategory === "analysis" || riskCategory === "advisory_write" || riskCategory === "draft_only";
    case "full":
      return true;
  }
}

function evaluateByRiskCategory(category: RiskCategory, manifest: ProjectFlowToolManifest): PolicyResult {
  switch (category) {
    case "read_only":
      return { decision: "allow", reason: "只读工具，允许并行执行" };

    case "analysis":
      return {
        decision: "allow",
        reason: manifest.execution.mode === "parallel"
          ? "分析工具（无写入），允许并行"
          : "分析工具（含写入），顺序执行",
      };

    case "draft_only":
      // Draft-only tools can create proposals, but never commit
      if (manifest.effects.effectType === "proposal_create") {
        return { decision: "allow", reason: "草稿工具，仅创建提案" };
      }
      return {
        decision: "deny",
        reason: `草稿工具 ${manifest.name} 的效果类型 ${manifest.effects.effectType} 不允许`,
      };

    case "advisory_write":
      if (manifest.effects.effectType === "advisory_record_create") {
        return { decision: "allow", reason: "咨询写入工具，创建咨询记录" };
      }
      return {
        decision: "deny",
        reason: `咨询写入工具 ${manifest.name} 的效果类型 ${manifest.effects.effectType} 不允许`,
      };

    case "internal_write":
      if (manifest.sidecarOnly) {
        return { decision: "allow", reason: "内部写入工具（sidecar 专用）" };
      }
      return {
        decision: "deny",
        reason: `内部写入工具 ${manifest.name} 非 sidecar 专用，不允许模型调用`,
      };

    case "destructive":
      return {
        decision: "block",
        reason: `破坏性工具 ${manifest.name} 被阻止`,
      };

    case "open_world":
      return {
        decision: "block",
        reason: `开放世界工具 ${manifest.name} 当前被禁用`,
      };

    default:
      return {
        decision: "block",
        reason: `未知风险类别: ${category}`,
      };
  }
}

/**
 * Check if a batch of tools can execute in parallel.
 * Rule: if ANY tool is sequential, the entire batch executes sequentially.
 */
export function canExecuteInParallel(manifests: ProjectFlowToolManifest[]): boolean {
  return manifests.every(
    (m) =>
      m.riskCategory === "read_only"
      && m.execution.mode === "parallel"
      && m.execution.providerParallelToolCallsAllowed,
  );
}

/**
 * Validate that a draft_only tool does not have a commit effect type.
 * This is a critical invariant: LLM-callable manifests must never have commit effects.
 */
export function validateManifestSafety(manifest: ProjectFlowToolManifest): string[] {
  const errors: string[] = [];

  // Draft-only must not commit
  if (manifest.riskCategory === "draft_only" && manifest.effects.effectType !== "proposal_create") {
    errors.push(`draft_only 工具 ${manifest.name} 的效果类型必须是 proposal_create，当前是 ${manifest.effects.effectType}`);
  }

  // Advisory-write must not touch primary state
  if (manifest.riskCategory === "advisory_write" && manifest.effects.effectType !== "advisory_record_create") {
    errors.push(`advisory_write 工具 ${manifest.name} 的效果类型必须是 advisory_record_create`);
  }

  return errors;
}

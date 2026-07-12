/**
 * Outcome Contract — additive draft classification for each agent run.
 *
 * Classifies the request into a typed intent envelope BEFORE any model call.
 * Uses deterministic rules only — no LLM judge, no fuzzy inference.
 *
 * This is an ADDITIVE draft contract. It does not replace existing behavior;
 * it augments it with structured metadata for tracing, verification, and
 * future planner/verifier integration.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Outcome Contract
 */

import type { SkillContext } from "./context-builder.js";

/**
 * What kind of request this is.
 * - answer: user asks a question, expects information
 * - clarify: user needs more info before proceeding (blocking clarification)
 * - analyze: user wants analysis/read-only inspection
 * - act: user wants a concrete action/tool execution
 * - review: user wants to review/confirm/reject something
 */
export type RequestType = "answer" | "clarify" | "analyze" | "act" | "review";

/**
 * How much side-effect the run is allowed to produce.
 * - none: pure read/answer, no tools needed
 * - advisory_only: can create Risk/ActionCard, no proposals
 * - proposal_only: can create proposals, no direct commits
 * - full: can create proposals and advisory records
 */
export type EffectCeiling = "none" | "advisory_only" | "proposal_only" | "full";

/**
 * When the agent should ask for clarification.
 * - never: always proceed with available info
 * - blocking_only: ask only when missing info would change the result
 * - always: ask whenever info is incomplete
 */
export type ClarificationPolicy = "never" | "blocking_only" | "always";

/**
 * How the run result should be verified.
 * - none: no verification (answer-only)
 * - deterministic: schema/business invariants checked
 * - semantic: LLM judge (future, not in this slice)
 */
export type VerificationLevel = "none" | "deterministic" | "semantic";

/**
 * How the run completed.
 * - answer-only: direct answer, no artifacts
 * - complete: all success criteria met
 * - partial: some criteria met, some unresolved
 * - blocked: cannot proceed without user input or external change
 */
export type CompletionMode = "answer-only" | "complete" | "partial" | "blocked";

/**
 * The Outcome Contract for a single run.
 * Additive metadata — does not change existing behavior.
 */
export interface OutcomeContract {
  /** Version of the contract schema */
  schemaVersion: 1;
  /** What kind of request this is */
  requestType: RequestType;
  /** Normalized description of what the user wants */
  normalizedGoal: string;
  /** Hard constraints that must be respected */
  constraints: string[];
  /** What constitutes successful completion */
  successCriteria: string[];
  /** What evidence is needed to verify success */
  requiredEvidence: string[];
  /** Maximum side-effect level allowed */
  effectCeiling: EffectCeiling;
  /** When to ask for clarification */
  clarificationPolicy: ClarificationPolicy;
  /** How to verify the result */
  verificationLevel: VerificationLevel;
  /** How the run completed (set at end) */
  completionMode: CompletionMode;
}

/**
 * Input for contract classification.
 */
export interface ClassifyInput {
  /** The user's message content */
  userContent: string;
  /** Resolved skill context (undefined = answer mode) */
  skillContext?: SkillContext;
  /** Whether there are pending proposals */
  hasPendingProposals?: boolean;
  /** Whether the workspace has a direction card */
  hasDirectionCard?: boolean;
}

/**
 * Classify a request into an Outcome Contract using deterministic rules.
 *
 * Rules (conservative, no LLM):
 * 1. No skill + no explicit action markers → answer
 * 2. Skill with proposal-creating tools → act
 * 3. Review keywords (确认/拒绝/查看 proposal) → review
 * 4. Analysis skill without writes → analyze
 * 5. Otherwise → answer (safe default)
 */
export function classifyRequest(input: ClassifyInput): OutcomeContract {
  const { userContent, skillContext } = input;

  // Determine request type
  const requestType = determineRequestType(userContent, skillContext);

  // Determine effect ceiling based on skill and request type
  const effectCeiling = determineEffectCeiling(requestType, skillContext);

  // Build normalized goal
  const normalizedGoal = buildNormalizedGoal(userContent, skillContext);

  return {
    schemaVersion: 1,
    requestType,
    normalizedGoal,
    constraints: buildConstraints(skillContext),
    successCriteria: buildSuccessCriteria(requestType, skillContext),
    requiredEvidence: buildRequiredEvidence(requestType),
    effectCeiling,
    clarificationPolicy: requestType === "clarify" ? "blocking_only" : "never",
    verificationLevel: effectCeiling === "none" ? "none" : "deterministic",
    completionMode: requestType === "answer" ? "answer-only" : "complete",
  };
}

/**
 * Determine the request type from content and skill.
 */
function determineRequestType(
  content: string,
  skillContext?: SkillContext,
): RequestType {
  // Review keywords — user wants to confirm/reject/view proposals
  if (/确认|拒绝|批准|查看.*提案|处理.*提案/.test(content)) {
    return "review";
  }

  // With skill → act (skill implies action)
  if (skillContext) {
    // Check if it's an analysis-only skill
    if (isAnalysisSkill(skillContext)) {
      return "analyze";
    }
    return "act";
  }

  // No skill → answer (conservative default)
  return "answer";
}

/**
 * Check if a skill is analysis-only (read-only tools only).
 */
function isAnalysisSkill(skillContext: SkillContext): boolean {
  const readOnlyTools = ["get_workspace_state", "get_timeline_slice", "list_pending_proposals"];
  return skillContext.allowedTools.every((t) => readOnlyTools.includes(t));
}

/**
 * Determine the effect ceiling.
 */
function determineEffectCeiling(
  requestType: RequestType,
  skillContext?: SkillContext,
): EffectCeiling {
  switch (requestType) {
    case "answer":
      return "none";
    case "clarify":
      return "none";
    case "analyze":
      // Analysis can create advisory records (risk analysis creates risks)
      if (skillContext?.allowedTools.includes("create_risk")) {
        return "advisory_only";
      }
      return "none";
    case "act":
      return determineActEffectCeiling(skillContext);
    case "review":
      return "none"; // Review is read-only
  }
}

/**
 * Determine effect ceiling for action requests based on skill tools.
 */
function determineActEffectCeiling(skillContext?: SkillContext): EffectCeiling {
  if (!skillContext) return "none";

  const hasProposalTool = skillContext.allowedTools.some((t) =>
    t.includes("proposal") || t.includes("recommendation"),
  );
  const hasAdvisoryTool = skillContext.allowedTools.some((t) =>
    t.includes("create_risk") || t.includes("create_checkin"),
  );

  if (hasProposalTool && hasAdvisoryTool) return "full";
  if (hasProposalTool) return "proposal_only";
  if (hasAdvisoryTool) return "advisory_only";
  return "none";
}

/**
 * Build a normalized goal description.
 */
function buildNormalizedGoal(content: string, skillContext?: SkillContext): string {
  if (skillContext) {
    return `[${skillContext.name}] ${content.slice(0, 200)}`;
  }
  return content.slice(0, 200);
}

/**
 * Build constraints based on skill.
 */
function buildConstraints(skillContext?: SkillContext): string[] {
  const constraints: string[] = [
    "不得直接修改 Primary Project State",
    "不得编造成员、任务、阶段",
    "用户可见文本使用中文",
    "内部 ID 只用于工具参数",
  ];

  if (skillContext) {
    constraints.push(`只使用允许的工具: ${skillContext.allowedTools.join(", ")}`);
  }

  return constraints;
}

/**
 * Build success criteria based on request type.
 */
function buildSuccessCriteria(
  requestType: RequestType,
  skillContext?: SkillContext,
): string[] {
  switch (requestType) {
    case "answer":
      return ["回答基于可用上下文", "不产生副作用"];
    case "clarify":
      return ["明确指出缺失信息", "提出具体问题"];
    case "analyze":
      return ["分析基于实际数据", "包含证据和理由"];
    case "act":
      return [
        "调用必要的工具",
        "工具调用成功",
        ...(skillContext ? [`完成 ${skillContext.name} 工作流`] : []),
      ];
    case "review":
      return ["基于实际提案内容回答", "不自行创建新提案"];
  }
}

/**
 * Build required evidence based on request type.
 */
function buildRequiredEvidence(requestType: RequestType): string[] {
  switch (requestType) {
    case "answer":
      return [];
    case "clarify":
      return [];
    case "analyze":
      return ["tool_observations"];
    case "act":
      return ["tool_observations", "tool_results"];
    case "review":
      return ["proposal_context"];
  }
}

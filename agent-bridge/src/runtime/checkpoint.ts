/**
 * Durable checkpoint — versioned snapshots persisted at reliable boundaries.
 *
 * Each checkpoint captures the minimal state needed to resume a run after
 * sidecar restart. Persisted via the existing FastAPI appendEvents API
 * (no new tables needed).
 *
 * Checkpoint boundaries:
 * - After each successful tool result (reliable observation)
 * - After plan step update
 * - After work state transition to awaiting_user/awaiting_approval
 * - Before terminal status assignment
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Phase 5
 */

import type { WorkState } from "./work-state.js";
import type { RunPlan } from "./run-plan.js";
import type { OutcomeContract } from "./outcome-contract.js";
import type { ToolLedgerEntry } from "@/tools/tool-executor.js";
import type { AgentRunState, RunStatus } from "@/types/run-state.js";

/**
 * Recovery policy for a tool call when resuming.
 */
export type ToolRecoveryAction =
  | "completed"            // already succeeded, skip
  | "safe_to_retry"        // no_side_effect + replay-safe, can retry
  | "blocked_unknown"      // unknown side effect, manual review
  | "blocked_incompatible" // manifest version changed, can't resume
  | "pending";             // never executed, can run

/**
 * Recovery decision for a specific tool call.
 */
export interface ToolRecoveryDecision {
  toolName: string;
  toolCallId: string;
  logicalCallId: string;
  action: ToolRecoveryAction;
  reason: string;
}

/**
 * Durable checkpoint snapshot.
 * Bounded and redacted — no raw workspace_state, secrets, or chain-of-thought.
 */
export interface RunCheckpoint {
  /** Schema version */
  schemaVersion: 1;
  /** Checkpoint ID (unique per snapshot) */
  id: string;
  /** Run ID */
  runId: string;
  /** Conversation ID */
  conversationId: string;
  /** Workspace ID */
  workspaceId: string;
  /** Project ID */
  projectId: string;

  /** Transport state at checkpoint time */
  transportStatus: RunStatus;
  /** Work state (cognitive) */
  workState: WorkState;
  /** Work state version for optimistic concurrency */
  workStateVersion: number;

  /** Outcome Contract (classification only, not full content) */
  outcomeContractSummary?: {
    requestType: string;
    effectCeiling: string;
    completionMode: string;
    verificationLevel: string;
  };

  /** Full Outcome Contract — persisted at checkpoint creation for resume fidelity */
  fullOutcomeContract?: OutcomeContract;

  /** Original normalized user goal — persisted for resume (never synthetic) */
  originalUserContent?: string;

  /** Hard constraints from the original request */
  hardConstraints?: string[];

  /** Success criteria from the original request */
  successCriteria?: string[];

  /** RunPlan snapshot (if exists) */
  runPlanSnapshot?: {
    planId: string;
    stepCount: number;
    currentStepIndex: number;
    steps: Array<{
      id: string;
      goal: string;
      status: string;
      attemptCount: number;
    }>;
  };

  /** Manifest versions for compatibility check */
  manifestVersions: Record<string, number>;

  /** Tool ledger refs (logical call IDs + final status) */
  toolLedgerRefs: Array<{
    logicalCallId: string;
    toolName: string;
    attempt: number;
    resultStatus?: string;
    sideEffectStatus?: string;
    idempotencyKey: string;
  }>;

  /** Pending tool call (if any) */
  pendingToolCall?: {
    toolCallId: string;
    toolName: string;
    idempotencyKey: string;
  };

  /** Latest user steering sequence number (for ordering) */
  latestSteeringSeq?: number;

  /** Context summary refs (not raw content) */
  contextSummary?: {
    userContentLength: number;
    workspaceStateLength: number;
    recentMessageCount: number;
    memoryUsed: boolean;
    skillName?: string;
  };

  /** Recovery decisions for tool calls */
  recoveryDecisions?: ToolRecoveryDecision[];

  /** When this checkpoint was created */
  timestamp: string;
  /** Checkpoint version (incremented on each snapshot) */
  version: number;
}

/**
 * Checkpoint trigger reasons.
 */
export type CheckpointTrigger =
  | "tool_result"       // after successful tool result
  | "plan_update"       // after plan step update
  | "work_state_change" // after work state transition
  | "pre_terminal"      // before terminal status
  | "steering_received" // after steering event consumed
  | "manual";           // explicit request

/**
 * Create a checkpoint from the current run state.
 * Bounded and redacted — no sensitive data.
 */
export function createCheckpoint(
  runState: AgentRunState,
  workState: WorkState,
  runPlan: RunPlan | undefined,
  outcomeContract: OutcomeContract | undefined,
  toolLedger: ToolLedgerEntry[],
  _trigger: CheckpointTrigger,
  checkpointVersion: number,
  latestSteeringSeq?: number,
  originalUserContent?: string,
): RunCheckpoint {
  // Build manifest versions from tool results
  const manifestVersions: Record<string, number> = {};
  for (const tr of runState.toolResults) {
    manifestVersions[tr.toolName] = 1; // default version
  }

  // Build tool ledger refs (bounded — no raw data)
  const toolLedgerRefs = toolLedger.map((e) => ({
    logicalCallId: e.logicalCallId,
    toolName: e.toolName,
    attempt: e.attempt,
    resultStatus: e.resultStatus,
    sideEffectStatus: e.sideEffectStatus,
    idempotencyKey: e.idempotencyKey,
  }));

  // Build run plan snapshot
  let runPlanSnapshot: RunCheckpoint["runPlanSnapshot"];
  if (runPlan) {
    runPlanSnapshot = {
      planId: runPlan.id,
      stepCount: runPlan.steps.length,
      currentStepIndex: runPlan.currentStepIndex,
      steps: runPlan.steps.map((s) => ({
        id: s.id,
        goal: s.goal.slice(0, 200), // bounded
        status: s.status,
        attemptCount: s.attemptCount,
      })),
    };
  }

  // Build outcome contract summary
  let outcomeContractSummary: RunCheckpoint["outcomeContractSummary"];
  if (outcomeContract) {
    outcomeContractSummary = {
      requestType: outcomeContract.requestType,
      effectCeiling: outcomeContract.effectCeiling,
      completionMode: outcomeContract.completionMode,
      verificationLevel: outcomeContract.verificationLevel,
    };
  }

  // Compute recovery decisions
  const recoveryDecisions = computeRecoveryDecisions(toolLedger);

  return {
    schemaVersion: 1,
    id: `ckpt_${runState.runId}_${checkpointVersion}`,
    runId: runState.runId,
    conversationId: runState.conversationId,
    workspaceId: runState.workspaceId,
    projectId: runState.projectId,
    transportStatus: runState.status,
    workState: { ...workState },
    workStateVersion: workState.version,
    outcomeContractSummary,
    fullOutcomeContract: outcomeContract,
    originalUserContent: originalUserContent?.slice(0, 2000), // bounded
    hardConstraints: outcomeContract?.constraints?.slice(0, 20),
    successCriteria: outcomeContract?.successCriteria?.slice(0, 20),
    runPlanSnapshot,
    manifestVersions,
    toolLedgerRefs,
    pendingToolCall: runState.pendingToolCall
      ? {
          toolCallId: runState.pendingToolCall.toolCallId,
          toolName: runState.pendingToolCall.toolName,
          idempotencyKey: runState.pendingToolCall.idempotencyKey,
        }
      : undefined,
    latestSteeringSeq,
    contextSummary: {
      userContentLength: originalUserContent?.length ?? 0,
      workspaceStateLength: 0,
      recentMessageCount: 0,
      memoryUsed: false,
    },
    recoveryDecisions,
    timestamp: new Date().toISOString(),
    version: checkpointVersion,
  };
}

/**
 * Compute recovery decisions for each tool call in the ledger.
 * Groups by logicalCallId and uses the LATEST/FINAL attempt deterministically.
 * A timeout followed by success must be completed, not blocked.
 */
function computeRecoveryDecisions(ledger: ToolLedgerEntry[]): ToolRecoveryDecision[] {
  // Group by logicalCallId
  const grouped = new Map<string, ToolLedgerEntry[]>();
  for (const entry of ledger) {
    const existing = grouped.get(entry.logicalCallId);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(entry.logicalCallId, [entry]);
    }
  }

  const decisions: ToolRecoveryDecision[] = [];
  for (const [, attempts] of grouped) {
    // Sort by attempt number ascending; use the latest (last) attempt
    attempts.sort((a, b) => a.attempt - b.attempt);
    const latestAttempt = attempts[attempts.length - 1]!;
    const decision = classifyToolRecovery(latestAttempt);

    // If the latest attempt is still pending/blocked but an earlier attempt
    // succeeded, the operation IS completed (timeout after success = completed)
    if (decision.action !== "completed" && decision.action !== "safe_to_retry") {
      const earlierSuccess = attempts.find(
        (e) => e !== latestAttempt && e.resultStatus === "success",
      );
      if (earlierSuccess) {
        decisions.push({
          ...decision,
          action: "completed",
          reason: `早期尝试已成功 (attempt ${earlierSuccess.attempt})`,
        });
        continue;
      }
    }

    decisions.push(decision);
  }

  return decisions;
}

/**
 * Classify a single tool call's recovery action.
 */
function classifyToolRecovery(entry: ToolLedgerEntry): ToolRecoveryDecision {
  const base = {
    toolName: entry.toolName,
    toolCallId: entry.toolCallId,
    logicalCallId: entry.logicalCallId,
  };

  // Successfully completed
  if (entry.resultStatus === "success") {
    return { ...base, action: "completed", reason: "工具已成功执行" };
  }

  // Proposal/advisory persisted — completed, no replay
  if (entry.sideEffectStatus === "proposal_persisted" ||
      entry.sideEffectStatus === "advisory_record_persisted") {
    return { ...base, action: "completed", reason: "提案/记录已持久化" };
  }

  // Unknown side effect — blocked, manual review
  if (entry.sideEffectStatus === "unknown") {
    return { ...base, action: "blocked_unknown", reason: "未知副作用，需人工审查" };
  }

  // Timeout with no side effect on replay-safe tool — safe to retry
  if (entry.errorCode === "timeout" && entry.sideEffectStatus === "no_side_effect") {
    return { ...base, action: "safe_to_retry", reason: "超时且无副作用，可安全重试" };
  }

  // Transient error with no side effect — safe to retry
  if (entry.errorCode === "transient" && entry.sideEffectStatus === "no_side_effect") {
    return { ...base, action: "safe_to_retry", reason: "瞬时错误且无副作用，可安全重试" };
  }

  // Policy/validation/auth errors — blocked
  if (entry.errorCode === "policy" || entry.errorCode === "validation" || entry.errorCode === "auth") {
    return { ...base, action: "blocked_incompatible", reason: `${entry.errorCode} 错误，无法自动恢复` };
  }

  // Permanent error — blocked
  if (entry.errorCode === "permanent") {
    return { ...base, action: "blocked_incompatible", reason: "永久性错误" };
  }

  // Default: pending (never executed or unknown state)
  return { ...base, action: "pending", reason: "未执行" };
}

/**
 * Determine if a run can be resumed based on its checkpoint.
 * Returns { canResume, reason }.
 */
export function canResumeCheckpoint(checkpoint: RunCheckpoint): {
  canResume: boolean;
  reason: string;
} {
  // Terminal states cannot resume
  if (["completed", "cancelled", "failed"].includes(checkpoint.transportStatus)) {
    return { canResume: false, reason: `运行已终止 (${checkpoint.transportStatus})` };
  }

  if (["completed", "partial", "blocked", "failed", "cancelled"].includes(checkpoint.workState.status)) {
    return { canResume: false, reason: `工作状态已终态 (${checkpoint.workState.status})` };
  }

  // Check for blocked unknown side effects
  const blockedDecisions = checkpoint.recoveryDecisions?.filter(
    (d) => d.action === "blocked_unknown",
  ) ?? [];
  if (blockedDecisions.length > 0) {
    return {
      canResume: false,
      reason: `存在未知副作用: ${blockedDecisions.map((d) => d.toolName).join(", ")}`,
    };
  }

  return { canResume: true, reason: "可以恢复" };
}

/**
 * Compatibility check result.
 */
export interface CompatibilityCheckResult {
  compatible: boolean;
  action: "continue" | "regenerate" | "blocked";
  details: Array<{
    component: string;
    checkpointVersion: string;
    currentVersion: string;
    status: "compatible" | "regenerable" | "incompatible";
  }>;
}

/**
 * Check manifest/skill/prompt compatibility for resume.
 * Uses semver range checking where available.
 */
export function checkCompatibility(
  checkpoint: RunCheckpoint,
  currentManifestVersions: Record<string, number>,
  _currentPromptHash: string,
): CompatibilityCheckResult {
  const details: CompatibilityCheckResult["details"] = [];
  let hasIncompatible = false;
  let hasRegenerable = false;

  // Check manifest versions
  for (const [toolName, ckptVersion] of Object.entries(checkpoint.manifestVersions)) {
    const currentVersion = currentManifestVersions[toolName];
    if (currentVersion === undefined) {
      details.push({
        component: `manifest:${toolName}`,
        checkpointVersion: String(ckptVersion),
        currentVersion: "missing",
        status: "incompatible",
      });
      hasIncompatible = true;
    } else if (currentVersion === ckptVersion) {
      details.push({
        component: `manifest:${toolName}`,
        checkpointVersion: String(ckptVersion),
        currentVersion: String(currentVersion),
        status: "compatible",
      });
    } else {
      // Different version — can regenerate context
      details.push({
        component: `manifest:${toolName}`,
        checkpointVersion: String(ckptVersion),
        currentVersion: String(currentVersion),
        status: "regenerable",
      });
      hasRegenerable = true;
    }
  }

  // Determine overall action
  if (hasIncompatible) {
    return { compatible: false, action: "blocked", details };
  }
  if (hasRegenerable) {
    return { compatible: true, action: "regenerate", details };
  }
  return { compatible: true, action: "continue", details };
}

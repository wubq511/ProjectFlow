/**
 * Rehydrate — rebuild run state from FastAPI persisted events.
 *
 * After sidecar restart, the in-memory session store is lost.
 * This module reconstructs the minimal state needed to resume a run
 * from the durable events persisted in FastAPI.
 *
 * FastAPI is the durable authority — this module only reads.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Phase 5
 */

import type { AgentRunState, RunStatus } from "@/types/run-state.js";
import type { WorkState, WorkStateStatus } from "./work-state.js";
import { createInitialWorkState } from "./work-state.js";
import type { RunPlan, PlanStepStatus } from "./run-plan.js";
import type { ToolLedgerEntry } from "@/tools/tool-executor.js";
import { replayLedgerFromEvents } from "@/tools/tool-ledger.js";
import type { RunCheckpoint } from "./checkpoint.js";
import type { OutcomeContract } from "./outcome-contract.js";

/**
 * Result of rehydrating a run from durable events.
 */
export interface RehydrateResult {
  /** Whether rehydration succeeded */
  success: boolean;
  /** Rehydrated run state (if successful) */
  runState?: AgentRunState;
  /** Rehydrated work state (if successful) */
  workState?: WorkState;
  /** Rehydrated run plan (if found in events) */
  runPlan?: RunPlan;
  /** Rehydrated tool ledger */
  toolLedger: ToolLedgerEntry[];
  /** Latest checkpoint (if found) */
  checkpoint?: RunCheckpoint;
  /** Outcome Contract (if found in events) */
  outcomeContract?: OutcomeContract;
  /** Whether this run can be resumed */
  canResume: boolean;
  /** Reason for resume/no-resume decision */
  resumeReason: string;
  /** Error message if rehydration failed */
  error?: string;
}

/**
 * Event from FastAPI (as returned by list_run_events).
 */
interface PersistedEvent {
  id: string;
  run_id: string;
  type: string;
  event_seq: number;
  payload: Record<string, unknown>;
  trace?: Record<string, unknown>;
  created_at: string;
}

/**
 * Rehydrate a run from persisted events.
 *
 * This is the core of the restart recovery flow:
 * 1. Find the latest checkpoint
 * 2. Replay tool ledger from events
 * 3. Reconstruct WorkState from events
 * 4. Check resume eligibility
 */
export function rehydrateFromEvents(
  events: PersistedEvent[],
  runId: string,
  conversationId: string,
  workspaceId: string,
  projectId: string,
): RehydrateResult {
  if (events.length === 0) {
    return {
      success: false,
      toolLedger: [],
      canResume: false,
      resumeReason: "无持久化事件",
      error: "No persisted events found for this run",
    };
  }

  try {
    // 1. Find the latest checkpoint
    const checkpoint = findLatestCheckpoint(events);

    // 2. Replay tool ledger from events
    const toolLedger = replayLedgerFromEvents(events);

    // 3. Reconstruct WorkState from events
    const workState = reconstructWorkState(events, checkpoint);

    // 4. Determine transport status from latest state_changed event
    const transportStatus = reconstructTransportStatus(events);

    // 5. Reconstruct RunPlan from events
    const runPlan = reconstructRunPlan(events);

    // 6. Check resume eligibility
    const resumeCheck = checkResumeEligibility(
      transportStatus, workState, toolLedger, checkpoint,
    );

    // 7. Build minimal AgentRunState for resume
    const runState = buildRehydratedRunState(
      runId, conversationId, workspaceId, projectId,
      transportStatus, toolLedger, events,
    );

    return {
      success: true,
      runState,
      workState,
      runPlan,
      toolLedger,
      checkpoint,
      canResume: resumeCheck.canResume,
      resumeReason: resumeCheck.reason,
    };
  } catch (err) {
    return {
      success: false,
      toolLedger: [],
      canResume: false,
      resumeReason: "重hydration 失败",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Find the latest checkpoint event in the event stream.
 */
function findLatestCheckpoint(events: PersistedEvent[]): RunCheckpoint | undefined {
  const checkpointEvents = events
    .filter((e) => e.type === "checkpoint.saved")
    .sort((a, b) => b.event_seq - a.event_seq);

  if (checkpointEvents.length === 0) return undefined;

  try {
    return checkpointEvents[0]!.payload.checkpoint as RunCheckpoint;
  } catch {
    return undefined;
  }
}

/**
 * Reconstruct WorkState from events.
 * Looks for work_state.changed events and rebuilds the latest state.
 */
function reconstructWorkState(
  events: PersistedEvent[],
  checkpoint: RunCheckpoint | undefined,
): WorkState {
  // Start from checkpoint if available
  if (checkpoint?.workState) {
    return { ...checkpoint.workState };
  }

  // Otherwise, find the latest work_state.changed event
  const workStateEvents = events
    .filter((e) => e.type === "work_state.changed")
    .sort((a, b) => b.event_seq - a.event_seq);

  if (workStateEvents.length > 0) {
    const payload = workStateEvents[0]!.payload;
    return {
      schemaVersion: 1,
      status: (payload.status as WorkStateStatus) ?? "understanding",
      version: (payload.version as number) ?? 1,
      expectedVersion: ((payload.version as number) ?? 1) - 1,
      timestamp: (payload.timestamp as string) ?? workStateEvents[0]!.created_at,
      reason: payload.reason as string,
    };
  }

  // Fallback: initial state
  return createInitialWorkState();
}

/**
 * Reconstruct transport status from the latest state_changed event.
 */
function reconstructTransportStatus(events: PersistedEvent[]): RunStatus {
  const stateEvents = events
    .filter((e) => e.type === "run.state_changed" || e.type === "state.changed")
    .sort((a, b) => b.event_seq - a.event_seq);

  if (stateEvents.length > 0) {
    return (stateEvents[0]!.payload.status as RunStatus) ?? "created";
  }

  return "created";
}

/**
 * Reconstruct RunPlan from the latest run_plan.created or run_plan.step_updated event.
 */
function reconstructRunPlan(events: PersistedEvent[]): RunPlan | undefined {
  const planEvents = events
    .filter((e) => e.type === "run_plan.created" || e.type === "run_plan.step_updated")
    .sort((a, b) => b.event_seq - a.event_seq);

  if (planEvents.length === 0) return undefined;

  const payload = planEvents[0]!.payload;
  if (!payload.plan_id) return undefined;

  return {
    schemaVersion: 1,
    id: payload.plan_id as string,
    rationale: (payload.rationale as string) ?? "",
    steps: Array.isArray(payload.steps)
      ? payload.steps.map((s: Record<string, unknown>) => ({
          id: s.id as string ?? "",
          goal: s.goal as string ?? "",
          dependencies: (s.dependencies as string[]) ?? [],
          allowedTools: (s.allowed_tools as string[]) ?? [],
          completionCriteria: [],
          status: ((s.status as string) ?? "pending") as PlanStepStatus,
          attemptCount: 0,
          maxAttempts: 3,
          failurePolicy: "abort" as const,
        }))
      : [],
    currentStepIndex: (payload.current_step_index as number) ?? 0,
    createdAt: planEvents[0]!.created_at,
    updatedAt: planEvents[0]!.created_at,
  };
}

/**
 * Check if a run can be resumed based on its reconstructed state.
 */
function checkResumeEligibility(
  transportStatus: RunStatus,
  workState: WorkState,
  toolLedger: ToolLedgerEntry[],
  checkpoint: RunCheckpoint | undefined,
): { canResume: boolean; reason: string } {
  // Terminal transport states cannot resume
  if (["completed", "cancelled", "failed"].includes(transportStatus)) {
    return { canResume: false, reason: `运行已终止 (${transportStatus})` };
  }

  // Terminal work states cannot resume
  if (["completed", "partial", "blocked", "failed", "cancelled"].includes(workState.status)) {
    return { canResume: false, reason: `工作状态已终态 (${workState.status})` };
  }

  // Check for unknown side effects in ledger
  const unknownSideEffects = toolLedger.filter((e) => e.sideEffectStatus === "unknown");
  if (unknownSideEffects.length > 0) {
    return {
      canResume: false,
      reason: `存在未知副作用: ${unknownSideEffects.map((e) => e.toolName).join(", ")}`,
    };
  }

  // Use checkpoint recovery decisions if available
  if (checkpoint?.recoveryDecisions) {
    const blocked = checkpoint.recoveryDecisions.filter(
      (d) => d.action === "blocked_unknown" || d.action === "blocked_incompatible",
    );
    if (blocked.length > 0) {
      return {
        canResume: false,
        reason: `存在阻塞的恢复决策: ${blocked.map((d) => d.toolName).join(", ")}`,
      };
    }
  }

  return { canResume: true, reason: "可以恢复" };
}

/**
 * Build a minimal AgentRunState from rehydrated data.
 * This is NOT the full run state — it's the minimum needed to resume.
 */
function buildRehydratedRunState(
  runId: string,
  conversationId: string,
  workspaceId: string,
  projectId: string,
  transportStatus: RunStatus,
  toolLedger: ToolLedgerEntry[],
  events: PersistedEvent[],
): AgentRunState {
  // Find max event_seq
  const maxEventSeq = Math.max(...events.map((e) => e.event_seq), 0);

  // Build side effects from ledger
  const sideEffects = toolLedger.map((e) => ({
    toolCallId: e.toolCallId,
    status: (e.sideEffectStatus ?? "no_side_effect") as AgentRunState["sideEffects"][0]["status"],
  }));

  // Build tool results from ledger
  const toolResults = toolLedger
    .filter((e) => e.resultStatus)
    .map((e) => ({
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      sideEffectStatus: (e.sideEffectStatus ?? "no_side_effect") as AgentRunState["toolResults"][0]["sideEffectStatus"],
      observation: "",
    }));

  return {
    runId,
    conversationId,
    workspaceId,
    projectId,
    status: transportStatus === "created" ? "context_building" : transportStatus,
    currentTurn: 0,
    currentStep: toolResults.length,
    model: { provider: "unknown", name: "unknown" },
    sideEffects,
    toolResults,
    lastEventSeq: maxEventSeq,
    stateVersion: 0, // restored from snapshot in resume-run.ts
    budgetLimits: { maxSteps: 8, maxToolCalls: 6, timeoutMs: 180000 },
    resumePolicy: { manifestVersion: 1, requiresRegenerationOnMismatch: true },
    createdAt: events[0]?.created_at ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

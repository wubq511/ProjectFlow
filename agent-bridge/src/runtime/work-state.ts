/**
 * WorkState — cognitive work state for an agent run.
 *
 * Separated from TransportState (AgentRunState.status) which tracks
 * technical process state. WorkState tracks WHY the task isn't done yet.
 *
 * Persisted via event payload (additive draft, no new DB table).
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §统一状态模型
 */

/**
 * Work state values — maps to the T43 spec's WorkState model.
 */
export type WorkStateStatus =
  | "understanding"      // parsing user intent, building context
  | "planning"           // creating/updating RunPlan
  | "executing"          // running plan steps, calling tools
  | "verifying"          // running deterministic verifier
  | "awaiting_user"      // needs clarification from user
  | "awaiting_approval"  // needs proposal confirmation
  | "recovering"         // handling tool failure, retrying
  | "completed"          // all success criteria met
  | "partial"            // some criteria met, some unresolved
  | "blocked"            // cannot proceed without external change
  | "failed"             // unrecoverable error
  | "cancelled";         // user cancelled

/**
 * Valid WorkState transitions.
 * Illegal or stale transitions fail closed.
 */
const VALID_WORK_TRANSITIONS: Record<WorkStateStatus, WorkStateStatus[]> = {
  understanding: ["planning", "executing", "awaiting_user", "completed", "failed", "cancelled"],
  planning: ["executing", "awaiting_user", "failed", "cancelled"],
  executing: ["verifying", "planning", "recovering", "awaiting_user", "awaiting_approval", "completed", "partial", "blocked", "failed", "cancelled"],
  verifying: ["completed", "partial", "blocked", "executing", "recovering", "failed", "cancelled"],
  awaiting_user: ["understanding", "planning", "executing", "cancelled"],
  awaiting_approval: ["executing", "planning", "cancelled"],
  recovering: ["executing", "planning", "failed", "cancelled"],
  completed: [],
  partial: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

/**
 * Check if a WorkState transition is valid.
 */
export function isValidWorkTransition(from: WorkStateStatus, to: WorkStateStatus): boolean {
  return VALID_WORK_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * WorkState — persisted via event payload.
 */
export interface WorkState {
  /** Schema version */
  schemaVersion: 1;
  /** Current work state */
  status: WorkStateStatus;
  /** Version counter (incremented on each transition) */
  version: number;
  /** Expected version for optimistic concurrency (prevents stale transitions) */
  expectedVersion: number;
  /** When this state was entered */
  timestamp: string;
  /** Optional reason for the transition */
  reason?: string;
  /** Current plan step ID (if executing) */
  currentStepId?: string;
}

/**
 * Create initial WorkState for a new run.
 */
export function createInitialWorkState(): WorkState {
  return {
    schemaVersion: 1,
    status: "understanding",
    version: 1,
    expectedVersion: 0,
    timestamp: new Date().toISOString(),
    reason: "run started",
  };
}

/**
 * Transition WorkState to a new status.
 * Returns the new WorkState or throws if transition is illegal.
 */
export function transitionWorkState(
  current: WorkState,
  to: WorkStateStatus,
  expectedVersion: number,
  reason?: string,
  currentStepId?: string,
): WorkState {
  // Check version match (optimistic concurrency)
  if (current.version !== expectedVersion) {
    throw new Error(
      `WorkState version mismatch: expected ${expectedVersion}, got ${current.version}. ` +
      `Stale transition rejected.`
    );
  }

  // Check transition validity
  if (!isValidWorkTransition(current.status, to)) {
    throw new Error(
      `Illegal WorkState transition: ${current.status} → ${to}. ` +
      `Allowed: ${VALID_WORK_TRANSITIONS[current.status]?.join(", ") ?? "none"}`
    );
  }

  return {
    schemaVersion: 1,
    status: to,
    version: current.version + 1,
    expectedVersion: current.version,
    timestamp: new Date().toISOString(),
    reason,
    currentStepId,
  };
}

/**
 * Get terminal WorkState values (no further transitions possible).
 */
export function isTerminalWorkState(status: WorkStateStatus): boolean {
  return ["completed", "partial", "blocked", "failed", "cancelled"].includes(status);
}

/**
 * Get user-safe description of WorkState (no chain-of-thought).
 */
export function workStateToUserMessage(status: WorkStateStatus): string {
  const messages: Record<WorkStateStatus, string> = {
    understanding: "正在理解你的需求...",
    planning: "正在制定执行计划...",
    executing: "正在执行任务...",
    verifying: "正在验证结果...",
    awaiting_user: "等待你的输入...",
    awaiting_approval: "等待确认...",
    recovering: "正在恢复...",
    completed: "任务完成",
    partial: "部分完成",
    blocked: "任务受阻",
    failed: "任务失败",
    cancelled: "已取消",
  };
  return messages[status];
}

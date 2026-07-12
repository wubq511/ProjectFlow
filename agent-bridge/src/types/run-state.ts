/**
 * AgentRunState — sidecar-internal representation (camelCase).
 * Wire format is snake_case; see wire.ts for conversion.
 */

export type RunStatus =
  | "created"
  | "context_building"
  | "model_streaming"
  | "tool_preparing"
  | "tool_running"
  | "persisting_tool_result"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";

export type SideEffectStatus =
  | "no_side_effect"
  | "event_persisted"
  | "proposal_persisted"
  | "advisory_record_persisted"
  | "commit_persisted"
  | "unknown";

export interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  toolVersion: number;
  idempotencyKey: string;
}

export interface SideEffect {
  toolCallId: string;
  status: SideEffectStatus;
}

export interface ResumePolicy {
  manifestVersion: number;
  requiresRegenerationOnMismatch: boolean;
}

/** Lightweight summary of a tool call result for the GET /runs response. */
export interface ToolResultSummary {
  toolCallId: string;
  toolName: string;
  sideEffectStatus: SideEffectStatus;
  observation: string;
  proposalId?: string;
  createdIds?: string[];
}

export interface RunBudgetLimits {
  maxSteps: number;
  maxToolCalls: number;
  timeoutMs: number;
}

/** Thinking/reasoning level for models that support it. */
export type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface PendingTerminal {
  /** Stop reason from the model */
  stopReason: string;
  /** Final content extracted from the last assistant message */
  finalContent: string;
  /** Whether the model reported an error */
  modelError: boolean;
  /** Whether the model was aborted */
  modelAborted: boolean;
}

export interface AgentRunState {
  runId: string;
  conversationId: string;
  workspaceId: string;
  projectId: string;
  status: RunStatus;
  currentTurn: number;
  currentStep: number;
  model: { provider: string; name: string };
  thinkingLevel?: ThinkingLevel;
  pendingToolCall?: PendingToolCall;
  sideEffects: SideEffect[];
  toolResults: ToolResultSummary[];
  lastEventSeq: number;
  /** Durable state version from FastAPI — passed as expected_state_version on mutations. */
  stateVersion: number;
  budgetLimits: RunBudgetLimits;
  resumePolicy: ResumePolicy;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /**
   * Captured from agent_end but NOT yet persisted as terminal status.
   * Terminal status is determined AFTER verifier runs.
   * This field is set by applyPiEventToRunState(agent_end) and consumed
   * by the post-loop terminal determination logic.
   */
  pendingTerminal?: PendingTerminal;
}

export interface CreateRunStateInput {
  conversationId: string;
  workspaceId: string;
  projectId: string;
  model: { provider: string; name: string };
  maxSteps: number;
  maxToolCalls: number;
  timeoutMs: number;
  /** External run ID (e.g. from FastAPI). If omitted, a local ID is generated. */
  runId?: string;
  /** Thinking/reasoning level for models that support it. */
  thinkingLevel?: ThinkingLevel;
}

let runCounter = 0;

export function createRunState(input: CreateRunStateInput): AgentRunState {
  runCounter++;
  const now = new Date().toISOString();
  return {
    runId: input.runId ?? `run_${Date.now()}_${runCounter}`,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    status: "created",
    currentTurn: 0,
    currentStep: 0,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    sideEffects: [],
    toolResults: [],
    lastEventSeq: 0,
    stateVersion: 0,
    budgetLimits: {
      maxSteps: input.maxSteps,
      maxToolCalls: input.maxToolCalls,
      timeoutMs: input.timeoutMs,
    },
    resumePolicy: {
      manifestVersion: 1,
      requiresRegenerationOnMismatch: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Valid state transitions. Returns true if transition is allowed.
 *
 * NOTE: This table represents the "happy path" transitions. The Python-side
 * `_VALID_TRANSITIONS` in `agent_runtime_service.py` is intentionally more
 * permissive to handle edge cases from the Pi SDK event stream (e.g. skip-ahead
 * transitions like tool_running → model_streaming). The TS table is used in
 * tests only; runtime enforcement happens on the Python side.
 */
export function isValidTransition(from: RunStatus, to: RunStatus): boolean {
  const validTransitions: Record<RunStatus, RunStatus[]> = {
    created: ["context_building", "cancelling", "failed"],
    context_building: ["model_streaming", "cancelling", "failed"],
    model_streaming: ["tool_preparing", "tool_running", "persisting_tool_result", "completed", "cancelling", "failed"],
    tool_preparing: ["tool_running", "persisting_tool_result", "model_streaming", "completed", "cancelling", "failed"],
    tool_running: ["persisting_tool_result", "model_streaming", "completed", "cancelling", "failed"],
    persisting_tool_result: ["model_streaming", "completed", "cancelling", "cancelled", "failed"],
    completed: [],
    cancelling: ["cancelled", "failed"],
    cancelled: [],
    failed: [],
  };
  return validTransitions[from]?.includes(to) ?? false;
}

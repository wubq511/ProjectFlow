/**
 * Event mapper — maps Pi lifecycle events to ProjectFlow event types.
 *
 * Pi lifecycle → ProjectFlow:
 * - agent_start → agent.started
 * - turn_start → agent.status
 * - message_delta → agent.delta
 * - tool_execution_start → tool.started
 * - tool_execution_update → tool.progress
 * - tool_execution_end → tool.completed or tool.failed
 * - turn_end → agent.status
 * - agent_end → agent.completed or agent.failed
 * - policy block → tool.blocked
 * - advisory record created → advisory_record.created
 * - proposal created → proposal.created
 * - budget exceeded → runtime.error (code: BUDGET_EXCEEDED)
 */

import { createEvent } from "@/types/runtime-event.js";
import type { RuntimeEvent, RuntimeEventType } from "@/types/runtime-event.js";
import type { AgentRunState, RunStatus } from "@/types/run-state.js";
import { createRunStateTrace } from "@/events/trace-envelope.js";

/** Pi lifecycle event types (from pi-ai/pi-agent-core). */
export type PiEventType =
  | "agent_start"
  | "turn_start"
  | "message_delta"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "turn_end"
  | "agent_end"
  | "policy_block"
  | "advisory_created"
  | "proposal_created"
  | "budget_exceeded";

export interface PiEvent {
  type: PiEventType;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: unknown;
  assistantMessageEvent?: unknown;
  /** Pi AgentEvent.messages — available on agent_end events. */
  messages?: unknown[];
}

export interface MappedEvent {
  type: RuntimeEventType;
  payload: Record<string, unknown>;
  newStatus?: RunStatus;
  toolCallId?: string;
  toolName?: string;
  proposalId?: string;
}

export interface RuntimeEventBuildOptions {
  orderingHint?: number;
  includeSensitiveData?: boolean;
  proposalId?: string;
  payload?: Record<string, unknown>;
}

/**
 * Map a Pi lifecycle event to a ProjectFlow event.
 */
export function mapPiEvent(piEvent: PiEvent, runId: string): MappedEvent {
  switch (piEvent.type) {
    case "agent_start":
      return {
        type: "agent.started",
        payload: { run_id: runId, ...piEvent.data },
        newStatus: "context_building",
      };

    case "turn_start":
      return {
        type: "agent.status",
        payload: { run_id: runId, phase: "turn_start", ...piEvent.data },
      };

    case "message_delta":
      return {
        type: "agent.delta",
        payload: { run_id: runId, ...piEvent.data },
        newStatus: "model_streaming",
      };

    case "message_start":
      return {
        type: "agent.status",
        payload: { run_id: runId, phase: "message_start", ...piEvent.data },
        newStatus: "model_streaming",
      };

    case "message_update":
      return {
        type: "agent.delta",
        payload: {
          run_id: runId,
          content: piEvent.assistantMessageEvent ?? piEvent.data?.content,
          ...piEvent.data,
        },
        newStatus: "model_streaming",
      };

    case "message_end":
      return {
        type: "agent.status",
        payload: { run_id: runId, phase: "message_end", ...piEvent.data },
      };

    case "tool_execution_start":
      return {
        type: "tool.started",
        payload: {
          run_id: runId,
          ...(piEvent.toolCallId ? { tool_call_id: piEvent.toolCallId } : {}),
          ...(piEvent.toolName ? { tool_name: piEvent.toolName } : {}),
          ...piEvent.data,
        },
        newStatus: "tool_running",
        toolCallId: piEvent.toolCallId,
        toolName: piEvent.toolName,
      };

    case "tool_execution_update":
      return {
        type: "tool.progress",
        payload: {
          run_id: runId,
          ...(piEvent.toolCallId ? { tool_call_id: piEvent.toolCallId } : {}),
          ...(piEvent.toolName ? { tool_name: piEvent.toolName } : {}),
          ...piEvent.data,
        },
        toolCallId: piEvent.toolCallId,
        toolName: piEvent.toolName,
      };

    case "tool_execution_end": {
      const success = !piEvent.error && !piEvent.isError;
      return {
        type: success ? "tool.completed" : "tool.failed",
        payload: {
          run_id: runId,
          ...(piEvent.error ? { error: piEvent.error } : {}),
          ...(piEvent.toolCallId ? { tool_call_id: piEvent.toolCallId } : {}),
          ...(piEvent.toolName ? { tool_name: piEvent.toolName } : {}),
          ...(piEvent.isError !== undefined ? { is_error: piEvent.isError } : {}),
          ...piEvent.data,
        },
        newStatus: "persisting_tool_result",
        toolCallId: piEvent.toolCallId,
        toolName: piEvent.toolName,
      };
    }

    case "turn_end":
      return {
        type: "agent.status",
        payload: { run_id: runId, phase: "turn_end", ...piEvent.data },
      };

    case "agent_end": {
      // Derive failure from explicit error flags OR from the last assistant message's stopReason
      const lastMsg = piEvent.messages?.[piEvent.messages.length - 1] as
        | { stopReason?: string }
        | undefined;
      const stopReason = lastMsg?.stopReason;
      const cancelled = stopReason === "aborted";
      const failed = !!(piEvent.error || piEvent.isError || stopReason === "error");
      const newStatus: RunStatus = cancelled ? "cancelled" : failed ? "failed" : "completed";
      return {
        type: cancelled ? "run.cancelled" : failed ? "agent.failed" : "agent.completed",
        payload: {
          run_id: runId,
          ...(piEvent.error ? { error: piEvent.error } : {}),
          ...(piEvent.isError !== undefined ? { is_error: piEvent.isError } : {}),
          ...(stopReason === "error" ? { reason: "模型返回错误" } : {}),
          ...(stopReason === "aborted" ? { reason: "模型返回中止" } : {}),
          ...piEvent.data,
        },
        newStatus,
      };
    }

    case "policy_block":
      return {
        type: "tool.blocked",
        payload: {
          run_id: runId,
          reason: piEvent.data?.reason ?? "策略拒绝",
          ...piEvent.data,
        },
      };

    case "advisory_created":
      return {
        type: "advisory_record.created",
        payload: { run_id: runId, ...piEvent.data },
      };

    case "proposal_created":
      return {
        type: "proposal.created",
        payload: { run_id: runId, ...piEvent.data },
        proposalId: typeof piEvent.data?.proposal_id === "string" ? piEvent.data.proposal_id : undefined,
      };

    case "budget_exceeded":
      return {
        type: "runtime.error",
        payload: {
          run_id: runId,
          code: "BUDGET_EXCEEDED",
          scope: piEvent.data?.scope ?? "unknown",
          ...piEvent.data,
        },
        newStatus: "failed",
      };

    default: {
      // Exhaustiveness check — if PiEventType is extended, TypeScript will error here
      const _exhaustive: never = piEvent.type;
      return {
        type: "runtime.error",
        payload: { run_id: runId, message: `未知事件类型: ${String(_exhaustive)}` },
      };
    }
  }
}

export function buildRuntimeEventFromPiEvent(
  piEvent: PiEvent,
  runState: AgentRunState,
  options: RuntimeEventBuildOptions = {},
): RuntimeEvent {
  const mapped = mapPiEvent(piEvent, runState.runId);
  return buildRuntimeEvent(mapped, runState, options);
}

export function buildRuntimeEvent(
  mapped: MappedEvent,
  runState: AgentRunState,
  options: RuntimeEventBuildOptions = {},
): RuntimeEvent {
  const orderingHint = options.orderingHint ?? runState.lastEventSeq + 1;
  const toolCallId = mapped.toolCallId ?? asString(mapped.payload.tool_call_id);
  const toolName = mapped.toolName ?? asString(mapped.payload.tool_name);
  const proposalId = options.proposalId ?? mapped.proposalId ?? asString(mapped.payload.proposal_id);
  const payload = {
    ...basePayload(runState),
    ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    ...(toolName ? { tool_name: toolName } : {}),
    ...(proposalId ? { proposal_id: proposalId } : {}),
    ...mapped.payload,
    ...(options.payload ?? {}),
  };

  return createEvent(
    mapped.type,
    runState.runId,
    mapped.newStatus ?? runState.status,
    payload,
    createRunStateTrace(runState, {
      toolCallId,
      toolName,
      proposalId,
      includeSensitiveData: options.includeSensitiveData,
    }).toRuntimeTraceSummary(),
    {
      conversationId: runState.conversationId,
      workspaceId: runState.workspaceId,
      projectId: runState.projectId,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(proposalId ? { proposalId } : {}),
      clientEventId: `${runState.runId}:${orderingHint}:${mapped.type}`,
      orderingHint,
    },
  );
}

export function buildRuntimeProductEvent(
  type: Extract<RuntimeEventType, "proposal.created" | "advisory_record.created">,
  runState: AgentRunState,
  payload: Record<string, unknown>,
  options: RuntimeEventBuildOptions = {},
): RuntimeEvent {
  return buildRuntimeEvent(
    {
      type,
      payload: {
        run_id: runState.runId,
        ...payload,
      },
      proposalId: asString(payload.proposal_id),
      toolCallId: asString(payload.tool_call_id),
      toolName: asString(payload.tool_name),
    },
    runState,
    options,
  );
}

function basePayload(runState: AgentRunState): Record<string, unknown> {
  return {
    run_id: runState.runId,
    conversation_id: runState.conversationId,
    workspace_id: runState.workspaceId,
    project_id: runState.projectId,
    state_schema_version: 1,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

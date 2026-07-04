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
 * - agent_end → agent.completed
 * - policy block → tool.blocked
 * - advisory record created → advisory_record.created
 * - proposal created → proposal.created
 * - budget exceeded → runtime.error (code: BUDGET_EXCEEDED)
 */

import type { RuntimeEventType } from "@/types/runtime-event.js";
import type { RunStatus } from "@/types/run-state.js";

/** Pi lifecycle event types (from pi-ai/pi-agent-core). */
export type PiEventType =
  | "agent_start"
  | "turn_start"
  | "message_delta"
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
}

export interface MappedEvent {
  type: RuntimeEventType;
  payload: Record<string, unknown>;
  newStatus?: RunStatus;
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

    case "tool_execution_start":
      return {
        type: "tool.started",
        payload: { run_id: runId, ...piEvent.data },
        newStatus: "tool_running",
      };

    case "tool_execution_update":
      return {
        type: "tool.progress",
        payload: { run_id: runId, ...piEvent.data },
      };

    case "tool_execution_end": {
      const success = !piEvent.error;
      return {
        type: success ? "tool.completed" : "tool.failed",
        payload: {
          run_id: runId,
          ...(piEvent.error ? { error: piEvent.error } : {}),
          ...piEvent.data,
        },
        newStatus: "persisting_tool_result",
      };
    }

    case "turn_end":
      return {
        type: "agent.status",
        payload: { run_id: runId, phase: "turn_end", ...piEvent.data },
      };

    case "agent_end":
      return {
        type: "agent.completed",
        payload: { run_id: runId, ...piEvent.data },
        newStatus: "completed",
      };

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

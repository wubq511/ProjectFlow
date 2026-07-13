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
 * High-frequency provider deltas are transport events, not durable audit facts.
 * Their complete result is persisted at agent_end/tool_execution_end and in the
 * checkpoint, so storing every token/progress update only amplifies the event log.
 */
export function shouldPersistPiEvent(piEvent: PiEvent): boolean {
  return piEvent.type !== "message_delta"
    && piEvent.type !== "message_update"
    && piEvent.type !== "tool_execution_update";
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

    case "message_update": {
      // Extract incremental content from assistantMessageEvent.
      // Do NOT pass the full assistantMessageEvent object — it causes DB bloat.
      //
      // Typed streaming contract (方案 A):
      // - text_start/thinking_start → structural marker with kind + phase + contentIndex
      // - text_delta/thinking_delta → visible content with kind + phase + contentIndex + content
      // - text_end/thinking_end → structural marker with kind + phase + contentIndex
      // - toolcall_start/delta/end → intentionally discarded (tool args not shown to user)
      //
      // The downstream SSE layer uses delta_type, content_index, and phase to emit
      // typed StreamContentEvent to the frontend. This replaces the old tool-boundary
      // heuristic for thinking/answer separation.
      const ame = piEvent.assistantMessageEvent as Record<string, unknown> | undefined;
      let deltaContent: string | undefined;
      let deltaType: string | undefined;
      let contentIndex: number | undefined;
      if (ame && typeof ame.type === "string") {
        const ameType = ame.type as string;
        // All content block types: start, delta, end for both text and thinking
        if (
          ameType === "text_delta" || ameType === "thinking_delta" ||
          ameType === "text_start" || ameType === "thinking_start" ||
          ameType === "text_end" || ameType === "thinking_end"
        ) {
          deltaType = ameType;
          // delta content only for *_delta events
          if (ameType.endsWith("_delta") && typeof ame.delta === "string") {
            deltaContent = ame.delta;
          }
          // contentIndex from Pi runtime
          if (typeof ame.contentIndex === "number") {
            contentIndex = ame.contentIndex;
          }
        }
        // toolcall_start, toolcall_delta, toolcall_end → no visible content
      }
      return {
        type: "agent.delta",
        payload: {
          run_id: runId,
          ...(deltaContent !== undefined ? { content: deltaContent } : {}),
          ...(deltaType !== undefined ? { delta_type: deltaType } : {}),
          ...(contentIndex !== undefined ? { content_index: contentIndex } : {}),
        },
        newStatus: "model_streaming",
      };
    }

    case "message_end": {
      const message = piEvent.message as Record<string, unknown> | undefined;
      const rawUsage = message?.role === "assistant" && message.usage && typeof message.usage === "object"
        ? message.usage as Record<string, unknown>
        : undefined;
      const rawCost = rawUsage?.cost && typeof rawUsage.cost === "object"
        ? rawUsage.cost as Record<string, unknown>
        : undefined;
      if (!rawUsage) {
        return {
          type: "agent.status",
          payload: { run_id: runId, phase: "message_end", ...piEvent.data },
        };
      }
      // Preserve all numeric usage fields; omit keys the provider did not supply
      // so that unknown values remain absent rather than measured zeros.
      const KNOWN_USAGE_KEYS = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens"];
      const usage: Record<string, unknown> = {};
      for (const key of KNOWN_USAGE_KEYS) {
        if (typeof rawUsage[key] === "number") {
          usage[key] = rawUsage[key];
        }
      }
      // Pass through any cost breakdown fields the provider supplies.
      const cost: Record<string, unknown> = {};
      if (rawCost) {
        for (const [k, v] of Object.entries(rawCost)) {
          if (typeof v === "number") cost[k] = v;
        }
      }
      return {
        type: "agent.status",
        payload: {
          run_id: runId,
          phase: "message_end",
          ...piEvent.data,
          usage,
          ...(Object.keys(cost).length > 0 ? { cost } : {}),
        },
      };
    }

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
      // DEFERRED: Terminal status is NOT set here.
      // The post-loop verifier determines the actual terminal status.
      // This event captures the model's output for tracing only.
      const lastMsg = piEvent.messages?.[piEvent.messages.length - 1] as
        | { stopReason?: string; content?: unknown[] }
        | undefined;
      const stopReason = lastMsg?.stopReason;

      // Extract final answer text from the last assistant message
      let finalContent = "";
      if (lastMsg?.content && Array.isArray(lastMsg.content)) {
        const textParts: string[] = [];
        for (const part of lastMsg.content) {
          if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            if (p.type === "text" && typeof p.text === "string") {
              textParts.push(p.text);
            }
          }
        }
        finalContent = textParts.join("");
      }

      return {
        // Use agent.output_captured to distinguish from the real terminal event
        type: "agent.output_captured" as any,
        payload: {
          run_id: runId,
          stop_reason: stopReason ?? "unknown",
          ...(piEvent.error ? { error: piEvent.error } : {}),
          ...(piEvent.isError !== undefined ? { is_error: piEvent.isError } : {}),
          ...(finalContent ? { final_content: finalContent } : {}),
        },
        // No newStatus — terminal status determined after verifier
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

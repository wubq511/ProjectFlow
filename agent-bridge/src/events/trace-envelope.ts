/**
 * Trace envelope — run/tool/proposal correlation.
 * Records trace metadata without secrets.
 */

import { hashValue as sharedHashValue } from "@/utils/hash.js";
import type { AgentRunState } from "@/types/run-state.js";
import type { TraceSummary } from "@/types/runtime-event.js";

export interface TraceEnvelopeData {
  runId: string;
  conversationId?: string;
  workspaceId?: string;
  projectId?: string;
  toolCallId?: string;
  toolName?: string;
  proposalId?: string;
  provider?: string;
  model?: string;
  runState?: {
    status: AgentRunState["status"];
    currentStep: number;
    stateSchemaVersion: number;
  };
  budget?: {
    maxSteps: number;
    maxToolCalls: number;
    timeoutMs: number;
  };
  spans: TraceSpan[];
  attributes: Record<string, unknown>;
  includeSensitiveData: boolean;
}

export interface TraceSpan {
  name: string;
  startMs: number;
  endMs?: number;
  attributes?: Record<string, unknown>;
}

export class TraceEnvelope {
  private readonly data: TraceEnvelopeData;
  private spans: TraceSpan[] = [];

  constructor(data: TraceEnvelopeData) {
    this.data = data;
  }

  /** Start a new span. */
  startSpan(name: string, attributes?: Record<string, unknown>): TraceSpan {
    const span: TraceSpan = {
      name,
      startMs: Date.now(),
      attributes,
    };
    this.spans.push(span);
    return span;
  }

  /** End a span. */
  endSpan(span: TraceSpan, attributes?: Record<string, unknown>): void {
    span.endMs = Date.now();
    if (attributes) {
      span.attributes = { ...span.attributes, ...attributes };
    }
  }

  /** Hash a value for trace (delegates to shared utility). */
  hashValue(value: unknown): string {
    return sharedHashValue(value);
  }

  /** Build the trace output for inclusion in events/results. */
  toTraceSummary(): {
    run_id: string;
    conversation_id?: string;
    workspace_id?: string;
    project_id?: string;
    tool_call_id?: string;
    tool_name?: string;
    proposal_id?: string;
    provider?: string;
    model?: string;
    run_state?: {
      status: AgentRunState["status"];
      current_step: number;
      state_schema_version: number;
    };
    budget?: {
      max_steps: number;
      max_tool_calls: number;
      timeout_ms: number;
    };
    redacted: boolean;
    spans: Array<{
      name: string;
      start_ms: number;
      end_ms?: number;
      duration_ms?: number;
      attributes?: Record<string, unknown>;
    }>;
  } {
    return {
      run_id: this.data.runId,
      ...(this.data.conversationId ? { conversation_id: this.data.conversationId } : {}),
      ...(this.data.workspaceId ? { workspace_id: this.data.workspaceId } : {}),
      ...(this.data.projectId ? { project_id: this.data.projectId } : {}),
      ...(this.data.toolCallId ? { tool_call_id: this.data.toolCallId } : {}),
      ...(this.data.toolName ? { tool_name: this.data.toolName } : {}),
      ...(this.data.proposalId ? { proposal_id: this.data.proposalId } : {}),
      ...(this.data.provider ? { provider: this.data.provider } : {}),
      ...(this.data.model ? { model: this.data.model } : {}),
      ...(this.data.runState
        ? {
            run_state: {
              status: this.data.runState.status,
              current_step: this.data.runState.currentStep,
              state_schema_version: this.data.runState.stateSchemaVersion,
            },
          }
        : {}),
      ...(this.data.budget
        ? {
            budget: {
              max_steps: this.data.budget.maxSteps,
              max_tool_calls: this.data.budget.maxToolCalls,
              timeout_ms: this.data.budget.timeoutMs,
            },
          }
        : {}),
      redacted: !this.data.includeSensitiveData,
      spans: this.spans.map((s) => ({
        name: s.name,
        start_ms: s.startMs,
        end_ms: s.endMs,
        duration_ms: s.endMs ? s.endMs - s.startMs : undefined,
        ...(s.attributes ? { attributes: s.attributes } : {}),
      })),
    };
  }

  /** Build camelCase trace summary for sidecar RuntimeEvent objects. */
  toRuntimeTraceSummary(): TraceSummary {
    return {
      runId: this.data.runId,
      ...(this.data.conversationId ? { conversationId: this.data.conversationId } : {}),
      ...(this.data.workspaceId ? { workspaceId: this.data.workspaceId } : {}),
      ...(this.data.projectId ? { projectId: this.data.projectId } : {}),
      ...(this.data.toolCallId ? { toolCallId: this.data.toolCallId } : {}),
      ...(this.data.toolName ? { toolName: this.data.toolName } : {}),
      ...(this.data.proposalId ? { proposalId: this.data.proposalId } : {}),
      ...(this.data.provider ? { provider: this.data.provider } : {}),
      ...(this.data.model ? { model: this.data.model } : {}),
      ...(this.data.runState ? { runState: this.data.runState } : {}),
      ...(this.data.budget ? { budget: this.data.budget } : {}),
      redacted: !this.data.includeSensitiveData,
    };
  }

  /** Build wire-format trace for ProjectFlowToolResult. */
  toResultTrace(inputHash?: string, outputHash?: string): {
    input_hash?: string;
    output_hash?: string;
    redacted: boolean;
  } {
    return {
      ...(inputHash ? { input_hash: inputHash } : {}),
      ...(outputHash ? { output_hash: outputHash } : {}),
      redacted: !this.data.includeSensitiveData,
    };
  }
}

/** Create a trace envelope for a tool call. */
export function createToolTrace(
  runId: string,
  toolCallId: string,
  toolName: string,
  includeSensitiveData: boolean = false,
): TraceEnvelope {
  return new TraceEnvelope({
    runId,
    toolCallId,
    toolName,
    spans: [],
    attributes: {},
    includeSensitiveData,
  });
}

/** Create a trace envelope for a run. */
export function createRunTrace(
  runId: string,
  includeSensitiveData: boolean = false,
): TraceEnvelope {
  return new TraceEnvelope({
    runId,
    spans: [],
    attributes: {},
    includeSensitiveData,
  });
}

/** Create a trace envelope from current durable run state. */
export function createRunStateTrace(
  runState: AgentRunState,
  options: {
    toolCallId?: string;
    toolName?: string;
    proposalId?: string;
    includeSensitiveData?: boolean;
  } = {},
): TraceEnvelope {
  return new TraceEnvelope({
    runId: runState.runId,
    conversationId: runState.conversationId,
    workspaceId: runState.workspaceId,
    projectId: runState.projectId,
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    ...(options.toolName ? { toolName: options.toolName } : {}),
    ...(options.proposalId ? { proposalId: options.proposalId } : {}),
    provider: runState.model.provider,
    model: runState.model.name,
    runState: {
      status: runState.status,
      currentStep: runState.currentStep,
      stateSchemaVersion: 1,
    },
    budget: runState.budgetLimits,
    spans: [],
    attributes: {},
    includeSensitiveData: options.includeSensitiveData ?? false,
  });
}

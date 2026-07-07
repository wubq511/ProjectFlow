/**
 * Pi runtime adapter — wraps @earendil-works/pi-agent-core's runAgentLoop.
 *
 * This is the core orchestration module that:
 * 1. Receives a run request from FastAPI
 * 2. Builds model context via context-builder
 * 3. Runs the agent loop using Pi's runAgentLoop
 * 4. On each tool call: beforeToolCall → policy gate → execute → afterToolCall
 * 5. Persists events/results via FastAPI append API
 * 6. Loops until model produces final answer or budget exhausted
 *
 * Key invariants:
 * - Every tool call produces exactly one result
 * - Parameters validated before execution
 * - Policy decision recorded before every side effect
 * - Every result has a bounded payload
 * - Tool success observation only returned to model after FastAPI confirms persistence
 */

import type { AgentRunState } from "@/types/run-state.js";
import type { ContextBuildInput, SkillContext } from "./context-builder.js";
import { buildContext, filterModelCallableManifests } from "./context-builder.js";
import type { ModelRouter } from "./model-router.js";
import type { FastapiClient } from "@/tools/fastapi-client.js";
import type { ToolRegistry, ToolExecutionContext } from "@/tools/registry.js";
import { normalizeResult } from "@/tools/result-normalizer.js";
import { canExecuteInParallel, evaluatePolicy } from "@/policy/policy-engine.js";
import { BudgetManager } from "@/policy/budget.js";
import { createToolTrace } from "@/events/trace-envelope.js";
import {
  buildRuntimeEvent,
  buildRuntimeEventFromPiEvent,
  buildRuntimeProductEvent,
} from "@/events/event-mapper.js";
import { getDebugPayloadStore, type DebugPayloadStore } from "@/events/debug-payload-store.js";
import type { EventStream, StreamEventType } from "@/events/stream.js";
import type { RuntimeEvent } from "@/types/runtime-event.js";
import type { ProjectFlowToolResult, ToolTrace } from "@/types/tool-result.js";
import { snakifyKeys } from "@/types/wire.js";
import type {
  WireAppendResponse,
  WireEventAppendItem,
  WireProjectFlowToolResult,
} from "@/types/wire.js";

// Pi imports
import {
  runAgentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentTool,
  type AgentToolResult,
  type AgentMessage,
  type AgentLoopConfig,
  type BeforeToolCallContext,
  type AfterToolCallContext,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model, Api, Provider, AssistantMessage, Message, ToolCall, Usage, TSchema } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";

export interface RunInput {
  conversationId: string;
  workspaceId: string;
  projectId: string;
  userContent: string;
  workspaceState?: unknown;
  recentMessages?: unknown[];
  pendingProposals?: unknown[];
  skillContext?: SkillContext;
}

export interface RunCallbacks {
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  onComplete?: (state: AgentRunState) => void;
  onError?: (error: Error, state: AgentRunState) => void;
}

/**
 * Convert a ProjectFlow ToolRegistry tool to a Pi AgentTool.
 * Throws on tool execution failure (Pi convention).
 */
function toPiTool(
  toolName: string,
  registry: ToolRegistry,
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  stream: EventStream,
  budget: BudgetManager,
  traceIncludeSensitiveData: boolean,
  debugPayloadStore: DebugPayloadStore,
): AgentTool<any> | null {
  const registered = registry.get(toolName);
  if (!registered) return null;

  const manifest = registered.manifest;

  return {
    name: manifest.name,
    description: manifest.description,
    label: manifest.name,
    parameters: toToolParameters(manifest.inputSchema),
    executionMode: manifest.execution.mode === "parallel" ? "parallel" : "sequential",
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<any>> => {
      const idempotencyKey = `${runState.runId}_${toolCallId}`;
      const context: ToolExecutionContext = {
        runId: runState.runId,
        toolCallId,
        conversationId: runState.conversationId,
        workspaceId: runState.workspaceId,
        projectId: runState.projectId,
        toolName,
        toolVersion: manifest.version,
        manifestVersion: manifest.resume.manifestVersion,
        idempotencyKey,
      };

      const toolTrace = createToolTrace(runState.runId, toolCallId, toolName, traceIncludeSensitiveData);
      const span = toolTrace.startSpan("tool.execution");

      try {
        if (signal?.aborted) {
          throw new Error("运行已取消");
        }

        const budgetCheck = budget.checkAll();
        if (!budgetCheck.allowed) {
          const observation = budgetCheck.message ?? "运行预算已超限";
          const trace = toolTrace.toResultTrace();
          const appendResponse = await fastapiClient.appendEvents(runState.runId, {
            idempotency_key: idempotencyKey,
            tool_results: [{
              tool_call_id: toolCallId,
              tool_name: toolName,
              tool_version: manifest.version,
              result: {
                status: "failed",
                error: { code: "BUDGET_EXCEEDED", message: observation },
                side_effect_status: "no_side_effect",
                observation,
                trace,
              },
            }],
          });
          updateLastEventSeq(runState, appendResponse.state_version, appendResponse.events.map((event) => event.event_seq));
          throw new Error(`BUDGET_EXCEEDED: ${observation}`);
        }

        budget.useToolCall();
        const rawResult = await registered.execute(params as Record<string, unknown>, context);
        toolTrace.endSpan(span, { status: "success" });

        const normalized = normalizeResult(rawResult, params, {
          maxBytes: manifest.resultLimit.maxBytes,
          redaction: manifest.resultLimit.redaction,
          recordInput: manifest.privacy.traceIncludeInputs,
          recordOutput: manifest.privacy.traceIncludeOutputs,
          includeSensitiveData: traceIncludeSensitiveData,
          debugPayloadStore,
          debugPayloadContext: {
            runId: runState.runId,
            toolCallId,
            toolName,
          },
        });
        normalized.idempotencyKey ??= idempotencyKey;

        const productEvents = buildToolResultProductEvents(
          normalized,
          context,
          runState,
          traceIncludeSensitiveData,
        );

        // Persist via append API
        const appendResponse = await fastapiClient.appendEvents(runState.runId, {
          idempotency_key: idempotencyKey,
          events: productEvents.map(toWireEvent),
          tool_results: [{
            tool_call_id: toolCallId,
            tool_name: toolName,
            tool_version: manifest.version,
            result: toWireToolResult(normalized),
          }],
        });
        assignPersistedEventSeqs(productEvents, appendResponse);
        updateLastEventSeq(runState, appendResponse.state_version, appendResponse.events.map((event) => event.event_seq));
        emitPersistedEvents(stream, productEvents);

        runState.sideEffects.push({ toolCallId, status: normalized.sideEffectStatus });

        if (normalized.status !== "success") {
          throw new Error(normalized.observation);
        }

        return {
          content: [{ type: "text" as const, text: normalized.observation }],
          details: normalized.data,
        };
      } catch (err) {
        toolTrace.endSpan(span, { status: "error", error: String(err) });
        throw err; // Pi convention: throw on failure
      }
    },
  };
}

/**
 * Map a Pi AgentEvent to a ProjectFlow event, persist it, then emit to stream.
 */
async function handlePiEvent(
  event: AgentEvent,
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  stream: EventStream,
  callbacks: RunCallbacks,
  traceIncludeSensitiveData: boolean,
): Promise<void> {
  applyPiEventToRunState(event, runState);
  const pfEvent = buildRuntimeEventFromPiEvent(
    event as Parameters<typeof buildRuntimeEventFromPiEvent>[0],
    runState,
    {
      orderingHint: runState.lastEventSeq + 1,
      includeSensitiveData: traceIncludeSensitiveData,
    },
  );
  const appendResponse = await fastapiClient.appendEvents(runState.runId, {
    idempotency_key: `${pfEvent.clientEventId}:append:v1`,
    state_patch: buildStatePatch(runState),
    events: [toWireEvent(pfEvent)],
  });
  assignPersistedEventSeqs([pfEvent], appendResponse);
  updateLastEventSeq(runState, appendResponse.state_version, appendResponse.events.map((item) => item.event_seq));
  stream.emit(pfEvent.type as StreamEventType, pfEvent);
  callbacks.onEvent?.(pfEvent.type, pfEvent.payload);
}

function applyPiEventToRunState(event: AgentEvent, runState: AgentRunState): void {
  switch (event.type) {
    case "agent_start": {
      runState.status = "context_building";
      break;
    }
    case "turn_start": {
      runState.currentTurn++;
      runState.status = "model_streaming";
      runState.updatedAt = new Date().toISOString();
      break;
    }
    case "message_start":
    case "message_update": {
      runState.status = "model_streaming";
      runState.updatedAt = new Date().toISOString();
      break;
    }
    case "message_end": {
      runState.status = "model_streaming";
      runState.updatedAt = new Date().toISOString();
      break;
    }
    case "tool_execution_start": {
      runState.status = "tool_preparing";
      runState.currentStep++;
      runState.pendingToolCall = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolVersion: 1,
        idempotencyKey: `${runState.runId}_${event.toolCallId}`,
      };
      break;
    }
    case "tool_execution_update": {
      runState.status = "tool_running";
      runState.updatedAt = new Date().toISOString();
      break;
    }
    case "tool_execution_end": {
      runState.status = "persisting_tool_result";
      runState.pendingToolCall = undefined;
      runState.updatedAt = new Date().toISOString();
      break;
    }
    case "turn_end": {
      runState.status = "model_streaming";
      runState.updatedAt = new Date().toISOString();
      break;
    }
    case "agent_end": {
      // Derive terminal status from the last assistant message's stopReason
      const lastMsg = event.messages?.[event.messages.length - 1];
      const stopReason = (lastMsg as AssistantMessage | undefined)?.stopReason;
      if (stopReason === "error") {
        runState.status = "failed";
      } else if (stopReason === "aborted") {
        runState.status = "cancelled";
      } else {
        runState.status = "completed";
      }
      runState.completedAt = new Date().toISOString();
      runState.updatedAt = new Date().toISOString();
      break;
    }
  }
}

/**
 * Execute a complete agent run using Pi's runAgentLoop.
 */
export async function executeRun(
  runState: AgentRunState,
  input: RunInput,
  toolRegistry: ToolRegistry,
  modelRouter: ModelRouter,
  fastapiClient: FastapiClient,
  stream: EventStream,
  options: {
    traceIncludeSensitiveData?: boolean;
    signal?: AbortSignal;
    debugPayloadStore?: DebugPayloadStore;
    model?: Model<Api>;
    streamFn?: StreamFn;
  } = {},
  callbacks: RunCallbacks = {},
): Promise<AgentRunState> {
  const budget = new BudgetManager({
    maxSteps: runState.budgetLimits.maxSteps,
    maxToolCalls: runState.budgetLimits.maxToolCalls,
    timeoutMs: runState.budgetLimits.timeoutMs,
    maxOutputTokens: 4096,
    maxToolResultBytes: 32768,
  });

  const traceIncludeSensitiveData = options.traceIncludeSensitiveData ?? false;
  const debugPayloadStore = options.debugPayloadStore ?? getDebugPayloadStore();

  try {
    // Step 1: Context building
    runState.status = "context_building";
    runState.updatedAt = new Date().toISOString();
    callbacks.onEvent?.("state.changed", { run_id: runState.runId, status: runState.status });

    const contextInput: ContextBuildInput = {
      userContent: input.userContent,
      workspaceState: input.workspaceState,
      recentMessages: input.recentMessages,
      pendingProposals: input.pendingProposals,
      toolManifests: toolRegistry.getManifests(),
      skillContext: input.skillContext,
      currentTime: new Date().toISOString(),
    };
    const builtContext = buildContext(contextInput);

    // Step 2: Build Pi tools from registry
    const exposedManifests = filterModelCallableManifests(toolRegistry.getManifests(), input.skillContext);
    const toolNames = exposedManifests.map((m) => m.name);
    const piTools: AgentTool<any>[] = [];
    for (const name of toolNames) {
      const piTool = toPiTool(
        name, toolRegistry, runState, fastapiClient, stream, budget, traceIncludeSensitiveData, debugPayloadStore,
      );
      if (piTool) piTools.push(piTool);
    }

    // Step 3: Build Pi AgentContext
    const agentContext: AgentContext = {
      systemPrompt: builtContext.systemPrompt,
      messages: [{ role: "user" as const, content: builtContext.userMessage, timestamp: Date.now() } as AgentMessage],
      tools: piTools,
    };

    // Step 4: Resolve model from registry
    // The runState.model.provider/name come from the frontend's model selection.
    // We look up the corresponding ModelConfigEntryRuntime to get the full config
    // (including apiKeyEnvVar, baseUrl, capabilities, etc.).
    const modelConfigEntry = modelRouter.resolve(
      // Use provider:name as a composite id lookup, or fall back to default
      `${runState.model.provider}:${runState.model.name}`,
    );

    // Step 5: Create model instance — real provider when configured, mock fallback
    const resolved = await resolveRealModel(
      modelConfigEntry
        ? { provider: modelConfigEntry.provider, name: modelConfigEntry.name, baseUrl: modelConfigEntry.resolvedBaseUrl }
        : { provider: runState.model.provider, name: runState.model.name },
    );
    const model = options.model ?? resolved.model;
    const streamFn = options.streamFn ?? ((modelConfigEntry?.provider ?? runState.model.provider) === "mock" ? createMockStreamFn() : undefined);

    // Step 6: Build AgentLoopConfig with hooks
    // Map our ThinkingLevel to Pi SDK's ThinkingLevel.
    // Pi SDK has: minimal | low | medium | high | xhigh (no "max").
    // Our "max" maps to Pi SDK "xhigh" (DeepSeek thinkingLevelMap: xhigh → "max" budget).
    const reasoningLevel = runState.thinkingLevel === "max" ? "xhigh" as const : runState.thinkingLevel;
    const config: AgentLoopConfig = {
      model,
      reasoning: reasoningLevel,
      convertToLlm: (messages: AgentMessage[]): Message[] => messages as Message[],
      toolExecution: canExecuteInParallel(exposedManifests) ? "parallel" : "sequential",
      beforeToolCall: async (_ctx: BeforeToolCallContext) => {
        if (options.signal?.aborted) {
          return { block: true, reason: "运行已取消" };
        }
        // Policy gate — check if tool is allowed
        const toolName = _ctx.toolCall.name;
        const tool = toolRegistry.get(toolName);
        if (tool) {
          const policy = evaluatePolicy(tool.manifest);
          if (policy.decision === "block" || policy.decision === "deny") {
            return { block: true, reason: policy.reason };
          }
        }
        return undefined;
      },
      afterToolCall: async (_ctx: AfterToolCallContext) => {
        // Result normalization is handled in the tool's execute function
        return undefined;
      },
    };

    // Step 7: Run the agent loop
    runState.status = "model_streaming";
    runState.updatedAt = new Date().toISOString();

    let agentEndProcessed = false;
    const piEventSink = async (event: AgentEvent) => {
      if (event.type === "agent_end") {
        agentEndProcessed = true;
      }
      await handlePiEvent(event, runState, fastapiClient, stream, callbacks, traceIncludeSensitiveData);
    };

    const promptMessage = {
      role: "user" as const,
      content: builtContext.userMessage,
      timestamp: Date.now(),
    } as AgentMessage;

    await runAgentLoop(
      [promptMessage],
      agentContext,
      config,
      piEventSink,
      options.signal,
      streamFn,
    );

    // Step 8: Finalize terminal status (if not already set by agent_end event)
    // Status may have been mutated by handlePiEvent callback during runAgentLoop.
    // If agent_end was already processed, it already emitted the terminal event —
    // we only emit a fallback event when agent_end was NOT processed.
    const statusAfterRun = runState.status as string;
    if (options.signal?.aborted || statusAfterRun === "cancelling" || statusAfterRun === "cancelled") {
      runState.status = "cancelled";
      runState.completedAt = new Date().toISOString();
      runState.updatedAt = new Date().toISOString();
    } else if (statusAfterRun === "failed" && !agentEndProcessed) {
      // agent_end was not emitted — emit failure event ourselves
      await persistAndEmitMappedEvent(
        {
          type: "agent.failed",
          payload: { reason: "模型返回错误" },
          newStatus: runState.status,
        },
        runState,
        fastapiClient,
        stream,
        traceIncludeSensitiveData,
      );
    } else if (statusAfterRun !== "completed" && statusAfterRun !== "failed" && !agentEndProcessed) {
      runState.status = "completed";
      runState.completedAt = new Date().toISOString();
      runState.updatedAt = new Date().toISOString();
    }
    callbacks.onComplete?.(runState);

    return runState;
  } catch (err) {
    const wasCancelled = options.signal?.aborted || runState.status === "cancelling" || runState.status === "cancelled";
    runState.status = wasCancelled ? "cancelled" : "failed";
    runState.completedAt = new Date().toISOString();
    runState.updatedAt = new Date().toISOString();
    const error = err instanceof Error ? err : new Error(String(err));

    if (wasCancelled) {
      await persistAndEmitMappedEvent(
        {
          type: "run.cancelled",
          payload: { reason: "运行已取消" },
          newStatus: runState.status,
        },
        runState,
        fastapiClient,
        stream,
        traceIncludeSensitiveData,
      );
      callbacks.onComplete?.(runState);
    } else {
      await persistAndEmitMappedEvent(
        {
          type: "run.failed",
          payload: {
            error: error.message,
            ...(error.message.startsWith("BUDGET_EXCEEDED") ? { code: "BUDGET_EXCEEDED" } : {}),
          },
          newStatus: runState.status,
        },
        runState,
        fastapiClient,
        stream,
        traceIncludeSensitiveData,
      );
      callbacks.onError?.(error, runState);
    }

    return runState;
  }
}

async function persistAndEmitMappedEvent(
  mapped: Parameters<typeof buildRuntimeEvent>[0],
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  stream: EventStream,
  traceIncludeSensitiveData: boolean,
): Promise<RuntimeEvent> {
  const event = buildRuntimeEvent(mapped, runState, {
    orderingHint: runState.lastEventSeq + 1,
    includeSensitiveData: traceIncludeSensitiveData,
  });
  const appendResponse = await fastapiClient.appendEvents(runState.runId, {
    idempotency_key: `${event.clientEventId}:append:v1`,
    state_patch: buildStatePatch(runState),
    events: [toWireEvent(event)],
  });
  assignPersistedEventSeqs([event], appendResponse);
  updateLastEventSeq(runState, appendResponse.state_version, appendResponse.events.map((item) => item.event_seq));
  stream.emit(event.type as StreamEventType, event);
  return event;
}

function buildStatePatch(runState: AgentRunState): Record<string, unknown> {
  return {
    schema_version: 1,
    status: runState.status,
    current_turn: runState.currentTurn,
    current_step: runState.currentStep,
    model_provider: runState.model.provider,
    model_name: runState.model.name,
    pending_tool_call_id: runState.pendingToolCall?.toolCallId ?? null,
    pending_tool_name: runState.pendingToolCall?.toolName ?? null,
    pending_tool_version: runState.pendingToolCall?.toolVersion ?? null,
    pending_idempotency_key: runState.pendingToolCall?.idempotencyKey ?? null,
  };
}

function buildToolResultProductEvents(
  result: ProjectFlowToolResult,
  context: ToolExecutionContext,
  runState: AgentRunState,
  traceIncludeSensitiveData: boolean,
): RuntimeEvent[] {
  const commonPayload = {
    tool_call_id: context.toolCallId,
    tool_name: context.toolName,
    tool_version: context.toolVersion,
    side_effect_status: result.sideEffectStatus,
    ...(result.links?.agentEventId ? { agent_event_id: result.links.agentEventId } : {}),
    ...(result.links?.createdIds ? { created_ids: result.links.createdIds } : {}),
  };
  const orderingHint = runState.lastEventSeq + 1;

  if (result.sideEffectStatus === "proposal_persisted" && result.links?.proposalId) {
    return [
      buildRuntimeProductEvent(
        "proposal.created",
        runState,
        {
          ...commonPayload,
          proposal_id: result.links.proposalId,
        },
        {
          orderingHint,
          includeSensitiveData: traceIncludeSensitiveData,
          proposalId: result.links.proposalId,
        },
      ),
    ];
  }

  if (result.sideEffectStatus === "advisory_record_persisted" && result.links?.createdIds?.length) {
    return [
      buildRuntimeProductEvent(
        "advisory_record.created",
        runState,
        commonPayload,
        {
          orderingHint,
          includeSensitiveData: traceIncludeSensitiveData,
        },
      ),
    ];
  }

  return [];
}

function toWireEvent(event: RuntimeEvent): WireEventAppendItem {
  return {
    client_event_id: event.clientEventId ?? `${event.runId}:${event.type}:${event.orderingHint ?? 0}`,
    type: event.type,
    ordering_hint: event.orderingHint,
    payload: event.payload,
    ...(event.trace ? { trace: snakifyKeys(event.trace) as Record<string, unknown> } : {}),
  };
}

function assignPersistedEventSeqs(events: RuntimeEvent[], response: WireAppendResponse): void {
  const byClientId = new Map(response.events.map((event) => [event.client_event_id, event.event_seq]));
  for (const event of events) {
    const eventSeq = event.clientEventId ? byClientId.get(event.clientEventId) : undefined;
    if (eventSeq !== undefined) {
      event.eventSeq = eventSeq;
    }
  }
}

function emitPersistedEvents(stream: EventStream, events: RuntimeEvent[]): void {
  for (const event of events) {
    stream.emit(event.type as StreamEventType, event);
  }
}

function toToolParameters(inputSchema: unknown): TSchema {
  if (inputSchema && typeof inputSchema === "object") {
    return inputSchema as TSchema;
  }
  return Type.Object({});
}

function updateLastEventSeq(runState: AgentRunState, stateVersion: number, eventSeqs: number[]): void {
  runState.lastEventSeq = Math.max(runState.lastEventSeq, stateVersion, ...eventSeqs);
}

function toWireTrace(trace: ToolTrace): NonNullable<WireProjectFlowToolResult["trace"]> {
  return {
    ...(trace.inputHash ? { input_hash: trace.inputHash } : {}),
    ...(trace.outputHash ? { output_hash: trace.outputHash } : {}),
    ...(trace.debugPayloadId ? { debug_payload_id: trace.debugPayloadId } : {}),
    redacted: trace.redacted,
  };
}

function toWireToolResult(result: ProjectFlowToolResult): WireProjectFlowToolResult {
  return {
    status: result.status,
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.error ? { error: result.error } : {}),
    side_effect_status: result.sideEffectStatus,
    ...(result.idempotencyKey ? { idempotency_key: result.idempotencyKey } : {}),
    ...(result.links
      ? {
          links: {
            ...(result.links.agentEventId ? { agent_event_id: result.links.agentEventId } : {}),
            ...(result.links.agentRunId ? { agent_run_id: result.links.agentRunId } : {}),
            ...(result.links.proposalId ? { proposal_id: result.links.proposalId } : {}),
            ...(result.links.createdIds ? { created_ids: result.links.createdIds } : {}),
          },
        }
      : {}),
    observation: result.observation,
    trace: toWireTrace(result.trace),
  };
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createMockStreamFn(): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    queueMicrotask(() => {
      if (options?.signal?.aborted) {
        const aborted = createAssistantMessage(model, [{ type: "text", text: "运行已取消" }], "aborted");
        stream.push({ type: "error", reason: "aborted", error: aborted });
        return;
      }

      const hasToolResult = context.messages.some((message) => message.role === "toolResult");
      const firstTool = context.tools?.[0];
      if (firstTool && !hasToolResult) {
        const toolCall: ToolCall = {
          type: "toolCall",
          id: "mock_tool_call_1",
          name: firstTool.name,
          arguments: {},
        };
        const message = createAssistantMessage(model, [toolCall], "toolUse");
        stream.push({ type: "done", reason: "toolUse", message });
        return;
      }

      const message = createAssistantMessage(
        model,
        [{ type: "text", text: "已完成 ProjectFlow mock tool loop。" }],
        "stop",
      );
      stream.push({ type: "done", reason: "stop", message });
    });

    return stream;
  };
}

function createAssistantMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.name,
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Create a mock model for testing when no real provider is configured.
 */
function createMockModel(name: string): Model<Api> {
  return {
    id: name,
    providerId: "mock" as any,
    api: "openai-completions" as Api,
    name,
    reasoning: false,
    provider: "mock" as any,
    baseUrl: "",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<Api>;
}

/**
 * Resolved model — the Pi SDK Model object plus an optional API key override.
 *
 * NOTE: apiKeyOverride is currently not consumed by the runtime loop.
 * Pi SDK providers read API keys from process.env at their own expected env var names.
 * As long as the user sets the key to the correct env var (e.g., DEEPSEEK_API_KEY),
 * the provider will pick it up automatically. apiKeyOverride is reserved for future
 * per-request key injection once Pi SDK supports it.
 */
interface ResolvedModel {
  model: Model<Api>;
  /** Per-request API key override (reserved — not yet consumed at runtime) */
  apiKeyOverride?: string;
}

/**
 * Resolve a real Model object from Pi SDK providers.
 * - provider "mock" → returns mock model
 * - known provider → dynamic import, resolve from Pi SDK catalog
 * - model not in catalog (e.g., custom openai-compatible) → construct Model manually
 * - unknown provider → throws (fail-fast)
 *
 * This function is async because it uses dynamic import() for providers.
 */
async function resolveRealModel(
  input: { provider: string; name: string; baseUrl?: string; apiKeyOverride?: string },
): Promise<ResolvedModel> {
  const { provider, name, baseUrl, apiKeyOverride } = input;

  if (provider === "mock") {
    return { model: createMockModel(name) };
  }

  const piProvider = await getPiProvider(provider);
  if (!piProvider) {
    throw new Error(
      `[agent-bridge] 未找到 Pi SDK provider: "${provider}"。` +
      `请检查模型配置中的 provider 字段。`
    );
  }

  // Try to find model in catalog
  const models = piProvider.getModels();
  const found = models.find((m) => m.id === name || m.name === name);

  if (found) {
    // Catalog model — use as-is, optionally override baseUrl
    const model = baseUrl
      ? { ...found, baseUrl } as Model<Api>
      : found as Model<Api>;
    return { model, apiKeyOverride };
  }

  // Model not in catalog — construct a custom Model object
  // This supports openai-compatible providers with custom model names
  if (provider === "openai-compatible" || provider === "openrouter") {
    return {
      model: createCustomOpenAICompatibleModel(name, provider, baseUrl ?? piProvider.baseUrl ?? ""),
      apiKeyOverride,
    };
  }

  // For other providers, model-not-in-catalog is an error
  const available = models.map((m) => m.id).join(", ");
  throw new Error(
    `[agent-bridge] 未在 ${provider} catalog 中找到模型: "${name}"。` +
    `可用模型: ${available}`
  );
}

/**
 * Construct a custom Model object for openai-compatible providers.
 */
function createCustomOpenAICompatibleModel(name: string, provider: string, baseUrl: string): Model<Api> {
  return {
    id: name,
    name,
    api: "openai-completions" as Api,
    provider: provider as any,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<Api>;
}

/**
 * Get Pi SDK Provider instance by provider type — dynamic import.
 * Only loads the provider module when actually needed.
 */
async function getPiProvider(provider: string): Promise<Provider | undefined> {
  switch (provider) {
    case "deepseek":
      return (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider();
    case "openai":
      return (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider();
    case "openai-compatible":
      return (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider();
    case "anthropic":
      return (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider();
    case "xiaomi":
      return (await import("@earendil-works/pi-ai/providers/xiaomi")).xiaomiProvider();
    case "xiaomi-token-plan-cn":
      return (await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-cn")).xiaomiTokenPlanCnProvider();
    case "openrouter":
      return (await import("@earendil-works/pi-ai/providers/openrouter")).openrouterProvider();
    default:
      return undefined;
  }
}

/**
 * Get catalog models for a provider (used by /config/providers/:provider/models).
 */
export async function getProviderCatalogModels(provider: string): Promise<{ id: string; name: string; reasoning: boolean; input: ("text" | "image")[] }[]> {
  if (provider === "mock") return [];
  const piProvider = await getPiProvider(provider);
  if (!piProvider) return [];
  return piProvider.getModels().map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input as ("text" | "image")[],
  }));
}

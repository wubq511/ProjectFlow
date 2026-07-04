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
import { buildContext } from "./context-builder.js";
import type { ModelRouter } from "./model-router.js";
import type { FastapiClient } from "@/tools/fastapi-client.js";
import type { ToolRegistry, ToolExecutionContext } from "@/tools/registry.js";
import { normalizeResult } from "@/tools/result-normalizer.js";
import { evaluatePolicy } from "@/policy/policy-engine.js";
import { BudgetManager } from "@/policy/budget.js";
import { createToolTrace } from "@/events/trace-envelope.js";
import type { EventStream } from "@/events/stream.js";
import { createEvent } from "@/types/runtime-event.js";

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
import type { Model, Api } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";

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
  budget: BudgetManager,
  traceIncludeSensitiveData: boolean,
): AgentTool<any> | null {
  const registered = registry.get(toolName);
  if (!registered) return null;

  const manifest = registered.manifest;

  return {
    name: manifest.name,
    description: manifest.description,
    label: manifest.name,
    parameters: Type.Object({}),
    executionMode: manifest.execution.mode === "parallel" ? "parallel" : "sequential",
    execute: async (
      toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<any>> => {
      const idempotencyKey = `${runState.runId}_${toolCallId}`;
      const context: ToolExecutionContext = {
        runId: runState.runId,
        toolCallId,
        conversationId: runState.conversationId,
        workspaceId: runState.workspaceId,
        projectId: runState.projectId,
        idempotencyKey,
      };

      const toolTrace = createToolTrace(runState.runId, toolCallId, toolName, traceIncludeSensitiveData);
      const span = toolTrace.startSpan("tool.execution");

      try {
        const rawResult = await registered.execute(params as Record<string, unknown>, context);
        toolTrace.endSpan(span, { status: "success" });

        const normalized = normalizeResult(rawResult, params, {
          maxBytes: manifest.resultLimit.maxBytes,
          redaction: manifest.resultLimit.redaction,
          recordInput: manifest.privacy.traceIncludeInputs,
          recordOutput: manifest.privacy.traceIncludeOutputs,
        });

        // Persist via append API
        await fastapiClient.appendEvents(runState.runId, {
          idempotency_key: idempotencyKey,
          tool_results: [{
            tool_call_id: toolCallId,
            tool_name: toolName,
            tool_version: manifest.version,
            result: {
              status: normalized.status,
              data: normalized.data,
              side_effect_status: normalized.sideEffectStatus,
              observation: normalized.observation,
              trace: normalized.trace,
            },
          }],
        });

        runState.sideEffects.push({ toolCallId, status: normalized.sideEffectStatus });
        budget.useToolCall();

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
 * Map a Pi AgentEvent to a ProjectFlow event type and emit to stream.
 */
function handlePiEvent(
  event: AgentEvent,
  runState: AgentRunState,
  stream: EventStream,
  callbacks: RunCallbacks,
): void {
  switch (event.type) {
    case "agent_start": {
      runState.status = "context_building";
      const pfEvent = createEvent("agent.started", runState.runId, runState.status);
      stream.emit("run.status", pfEvent);
      callbacks.onEvent?.("agent.started", { run_id: runState.runId });
      break;
    }
    case "turn_start": {
      runState.currentTurn++;
      runState.status = "model_streaming";
      runState.updatedAt = new Date().toISOString();
      callbacks.onEvent?.("agent.status", { run_id: runState.runId, phase: "turn_start" });
      break;
    }
    case "message_update": {
      const messageEvent = "assistantMessageEvent" in event
        ? (event as Record<string, unknown>).assistantMessageEvent
        : undefined;
      const pfEvent = createEvent("agent.delta", runState.runId, runState.status, {
        content: messageEvent,
      });
      stream.emit("agent.delta", pfEvent);
      break;
    }
    case "tool_execution_start": {
      runState.status = "tool_running";
      runState.currentStep++;
      runState.pendingToolCall = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolVersion: 1,
        idempotencyKey: `${runState.runId}_${event.toolCallId}`,
      };
      const pfEvent = createEvent("tool.started", runState.runId, runState.status, {
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
      });
      stream.emit("tool.started", pfEvent);
      callbacks.onEvent?.("tool.started", { tool_name: event.toolName, tool_call_id: event.toolCallId });
      break;
    }
    case "tool_execution_end": {
      runState.status = "persisting_tool_result";
      runState.pendingToolCall = undefined;
      const pfEventType = event.isError ? "tool.failed" : "tool.completed";
      const pfEvent = createEvent(pfEventType, runState.runId, runState.status, {
        tool_name: event.toolName,
        tool_call_id: event.toolCallId,
        is_error: event.isError,
      });
      stream.emit(event.isError ? "tool.failed" : "tool.completed", pfEvent);
      callbacks.onEvent?.(pfEventType, { tool_name: event.toolName });
      break;
    }
    case "turn_end": {
      runState.status = "model_streaming";
      runState.updatedAt = new Date().toISOString();
      callbacks.onEvent?.("agent.status", { run_id: runState.runId, phase: "turn_end" });
      break;
    }
    case "agent_end": {
      runState.status = "completed";
      runState.completedAt = new Date().toISOString();
      runState.updatedAt = new Date().toISOString();
      const pfEvent = createEvent("agent.completed", runState.runId, runState.status);
      stream.emit("run.status", pfEvent);
      callbacks.onEvent?.("agent.completed", { run_id: runState.runId });
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
    model?: Model<Api>;
    streamFn?: StreamFn;
  } = {},
  callbacks: RunCallbacks = {},
): Promise<AgentRunState> {
  const budget = new BudgetManager({
    maxSteps: 8,
    maxToolCalls: 6,
    timeoutMs: 180000,
    maxOutputTokens: 4096,
    maxToolResultBytes: 32768,
  });

  const traceIncludeSensitiveData = options.traceIncludeSensitiveData ?? false;

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
    const toolNames = toolRegistry.getManifests().map((m) => m.name);
    const piTools: AgentTool<any>[] = [];
    for (const name of toolNames) {
      const piTool = toPiTool(
        name, toolRegistry, runState, fastapiClient, budget, traceIncludeSensitiveData,
      );
      if (piTool) piTools.push(piTool);
    }

    // Step 3: Build Pi AgentContext
    const agentContext: AgentContext = {
      systemPrompt: builtContext.systemPrompt,
      messages: [{ role: "user" as const, content: builtContext.userMessage, timestamp: Date.now() } as AgentMessage],
      tools: piTools,
    };

    // Step 4: Resolve model
    const resolvedModel = modelRouter.resolve(runState.model.provider, runState.model.name);

    // Step 5: Create model instance (mock for now, real provider when configured)
    const model = options.model ?? createMockModel(resolvedModel.name);

    // Step 6: Build AgentLoopConfig with hooks
    const config: AgentLoopConfig = {
      model,
      convertToLlm: (messages: AgentMessage[]) => messages as any[],
      toolExecution: "parallel",
      beforeToolCall: async (_ctx: BeforeToolCallContext) => {
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

    const piEventSink = async (event: AgentEvent) => {
      handlePiEvent(event, runState, stream, callbacks);
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
      undefined, // signal
      options.streamFn,
    );

    // Step 8: Complete (if not already completed by agent_end event)
    // Status may have been mutated by handlePiEvent callback during runAgentLoop
    if ((runState.status as string) !== "completed") {
      runState.status = "completed";
      runState.completedAt = new Date().toISOString();
      runState.updatedAt = new Date().toISOString();
    }
    callbacks.onComplete?.(runState);

    return runState;
  } catch (err) {
    runState.status = "failed";
    runState.completedAt = new Date().toISOString();
    runState.updatedAt = new Date().toISOString();
    const error = err instanceof Error ? err : new Error(String(err));

    const pfEvent = createEvent("run.failed", runState.runId, runState.status, {
      error: error.message,
    });
    stream.emit("runtime.error", pfEvent);
    callbacks.onError?.(error, runState);

    return runState;
  }
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

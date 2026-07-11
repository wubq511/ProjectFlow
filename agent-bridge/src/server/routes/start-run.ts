/**
 * POST /runs — Start a new agent run.
 * Receives RunStartRequest from FastAPI, initiates the runtime loop.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parseRunStartRequest } from "@/types/wire.js";
import { createRunState } from "@/types/run-state.js";
import { executeRun } from "@/runtime/pi-runtime.js";
import type { StreamEventType } from "@/events/stream.js";
import type { RuntimeEvent } from "@/types/runtime-event.js";
import type { RunContext } from "./utils.js";
import { sendJson, readJsonBody } from "./utils.js";

export async function handleStartRun(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const bodyText = (req as IncomingMessage & { bodyText?: string }).bodyText ?? "";

  const parsed = readJsonBody(res, bodyText, parseRunStartRequest);
  if (!parsed) return;

  // Step 1: Create run record in FastAPI (persists AgentRunV2 to DB)
  // FastAPI's RuntimeConfig.model is a string, but sidecar wire format uses { provider, name }.
  // Convert before sending to FastAPI.
  const modelName = parsed.runtime_config?.model
    ? `${parsed.runtime_config.model.provider}:${parsed.runtime_config.model.name}`
    : `${ctx.config.defaultModelProvider}:${ctx.config.defaultModelName}`;
  const fastapiRequestBody: Record<string, unknown> = {
    conversation_id: parsed.conversation_id,
    workspace_id: parsed.workspace_id,
    project_id: parsed.project_id,
    user_message_id: parsed.user_message_id,
    user_content: parsed.user_content,
    viewer_user_id: parsed.viewer_user_id,
    workspace_state: parsed.workspace_state,
    recent_messages: parsed.recent_messages,
    pending_proposals: parsed.pending_proposals,
    memory_mode: parsed.memory_mode ?? "enabled",
    runtime_config: {
      model: modelName,
      max_steps: parsed.runtime_config?.max_steps ?? ctx.config.defaults.maxSteps,
      max_tool_calls: parsed.runtime_config?.max_tool_calls ?? ctx.config.defaults.maxToolCalls,
      timeout_ms: parsed.runtime_config?.timeout_ms ?? ctx.config.defaults.timeoutMs,
      trace_include_sensitive_data: parsed.runtime_config?.trace_include_sensitive_data ?? ctx.config.traceIncludeSensitiveData,
    },
  };
  const fastapiRunResp = await ctx.fastapiClient.startRun(fastapiRequestBody as any);
  const fastapiRunId = fastapiRunResp.run_id;
  const memoryContext = fastapiRunResp.memory_context
    ? {
        text: fastapiRunResp.memory_context.text,
        usedMemoryIds: fastapiRunResp.memory_context.used_memory_ids,
        memoryBackend: fastapiRunResp.memory_context.memory_backend,
        retrievalCount: fastapiRunResp.memory_context.retrieval_count,
        injectedCount: fastapiRunResp.memory_context.injected_count,
        latencyMs: fastapiRunResp.memory_context.latency_ms,
      }
    : null;

  // Step 2: Create local run state using FastAPI-assigned run_id
  const runState = createRunState({
    runId: fastapiRunId,
    conversationId: parsed.conversation_id,
    workspaceId: parsed.workspace_id,
    projectId: parsed.project_id,
    model: {
      provider: parsed.runtime_config?.model?.provider ?? ctx.config.defaultModelProvider,
      name: parsed.runtime_config?.model?.name ?? ctx.config.defaultModelName,
    },
    maxSteps: parsed.runtime_config?.max_steps ?? ctx.config.defaults.maxSteps,
    maxToolCalls: parsed.runtime_config?.max_tool_calls ?? ctx.config.defaults.maxToolCalls,
    timeoutMs: parsed.runtime_config?.timeout_ms ?? ctx.config.defaults.timeoutMs,
    thinkingLevel: parsed.runtime_config?.thinking_level,
  });

  // Store run in session store
  ctx.sessionStore.set(runState.runId, runState);
  const abortController = new AbortController();
  ctx.sessionStore.setAbortController(runState.runId, abortController);

  // Return run_id immediately, execute loop asynchronously
  sendJson(res, 200, {
    run_id: runState.runId,
    status: runState.status,
  });

  // Default read-only tools are registered once at server startup (see app.ts);
  // the shared registry is reused across runs.

  // Start the runtime loop asynchronously
  executeRun(
    runState,
    {
      conversationId: parsed.conversation_id,
      workspaceId: parsed.workspace_id,
      projectId: parsed.project_id,
      userContent: parsed.user_content ?? "",
      workspaceState: parsed.workspace_state,
      recentMessages: parsed.recent_messages,
      pendingProposals: parsed.pending_proposals,
      viewerUserId: parsed.viewer_user_id,
      memoryContext,
    },
    ctx.toolRegistry,
    // Model router: resolve from model config registry (loaded from model-configs.json)
    ctx.modelRouter,
    ctx.fastapiClient,
    ctx.stream,
    {
      traceIncludeSensitiveData: parsed.runtime_config?.trace_include_sensitive_data ?? ctx.config.traceIncludeSensitiveData,
      signal: abortController.signal,
    },
    {
      onEvent: (type, payload) => {
        ctx.stream.emit(type as StreamEventType, { type, ...payload } as RuntimeEvent);
      },
      onComplete: (state) => {
        ctx.sessionStore.clearAbortController(state.runId);
        console.log(`[agent-bridge] run ${state.runId} completed`);
      },
      onError: (error, state) => {
        ctx.sessionStore.clearAbortController(state.runId);
        console.error(`[agent-bridge] run ${state.runId} failed:`, error.message);
      },
    },
  ).catch((err) => {
    ctx.sessionStore.clearAbortController(runState.runId);
    console.error(`[agent-bridge] run ${runState.runId} uncaught error:`, err);
  });
}

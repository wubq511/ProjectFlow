/**
 * POST /runs — Start a new agent run.
 * Receives RunStartRequest from FastAPI, initiates the runtime loop.
 *
 * Uses shared prepareRunRequest() for request validation, skill resolution,
 * and Outcome Contract classification BEFORE any durable/HTTP effects.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createRunState } from "@/types/run-state.js";
import { executeRun } from "@/runtime/pi-runtime.js";
import type { MemoryContext } from "@/runtime/context-builder.js";
import { prepareRunRequest } from "@/runtime/request-preparation.js";
import type { StreamEventType } from "@/events/stream.js";
import type { RuntimeEvent } from "@/types/runtime-event.js";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";

export async function handleStartRun(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const bodyText = (req as IncomingMessage & { bodyText?: string }).bodyText ?? "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { error: "parse_error", message: "JSON 解析失败" });
    return;
  }

  // ── Shared request preparation (BEFORE any side effects) ──
  const prepared = await prepareRunRequest(parsed, ctx.skillLoader, ctx.skillIndex, {
    workspaceState: (parsed as Record<string, unknown>)?.workspace_state,
    hasPendingProposals: Array.isArray((parsed as Record<string, unknown>)?.pending_proposals) &&
      ((parsed as Record<string, unknown>)?.pending_proposals as unknown[]).length > 0,
  });

  if (prepared.status === "invalid") {
    sendJson(res, 400, { error: prepared.error, message: prepared.message });
    return;
  }
  if (prepared.status === "unknown-skill") {
    sendJson(res, 400, {
      error: "invalid_skill",
      message: `未知的 Skill: ${prepared.skillName}`,
    });
    return;
  }
  if (prepared.status === "skill-load-error") {
    sendJson(res, 500, {
      error: "skill_load_error",
      message: `Skill 加载失败: ${prepared.skillName}`,
    });
    return;
  }

  // status === "ready"
  const { wireRequest, skillContext, allSkillContexts, outcomeContract } = prepared;

  // ── FastAPI run creation ──
  const modelName = wireRequest.runtime_config?.model
    ? `${wireRequest.runtime_config.model.provider}:${wireRequest.runtime_config.model.name}`
    : `${ctx.config.defaultModelProvider}:${ctx.config.defaultModelName}`;
  const fastapiRequestBody: Record<string, unknown> = {
    conversation_id: wireRequest.conversation_id,
    workspace_id: wireRequest.workspace_id,
    project_id: wireRequest.project_id,
    user_message_id: wireRequest.user_message_id,
    user_content: wireRequest.user_content,
    viewer_user_id: wireRequest.viewer_user_id,
    workspace_state: wireRequest.workspace_state,
    recent_messages: wireRequest.recent_messages,
    pending_proposals: wireRequest.pending_proposals,
    memory_mode: wireRequest.memory_mode ?? "enabled",
    runtime_config: {
      model: modelName,
      max_steps: wireRequest.runtime_config?.max_steps ?? ctx.config.defaults.maxSteps,
      max_tool_calls: wireRequest.runtime_config?.max_tool_calls ?? ctx.config.defaults.maxToolCalls,
      timeout_ms: wireRequest.runtime_config?.timeout_ms ?? ctx.config.defaults.timeoutMs,
      trace_include_sensitive_data: wireRequest.runtime_config?.trace_include_sensitive_data ?? ctx.config.traceIncludeSensitiveData,
    },
  };
  const fastapiRunResp = await ctx.fastapiClient.startRun(fastapiRequestBody as any);
  const fastapiRunId = fastapiRunResp.run_id;
  const memoryContext: MemoryContext | null = fastapiRunResp.memory_context
    ? {
        text: fastapiRunResp.memory_context.text,
        usedMemoryIds: fastapiRunResp.memory_context.used_memory_ids,
        usedMemoryTypes: fastapiRunResp.memory_context.used_memory_types ?? [],
        guardedMemberNames: fastapiRunResp.memory_context.guarded_member_names ?? [],
        memoryBackend: fastapiRunResp.memory_context.memory_backend,
        retrievalCount: fastapiRunResp.memory_context.retrieval_count,
        injectedCount: fastapiRunResp.memory_context.injected_count,
        latencyMs: fastapiRunResp.memory_context.latency_ms,
      }
    : null;

  // ── Local run state + session ──
  const runState = createRunState({
    runId: fastapiRunId,
    conversationId: wireRequest.conversation_id,
    workspaceId: wireRequest.workspace_id,
    projectId: wireRequest.project_id,
    model: {
      provider: wireRequest.runtime_config?.model?.provider ?? ctx.config.defaultModelProvider,
      name: wireRequest.runtime_config?.model?.name ?? ctx.config.defaultModelName,
    },
    maxSteps: wireRequest.runtime_config?.max_steps ?? ctx.config.defaults.maxSteps,
    maxToolCalls: wireRequest.runtime_config?.max_tool_calls ?? ctx.config.defaults.maxToolCalls,
    timeoutMs: wireRequest.runtime_config?.timeout_ms ?? ctx.config.defaults.timeoutMs,
    thinkingLevel: wireRequest.runtime_config?.thinking_level,
  });

  ctx.sessionStore.set(runState.runId, runState);
  const abortController = new AbortController();
  ctx.sessionStore.setAbortController(runState.runId, abortController);

  // ── HTTP 200 response ──
  sendJson(res, 200, {
    run_id: runState.runId,
    status: runState.status,
  });

  // ── Async runtime loop ──
  executeRun(
    runState,
    {
      conversationId: wireRequest.conversation_id,
      workspaceId: wireRequest.workspace_id,
      projectId: wireRequest.project_id,
      userContent: wireRequest.user_content ?? "",
      workspaceState: wireRequest.workspace_state,
      recentMessages: wireRequest.recent_messages,
      pendingProposals: wireRequest.pending_proposals,
      skillContext,
      allSkillContexts,
      viewerUserId: wireRequest.viewer_user_id,
      memoryContext,
      outcomeContract,
    },
    ctx.toolRegistry,
    ctx.modelRouter,
    ctx.fastapiClient,
    ctx.stream,
    {
      traceIncludeSensitiveData: wireRequest.runtime_config?.trace_include_sensitive_data ?? ctx.config.traceIncludeSensitiveData,
      signal: abortController.signal,
      sessionStore: ctx.sessionStore,
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

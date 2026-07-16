/**
 * POST /runs/stream — Start a new agent run and stream events via SSE.
 *
 * Same as POST /runs but returns an SSE stream instead of JSON.
 * The SSE stream stays open until the run completes, fails, or is cancelled.
 *
 * SSE event types emitted:
 * - `status`          — phase/module/message for UI step indicator
 * - `content`         — typed StreamContentEvent (thinking only: start/delta/end) [no longer emitted — aggregated server-side]
 * - `tool`            — tool lifecycle (started/completed/failed/blocked)
 * - `activity`        — RunActivityItem (progress/skill/tool) via projector
 * - `process_started` — process phase begins
 * - `process_delta`   — progress content append
 * - `process_completed` — process phase ends
 * - `answer_started`  — answer phase begins
 * - `answer_delta`    — answer content chunk
 * - `run_completed`   — full done payload with stream_sequence
 * - `done`            — final_content, thinking_content, activities
 * - `error`           — error message
 *
 * Text projection model:
 * - Model text deltas accumulate as pendingVisibleText in the projector.
 * - They are NEVER emitted as `content:text` events.
 * - On tool.started, pending text is flushed as a ProgressActivity.
 * - On agent.completed, final_content from the runtime is the sole answer
 *   source; pendingVisibleText is used only as fallback when final_content
 *   is missing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createRunState } from "@/types/run-state.js";
import { executeRun } from "@/runtime/pi-runtime.js";
import type { MemoryContext } from "@/runtime/context-builder.js";
import { prepareRunRequest } from "@/runtime/request-preparation.js";
import { createOutputSanitizer } from "@/runtime/output-sanitizer.js";
import type { StreamEventType } from "@/events/stream.js";
import type { RuntimeEvent } from "@/types/runtime-event.js";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";
import {
  createStreamProjector,
  formatToolStartLabel,
  formatToolBlockedLabel,
  getToolBaseLabel,
  toolLabel,
} from "./run-stream-presentation.js";

/** Write a single SSE event to the response. */
function writeSSE(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Compare composite block keys by numeric tuple [messageSeq, contentIndex].
 * localeCompare would sort "10:0" before "2:0" — numeric tuple sort is correct.
 * Exported for testing.
 */
export function compareCompositeKeys(a: string, b: string): number {
  const aParts = a.split(":").map(Number);
  const bParts = b.split(":").map(Number);
  const aSeq = aParts[0] ?? 0;
  const aIdx = aParts[1] ?? 0;
  const bSeq = bParts[0] ?? 0;
  const bIdx = bParts[1] ?? 0;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return aIdx - bIdx;
}

/**
 * Build the `done` event payload: final_content, thinking_content, activities.
 *
 * thinking_content is aggregated from all thinking block deltas.
 * final_content is the runtime's final answer (already sanitized by caller).
 */
export function buildDonePayload(
  runId: string,
  finalAnswer: string,
  thinkingBlocks: Map<string, string>,
  executionSteps: Array<{ tool_name: string; tool_call_id?: string; status: string; label: string }>,
  metrics?: { latency_ms: number; input_tokens: number; output_tokens: number; reasoning_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; total_cost?: number },
): Record<string, unknown> {
  const thinkingContent = Array.from(thinkingBlocks.entries())
    .sort(([a], [b]) => compareCompositeKeys(a, b))
    .map(([, content]) => content)
    .join("");

  return {
    run_id: runId,
    status: "completed",
    final_content: finalAnswer,
    ...(thinkingContent ? { thinking_content: thinkingContent } : {}),
    execution_steps: executionSteps.length > 0 ? executionSteps : undefined,
    ...(metrics ? { metrics } : {}),
  };
}

/**
 * Re-export toolLabel for backward compatibility with tests.
 * Prefer formatToolStartLabel / formatToolCompleteLabel for new code.
 */
export { toolLabel };

export async function handleStartRunStream(
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

  // Step 1: Create run record in FastAPI
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
  const memoryEvidence = {
    mode: wireRequest.memory_mode ?? "enabled",
    backend: memoryContext?.memoryBackend ?? "none",
    used_memory_ids: memoryContext?.usedMemoryIds ?? [],
    used_memory_types: memoryContext?.usedMemoryTypes ?? [],
    retrieval_count: memoryContext?.retrievalCount ?? 0,
    injected_count: memoryContext?.injectedCount ?? 0,
    latency_ms: memoryContext?.latencyMs ?? 0,
  };
  const finalMemoryEvidence = () => ({
    ...memoryEvidence,
    output_guard_status: memoryContext?.outputGuardStatus ?? "not_applied",
    output_guard_model_calls: memoryContext?.outputGuardModelCalls ?? 0,
  });

  // Step 2: Create local run state
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

  // Step 3: Set up SSE response headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // ── Create projector ──
  const streamStartedAt = Date.now();
  const projector = createStreamProjector(
    (event, data) => writeSSE(res, event, data),
    streamStartedAt,
  );

  // Emit process_started → initial deterministic progress → preflight skills
  projector.emitProcessStarted();
  projector.emitInitialProgress();

  const labelMap: Record<string, string> = {
    "project-intake": "项目澄清",
    "project-planning": "阶段规划",
    "task-breakdown": "任务拆解",
    "assignment-planning": "分工推荐",
    "project-status": "主动推进",
    "risk-analysis": "风险分析",
    "risk-replan": "计划调整",
  };
  for (const skill of allSkillContexts) {
    const skillNameCn = labelMap[skill.name] ?? skill.name;
    projector.emitSkillActivity(skill.name, `已读取${skillNameCn}技能`);
  }

  // Step 4: Subscribe to EventStream and forward as SSE
  let runCompleted = false;
  /** Final answer text extracted from the runtime's agent.completed payload. */
  let finalAnswerFromRuntime = "";

  /**
   * Assistant message sequence counter. Incremented on each `message_start` event.
   * Used to form composite block keys for thinking aggregation.
   */
  let messageSeq = 0;
  /**
   * Thinking block content aggregated by composite key.
   * Key = `${messageSeq}:${contentIndex}`, Value = concatenated delta content.
   */
  const thinkingBlocks = new Map<string, string>();

  const outputSanitizer = createOutputSanitizer(wireRequest.workspace_state);
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalCost = 0;
  let observedReasoning = false;
  let observedCacheRead = false;
  let observedCacheWrite = false;
  let observedCost = false;
  const currentMetrics = () => {
    const metrics: Record<string, unknown> = {
      latency_ms: Math.max(0, Date.now() - streamStartedAt),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
    if (observedReasoning) metrics.reasoning_tokens = reasoningTokens;
    if (observedCacheRead) metrics.cache_read_tokens = cacheReadTokens;
    if (observedCacheWrite) metrics.cache_write_tokens = cacheWriteTokens;
    if (observedCost) metrics.total_cost = totalCost;
    return metrics as { latency_ms: number; input_tokens: number; output_tokens: number; reasoning_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; total_cost?: number };
  };

  const finalizeRun = (state?: { runId: string }): void => {
    if (runCompleted) return;
    runCompleted = true;

    // Flush any remaining sanitizer text into projector and capture it
    const pendingText = projector.drainPendingText(() => outputSanitizer.flush());

    // Emit answer boundary + content (process_completed → answer_started → answer_delta)
    // final_content from runtime is the primary source; pendingVisibleText is fallback.
    const finalAnswer = finalAnswerFromRuntime || pendingText;
    projector.emitAnswerBoundaryAndContent(finalAnswer);

    const donePayload: Record<string, unknown> = buildDonePayload(
      state?.runId ?? runState.runId,
      finalAnswer,
      thinkingBlocks,
      projector.getExecutionSteps(),
      currentMetrics(),
    );
    donePayload.memory_evidence = finalMemoryEvidence();
    donePayload.activities = projector.getActivities();
    const processSummary = projector.getProcessSummary();
    donePayload.run_summary = {
      started_at: new Date(streamStartedAt).toISOString(),
      process_completed_at: processSummary.process_completed_at,
      completed_at: new Date().toISOString(),
      processing_duration_ms: processSummary.processing_duration_ms,
      duration_ms: Date.now() - streamStartedAt,
      status: "completed",
      activity_count: projector.getActivities().length,
    };

    writeSSE(res, "run_completed", {
      stream_sequence: projector.getStreamSequence() + 1,
      completed_at: new Date().toISOString(),
      ...donePayload,
    });
    writeSSE(res, "done", donePayload);
    res.end();
  };

  // Abort runtime when client disconnects mid-stream
  res.on("close", () => {
    if (!runCompleted) {
      runCompleted = true;
      abortController.abort();
    }
  });

  const unsubscribe = ctx.stream.subscribe((message) => {
    if (runCompleted) return;
    const data = message.data as RuntimeEvent;
    if (data.runId && data.runId !== runState.runId) return;

    const eventType = message.event as StreamEventType;

    switch (eventType) {
      case "run.started":
      case "agent.started":
        writeSSE(res, "status", {
          phase: "planning",
          message: "正在理解你的需求...",
          run_id: runState.runId,
          request_mode: outcomeContract.effectCeiling === "none" ? "answer" : "action",
          selected_skills: allSkillContexts.map((s) => s.name),
        });
        break;

      case "agent.delta": {
        const deltaType = data.payload?.delta_type as string | undefined;
        const contentIndex = typeof data.payload?.content_index === "number"
          ? data.payload.content_index as number
          : 0;
        const tokenText = typeof data.payload?.content === "string" ? data.payload.content as string : "";
        const blockKey = `${messageSeq}:${contentIndex}`;

        if (!deltaType) break;

        // Thinking events: aggregate server-side ONLY (no content SSE to frontend).
        // done.thinking_content is populated from thinkingBlocks for backward compat.
        if (deltaType === "thinking_start") {
          // No-op: thinking block boundary tracked by messageSeq/contentIndex
        } else if (deltaType === "thinking_delta") {
          if (tokenText) {
            const existing = thinkingBlocks.get(blockKey) ?? "";
            thinkingBlocks.set(blockKey, existing + tokenText);
          }
        } else if (deltaType === "thinking_end") {
          // No-op: block completion tracked locally
        }
        // Text events: accumulate in projector, NO content:text emission
        else if (deltaType === "text_delta") {
          if (tokenText) {
            const safeText = outputSanitizer.push(tokenText);
            projector.accumulateText(safeText);
          }
        } else if (deltaType === "text_end") {
          // Flush sanitizer tail on text block boundary
          const tail = outputSanitizer.flush();
          projector.accumulateText(tail);
        }
        break;
      }

      case "agent.status":
        if (data.payload?.phase === "message_start") {
          messageSeq++;
        }
        if (data.payload?.phase === "message_end") {
          const usage = data.payload.usage && typeof data.payload.usage === "object"
            ? data.payload.usage as Record<string, unknown>
            : {};
          const cost = data.payload.cost && typeof data.payload.cost === "object"
            ? data.payload.cost as Record<string, unknown>
            : {};
          inputTokens += typeof usage.input === "number" ? usage.input
            : typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
          outputTokens += typeof usage.output === "number" ? usage.output
            : typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
          {
            const r = typeof usage.reasoning === "number" ? usage.reasoning
              : typeof usage.reasoning_tokens === "number" ? usage.reasoning_tokens : undefined;
            if (r !== undefined) { observedReasoning = true; reasoningTokens += r; }
            const cr = typeof usage.cacheRead === "number" ? usage.cacheRead
              : typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : undefined;
            if (cr !== undefined) { observedCacheRead = true; cacheReadTokens += cr; }
            const cw = typeof usage.cacheWrite === "number" ? usage.cacheWrite
              : typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : undefined;
            if (cw !== undefined) { observedCacheWrite = true; cacheWriteTokens += cw; }
            const ct = typeof cost.total === "number" ? cost.total : undefined;
            if (ct !== undefined) { observedCost = true; totalCost += ct; }
          }
        }
        break;

      case "run.status":
      case "state.changed":
      case "run.state_changed":
        if (data.payload?.status) {
          const status = data.payload.status as string;
          if (status === "model_streaming") {
            writeSSE(res, "status", { phase: "streaming", message: "正在生成回复..." });
          } else if (status === "tool_running" || status === "tool_preparing") {
            writeSSE(res, "status", { phase: "executing", message: "正在执行工具..." });
          }
        }
        break;

      case "tool.started":
        {
          // Flush sanitizer tail into projector as accumulated text (NOT drain).
          // handleToolStarted will flush pendingVisibleText as a progress activity.
          const tail = outputSanitizer.flush();
          projector.accumulateText(tail);

          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "";
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : toolName;

          projector.handleToolStarted(toolName, toolCallId);

          // Legacy tool event for frontend execution steps
          const startLabel = formatToolStartLabel(toolName);
          const baseLabel = toolName && getToolBaseLabel(toolName) || "执行工具";
          writeSSE(res, "tool", { phase: "started", tool_call_id: toolCallId, tool_name: toolName, label: startLabel });
          writeSSE(res, "status", { phase: "executing", message: `正在${baseLabel}...` });
        }
        break;

      case "tool.completed":
        {
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "";

          if (toolCallId) {
            projector.handleToolCompleted(toolCallId, toolName);
          }

          writeSSE(res, "tool", { phase: "completed", tool_call_id: toolCallId ?? toolName, tool_name: toolName });
          writeSSE(res, "status", { phase: "generating", message: "正在整理结果..." });
        }
        break;

      case "tool.failed":
        {
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "";

          if (toolCallId) {
            projector.handleToolFailed(toolCallId, toolName);
          }

          writeSSE(res, "tool", { phase: "failed", tool_call_id: toolCallId ?? toolName, tool_name: toolName });
        }
        break;

      case "tool.blocked":
        {
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "";
          const eventId = typeof data.payload?.event_id === "string" ? data.payload.event_id : `blocked-${Date.now()}`;

          projector.handleToolBlocked(toolCallId, toolName, eventId);

          writeSSE(res, "tool", {
            phase: "blocked",
            ...(toolCallId ? { tool_call_id: toolCallId } : {}),
            ...(toolName ? { tool_name: toolName } : {}),
            label: formatToolBlockedLabel(toolName),
            event_id: eventId,
          });
        }
        break;

      case "tool.progress":
        writeSSE(res, "status", { phase: "executing", message: "正在执行任务..." });
        break;

      case "proposal.created":
        writeSSE(res, "status", { phase: "generating", message: "提案已生成，等待确认" });
        break;
      case "proposal.confirmed":
      case "proposal_confirmation.confirmed":
      case "proposal_confirmation.committed":
        writeSSE(res, "status", { phase: "generating", message: "提案已确认" });
        break;
      case "proposal.rejected":
      case "proposal_confirmation.rejected":
        writeSSE(res, "status", { phase: "generating", message: "提案已拒绝" });
        break;
      case "advisory_record.created":
        writeSSE(res, "status", { phase: "generating", message: "咨询记录已创建" });
        break;

      case "runtime.error": {
        const errorCode = data.payload?.code;
        let userMessage: string;
        if (errorCode === "budget_exceeded") {
          userMessage = "Agent 预算已用尽，请稍后重试。";
        } else if (errorCode === "policy_violation") {
          userMessage = "操作被策略拦截，请检查后重试。";
        } else if (errorCode === "timeout") {
          userMessage = "Agent 响应超时，请稍后重试。";
        } else {
          userMessage = "Agent 运行时错误，请稍后重试。";
        }
        if (!runCompleted) {
          runCompleted = true;
          writeSSE(res, "error", { message: userMessage });
          res.end();
        }
        break;
      }

      case "agent.completed":
      case "run.completed": {
        finalAnswerFromRuntime = typeof data.payload?.final_content === "string"
          ? outputSanitizer.sanitize(data.payload.final_content)
          : "";
        finalizeRun();
        break;
      }

      case "agent.failed":
      case "run.failed": {
        runCompleted = true;
        writeSSE(res, "error", { message: "Agent 处理失败，请稍后重试。" });
        res.end();
        break;
      }

      case "run.cancelled": {
        runCompleted = true;
        writeSSE(res, "error", { message: "运行已取消" });
        res.end();
        break;
      }

      default:
        break;
    }
  });

  // Step 5: Start the runtime loop
  try {
    await executeRun(
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
      },
      {
        onEvent: (_type, _payload) => {
          // Events are forwarded via the stream subscription above
        },
        onComplete: (state) => {
          ctx.sessionStore.clearAbortController(state.runId);
          finalizeRun(state);
        },
        onError: (_error, state) => {
          ctx.sessionStore.clearAbortController(state.runId);
          if (!runCompleted) {
            runCompleted = true;
            writeSSE(res, "error", { message: "Agent 执行出错，请稍后重试。" });
            res.end();
          }
        },
      },
    );
  } catch (_err) {
    if (!runCompleted) {
      runCompleted = true;
      writeSSE(res, "error", { message: "Agent 执行出错，请稍后重试。" });
      res.end();
    }
  } finally {
    unsubscribe();
    ctx.sessionStore.clearAbortController(runState.runId);
    ctx.sessionStore.delete(runState.runId);
  }
}

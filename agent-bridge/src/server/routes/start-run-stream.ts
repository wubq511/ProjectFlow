/**
 * POST /runs/stream — Start a new agent run and stream events via SSE.
 *
 * Same as POST /runs but returns an SSE stream instead of JSON.
 * The SSE stream stays open until the run completes, fails, or is cancelled.
 *
 * SSE event types emitted:
 * - `status`  — phase/module/message for UI step indicator
 * - `content` — typed StreamContentEvent (thinking/text × start/delta/end + contentIndex)
 * - `done`    — final_content, thinking_content, execution_steps
 * - `error`   — error message
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
import type { StreamContentEvent } from "@/types/stream-content.js";

/** Write a single SSE event to the response. */
function writeSSE(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Tool name → Chinese label mapping for execution steps. */
const TOOL_LABELS: Record<string, string> = {
  get_project_state: "获取项目状态",
  get_workspace_state: "获取工作区状态",
  generate_stage_plan_proposal: "生成阶段规划",
  generate_task_breakdown_proposal: "生成任务分解",
  recommend_assignment: "推荐分工方案",
  generate_replan_proposal: "生成调整方案",
  analyze_checkins_and_risks: "分析进展与风险",
  generate_direction_card_proposal: "生成方向卡",
  create_risk: "创建风险记录",
  create_checkin: "创建进展记录",
};

/** Unknown tool fallback — never return raw tool name to frontend. */
const UNKNOWN_TOOL_LABEL = "执行项目操作";

/** Exported for testing — maps tool name to Chinese label. */
export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? UNKNOWN_TOOL_LABEL;
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
 * Build the `done` event payload: final_content, thinking_content, execution_steps.
 *
 * thinking_content is aggregated from all thinking block deltas.
 * final_content prefers the runtime's final_content (from last assistant message TextContent),
 * falls back to aggregated text block deltas, then to accumulatedContent.
 */
export function buildDonePayload(
  runId: string,
  finalAnswerFromRuntime: string,
  thinkingBlocks: Map<string, string>,
  textBlocks: Map<string, string>,
  accumulatedContent: string,
  executionSteps: Array<{ tool_name: string; tool_call_id?: string; status: string; label: string }>,
  metrics?: { latency_ms: number; input_tokens: number; output_tokens: number; reasoning_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; total_cost?: number },
): Record<string, unknown> {
  // Aggregate thinking from all blocks (ordered by composite key: message_seq:contentIndex)
  const thinkingContent = Array.from(thinkingBlocks.entries())
    .sort(([a], [b]) => compareCompositeKeys(a, b))
    .map(([, content]) => content)
    .join("");

  // Aggregate text from all blocks (ordered by composite key)
  const textContent = Array.from(textBlocks.entries())
    .sort(([a], [b]) => compareCompositeKeys(a, b))
    .map(([, content]) => content)
    .join("");

  let finalAnswer: string;
  if (finalAnswerFromRuntime) {
    finalAnswer = finalAnswerFromRuntime;
  } else if (textContent) {
    finalAnswer = textContent;
  } else {
    finalAnswer = accumulatedContent;
  }

  return {
    run_id: runId,
    status: "completed",
    final_content: finalAnswer,
    ...(thinkingContent ? { thinking_content: thinkingContent } : {}),
    execution_steps: executionSteps.length > 0 ? executionSteps : undefined,
    ...(metrics ? { metrics } : {}),
  };
}

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

  // Emit process_started
  const streamStartedAt = Date.now();
  let streamSequence = 0;
  let activitySeq = 0;
  const activities: any[] = [];
  let hasSentProcessCompleted = false;
  let processCompletedAt: string | undefined = undefined;
  let processingDurationMs = 0;

  writeSSE(res, "process_started", {
    stream_sequence: ++streamSequence,
    started_at: new Date(streamStartedAt).toISOString(),
  });

  // Emit preflight loaded skills as SkillActivity
  for (const skill of allSkillContexts) {
    const labelMap: Record<string, string> = {
      "project-intake": "项目澄清",
      "project-planning": "阶段规划",
      "task-breakdown": "任务拆解",
      "assignment-planning": "分工推荐",
      "project-status": "主动推进",
      "risk-analysis": "风险分析",
      "risk-replan": "计划调整",
    };
    const skillNameCn = labelMap[skill.name] ?? skill.name;
    const skillActivity = {
      id: `skill-${skill.name}`,
      sequence: ++activitySeq,
      created_at: new Date(streamStartedAt).toISOString(),
      kind: "skill",
      skill_name: skill.name,
      status: "loaded",
      label: `已读取${skillNameCn}技能`,
      started_at: new Date(streamStartedAt).toISOString(),
      completed_at: new Date(streamStartedAt).toISOString(),
      duration_ms: 0,
    };
    activities.push(skillActivity);
    writeSSE(res, "activity", {
      stream_sequence: ++streamSequence,
      data: skillActivity,
    });
  }

  // Step 4: Subscribe to EventStream and forward as SSE
  let runCompleted = false;
  /** Accumulated content from text_delta only (for final_content fallback). */
  let accumulatedContent = "";
  /** Final answer text extracted from the last assistant message at agent_end. */
  let finalAnswerFromRuntime = "";
  /**
   * Assistant message sequence counter. Incremented on each `message_start` event.
   * Used to form composite block keys: `${messageSeq}:${contentIndex}`.
   * This prevents contentIndex collision across assistant messages (Pi scopes
   * contentIndex per message, so after a tool call a new message may restart from 0).
   */
  let messageSeq = 0;
  /**
   * Thinking block content aggregated by composite key.
   * Key = `${messageSeq}:${contentIndex}`, Value = concatenated delta content.
   */
  const thinkingBlocks = new Map<string, string>();
  /**
   * Text block content aggregated by composite key.
   * Key = `${messageSeq}:${contentIndex}`, Value = concatenated delta content.
   */
  const textBlocks = new Map<string, string>();
  /** Bounded execution steps collected from tool lifecycle events. */
  const executionSteps: Array<{ tool_name: string; tool_call_id?: string; status: string; label: string }> = [];
  const outputSanitizer = createOutputSanitizer(wireRequest.workspace_state);
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalCost = 0;
  // Track whether the provider actually supplied each optional metric.
  // This distinguishes "provider reported 0" from "provider did not report at all".
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
    // Only include optional fields when the provider actually supplied them.
    // Provider-unknown must remain absent, not synthetic zero.
    if (observedReasoning) metrics.reasoning_tokens = reasoningTokens;
    if (observedCacheRead) metrics.cache_read_tokens = cacheReadTokens;
    if (observedCacheWrite) metrics.cache_write_tokens = cacheWriteTokens;
    if (observedCost) metrics.total_cost = totalCost;
    return metrics as { latency_ms: number; input_tokens: number; output_tokens: number; reasoning_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; total_cost?: number };
  };

  const emitSanitizedText = (content: string, contentIndex: number): void => {
    if (!content) return;
    const blockKey = `${messageSeq}:${contentIndex}`;
    accumulatedContent += content;
    textBlocks.set(blockKey, (textBlocks.get(blockKey) ?? "") + content);
    writeSSE(res, "content", {
      kind: "text",
      phase: "delta",
      content_index: contentIndex,
      message_seq: messageSeq,
      content,
    } satisfies StreamContentEvent);
  };

  const flushSanitizedTail = (contentIndex = 0): void => {
    const tail = outputSanitizer.flush();
    emitSanitizedText(tail, contentIndex);
    if (tail) {
      writeSSE(res, "answer_delta", {
        stream_sequence: ++streamSequence,
        content: tail,
      });
    }
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
    // Only forward events for this run
    const data = message.data as RuntimeEvent;
    if (data.runId && data.runId !== runState.runId) return;

    const eventType = message.event as StreamEventType;

    switch (eventType) {
      case "run.started":
      case "agent.started":
        writeSSE(res, "status", { phase: "planning", message: "正在理解你的需求..." });
        break;
      case "agent.delta": {
        // Typed streaming contract: emit `content` SSE events with kind/phase/contentIndex/message_seq.
        // The event-mapper now provides delta_type, content_index for all content block types.
        const deltaType = data.payload?.delta_type as string | undefined;
        const contentIndex = typeof data.payload?.content_index === "number"
          ? data.payload.content_index as number
          : 0;
        const tokenText = typeof data.payload?.content === "string" ? data.payload.content as string : "";
        const blockKey = `${messageSeq}:${contentIndex}`;

        if (!deltaType) break;

        // Map delta_type to StreamContentEvent kind + phase
        if (deltaType === "thinking_start") {
          const evt: StreamContentEvent = { kind: "thinking", phase: "start", content_index: contentIndex, message_seq: messageSeq };
          writeSSE(res, "content", evt);
        } else if (deltaType === "thinking_delta") {
          if (tokenText) {
            // Aggregate for thinking_content at completion
            const existing = thinkingBlocks.get(blockKey) ?? "";
            thinkingBlocks.set(blockKey, existing + tokenText);
            const evt: StreamContentEvent = { kind: "thinking", phase: "delta", content_index: contentIndex, message_seq: messageSeq, content: tokenText };
            writeSSE(res, "content", evt);
          }
        } else if (deltaType === "thinking_end") {
          const evt: StreamContentEvent = { kind: "thinking", phase: "end", content_index: contentIndex, message_seq: messageSeq };
          writeSSE(res, "content", evt);
        } else if (deltaType === "text_start") {
          const evt: StreamContentEvent = { kind: "text", phase: "start", content_index: contentIndex, message_seq: messageSeq };
          writeSSE(res, "content", evt);
          if (!hasSentProcessCompleted) {
            processCompletedAt = new Date().toISOString();
            processingDurationMs = Date.now() - streamStartedAt;
            writeSSE(res, "process_completed", {
              stream_sequence: ++streamSequence,
              completed_at: processCompletedAt,
              processing_duration_ms: processingDurationMs,
            });
            writeSSE(res, "answer_started", {
              stream_sequence: ++streamSequence,
              started_at: processCompletedAt,
            });
            hasSentProcessCompleted = true;
          }
        } else if (deltaType === "text_delta") {
          if (tokenText) {
            const safeText = outputSanitizer.push(tokenText);
            emitSanitizedText(safeText, contentIndex);
            if (!hasSentProcessCompleted) {
              processCompletedAt = new Date().toISOString();
              processingDurationMs = Date.now() - streamStartedAt;
              writeSSE(res, "process_completed", {
                stream_sequence: ++streamSequence,
                completed_at: processCompletedAt,
                processing_duration_ms: processingDurationMs,
              });
              writeSSE(res, "answer_started", {
                stream_sequence: ++streamSequence,
                started_at: processCompletedAt,
              });
              hasSentProcessCompleted = true;
            }
            if (safeText) {
              writeSSE(res, "answer_delta", {
                stream_sequence: ++streamSequence,
                content: safeText,
              });
            }
          }
        } else if (deltaType === "text_end") {
          flushSanitizedTail(contentIndex);
          const evt: StreamContentEvent = { kind: "text", phase: "end", content_index: contentIndex, message_seq: messageSeq };
          writeSSE(res, "content", evt);
        }
        break;
      }
      case "agent.status":
        // Internal runtime status is used only for block correlation. Never
        // forward the raw payload because it can contain provider data or IDs.
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
        // Status updates — forward phase info if available
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
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "工具";
          const label = toolLabel(toolName);
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          
          writeSSE(res, "tool", { phase: "started", tool_call_id: toolCallId ?? toolName, tool_name: toolName, label });
          
          const toolActivity = {
            id: toolCallId ?? `tool-${toolName}-${Date.now()}`,
            sequence: ++activitySeq,
            created_at: new Date().toISOString(),
            kind: "tool" as const,
            tool_call_id: toolCallId ?? toolName,
            tool_name: toolName,
            status: "running" as const,
            label: `正在${label}`,
            started_at: new Date().toISOString(),
          };
          activities.push(toolActivity);
          writeSSE(res, "activity", {
            stream_sequence: ++streamSequence,
            data: toolActivity,
          });

          writeSSE(res, "status", {
            phase: "executing",
            message: `正在${label}...`,
          });
          executionSteps.push({ tool_name: toolName, tool_call_id: toolCallId, status: "started", label });
        }
        break;
      case "tool.completed":
        {
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "工具";
          const label = toolLabel(toolName);
          
          writeSSE(res, "tool", { phase: "completed", tool_call_id: toolCallId ?? toolName, tool_name: toolName });
          writeSSE(res, "status", { phase: "generating", message: "正在整理结果..." });
          
          const act = activities.find(a => a.kind === "tool" && a.tool_call_id === (toolCallId ?? toolName));
          if (act) {
            act.status = "completed";
            act.completed_at = new Date().toISOString();
            act.label = `已${label}`;
            if (act.started_at) {
              act.duration_ms = new Date(act.completed_at).getTime() - new Date(act.started_at).getTime();
            }
            writeSSE(res, "activity", {
              stream_sequence: ++streamSequence,
              data: act,
            });
          }

          const step = toolCallId
            ? executionSteps.find((s) => s.tool_call_id === toolCallId && s.status === "started")
            : [...executionSteps].reverse().find((s) => s.tool_name === toolName && s.status === "started");
          if (step) step.status = "completed";
        }
        break;
      case "tool.failed":
        {
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "工具";
          const label = toolLabel(toolName);
          
          writeSSE(res, "tool", { phase: "failed", tool_call_id: toolCallId ?? toolName, tool_name: toolName });
          
          const act = activities.find(a => a.kind === "tool" && a.tool_call_id === (toolCallId ?? toolName));
          if (act) {
            act.status = "failed";
            act.completed_at = new Date().toISOString();
            act.label = `${label}失败`;
            if (act.started_at) {
              act.duration_ms = new Date(act.completed_at).getTime() - new Date(act.started_at).getTime();
            }
            writeSSE(res, "activity", {
              stream_sequence: ++streamSequence,
              data: act,
            });
          }

          const step = toolCallId
            ? executionSteps.find((s) => s.tool_call_id === toolCallId && s.status === "started")
            : [...executionSteps].reverse().find((s) => s.tool_name === toolName && s.status === "started");
          if (step) step.status = "failed";
        }
        break;
      case "tool.blocked":
        {
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "";
          const label = toolLabel(toolName || "工具");
          const eventId = typeof data.payload?.event_id === "string" ? data.payload.event_id : `blocked-${executionSteps.length}`;
          
          writeSSE(res, "tool", {
            phase: "blocked",
            ...(toolCallId ? { tool_call_id: toolCallId } : {}),
            ...(toolName ? { tool_name: toolName } : {}),
            label,
            event_id: eventId,
          });

          const act = activities.find(a => a.kind === "tool" && a.tool_call_id === (toolCallId ?? toolName));
          if (act) {
            act.status = "blocked";
            act.completed_at = new Date().toISOString();
            act.label = `${label}已被阻止`;
            writeSSE(res, "activity", {
              stream_sequence: ++streamSequence,
              data: act,
            });
          } else {
            const blockedActivity = {
              id: eventId,
              sequence: ++activitySeq,
              created_at: new Date().toISOString(),
              kind: "tool" as const,
              tool_call_id: toolCallId,
              tool_name: toolName,
              status: "blocked" as const,
              label: `${label}已被阻止`,
              completed_at: new Date().toISOString(),
            };
            activities.push(blockedActivity);
            writeSSE(res, "activity", {
              stream_sequence: ++streamSequence,
              data: blockedActivity,
            });
          }

          const step = toolCallId
            ? executionSteps.find((s) => s.tool_call_id === toolCallId && s.status === "started")
            : [...executionSteps].reverse().find((s) => s.tool_name === toolName && s.status === "started");
          if (step) {
            step.status = "blocked";
          } else {
            executionSteps.push({
              tool_name: toolName || "工具",
              tool_call_id: toolCallId,
              status: "blocked",
              label,
            });
          }
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
        runCompleted = true;
        flushSanitizedTail();
        finalAnswerFromRuntime = typeof data.payload?.final_content === "string"
          ? outputSanitizer.sanitize(data.payload.final_content)
          : "";
        
        if (!hasSentProcessCompleted) {
          processCompletedAt = new Date().toISOString();
          processingDurationMs = Date.now() - streamStartedAt;
          writeSSE(res, "process_completed", {
            stream_sequence: ++streamSequence,
            completed_at: processCompletedAt,
            processing_duration_ms: processingDurationMs,
          });
          writeSSE(res, "answer_started", {
            stream_sequence: ++streamSequence,
            started_at: processCompletedAt,
          });
          hasSentProcessCompleted = true;
        }

        const donePayload: any = buildDonePayload(
          runState.runId, finalAnswerFromRuntime,
          thinkingBlocks, textBlocks, accumulatedContent, executionSteps,
          currentMetrics(),
        );
        donePayload.memory_evidence = finalMemoryEvidence();
        donePayload.activities = activities;
        donePayload.run_summary = {
          started_at: new Date(streamStartedAt).toISOString(),
          process_completed_at: processCompletedAt,
          completed_at: new Date().toISOString(),
          processing_duration_ms: processingDurationMs,
          duration_ms: Date.now() - streamStartedAt,
          status: "completed",
          activity_count: activities.length,
        };
        
        writeSSE(res, "run_completed", {
          stream_sequence: ++streamSequence,
          completed_at: new Date().toISOString(),
          ...donePayload
        });
        writeSSE(res, "done", donePayload);
        res.end();
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

  // Step 5: Start the runtime loop (skillContext resolved above)
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
          if (!runCompleted) {
            runCompleted = true;
            flushSanitizedTail();
            if (!hasSentProcessCompleted) {
              processCompletedAt = new Date().toISOString();
              processingDurationMs = Date.now() - streamStartedAt;
              writeSSE(res, "process_completed", {
                stream_sequence: ++streamSequence,
                completed_at: processCompletedAt,
                processing_duration_ms: processingDurationMs,
              });
              writeSSE(res, "answer_started", {
                stream_sequence: ++streamSequence,
                started_at: processCompletedAt,
              });
              hasSentProcessCompleted = true;
            }
            const donePayload: any = buildDonePayload(
              state.runId, finalAnswerFromRuntime,
              thinkingBlocks, textBlocks, accumulatedContent, executionSteps,
              currentMetrics(),
            );
            donePayload.memory_evidence = finalMemoryEvidence();
            donePayload.activities = activities;
            donePayload.run_summary = {
              started_at: new Date(streamStartedAt).toISOString(),
              process_completed_at: processCompletedAt,
              completed_at: new Date().toISOString(),
              processing_duration_ms: processingDurationMs,
              duration_ms: Date.now() - streamStartedAt,
              status: "completed",
              activity_count: activities.length,
            };
            writeSSE(res, "run_completed", {
              stream_sequence: ++streamSequence,
              completed_at: new Date().toISOString(),
              ...donePayload
            });
            writeSSE(res, "done", donePayload);
            res.end();
          }
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

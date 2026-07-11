/**
 * POST /runs/stream — Start a new agent run and stream events via SSE.
 *
 * Same as POST /runs but returns an SSE stream instead of JSON.
 * The SSE stream stays open until the run completes, fails, or is cancelled.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parseRunStartRequest } from "@/types/wire.js";
import { createRunState } from "@/types/run-state.js";
import { executeRun } from "@/runtime/pi-runtime.js";
import { createOutputSanitizer } from "@/runtime/output-sanitizer.js";
import type { StreamEventType } from "@/events/stream.js";
import type { RuntimeEvent } from "@/types/runtime-event.js";
import type { RunContext } from "./utils.js";
import { readJsonBody } from "./utils.js";

/** Write a single SSE event to the response. */
function writeSSE(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function handleStartRunStream(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const bodyText = (req as IncomingMessage & { bodyText?: string }).bodyText ?? "";

  const parsed = readJsonBody(res, bodyText, parseRunStartRequest);
  if (!parsed) return;

  // Step 1: Create run record in FastAPI (same as start-run.ts)
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
  const memoryEvidence = {
    mode: parsed.memory_mode ?? "enabled",
    backend: memoryContext?.memoryBackend ?? "none",
    used_memory_ids: memoryContext?.usedMemoryIds ?? [],
    retrieval_count: memoryContext?.retrievalCount ?? 0,
    injected_count: memoryContext?.injectedCount ?? 0,
    latency_ms: memoryContext?.latencyMs ?? 0,
  };

  // Step 2: Create local run state
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

  // Emit initial status
  writeSSE(res, "status", { phase: "planning", message: "正在理解你的需求..." });

  // Step 4: Subscribe to EventStream and forward as SSE
  let runCompleted = false;
  let accumulatedContent = "";
  const outputSanitizer = createOutputSanitizer(parsed.workspace_state);

  const flushSanitizedTail = (): void => {
    const tail = outputSanitizer.flush();
    if (!tail) return;
    accumulatedContent += tail;
    writeSSE(res, "token", { content: tail });
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
      case "agent.delta":
        // Forward model delta tokens — Pi runtime emits "agent.delta" via event-mapper.
        // Do NOT also listen for "model.streaming" — that's the raw Pi SDK event that
        // event-mapper already mapped to "agent.delta". Listening to both would double-count tokens.
        // payload.content may be:
        //   - a plain string
        //   - a Pi structured object {type: "text_delta", delta: "..."}
        //   - an array of ContentPart objects [{type: "text_delta", delta: "..."}, ...]
        {
          let tokenText = "";
          const rawContent = data.payload?.content ?? data.payload?.delta;
          if (typeof rawContent === "string") {
            tokenText = rawContent;
          } else if (Array.isArray(rawContent)) {
            // Pi SDK ContentPart[] — extract text from each part
            for (const part of rawContent) {
              if (part && typeof part === "object") {
                const p = part as Record<string, unknown>;
                if (p.type === "text_delta" && typeof p.delta === "string") {
                  tokenText += p.delta;
                } else if (p.type === "text" && typeof p.text === "string") {
                  tokenText += p.text;
                }
              }
            }
          } else if (rawContent && typeof rawContent === "object") {
            // Pi SDK structured content: extract delta from text_delta events
            const obj = rawContent as Record<string, unknown>;
            tokenText = (typeof obj.delta === "string" ? obj.delta : "") || (typeof obj.text === "string" ? obj.text : "");
          }
          if (tokenText) {
            const safeText = outputSanitizer.push(tokenText);
            if (safeText) {
              accumulatedContent += safeText;
              writeSSE(res, "token", { content: safeText });
            }
          }
        }
        break;
      case "agent.status":
        writeSSE(res, "status", data.payload);
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
        writeSSE(res, "status", {
          phase: "executing",
          module: data.payload?.tool_name ?? "unknown",
          message: `正在执行 ${data.payload?.tool_name ?? "工具"}...`,
        });
        break;
      case "tool.completed":
        writeSSE(res, "status", { phase: "generating", message: "正在整理结果..." });
        break;
      case "tool.failed":
      case "tool.blocked":
        // Tool issues — let the runtime handle them; just log
        break;
      case "tool.progress":
        // Tool progress updates — forward as status for UI feedback
        if (data.payload?.message) {
          writeSSE(res, "status", { phase: "executing", message: String(data.payload.message) });
        }
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
        // Runtime-level errors (budget exceeded, policy violation, etc.)
        const errorMsg = data.payload?.error ?? data.payload?.code ?? data.payload?.reason ?? "运行时错误";
        if (!runCompleted) {
          runCompleted = true;
          writeSSE(res, "error", { message: `运行时错误：${errorMsg}` });
          res.end();
        }
        break;
      }
      case "agent.completed":
      case "run.completed": {
        runCompleted = true;
        flushSanitizedTail();
        const rawFinalContent = data.payload?.final_content ?? data.payload?.content;
        const finalContent =
          typeof rawFinalContent === "string"
            ? outputSanitizer.sanitize(rawFinalContent)
            : accumulatedContent;
        writeSSE(res, "done", {
          run_id: runState.runId,
          status: "completed",
          final_content: finalContent,
          memory_evidence: memoryEvidence,
        });
        res.end();
        break;
      }
      case "agent.failed":
      case "run.failed": {
        runCompleted = true;
        writeSSE(res, "error", {
          message: data.payload?.error ?? data.payload?.reason ?? "Agent 处理失败",
        });
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
        // Forward unknown events as status for debugging
        break;
    }
  });

  // Step 5: Start the runtime loop
  try {
    await executeRun(
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
      ctx.modelRouter,
      ctx.fastapiClient,
      ctx.stream,
      {
        traceIncludeSensitiveData: parsed.runtime_config?.trace_include_sensitive_data ?? ctx.config.traceIncludeSensitiveData,
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
            writeSSE(res, "done", {
              run_id: state.runId,
              status: "completed",
              final_content: accumulatedContent,
              memory_evidence: memoryEvidence,
            });
            res.end();
          }
        },
        onError: (error, state) => {
          ctx.sessionStore.clearAbortController(state.runId);
          if (!runCompleted) {
            runCompleted = true;
            writeSSE(res, "error", { message: error.message });
            res.end();
          }
        },
      },
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!runCompleted) {
      runCompleted = true;
      writeSSE(res, "error", { message: error.message });
      res.end();
    }
  } finally {
    unsubscribe();
    ctx.sessionStore.clearAbortController(runState.runId);
    ctx.sessionStore.delete(runState.runId);
  }
}

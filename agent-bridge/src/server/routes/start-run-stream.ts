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
  /** Final answer text extracted from the last assistant message at agent_end. */
  let finalAnswerFromRuntime = "";
  /** Thinking text separated from answer at completion. */
  let thinkingContent = "";
  /**
   * Ordered content chunks with their delta type.
   * At completion, separated into thinking (before last tool boundary) and answer (after).
   */
  const contentChunks: Array<{ type: "text" | "thinking"; content: string }> = [];
  /** Index in contentChunks of the last chunk before a tool.started event.
   *  Used at completion to separate thinking (before boundary) from answer (after). */
  let lastToolBoundaryIdx = -1;
  /** Bounded execution steps collected from tool lifecycle events. */
  const executionSteps: Array<{ tool_name: string; tool_call_id?: string; status: string; label: string }> = [];

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
        // event-mapper filters: content is from text_delta or thinking_delta.
        // toolcall_delta never reaches here.
        // Both types are streamed to the client for real-time visibility.
        {
          const tokenText = typeof data.payload?.content === "string" ? data.payload.content : "";
          if (tokenText) {
            accumulatedContent += tokenText;
            const deltaType = data.payload?.delta_type;
            contentChunks.push({
              type: deltaType === "thinking_delta" ? "thinking" : "text",
              content: tokenText,
            });
            writeSSE(res, "token", { content: tokenText });
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
        // Record tool boundary: text before this point is thinking, text after is answer
        lastToolBoundaryIdx = contentChunks.length;
        // Collect execution step (started)
        {
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "工具";
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          executionSteps.push({ tool_name: toolName, tool_call_id: toolCallId, status: "started", label: `调用${toolName}` });
        }
        break;
      case "tool.completed":
        writeSSE(res, "status", { phase: "generating", message: "正在整理结果..." });
        // Update matching step to completed (prefer tool_call_id for precision)
        {
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "";
          const step = toolCallId
            ? executionSteps.find((s) => s.tool_call_id === toolCallId && s.status === "started")
            : [...executionSteps].reverse().find((s) => s.tool_name === toolName && s.status === "started");
          if (step) step.status = "completed";
        }
        break;
      case "tool.failed":
        // Update matching step to failed (prefer tool_call_id for precision)
        {
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "";
          const step = toolCallId
            ? executionSteps.find((s) => s.tool_call_id === toolCallId && s.status === "started")
            : [...executionSteps].reverse().find((s) => s.tool_name === toolName && s.status === "started");
          if (step) step.status = "failed";
        }
        break;
      case "tool.blocked":
        // Update matching step to blocked (policy gate rejection, distinct from execution failure)
        {
          const toolCallId = typeof data.payload?.tool_call_id === "string" ? data.payload.tool_call_id : undefined;
          const toolName = typeof data.payload?.tool_name === "string" ? data.payload.tool_name : "";
          const step = toolCallId
            ? executionSteps.find((s) => s.tool_call_id === toolCallId && s.status === "started")
            : [...executionSteps].reverse().find((s) => s.tool_name === toolName && s.status === "started");
          if (step) step.status = "blocked";
        }
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
        // Capture final_content from the runtime (extracted from last assistant message's TextContent).
        // This only contains text_delta, not thinking_delta.
        finalAnswerFromRuntime = typeof data.payload?.final_content === "string"
          ? data.payload.final_content
          : "";
        // Separate thinking from answer using tool boundaries.
        // Text before the last tool.started = thinking/analysis.
        // Text after the last tool.started = final answer.
        const thinkingChunks = lastToolBoundaryIdx >= 0
          ? contentChunks.slice(0, lastToolBoundaryIdx)
          : [];  // No tools = no separation (all text is answer)
        const answerChunks = lastToolBoundaryIdx >= 0
          ? contentChunks.slice(lastToolBoundaryIdx)
          : contentChunks;
        const accumulatedThinking = thinkingChunks.map((c) => c.content).join("");
        const answerText = answerChunks.map((c) => c.content).join("");
        let finalAnswer: string;
        if (finalAnswerFromRuntime) {
          finalAnswer = finalAnswerFromRuntime;
        } else if (answerText) {
          finalAnswer = answerText;
        } else {
          finalAnswer = accumulatedContent;
        }
        thinkingContent = accumulatedThinking;
        writeSSE(res, "done", {
          run_id: runState.runId,
          status: "completed",
          final_content: finalAnswer,
          ...(thinkingContent ? { thinking_content: thinkingContent } : {}),
          execution_steps: executionSteps.length > 0 ? executionSteps : undefined,
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
            const thinkingChunks = lastToolBoundaryIdx >= 0
              ? contentChunks.slice(0, lastToolBoundaryIdx)
              : [];
            const answerChunks = lastToolBoundaryIdx >= 0
              ? contentChunks.slice(lastToolBoundaryIdx)
              : contentChunks;
            const accumulatedThinking = thinkingChunks.map((c) => c.content).join("");
            const answerText = answerChunks.map((c) => c.content).join("");
            let finalAnswer: string;
            if (finalAnswerFromRuntime) {
              finalAnswer = finalAnswerFromRuntime;
            } else if (answerText) {
              finalAnswer = answerText;
            } else {
              finalAnswer = accumulatedContent;
            }
            thinkingContent = accumulatedThinking;
            writeSSE(res, "done", {
              run_id: state.runId,
              status: "completed",
              final_content: finalAnswer,
              ...(thinkingContent ? { thinking_content: thinkingContent } : {}),
              execution_steps: executionSteps.length > 0 ? executionSteps : undefined,
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

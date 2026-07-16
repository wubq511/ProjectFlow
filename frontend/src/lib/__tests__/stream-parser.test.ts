/**
 * Stream parser → reducer connectivity test.
 *
 * Uses the PRODUCTION streamTurnReducer (imported, not copied).
 * Validates that SSE events correctly dispatch to the reducer.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { consumeAgentConversationSSE, type AgentStreamCallbacks } from "../api";
import { streamTurnReducer, createInitialTurn } from "../use-agent-stream-turn";
import type { AgentStreamTurn, StreamContentEvent, StreamToolEvent } from "../types";

// Helper: apply a sequence of StreamContentEvent to the reducer
// This mirrors the dispatchContentEvent logic in useAgentStreamTurn
function applyContentEvents(state: AgentStreamTurn, events: StreamContentEvent[]): AgentStreamTurn {
  let s = state;
  for (const event of events) {
    const seq = event.message_seq ?? 0;
    switch (event.kind) {
      case "thinking":
        switch (event.phase) {
          case "start": s = streamTurnReducer(s, { type: "THINKING_START", contentIndex: event.content_index, messageSeq: seq }); break;
          case "delta": s = streamTurnReducer(s, { type: "THINKING_DELTA", contentIndex: event.content_index, messageSeq: seq, content: event.content }); break;
          case "end": s = streamTurnReducer(s, { type: "THINKING_END", contentIndex: event.content_index, messageSeq: seq }); break;
        }
        break;
      case "text":
        switch (event.phase) {
          case "start": s = streamTurnReducer(s, { type: "TEXT_START", contentIndex: event.content_index, messageSeq: seq }); break;
          case "delta": s = streamTurnReducer(s, { type: "TEXT_DELTA", contentIndex: event.content_index, messageSeq: seq, content: event.content }); break;
          case "end": s = streamTurnReducer(s, { type: "TEXT_END", contentIndex: event.content_index, messageSeq: seq }); break;
        }
        break;
    }
  }
  return s;
}

// Helper: apply a StreamToolEvent to the reducer
// This mirrors the onToolEvent dispatch logic in useAgentConversationStream
function applyToolEvent(state: AgentStreamTurn, event: StreamToolEvent): AgentStreamTurn {
  switch (event.phase) {
    case "started": return streamTurnReducer(state, { type: "TOOL_STARTED", tool_name: event.tool_name, tool_call_id: event.tool_call_id, label: event.label });
    case "completed": return streamTurnReducer(state, { type: "TOOL_COMPLETED", tool_name: event.tool_name, tool_call_id: event.tool_call_id });
    case "failed": return streamTurnReducer(state, { type: "TOOL_FAILED", tool_name: event.tool_name, tool_call_id: event.tool_call_id });
    case "blocked": return streamTurnReducer(state, { type: "TOOL_BLOCKED", tool_name: event.tool_name ?? "工具", tool_call_id: event.tool_call_id, label: event.label });
  }
}

describe("stream parser → reducer connectivity", () => {
  function init(): AgentStreamTurn {
    return streamTurnReducer(createInitialTurn(), { type: "CONNECTING", clientTurnId: "turn-1", userMessage: { id: "u1", conversation_id: "c1", role: "user", content: "hi", structured_payload: {}, created_at: new Date().toISOString() } });
  }

  it("full lifecycle: thinking → tool → thinking → tool → text → done", () => {
    let state = init();

    state = applyContentEvents(state, [
      { kind: "thinking", phase: "start", content_index: 0, message_seq: 1 },
      { kind: "thinking", phase: "delta", content_index: 0, message_seq: 1, content: "分析中..." },
      { kind: "thinking", phase: "end", content_index: 0, message_seq: 1 },
    ]);
    expect(state.status).toBe("thinking");

    state = applyToolEvent(state, { phase: "started", tool_call_id: "tc1", tool_name: "get_project_state", label: "获取项目状态" });
    expect(state.executionSteps).toHaveLength(1);
    expect(state.status).toBe("executing");
    state = applyToolEvent(state, { phase: "completed", tool_call_id: "tc1", tool_name: "get_project_state" });
    expect(state.executionSteps[0].status).toBe("completed");

    state = applyContentEvents(state, [
      { kind: "thinking", phase: "start", content_index: 0, message_seq: 2 },
      { kind: "thinking", phase: "delta", content_index: 0, message_seq: 2, content: "生成规划..." },
      { kind: "thinking", phase: "end", content_index: 0, message_seq: 2 },
    ]);

    state = applyContentEvents(state, [
      { kind: "text", phase: "start", content_index: 1, message_seq: 3 },
      { kind: "text", phase: "delta", content_index: 1, message_seq: 3, content: "已生成提案" },
      { kind: "text", phase: "end", content_index: 1, message_seq: 3 },
    ]);
    // TEXT_START/TEXT_DELTA no longer transition to answering — only ANSWER_STARTED does.
    // Status remains "executing" (from last tool) until ANSWER_STARTED.
    expect(state.status).not.toBe("answering");
    expect(state.thinkingOpen).toBe(false);

    state = streamTurnReducer(state, { type: "DONE", finalContent: "已生成提案", thinkingContent: "分析中...生成规划...", executionSteps: state.executionSteps });
    expect(state.status).toBe("completed");
  });

  it("tool failed event updates execution step", () => {
    let state = init();
    state = applyToolEvent(state, { phase: "started", tool_call_id: "tc-fail", tool_name: "get_project_state", label: "获取项目状态" });
    state = applyToolEvent(state, { phase: "failed", tool_call_id: "tc-fail", tool_name: "get_project_state" });
    expect(state.executionSteps[0].status).toBe("failed");
  });

  it("tool blocked without tool_call_id creates standalone timeline entry", () => {
    let state = init();
    state = applyToolEvent(state, { phase: "blocked", label: "策略拦截", event_id: "ev1" });
    // Should create a standalone blocked step, not just "not crash"
    expect(state.executionSteps).toHaveLength(1);
    expect(state.executionSteps[0].status).toBe("blocked");
    expect(state.executionSteps[0].label).toBe("策略拦截");
  });

  it("tool blocked with tool_call_id updates matching started step", () => {
    let state = init();
    state = applyToolEvent(state, { phase: "started", tool_call_id: "tc1", tool_name: "get_project_state", label: "获取项目状态" });
    state = applyToolEvent(state, { phase: "blocked", tool_call_id: "tc1", tool_name: "get_project_state", label: "策略拦截", event_id: "ev1" });
    expect(state.executionSteps).toHaveLength(1);
    expect(state.executionSteps[0].status).toBe("blocked");
  });

  it("missing start marker: text delta still works", () => {
    let state = init();
    state = applyContentEvents(state, [
      { kind: "text", phase: "delta", content_index: 0, message_seq: 1, content: "直接回答" },
    ]);
    expect(state.blocks["1:0"]).toBeDefined();
    expect(state.blocks["1:0"].kind).toBe("text");
    expect(state.blocks["1:0"].content).toBe("直接回答");
  });

  it("high message_seq (≥10) sorts correctly", () => {
    let state = init();
    state = applyContentEvents(state, [
      { kind: "thinking", phase: "start", content_index: 0, message_seq: 10 },
      { kind: "thinking", phase: "delta", content_index: 0, message_seq: 10, content: "第10轮思考" },
      { kind: "text", phase: "start", content_index: 1, message_seq: 11 },
      { kind: "text", phase: "delta", content_index: 1, message_seq: 11, content: "第11轮回答" },
    ]);
    expect(state.blocks["10:0"].content).toBe("第10轮思考");
    expect(state.blocks["11:1"].content).toBe("第11轮回答");
  });

  it("disconnect event sets disconnected status", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "DISCONNECT" });
    expect(state.status).toBe("disconnected");
    expect(state.error).toBe("连接意外中断，可重试");
  });

  it("consecutive same tool with different tool_call_id", () => {
    let state = init();
    state = applyToolEvent(state, { phase: "started", tool_call_id: "tc-a", tool_name: "get_project_state", label: "获取项目状态" });
    state = applyToolEvent(state, { phase: "completed", tool_call_id: "tc-a", tool_name: "get_project_state" });
    state = applyToolEvent(state, { phase: "started", tool_call_id: "tc-b", tool_name: "get_project_state", label: "获取项目状态" });
    state = applyToolEvent(state, { phase: "completed", tool_call_id: "tc-b", tool_name: "get_project_state" });
    expect(state.executionSteps).toHaveLength(2);
    expect(state.executionSteps[0].status).toBe("completed");
    expect(state.executionSteps[1].status).toBe("completed");
  });

  it("P0: completed turn not passed to sidebar — status check", () => {
    let state = init();
    state = applyContentEvents(state, [
      { kind: "text", phase: "start", content_index: 0, message_seq: 1 },
      { kind: "text", phase: "delta", content_index: 0, message_seq: 1, content: "回答" },
    ]);
    state = streamTurnReducer(state, { type: "DONE", finalContent: "回答", thinkingContent: "", executionSteps: [] });
    expect(state.status).toBe("completed");
    // Sidebar condition: status !== "idle" && status !== "completed" → null
    const shouldPassToSidebar = state.status !== "idle" && state.status !== "completed";
    expect(shouldPassToSidebar).toBe(false);
  });

  it("failed/cancelled/disconnected turn IS passed to sidebar", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "ERROR", message: "失败" });
    expect(state.status !== "idle" && state.status !== "completed").toBe(true);

    state = init();
    state = streamTurnReducer(state, { type: "CANCEL" });
    expect(state.status !== "idle" && state.status !== "completed").toBe(true);

    state = init();
    state = streamTurnReducer(state, { type: "DISCONNECT" });
    expect(state.status !== "idle" && state.status !== "completed").toBe(true);
  });
});

function readerFromSSE(payload: string, splitAt?: number): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = splitAt
    ? [payload.slice(0, splitAt), payload.slice(splitAt)]
    : [payload];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }).getReader();
}

function callbacks(overrides: Partial<AgentStreamCallbacks> = {}): AgentStreamCallbacks {
  return {
    onStatus: vi.fn(),
    onContent: vi.fn(),
    onToolEvent: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onDisconnect: vi.fn(),
    ...overrides,
  };
}

describe("production SSE parser", () => {
  it("consumes the shared cross-layer fixture across arbitrary chunks", async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), "../tests/fixtures/stream-events.json"), "utf8"),
    ) as { events: Array<{ event: string; data: unknown }> };
    const nonTerminalEvents = fixture.events.filter((event) => event.event !== "done");
    const wire = [
      ...nonTerminalEvents,
      { event: "error", data: { message: "Agent 处理失败，请稍后重试。" } },
    ].map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    const cb = callbacks();

    await consumeAgentConversationSSE(readerFromSSE(wire, 37), cb);

    expect(cb.onStatus).toHaveBeenCalled();
    expect(cb.onContent).toHaveBeenCalled();
    expect(cb.onToolEvent).toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledWith("Agent 处理失败，请稍后重试。");
    expect(cb.onDisconnect).not.toHaveBeenCalled();
  });

  it("forces a failed terminal callback when done handling throws", async () => {
    const turn = {
      conversation: { id: "c1", workspace_id: "w1", project_id: "p1", status: "active", summary: "", current_focus: "", messages: [], created_at: "2026-07-12T00:00:00Z", updated_at: "2026-07-12T00:00:00Z" },
      user_message: { id: "u1", conversation_id: "c1", role: "user", content: "你好", structured_payload: {}, created_at: "2026-07-12T00:00:00Z" },
      assistant_message: { id: "a1", conversation_id: "c1", role: "assistant", content: "回答", structured_payload: {}, created_at: "2026-07-12T00:00:01Z" },
      next_suggestions: [], suggestions: [], artifacts: [],
    };
    const cb = callbacks({ onDone: () => { throw new Error("render failed"); } });
    const wire = `event: done\ndata: ${JSON.stringify(turn)}\n\n`;

    await consumeAgentConversationSSE(readerFromSSE(wire), cb);

    expect(cb.onError).toHaveBeenCalledWith("处理完成事件失败，请重试");
    expect(cb.onDisconnect).not.toHaveBeenCalled();
  });

  it("does not suppress failure when the fallback callback also throws", async () => {
    const cb = callbacks({
      onDone: () => { throw new Error("done failed"); },
      onError: () => { throw new Error("error callback failed"); },
    });
    const wire = "event: done\ndata: null\n\n";

    await expect(consumeAgentConversationSSE(readerFromSSE(wire), cb)).rejects.toThrow("处理完成事件失败，请重试");
  });
});

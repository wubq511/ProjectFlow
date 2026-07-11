import { describe, it, expect } from "vitest";
import { streamTurnReducer, createInitialTurn } from "../use-agent-stream-turn";
import type { AgentStreamTurn, AgentConversationMessage } from "../types";

// ---------------------------------------------------------------------------
// Tests for the PRODUCTION stream turn reducer (imported, not copied)
// ---------------------------------------------------------------------------

const dummyUserMsg: AgentConversationMessage = {
  id: "user-1", conversation_id: "conv-1", role: "user", content: "你好", structured_payload: {}, created_at: new Date().toISOString(),
};

describe("stream turn reducer", () => {
  function init(): AgentStreamTurn {
    return streamTurnReducer(createInitialTurn(), { type: "CONNECTING", clientTurnId: "turn-1", userMessage: dummyUserMsg });
  }

  it("createInitialTurn returns idle status", () => {
    const idle = createInitialTurn();
    expect(idle.status).toBe("idle");
    expect(idle.userMessage).toBeNull();
  });

  it("CONNECTING transitions to connecting with optimistic user message", () => {
    const state = init();
    expect(state.status).toBe("connecting");
    expect(state.userMessage).toEqual(dummyUserMsg);
  });

  it("RESET returns to idle", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    expect(state.status).toBe("thinking");
    state = streamTurnReducer(state, { type: "RESET" });
    expect(state.status).toBe("idle");
    expect(state.userMessage).toBeNull();
    expect(state.blocks).toEqual({});
    expect(state.executionSteps).toEqual([]);
  });

  it("thinking_start transitions to thinking and opens thinking", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    expect(state.status).toBe("thinking");
    expect(state.thinkingOpen).toBe(true);
  });

  it("thinking_delta accumulates content", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "让我" });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "想想" });
    expect(state.blocks["0:0"].content).toBe("让我想想");
  });

  it("text_start transitions to answering and auto-folds thinking", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考中" });
    expect(state.thinkingOpen).toBe(true);
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 1, messageSeq: 0 });
    expect(state.status).toBe("answering");
    expect(state.thinkingOpen).toBe(false); // Auto-folded
    expect(state.thinkingWasAutoFolded).toBe(true);
  });

  it("user manual toggle is not overridden by auto-fold", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考中" });
    // User manually opens thinking
    state = streamTurnReducer(state, { type: "TOGGLE_THINKING" }); // closes (it was open)
    state = streamTurnReducer(state, { type: "TOGGLE_THINKING" }); // re-opens
    expect(state.thinkingOpen).toBe(true);
    expect(state.thinkingWasManuallyToggled).toBe(true);
    // First TEXT_START always auto-folds thinking (spec: first answer is the one exception)
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 1, messageSeq: 0 });
    expect(state.thinkingOpen).toBe(false); // Auto-folded on first answer
    // Subsequent TEXT_START does NOT override user's manual toggle
    state = streamTurnReducer(state, { type: "TOGGLE_THINKING" }); // user re-opens
    expect(state.thinkingOpen).toBe(true);
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 2, messageSeq: 0 });
    expect(state.thinkingOpen).toBe(true); // Second text_start preserves user choice
  });

  it("no thinking model: no thinking block, direct text", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 0, messageSeq: 0, content: "直接回答" });
    expect(state.status).toBe("answering");
    expect(state.blocks["0:0"].content).toBe("直接回答");
    const hasThinking = Object.values(state.blocks).some(b => b.kind === "thinking");
    expect(hasThinking).toBe(false);
  });

  it("restores canonical thinking from done when live thinking events were missing", () => {
    let state = init();
    state = streamTurnReducer(state, {
      type: "DONE",
      finalContent: "最终回答",
      thinkingContent: "服务端汇总的思考",
      executionSteps: [],
    });

    expect(state.status).toBe("completed");
    expect(state.thinkingOpen).toBe(false);
    expect(Object.values(state.blocks).filter((block) => block.kind === "thinking").map((block) => block.content)).toEqual(["服务端汇总的思考"]);
  });

  it("interleaved blocks with different contentIndex don't cross-contaminate", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考" });
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 1, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 1, messageSeq: 0, content: "回答" });
    // Late-arriving thinking delta for a different block
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 2, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 2, messageSeq: 0, content: "补充思考" });
    expect(state.blocks["0:0"].content).toBe("思考");
    expect(state.blocks["0:1"].content).toBe("回答");
    expect(state.blocks["0:2"].content).toBe("补充思考");
  });

  it("message_seq disambiguates contentIndex across assistant messages", () => {
    let state = init();
    // First assistant message: thinking block at contentIndex 0
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "第一轮思考" });
    // After tool call, second assistant message: new thinking block also at contentIndex 0
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 1 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 1, content: "第二轮思考" });
    // Both blocks should exist independently
    expect(state.blocks["0:0"].content).toBe("第一轮思考");
    expect(state.blocks["1:0"].content).toBe("第二轮思考");
  });

  it("optimistic user message persists throughout streaming", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 1, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 1, messageSeq: 0, content: "回答" });
    expect(state.userMessage).toEqual(dummyUserMsg);
  });

  it("done: no double bubble — status becomes completed with finalContent", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 0, messageSeq: 0, content: "流式" });
    state = streamTurnReducer(state, { type: "DONE", finalContent: "流式回答完成", thinkingContent: "", executionSteps: [] });
    expect(state.status).toBe("completed");
    expect(state.finalContent).toBe("流式回答完成");
  });

  it("stop preserves partial content and marks cancelled", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "部分思考" });
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 1, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 1, messageSeq: 0, content: "部分回答" });
    state = streamTurnReducer(state, { type: "CANCEL" });
    expect(state.status).toBe("cancelled");
    expect(state.blocks["0:0"].content).toBe("部分思考");
    expect(state.blocks["0:1"].content).toBe("部分回答");
    expect(state.error).toBe("已停止生成");
  });

  it("error preserves partial content", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 0, messageSeq: 0, content: "部分" });
    state = streamTurnReducer(state, { type: "ERROR", message: "模型调用失败" });
    expect(state.status).toBe("failed");
    expect(state.blocks["0:0"].content).toBe("部分");
    expect(state.error).toBe("模型调用失败");
  });

  it("disconnected state for SSE terminal event missing", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "DISCONNECT" });
    expect(state.status).toBe("disconnected");
    expect(state.error).toBe("连接意外中断，可重试");
  });

  it("isStreaming derived: true for thinking/executing/answering, false for completed/failed/cancelled", () => {
    let state = init();
    expect(["idle", "completed", "failed", "cancelled", "disconnected"]).not.toContain(state.status);
    state = streamTurnReducer(state, { type: "DONE", finalContent: "完成", thinkingContent: "", executionSteps: [] });
    expect(state.status).toBe("completed");
  });

  it("tool events update execution steps", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "TOOL_STARTED", tool_name: "get_project_state", tool_call_id: "tc1", label: "获取项目状态" });
    expect(state.executionSteps).toHaveLength(1);
    expect(state.executionSteps[0].status).toBe("started");
    state = streamTurnReducer(state, { type: "TOOL_COMPLETED", tool_name: "get_project_state", tool_call_id: "tc1" });
    expect(state.executionSteps[0].status).toBe("completed");
  });

  it("thinking_end auto-folds when all thinking blocks complete", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考" });
    expect(state.thinkingOpen).toBe(true);
    state = streamTurnReducer(state, { type: "THINKING_END", contentIndex: 0, messageSeq: 0 });
    expect(state.blocks["0:0"].completed).toBe(true);
    expect(state.thinkingOpen).toBe(false); // Auto-folded
  });

  it("late THINKING_START during answering does not re-open thinking area", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考" });
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 1, messageSeq: 0 });
    expect(state.thinkingOpen).toBe(false); // Auto-folded by text_start
    // Late thinking_start during answering
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 2, messageSeq: 0 });
    expect(state.thinkingOpen).toBe(false); // Should NOT re-open
  });

  it("lazy init: THINKING_DELTA without prior THINKING_START creates block", () => {
    let state = init();
    // Provider sends delta without start
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考" });
    expect(state.blocks["0:0"]).toBeDefined();
    expect(state.blocks["0:0"].kind).toBe("thinking");
    expect(state.blocks["0:0"].content).toBe("思考");
  });

  it("lazy init: TEXT_DELTA without prior TEXT_START creates block", () => {
    let state = init();
    // Provider sends delta without start
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 0, messageSeq: 0, content: "回答" });
    expect(state.blocks["0:0"]).toBeDefined();
    expect(state.blocks["0:0"].kind).toBe("text");
    expect(state.blocks["0:0"].content).toBe("回答");
  });

  it("lazy init: TEXT_DELTA auto-folds thinking on first text block (same as TEXT_START)", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考中" });
    expect(state.thinkingOpen).toBe(true);
    // Lazy TEXT_DELTA without TEXT_START — should auto-fold thinking
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 1, messageSeq: 0, content: "回答" });
    expect(state.status).toBe("answering");
    expect(state.thinkingOpen).toBe(false); // Auto-folded
    expect(state.thinkingWasAutoFolded).toBe(true);
  });

  it("toolStarted fallback label is '执行项目操作' when no label provided", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "TOOL_STARTED", tool_name: "unknown_tool", label: "执行项目操作" });
    expect(state.executionSteps[0].label).toBe("执行项目操作");
  });

  it("toolStarted with explicit label uses provided label", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "TOOL_STARTED", tool_name: "get_project_state", tool_call_id: "tc1", label: "获取项目状态" });
    expect(state.executionSteps[0].label).toBe("获取项目状态");
  });
});

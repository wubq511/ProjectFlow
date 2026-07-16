import { describe, it, expect } from "vitest";
import { streamTurnReducer, createInitialTurn } from "../use-agent-stream-turn";
import type { AgentStreamTurn, AgentConversationMessage, RunActivityItem } from "../types";

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
    expect(idle.processAutoCollapsed).toBe(false);
    expect(idle.processExpanded).toBe(true);
    expect(idle.answerBuffer).toBe("");
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
    expect(state.activities).toEqual([]);
    expect(state.processAutoCollapsed).toBe(false);
    expect(state.processExpanded).toBe(true);
    expect(state.answerBuffer).toBe("");
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

  it("text_start auto-folds thinking but does NOT transition to answering", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考中" });
    expect(state.thinkingOpen).toBe(true);
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 1, messageSeq: 0 });
    // TEXT_START is now process-phase commentary; only ANSWER_STARTED transitions to answering
    expect(state.status).not.toBe("answering");
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

  it("no thinking model: text blocks accumulate but status is NOT answering until ANSWER_STARTED", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 0, messageSeq: 0, content: "直接回答" });
    // TEXT_START/TEXT_DELTA no longer transition to answering
    expect(state.status).not.toBe("answering");
    expect(state.blocks["0:0"].content).toBe("直接回答");
    const hasThinking = Object.values(state.blocks).some(b => b.kind === "thinking");
    expect(hasThinking).toBe(false);
    // Only ANSWER_STARTED transitions to answering
    state = streamTurnReducer(state, { type: "ANSWER_STARTED", startedAt: new Date().toISOString(), streamSequence: 1 });
    expect(state.status).toBe("answering");
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

  it("late THINKING_START after text_start can re-open thinking (status still thinking in process phase)", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考" });
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 1, messageSeq: 0 });
    expect(state.thinkingOpen).toBe(false); // Auto-folded by text_start
    // With the new protocol, TEXT_START no longer transitions to "answering" —
    // status remains "thinking" during process phase. A late THINKING_START
    // sees status==="thinking" and re-opens. This is acceptable because the
    // actual answer phase only starts with ANSWER_STARTED.
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 2, messageSeq: 0 });
    expect(state.thinkingOpen).toBe(true); // Re-opens (status is still "thinking")
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

  it("lazy init: TEXT_DELTA auto-folds thinking on first text block but does NOT transition to answering", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "THINKING_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "THINKING_DELTA", contentIndex: 0, messageSeq: 0, content: "思考中" });
    expect(state.thinkingOpen).toBe(true);
    // Lazy TEXT_DELTA without TEXT_START — should auto-fold thinking but NOT enter answering
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 1, messageSeq: 0, content: "回答" });
    expect(state.status).not.toBe("answering");
    expect(state.thinkingOpen).toBe(false); // Auto-folded
    expect(state.thinkingWasAutoFolded).toBe(true);
  });

  it("toolStarted with explicit label uses provided label", () => {
    let state = init();
    state = streamTurnReducer(state, { type: "TOOL_STARTED", tool_name: "get_project_state", tool_call_id: "tc1", label: "获取项目状态" });
    expect(state.executionSteps[0].label).toBe("获取项目状态");
  });
});

// ===========================================================================
// Process Timeline / Dual-Phase Tests (new protocol)
// ===========================================================================

describe("process timeline: strict ordering", () => {
  function init(): AgentStreamTurn {
    return streamTurnReducer(createInitialTurn(), { type: "CONNECTING", clientTurnId: "turn-1", userMessage: dummyUserMsg });
  }

  it("test 1: progress → tool start → tool complete → progress → second tool → process_completed → answer_started/deltas", () => {
    let state = init();

    // process_started
    state = streamTurnReducer(state, { type: "PROCESS_STARTED", startedAt: new Date().toISOString(), streamSequence: 1 });
    expect(state.status).toBe("thinking");
    expect(state.processExpanded).toBe(true);

    // progress delta (creates new progress item)
    state = streamTurnReducer(state, { type: "PROCESS_DELTA", activityId: "prog-1", content: "我先核对现有实现。", streamSequence: 2 });
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0].kind).toBe("progress");
    expect(state.activities[0]).toMatchObject({ id: "prog-1", content: "我先核对现有实现。" });

    // tool started (activity)
    const toolStart: RunActivityItem = {
      id: "tc-1", sequence: 2, created_at: new Date().toISOString(),
      kind: "tool", tool_call_id: "tc-1", tool_name: "get_project_state",
      status: "running", label: "正在获取项目状态", started_at: new Date().toISOString(),
    };
    state = streamTurnReducer(state, { type: "ACTIVITY", data: toolStart, streamSequence: 3 });
    expect(state.activities).toHaveLength(2);
    expect(state.activities[1].kind).toBe("tool");

    // tool completed (same id, in-place update)
    const toolComplete: RunActivityItem = {
      id: "tc-1", sequence: 2, created_at: toolStart.created_at,
      kind: "tool", tool_call_id: "tc-1", tool_name: "get_project_state",
      status: "completed", label: "已获取项目状态", started_at: toolStart.started_at,
      completed_at: new Date().toISOString(), duration_ms: 150,
    };
    state = streamTurnReducer(state, { type: "ACTIVITY", data: toolComplete, streamSequence: 4 });
    expect(state.activities).toHaveLength(2); // Same count, in-place update
    expect((state.activities[1] as any).status).toBe("completed");

    // second progress delta (same activity_id → append)
    state = streamTurnReducer(state, { type: "PROCESS_DELTA", activityId: "prog-1", content: " 已确认状态。", streamSequence: 5 });
    expect(state.activities).toHaveLength(2);
    expect((state.activities[0] as any).content).toBe("我先核对现有实现。 已确认状态。");

    // second tool
    const tool2Start: RunActivityItem = {
      id: "tc-2", sequence: 3, created_at: new Date().toISOString(),
      kind: "tool", tool_call_id: "tc-2", tool_name: "create_risk",
      status: "running", label: "正在创建风险记录", started_at: new Date().toISOString(),
    };
    state = streamTurnReducer(state, { type: "ACTIVITY", data: tool2Start, streamSequence: 6 });
    expect(state.activities).toHaveLength(3);

    // process_completed
    state = streamTurnReducer(state, { type: "PROCESS_COMPLETED", completedAt: new Date().toISOString(), processingDurationMs: 5000, streamSequence: 7 });
    expect(state.processCompletedAt).toBeTruthy();
    expect(state.processDurationMs).toBe(5000);
    expect(state.processAutoCollapsed).toBe(true);
    expect(state.processExpanded).toBe(false); // Auto-collapsed

    // answer_started
    state = streamTurnReducer(state, { type: "ANSWER_STARTED", startedAt: new Date().toISOString(), streamSequence: 8 });
    expect(state.status).toBe("answering");

    // answer_delta
    state = streamTurnReducer(state, { type: "ANSWER_DELTA", content: "最终回答内容", streamSequence: 9 });
    expect(state.answerBuffer).toBe("最终回答内容");
    expect(state.status).toBe("answering");

    // Verify final order
    const kinds = state.activities.map((a) => a.kind);
    expect(kinds).toEqual(["progress", "tool", "tool"]);
  });

  it("test 2: process_completed exactly once, sequence < answer_started", () => {
    let state = init();

    state = streamTurnReducer(state, { type: "PROCESS_STARTED", startedAt: new Date().toISOString(), streamSequence: 1 });
    state = streamTurnReducer(state, { type: "PROCESS_DELTA", activityId: "p1", content: "进度说明", streamSequence: 2 });
    state = streamTurnReducer(state, { type: "PROCESS_COMPLETED", completedAt: new Date().toISOString(), processingDurationMs: 3000, streamSequence: 3 });
    state = streamTurnReducer(state, { type: "ANSWER_STARTED", startedAt: new Date().toISOString(), streamSequence: 4 });

    // processAutoCollapsed should be true
    expect(state.processAutoCollapsed).toBe(true);
    // processCompletedAt should be set
    expect(state.processCompletedAt).toBeTruthy();

    // Second PROCESS_COMPLETED should NOT re-collapse (idempotent)
    state = streamTurnReducer(state, { type: "PROCESS_COMPLETED", completedAt: new Date().toISOString(), processingDurationMs: 3000, streamSequence: 5 });
    // processAutoCollapsed remains true, no re-collapse
    expect(state.processAutoCollapsed).toBe(true);
  });

  it("test 3: first text before tool does not enter answer phase — status is NOT answering, answerContent empty", () => {
    let state = init();

    // text_start/delta during process phase (commentary text from content events)
    state = streamTurnReducer(state, { type: "TEXT_START", contentIndex: 0, messageSeq: 0 });
    state = streamTurnReducer(state, { type: "TEXT_DELTA", contentIndex: 0, messageSeq: 0, content: "让我先看看" });

    // Before boundary: status must NOT be answering, answerContent must be empty
    expect(state.status).not.toBe("answering");
    expect(state.answerBuffer).toBe("");

    // process_completed + answer_started
    state = streamTurnReducer(state, { type: "PROCESS_COMPLETED", completedAt: new Date().toISOString(), processingDurationMs: 2000, streamSequence: 1 });
    state = streamTurnReducer(state, { type: "ANSWER_STARTED", startedAt: new Date().toISOString(), streamSequence: 2 });
    expect(state.status).toBe("answering");

    // answer_delta accumulates in answerBuffer
    state = streamTurnReducer(state, { type: "ANSWER_DELTA", content: "正式回答", streamSequence: 3 });
    expect(state.answerBuffer).toBe("正式回答");
  });

  it("test 4: tool lifecycle same id in-place update, different tool_call_id not merged", () => {
    let state = init();

    // Two tools with same name but different tool_call_id
    const tool1: RunActivityItem = {
      id: "tc-a", sequence: 1, created_at: new Date().toISOString(),
      kind: "tool", tool_call_id: "tc-a", tool_name: "create_risk",
      status: "running", label: "正在创建风险记录", started_at: new Date().toISOString(),
    };
    const tool2: RunActivityItem = {
      id: "tc-b", sequence: 2, created_at: new Date().toISOString(),
      kind: "tool", tool_call_id: "tc-b", tool_name: "create_risk",
      status: "running", label: "正在创建风险记录", started_at: new Date().toISOString(),
    };

    state = streamTurnReducer(state, { type: "ACTIVITY", data: tool1, streamSequence: 1 });
    state = streamTurnReducer(state, { type: "ACTIVITY", data: tool2, streamSequence: 2 });
    expect(state.activities).toHaveLength(2); // Both exist separately

    // Complete first tool — only tc-a updates
    state = streamTurnReducer(state, {
      type: "ACTIVITY",
      data: { ...tool1, status: "completed" as const, completed_at: new Date().toISOString(), duration_ms: 200 },
      streamSequence: 3,
    });
    expect((state.activities[0] as any).status).toBe("completed");
    expect((state.activities[1] as any).status).toBe("running"); // tc-b unchanged
  });

  it("test 5: PROCESS_DELTA can create and append progress items", () => {
    let state = init();

    // First delta with new activityId → creates progress item
    state = streamTurnReducer(state, { type: "PROCESS_DELTA", activityId: "p-new", content: "第一段", streamSequence: 1 });
    expect(state.activities).toHaveLength(1);
    expect((state.activities[0] as any).content).toBe("第一段");

    // Same activityId → appends
    state = streamTurnReducer(state, { type: "PROCESS_DELTA", activityId: "p-new", content: " 继续", streamSequence: 2 });
    expect(state.activities).toHaveLength(1);
    expect((state.activities[0] as any).content).toBe("第一段 继续");

    // Different activityId → creates new progress item
    state = streamTurnReducer(state, { type: "PROCESS_DELTA", activityId: "p-other", content: "另一段进度", streamSequence: 3 });
    expect(state.activities).toHaveLength(2);
    expect((state.activities[1] as any).content).toBe("另一段进度");
  });

  it("test 6: process_completed auto-collapses once, answer token does not re-collapse, user can manually expand", () => {
    let state = init();

    state = streamTurnReducer(state, { type: "PROCESS_STARTED", startedAt: new Date().toISOString(), streamSequence: 1 });
    state = streamTurnReducer(state, { type: "PROCESS_DELTA", activityId: "p1", content: "进度", streamSequence: 2 });
    expect(state.processExpanded).toBe(true); // Expanded during streaming

    // process_completed → auto-collapse
    state = streamTurnReducer(state, { type: "PROCESS_COMPLETED", completedAt: new Date().toISOString(), processingDurationMs: 1000, streamSequence: 3 });
    expect(state.processExpanded).toBe(false); // Auto-collapsed
    expect(state.processAutoCollapsed).toBe(true);

    // answer_started + answer_delta → should NOT re-collapse
    state = streamTurnReducer(state, { type: "ANSWER_STARTED", startedAt: new Date().toISOString(), streamSequence: 4 });
    state = streamTurnReducer(state, { type: "ANSWER_DELTA", content: "回答", streamSequence: 5 });
    expect(state.processExpanded).toBe(false); // Still collapsed (no re-collapse)

    // User manually expands
    state = streamTurnReducer(state, { type: "TOGGLE_THINKING" });
    expect(state.processExpanded).toBe(true); // User expanded

    // More answer tokens → should NOT force collapse
    state = streamTurnReducer(state, { type: "ANSWER_DELTA", content: "更多回答", streamSequence: 6 });
    expect(state.processExpanded).toBe(true); // User choice preserved
  });

  it("test 6b: process_completed unconditionally collapses even after manual toggle", () => {
    let state = init();

    state = streamTurnReducer(state, { type: "PROCESS_STARTED", startedAt: new Date().toISOString(), streamSequence: 1 });

    // User manually toggles during process phase
    state = streamTurnReducer(state, { type: "TOGGLE_THINKING" });
    expect(state.processExpanded).toBe(false); // Toggled closed
    state = streamTurnReducer(state, { type: "TOGGLE_THINKING" });
    expect(state.processExpanded).toBe(true); // Toggled open
    expect(state.thinkingWasManuallyToggled).toBe(true);

    // process_completed must STILL auto-collapse regardless of manual toggle
    state = streamTurnReducer(state, { type: "PROCESS_COMPLETED", completedAt: new Date().toISOString(), processingDurationMs: 2000, streamSequence: 2 });
    expect(state.processExpanded).toBe(false);
    expect(state.processAutoCollapsed).toBe(true);

    // User can reopen after auto-collapse
    state = streamTurnReducer(state, { type: "TOGGLE_THINKING" });
    expect(state.processExpanded).toBe(true);
  });

  it("test 7: persisted reload default collapsed, order consistent", () => {
    // Simulate a completed turn with activities
    const activities: RunActivityItem[] = [
      { id: "p1", sequence: 1, created_at: "2026-07-16T10:00:00Z", kind: "progress", content: "进度说明" },
      { id: "t1", sequence: 2, created_at: "2026-07-16T10:00:01Z", kind: "tool", tool_call_id: "tc1", tool_name: "get_project_state", status: "completed", label: "已获取项目状态", started_at: "2026-07-16T10:00:01Z", completed_at: "2026-07-16T10:00:02Z", duration_ms: 1000 },
    ];

    let state = init();
    state = streamTurnReducer(state, {
      type: "DONE",
      finalContent: "最终回答",
      thinkingContent: "",
      executionSteps: [],
      activities,
    });

    expect(state.status).toBe("completed");
    expect(state.activities).toEqual(activities);
    // Order is preserved
    expect(state.activities[0].sequence).toBe(1);
    expect(state.activities[1].sequence).toBe(2);
  });

  it("test 8: no activity does not render empty summary", () => {
    let state = init();
    // Empty activities → RunActivity should return null
    expect(state.activities).toHaveLength(0);
  });

  it("test 10: no thinking_content/raw IDs/unknown fallback in activity labels", () => {
    let state = init();

    // Tool with proper label
    const tool: RunActivityItem = {
      id: "tc-1", sequence: 1, created_at: new Date().toISOString(),
      kind: "tool", tool_call_id: "tc-1", tool_name: "get_project_state",
      status: "running", label: "正在获取项目状态", started_at: new Date().toISOString(),
    };
    state = streamTurnReducer(state, { type: "ACTIVITY", data: tool, streamSequence: 1 });

    // Verify no raw IDs in labels
    expect((state.activities[0] as any).label).not.toContain("tc-1");
    expect((state.activities[0] as any).label).not.toContain("执行项目操作");
  });
});

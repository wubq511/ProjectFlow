import { describe, it, expect } from "vitest";
import { buildRuntimeEventFromPiEvent, mapPiEvent, shouldPersistPiEvent } from "../../src/events/event-mapper.js";
import type { PiEvent } from "../../src/events/event-mapper.js";
import { createRunState } from "../../src/types/run-state.js";

describe("event-mapper", () => {
  const runId = "run_123";

  it("keeps high-frequency token/progress deltas out of the durable event log", () => {
    expect(shouldPersistPiEvent({ type: "message_delta" })).toBe(false);
    expect(shouldPersistPiEvent({ type: "message_update" })).toBe(false);
    expect(shouldPersistPiEvent({ type: "tool_execution_update" })).toBe(false);
    expect(shouldPersistPiEvent({ type: "message_end" })).toBe(true);
    expect(shouldPersistPiEvent({ type: "tool_execution_end" })).toBe(true);
  });

  it("maps agent_start to agent.started", () => {
    const piEvent: PiEvent = { type: "agent_start", data: {} };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.started");
    expect(result.newStatus).toBe("context_building");
  });

  it("maps message_delta to agent.delta", () => {
    const piEvent: PiEvent = { type: "message_delta", data: { content: "hello" } };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.delta");
    expect(result.newStatus).toBe("model_streaming");
  });

  it("maps tool_execution_start to tool.started", () => {
    const piEvent: PiEvent = { type: "tool_execution_start", data: { tool_name: "test" } };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("tool.started");
    expect(result.newStatus).toBe("tool_running");
  });

  it("maps successful tool_execution_end to tool.completed", () => {
    const piEvent: PiEvent = { type: "tool_execution_end", data: {} };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("tool.completed");
    expect(result.newStatus).toBe("persisting_tool_result");
  });

  it("maps failed tool_execution_end to tool.failed", () => {
    const piEvent: PiEvent = {
      type: "tool_execution_end",
      data: {},
      error: { code: "TIMEOUT", message: "Tool timed out" },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("tool.failed");
    expect(result.payload.error).toEqual({ code: "TIMEOUT", message: "Tool timed out" });
  });

  it("maps agent_end to agent.output_captured (deferred terminal)", () => {
    const piEvent: PiEvent = { type: "agent_end", data: {} };
    const result = mapPiEvent(piEvent, runId);
    // agent_end no longer determines terminal status — that's done post-verifier
    expect(result.type).toBe("agent.output_captured");
    expect(result.newStatus).toBeUndefined();
    expect(result.payload.stop_reason).toBe("unknown");
  });

  it("maps agent_end with error to agent.output_captured with error info", () => {
    const piEvent: PiEvent = {
      type: "agent_end",
      data: {},
      error: { code: "RUNTIME_ERROR", message: "Agent execution failed" },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.output_captured");
    expect(result.payload.error).toEqual({ code: "RUNTIME_ERROR", message: "Agent execution failed" });
  });

  it("maps agent_end with isError to agent.output_captured with is_error flag", () => {
    const piEvent: PiEvent = {
      type: "agent_end",
      data: {},
      isError: true,
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.output_captured");
    expect(result.payload.is_error).toBe(true);
  });

  it("maps agent_end with stopReason=error to agent.output_captured", () => {
    const piEvent: PiEvent = {
      type: "agent_end",
      data: {},
      messages: [{ role: "assistant", stopReason: "error" } as unknown],
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.output_captured");
    expect(result.payload.stop_reason).toBe("error");
  });

  it("maps agent_end with stopReason=aborted to agent.output_captured", () => {
    const piEvent: PiEvent = {
      type: "agent_end",
      data: {},
      messages: [{ role: "assistant", stopReason: "aborted" } as unknown],
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.output_captured");
    expect(result.payload.stop_reason).toBe("aborted");
  });

  it("maps agent_end with stopReason=stop to agent.output_captured", () => {
    const piEvent: PiEvent = {
      type: "agent_end",
      data: {},
      messages: [{ role: "assistant", stopReason: "stop" } as unknown],
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.output_captured");
    expect(result.payload.stop_reason).toBe("stop");
  });

  it("maps policy_block to tool.blocked", () => {
    const piEvent: PiEvent = { type: "policy_block", data: { reason: "策略拒绝" } };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("tool.blocked");
  });

  it("maps budget_exceeded to runtime.error", () => {
    const piEvent: PiEvent = {
      type: "budget_exceeded",
      data: { scope: "tool_calls" },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("runtime.error");
    expect(result.payload.code).toBe("BUDGET_EXCEEDED");
    expect(result.newStatus).toBe("failed");
  });

  it("maps proposal_created correctly", () => {
    const piEvent: PiEvent = { type: "proposal_created", data: { proposal_id: "p1" } };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("proposal.created");
    expect(result.payload.proposal_id).toBe("p1");
  });

  it("maps advisory_created correctly", () => {
    const piEvent: PiEvent = { type: "advisory_created", data: { record_id: "r1" } };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("advisory_record.created");
  });

  it("builds a full ProjectFlow runtime event with context and trace", () => {
    const runState = createRunState({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      projectId: "proj_1",
      model: { provider: "mock", name: "mock-model" },
      maxSteps: 8,
      maxToolCalls: 6,
      timeoutMs: 180000,
    });
    runState.runId = runId;
    runState.status = "tool_running";
    runState.currentStep = 3;

    const event = buildRuntimeEventFromPiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "generate_stage_plan_proposal",
        args: { raw_prompt: "不要进入事件 payload" },
      },
      runState,
      { orderingHint: 7 },
    );

    expect(event.type).toBe("tool.started");
    expect(event.runId).toBe(runId);
    expect(event.conversationId).toBe("conv_1");
    expect(event.workspaceId).toBe("ws_1");
    expect(event.projectId).toBe("proj_1");
    expect(event.toolCallId).toBe("call_1");
    expect(event.clientEventId).toBe("run_123:7:tool.started");
    expect(event.orderingHint).toBe(7);
    expect(event.eventSeq).toBe(0);
    expect(event.payload).toMatchObject({
      run_id: runId,
      conversation_id: "conv_1",
      workspace_id: "ws_1",
      project_id: "proj_1",
      tool_call_id: "call_1",
      tool_name: "generate_stage_plan_proposal",
      state_schema_version: 1,
    });
    expect(event.payload).not.toHaveProperty("args");
    expect(event.trace).toMatchObject({
      runId,
      conversationId: "conv_1",
      workspaceId: "ws_1",
      projectId: "proj_1",
      toolCallId: "call_1",
      toolName: "generate_stage_plan_proposal",
      provider: "mock",
      model: "mock-model",
      redacted: true,
      runState: {
        status: "tool_running",
        currentStep: 3,
        stateSchemaVersion: 1,
      },
      budget: {
        maxSteps: 8,
        maxToolCalls: 6,
        timeoutMs: 180000,
      },
    });
  });

  // ── message_end usage/cache telemetry ─────────────────────────────────

  it("message_end preserves all usage fields including reasoning and cache", () => {
    const piEvent: PiEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        usage: {
          input: 200,
          output: 50,
          reasoning: 30,
          cacheRead: 150,
          cacheWrite: 20,
          cost: { total: 0.008, input: 0.005, output: 0.003 },
        },
      },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.status");
    expect(result.payload.phase).toBe("message_end");
    expect(result.payload.usage).toEqual({
      input: 200, output: 50, reasoning: 30, cacheRead: 150, cacheWrite: 20,
    });
    expect(result.payload.cost).toEqual({ total: 0.008, input: 0.005, output: 0.003 });
  });

  it("message_end omits absent cache/reasoning fields (not measured zeros)", () => {
    const piEvent: PiEvent = {
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 20 } },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.payload.usage).toEqual({ input: 100, output: 20 });
    expect(result.payload.usage).not.toHaveProperty("reasoning");
    expect(result.payload.usage).not.toHaveProperty("cacheRead");
    expect(result.payload.usage).not.toHaveProperty("cacheWrite");
    expect(result.payload).not.toHaveProperty("cost");
  });

  it("message_end omits usage when message has no usage", () => {
    const piEvent: PiEvent = {
      type: "message_end",
      message: { role: "assistant" },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.payload).not.toHaveProperty("usage");
    expect(result.payload).not.toHaveProperty("cost");
  });

  it("message_end ignores non-assistant message usage", () => {
    const piEvent: PiEvent = {
      type: "message_end",
      message: { role: "user", usage: { input: 100, output: 50 } },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.payload).not.toHaveProperty("usage");
    expect(result.payload).not.toHaveProperty("cost");
  });

  it("message_end normalizes snake_case token keys from provider", () => {
    const piEvent: PiEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          reasoning_tokens: 30,
          cache_read_tokens: 150,
          cache_write_tokens: 20,
        },
      },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.payload.usage).toEqual({
      input_tokens: 200, output_tokens: 50, reasoning_tokens: 30, cache_read_tokens: 150, cache_write_tokens: 20,
    });
  });

  it("maps real Pi message_update events to agent.delta without raw message payload", () => {
    const runState = createRunState({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      projectId: "proj_1",
      model: { provider: "mock", name: "mock-model" },
      maxSteps: 8,
      maxToolCalls: 6,
      timeoutMs: 180000,
    });
    runState.runId = runId;

    const event = buildRuntimeEventFromPiEvent(
      {
        type: "message_update",
        message: { role: "assistant", content: "raw message" },
        assistantMessageEvent: { type: "delta", delta: "公开增量" },
      },
      runState,
      { orderingHint: 2 },
    );

    expect(event.type).toBe("agent.delta");
    // assistantMessageEvent must NOT be passed as content (causes DB bloat)
    expect(event.payload).not.toHaveProperty("assistantMessageEvent");
    expect(event.payload).not.toHaveProperty("message");
  });

  it("message_update extracts text_delta from assistantMessageEvent", () => {
    const runState = createRunState({
      runId,
      conversationId: "conv_1",
      workspaceId: "ws_1",
      projectId: "proj_1",
      model: { provider: "mock", name: "mock-model" },
      maxSteps: 8,
      maxToolCalls: 6,
      timeoutMs: 180000,
    });
    runState.runId = runId;

    const event = buildRuntimeEventFromPiEvent(
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "这是可见的文本增量", contentIndex: 0 },
      },
      runState,
      { orderingHint: 3 },
    );

    expect(event.type).toBe("agent.delta");
    expect(event.payload.content).toBe("这是可见的文本增量");
    expect(event.payload).not.toHaveProperty("assistantMessageEvent");
  });

  it("message_update extracts thinking_delta from assistantMessageEvent", () => {
    const runState = createRunState({
      runId,
      conversationId: "conv_1",
      workspaceId: "ws_1",
      projectId: "proj_1",
      model: { provider: "mock", name: "mock-model" },
      maxSteps: 8,
      maxToolCalls: 6,
      timeoutMs: 180000,
    });
    runState.runId = runId;

    const event = buildRuntimeEventFromPiEvent(
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "内部推理链", contentIndex: 0 },
      },
      runState,
      { orderingHint: 4 },
    );

    expect(event.type).toBe("agent.delta");
    expect(event.payload.content).toBe("内部推理链");
    expect(event.payload.delta_type).toBe("thinking_delta");
    expect(event.payload).not.toHaveProperty("assistantMessageEvent");
  });

  it("message_update discards toolcall_delta from assistantMessageEvent", () => {
    const runState = createRunState({
      runId,
      conversationId: "conv_1",
      workspaceId: "ws_1",
      projectId: "proj_1",
      model: { provider: "mock", name: "mock-model" },
      maxSteps: 8,
      maxToolCalls: 6,
      timeoutMs: 180000,
    });
    runState.runId = runId;

    const event = buildRuntimeEventFromPiEvent(
      {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", delta: '{"limit": 10}', contentIndex: 0 },
      },
      runState,
      { orderingHint: 5 },
    );

    expect(event.type).toBe("agent.delta");
    expect(event.payload.content).toBeUndefined();
  });

  it("message_update ignores untrusted data.content", () => {
    const runState = createRunState({
      runId,
      conversationId: "conv_1",
      workspaceId: "ws_1",
      projectId: "proj_1",
      model: { provider: "mock", name: "mock-model" },
      maxSteps: 8,
      maxToolCalls: 6,
      timeoutMs: 180000,
    });
    runState.runId = runId;

    const event = buildRuntimeEventFromPiEvent(
      {
        type: "message_update",
        data: { content: "增量文本" },
      },
      runState,
      { orderingHint: 6 },
    );

    expect(event.type).toBe("agent.delta");
    expect(event.payload.content).toBeUndefined();
    expect(event.payload).not.toHaveProperty("assistantMessageEvent");
  });
});

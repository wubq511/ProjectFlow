import { describe, it, expect } from "vitest";
import { buildRuntimeEventFromPiEvent, mapPiEvent } from "../../src/events/event-mapper.js";
import type { PiEvent } from "../../src/events/event-mapper.js";
import { createRunState } from "../../src/types/run-state.js";

describe("event-mapper", () => {
  const runId = "run_123";

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

  it("maps agent_end to agent.completed", () => {
    const piEvent: PiEvent = { type: "agent_end", data: {} };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.completed");
    expect(result.newStatus).toBe("completed");
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
    expect(event.payload).toMatchObject({
      content: { type: "delta", delta: "公开增量" },
    });
    expect(event.payload).not.toHaveProperty("message");
  });
});

/**
 * Regression tests for the conversation output-channel fix.
 *
 * Bug: agent.delta events with toolcall_delta content were accumulated into
 * final_content, polluting persisted AgentMessage.content with raw tool JSON.
 *
 * Fix: Only text_delta contributes visible text. toolcall_start/delta/end never
 * become token events or persisted prose. final_content is extracted from the
 * last assistant message's TextContent at agent_end.
 */
import { describe, it, expect } from "vitest";
import { mapPiEvent, buildRuntimeEventFromPiEvent } from "../../src/events/event-mapper.js";
import type { PiEvent } from "../../src/events/event-mapper.js";
import { createRunState } from "../../src/types/run-state.js";

describe("output-channel fix: event-mapper", () => {
  const runId = "run_output_fix";

  function makeRunState() {
    return createRunState({
      runId,
      conversationId: "conv_1",
      workspaceId: "ws_1",
      projectId: "proj_1",
      model: { provider: "mock", name: "test" },
      maxSteps: 10,
      maxToolCalls: 20,
      timeoutMs: 120000,
    });
  }

  describe("message_update does NOT pass assistantMessageEvent", () => {
    it("does not include assistantMessageEvent in payload", () => {
      const piEvent: PiEvent = {
        type: "message_update",
        data: {},
        assistantMessageEvent: {
          type: "message_delta",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "growing full message that should not be passed" }],
          },
        },
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.type).toBe("agent.delta");
      // assistantMessageEvent must NOT appear in payload
      expect(result.payload).not.toHaveProperty("assistantMessageEvent");
      // content should not be the full assistantMessageEvent object
      expect(typeof result.payload.content !== "object" || result.payload.content === undefined).toBe(true);
    });

    it("extracts text_delta from assistantMessageEvent", () => {
      const piEvent: PiEvent = {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "可见文本增量", contentIndex: 0 },
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.type).toBe("agent.delta");
      expect(result.payload.content).toBe("可见文本增量");
      expect(result.payload).not.toHaveProperty("assistantMessageEvent");
    });

    it("extracts thinking_delta from assistantMessageEvent", () => {
      const piEvent: PiEvent = {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "推理链增量", contentIndex: 0 },
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.type).toBe("agent.delta");
      expect(result.payload.content).toBe("推理链增量");
      expect(result.payload.delta_type).toBe("thinking_delta");
      expect(result.payload).not.toHaveProperty("assistantMessageEvent");
    });

    it("discards toolcall_delta from assistantMessageEvent", () => {
      const piEvent: PiEvent = {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", delta: '{"limit":10}', contentIndex: 0 },
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.payload.content).toBeUndefined();
    });

    it("preserves explicit data.content if present", () => {
      const piEvent: PiEvent = {
        type: "message_update",
        data: { content: "explicit delta text" },
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.payload.content).toBe("explicit delta text");
    });
  });

  describe("agent_end extracts final_content from last assistant message", () => {
    it("extracts text from TextContent parts", () => {
      const piEvent: PiEvent = {
        type: "agent_end",
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "这是最终回答。" },
            ],
            stopReason: "end_turn",
          },
        ],
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.type).toBe("agent.completed");
      expect(result.payload.final_content).toBe("这是最终回答。");
    });

    it("joins multiple TextContent parts", () => {
      const piEvent: PiEvent = {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "第一段。" },
              { type: "toolCall", id: "tc1", name: "test", arguments: {} },
              { type: "text", text: "第二段。" },
            ],
            stopReason: "end_turn",
          },
        ],
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.payload.final_content).toBe("第一段。第二段。");
    });

    it("returns empty final_content when last message has no text", () => {
      const piEvent: PiEvent = {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tc1", name: "test", arguments: {} },
            ],
            stopReason: "toolUse",
          },
        ],
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.payload.final_content).toBeUndefined();
    });

    it("handles agent_end with no messages", () => {
      const piEvent: PiEvent = {
        type: "agent_end",
        messages: [],
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.payload.final_content).toBeUndefined();
    });
  });

  describe("toolcall events do not produce visible text", () => {
    it("tool_execution_start maps to tool.started, not agent.delta", () => {
      const piEvent: PiEvent = {
        type: "tool_execution_start",
        toolCallId: "tc_1",
        toolName: "get_project_state",
        args: { project_id: "proj_1" },
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.type).toBe("tool.started");
      expect(result.type).not.toBe("agent.delta");
    });

    it("tool_execution_end maps to tool.completed, not agent.delta", () => {
      const piEvent: PiEvent = {
        type: "tool_execution_end",
        toolCallId: "tc_1",
        toolName: "get_project_state",
        result: { status: "success" },
        isError: false,
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.type).toBe("tool.completed");
      expect(result.type).not.toBe("agent.delta");
    });
  });

  describe("multi-turn scenario: only final answer in final_content", () => {
    it("simulates 9-turn run: toolcall deltas not in final_content", () => {
      // Turn 0: model produces toolcall (no text)
      // Turn 1-7: model calls tools, produces toolcall deltas
      // Turn 8: model produces final text answer
      const messages = [
        { role: "user", content: "请帮我分析项目" },
        // Turn 0: toolcall
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc1", name: "get_workspace_state", arguments: {} }],
          stopReason: "toolUse",
        },
        { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: '{"status":"ok"}' }] },
        // Turn 1: toolcall
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc2", name: "get_project_state", arguments: {} }],
          stopReason: "toolUse",
        },
        { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: '{"project":"test"}' }] },
        // Turn 2-7: more toolcalls (abbreviated)
        // ...
        // Final turn: text answer
        {
          role: "assistant",
          content: [{ type: "text", text: "根据分析，项目当前处于阶段计划阶段。建议先明确方向再拆解任务。" }],
          stopReason: "end_turn",
        },
      ];

      const piEvent: PiEvent = {
        type: "agent_end",
        messages,
      };
      const result = mapPiEvent(piEvent, runId);
      expect(result.payload.final_content).toBe("根据分析，项目当前处于阶段计划阶段。建议先明确方向再拆解任务。");
      // Must NOT contain toolcall JSON
      expect(result.payload.final_content).not.toContain("get_workspace_state");
      expect(result.payload.final_content).not.toContain("get_project_state");
      expect(result.payload.final_content).not.toContain("toolCall");
    });
  });

  describe("buildRuntimeEventFromPiEvent preserves final_content", () => {
    it("final_content survives runtime event construction", () => {
      const runState = makeRunState();
      const piEvent: PiEvent = {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "最终回答内容" }],
            stopReason: "end_turn",
          },
        ],
      };
      const event = buildRuntimeEventFromPiEvent(piEvent, runState);
      expect(event.payload.final_content).toBe("最终回答内容");
    });
  });
});

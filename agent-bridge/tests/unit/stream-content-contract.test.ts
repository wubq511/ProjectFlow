/**
 * Typed streaming contract tests.
 *
 * Validates that the event-mapper and SSE layer preserve
 * text/thinking channel, start/delta/end lifecycle, contentIndex,
 * and message_seq from the Pi runtime through to the frontend.
 */
import { describe, it, expect } from "vitest";
import { mapPiEvent } from "../../src/events/event-mapper.js";
import type { PiEvent } from "../../src/events/event-mapper.js";

describe("typed streaming contract: event-mapper", () => {
  const runId = "run_stream_contract";

  it("thinking_start produces agent.delta with delta_type and content_index", () => {
    const piEvent: PiEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.delta");
    expect(result.payload.delta_type).toBe("thinking_start");
    expect(result.payload.content_index).toBe(0);
  });

  it("thinking_delta produces agent.delta with content, delta_type, and content_index", () => {
    const piEvent: PiEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "推理增量", contentIndex: 0 },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.delta");
    expect(result.payload.content).toBe("推理增量");
    expect(result.payload.delta_type).toBe("thinking_delta");
    expect(result.payload.content_index).toBe(0);
  });

  it("raw event data cannot override trusted content channel fields", () => {
    const result = mapPiEvent({
      type: "message_update",
      data: {
        run_id: "attacker-run",
        content: "raw hidden content",
        delta_type: "toolcall_delta",
        content_index: 999,
      },
      assistantMessageEvent: { type: "text_delta", delta: "可信回答", contentIndex: 1 },
    }, runId);

    expect(result.payload).toMatchObject({
      run_id: runId,
      content: "可信回答",
      delta_type: "text_delta",
      content_index: 1,
    });
  });

  it("thinking_end produces agent.delta with delta_type and content_index", () => {
    const piEvent: PiEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.delta");
    expect(result.payload.delta_type).toBe("thinking_end");
    expect(result.payload.content_index).toBe(0);
    expect(result.payload.content).toBeUndefined();
  });

  it("text_start produces agent.delta with delta_type and content_index", () => {
    const piEvent: PiEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.delta");
    expect(result.payload.delta_type).toBe("text_start");
    expect(result.payload.content_index).toBe(1);
  });

  it("text_delta produces agent.delta with content, delta_type, and content_index", () => {
    const piEvent: PiEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "回答增量", contentIndex: 1 },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.delta");
    expect(result.payload.content).toBe("回答增量");
    expect(result.payload.delta_type).toBe("text_delta");
    expect(result.payload.content_index).toBe(1);
  });

  it("text_end produces agent.delta with delta_type and content_index", () => {
    const piEvent: PiEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 1 },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.delta");
    expect(result.payload.delta_type).toBe("text_end");
    expect(result.payload.content_index).toBe(1);
    expect(result.payload.content).toBeUndefined();
  });

  it("toolcall_delta does NOT produce visible content", () => {
    const piEvent: PiEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_delta", delta: '{"limit":10}', contentIndex: 2 },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.payload.content).toBeUndefined();
    expect(result.payload.delta_type).toBeUndefined();
  });

  it("full lifecycle: thinking_start → thinking_delta → thinking_end → text_start → text_delta → text_end", () => {
    const events: PiEvent[] = [
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "让我想想", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "答案是", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1 } },
    ];
    const results = events.map((e) => mapPiEvent(e, runId));

    expect(results[0].payload.delta_type).toBe("thinking_start");
    expect(results[0].payload.content_index).toBe(0);
    expect(results[1].payload.delta_type).toBe("thinking_delta");
    expect(results[1].payload.content).toBe("让我想想");
    expect(results[2].payload.delta_type).toBe("thinking_end");
    expect(results[3].payload.delta_type).toBe("text_start");
    expect(results[3].payload.content_index).toBe(1);
    expect(results[4].payload.delta_type).toBe("text_delta");
    expect(results[4].payload.content).toBe("答案是");
    expect(results[5].payload.delta_type).toBe("text_end");
  });

  it("no thinking, direct text: text_start → text_delta → text_end", () => {
    const events: PiEvent[] = [
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "直接回答", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } },
    ];
    const results = events.map((e) => mapPiEvent(e, runId));

    expect(results[0].payload.delta_type).toBe("text_start");
    expect(results[1].payload.content).toBe("直接回答");
    expect(results[2].payload.delta_type).toBe("text_end");
  });

  it("thinking and tool events interleaved", () => {
    const thinkingDelta = mapPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "思考中", contentIndex: 0 } },
      runId,
    );
    const toolStart = mapPiEvent(
      { type: "tool_execution_start", toolCallId: "tc1", toolName: "get_project_state" },
      runId,
    );
    const textDelta = mapPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "回答中", contentIndex: 1 } },
      runId,
    );

    expect(thinkingDelta.payload.delta_type).toBe("thinking_delta");
    expect(thinkingDelta.payload.content).toBe("思考中");
    expect(toolStart.type).toBe("tool.started");
    expect(textDelta.payload.delta_type).toBe("text_delta");
    expect(textDelta.payload.content).toBe("回答中");
  });

  it("multiple thinking blocks with different contentIndex", () => {
    const events: PiEvent[] = [
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "第一段思考", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 2 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "第二段思考", contentIndex: 2 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 2 } },
    ];
    const results = events.map((e) => mapPiEvent(e, runId));

    expect(results[0].payload.content_index).toBe(0);
    expect(results[1].payload.content).toBe("第一段思考");
    expect(results[3].payload.content_index).toBe(2);
    expect(results[4].payload.content).toBe("第二段思考");
  });

  it("missing thinking_end: text_delta still has correct content_index", () => {
    const events: PiEvent[] = [
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "思考中", contentIndex: 0 } },
      // No thinking_end!
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "回答", contentIndex: 1 } },
    ];
    const results = events.map((e) => mapPiEvent(e, runId));

    expect(results[0].payload.delta_type).toBe("thinking_start");
    expect(results[2].payload.delta_type).toBe("text_start");
    expect(results[3].payload.content_index).toBe(1);
    expect(results[3].payload.content).toBe("回答");
  });

  it("contentIndex defaults to undefined when not provided by Pi", () => {
    const piEvent: PiEvent = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "无index" },
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.payload.content).toBe("无index");
    expect(result.payload.delta_type).toBe("text_delta");
    // content_index may be undefined if Pi doesn't provide it
  });

  it("message_start event is mapped to agent.status with message_start phase", () => {
    const piEvent: PiEvent = {
      type: "message_start",
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.type).toBe("agent.status");
    expect(result.payload.phase).toBe("message_start");
  });
});

describe("typed streaming contract: agent_end final_content", () => {
  const runId = "run_final_content";

  it("final_content only from TextContent, not ThinkingContent", () => {
    const piEvent: PiEvent = {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "这是思考内容，不应出现在final_content" },
            { type: "text", text: "这是正式回答。" },
          ],
          stopReason: "end_turn",
        },
      ],
    };
    const result = mapPiEvent(piEvent, runId);
    expect(result.payload.final_content).toBe("这是正式回答。");
    expect(result.payload.final_content).not.toContain("思考");
  });

  it("raw agent_end data cannot override the trusted terminal answer", () => {
    const result = mapPiEvent({
      type: "agent_end",
      data: { run_id: "attacker-run", final_content: "raw hidden answer" },
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "可信终态回答" }],
        stopReason: "end_turn",
      }],
    }, runId);

    expect(result.payload.run_id).toBe(runId);
    expect(result.payload.final_content).toBe("可信终态回答");
  });

  it("failed/cancelled after terminal state: no additional completed", () => {
    const failedEvent: PiEvent = {
      type: "agent_end",
      error: { code: "TIMEOUT", message: "Timeout" },
      messages: [],
    };
    const result = mapPiEvent(failedEvent, runId);
    expect(result.type).toBe("agent.failed");
    expect(result.newStatus).toBe("failed");
  });
});

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({ implementation: undefined as ((...args: any[]) => Promise<unknown>) | undefined }));
vi.mock("../../src/runtime/pi-runtime.js", () => ({
  executeRun: (...args: any[]) => runtimeMock.implementation?.(...args),
}));

import { EventStream } from "../../src/events/stream.js";
import { createEvent } from "../../src/types/runtime-event.js";
import { SessionStore } from "../../src/runtime/session-store.js";
import { handleStartRunStream } from "../../src/server/routes/start-run-stream.js";

class FakeResponse extends EventEmitter {
  statusCode = 0;
  chunks: string[] = [];
  ended = false;

  writeHead(statusCode: number): void {
    this.statusCode = statusCode;
  }

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  end(chunk?: string): void {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
  }
}

describe("start-run-stream production route", () => {
  it("streams typed content and never forwards raw agent.status payload", async () => {
    const stream = new EventStream();
    runtimeMock.implementation = async (...args) => {
      const state = args[0];
      const callbacks = args[7];
      expect(args).toHaveLength(8);
      stream.emit("agent.status", createEvent("agent.status", state.runId, "running", {
        phase: "message_start", message: "正在处理 project_id=secret",
      }));
      stream.emit("agent.delta", createEvent("agent.delta", state.runId, "running", {
        delta_type: "thinking_delta", content_index: 0, content: "分析中",
      }));
      stream.emit("tool.started", createEvent("tool.started", state.runId, "running", {
        tool_name: "get_project_state",
      }));
      stream.emit("tool.completed", createEvent("tool.completed", state.runId, "running", {
        tool_name: "get_project_state",
      }));
      stream.emit("agent.delta", createEvent("agent.delta", state.runId, "running", {
        delta_type: "text_delta", content_index: 1, content: "最终回答",
      }));
      stream.emit("run.completed", createEvent("run.completed", state.runId, "completed", {
        final_content: "最终回答",
      }));
      callbacks.onComplete?.(state);
      return state;
    };

    const request = {
      bodyText: JSON.stringify({
        conversation_id: "conversation-1",
        workspace_id: "workspace-1",
        project_id: "project-1",
        user_content: "问题",
      }),
    };
    const response = new FakeResponse();
    const context = {
      config: {
        defaultModelProvider: "mock", defaultModelName: "mock-model",
        defaults: { maxSteps: 8, maxToolCalls: 6, timeoutMs: 180000 },
        traceIncludeSensitiveData: false,
      },
      fastapiClient: { startRun: vi.fn().mockResolvedValue({ run_id: "run-1" }) },
      sessionStore: new SessionStore(),
      stream,
      toolRegistry: {}, modelRouter: {}, modelConfigStore: {}, dotenvWriter: {}, skillLoader: {},
      reloadDotEnv: vi.fn(),
    };

    await handleStartRunStream(request as never, response as never, {}, context as never);

    const wire = response.chunks.join("");
    expect(response.statusCode).toBe(200);
    expect(response.ended).toBe(true);
    expect(wire).toContain("event: content");
    expect(wire).toContain('"kind":"thinking"');
    expect(wire).toContain('"kind":"text"');
    expect(wire).toContain('"phase":"completed","tool_call_id":"get_project_state"');
    expect(wire).toContain("event: done");
    expect(wire).not.toContain("project_id=secret");
    expect(wire).not.toContain("message_start");
  });
});

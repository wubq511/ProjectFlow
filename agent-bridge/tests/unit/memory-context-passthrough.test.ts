import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventStream } from "../../src/events/stream.js";
import { SessionStore } from "../../src/runtime/session-store.js";
import { handleStartRunStream } from "../../src/server/routes/start-run-stream.js";
import { handleStartRun } from "../../src/server/routes/start-run.js";
import type { SidecarConfig } from "../../src/server/config.js";
import type { RunContext } from "../../src/server/routes/utils.js";

const { executeRunMock } = vi.hoisted(() => ({
  executeRunMock: vi.fn(),
}));

vi.mock("../../src/runtime/pi-runtime.js", () => ({
  executeRun: executeRunMock,
}));

const config: SidecarConfig = {
  host: "127.0.0.1",
  port: 4000,
  fastapiBaseUrl: "http://localhost:8000",
  serviceToken: "test-token",
  defaultModelProvider: "mock",
  defaultModelName: "mock-model",
  modelConfigsPath: "model-configs.json",
  dotenvPath: ".env",
  defaults: {
    maxSteps: 8,
    maxToolCalls: 6,
    timeoutMs: 180000,
    maxOutputTokens: 4096,
    maxToolResultBytes: 32768,
  },
  traceIncludeSensitiveData: false,
};

const wireMemoryContext = {
  text: "历史记忆：MVP 不做外部集成",
  used_memory_ids: ["mem-1", "mem-2"],
  used_memory_types: ["member_constraint", "assignment"],
  guarded_member_names: ["小林"],
  memory_backend: "fts5",
  retrieval_count: 10,
  injected_count: 2,
  latency_ms: 15.5,
};

function createRequest(
  memoryMode?: "enabled" | "disabled",
  workspaceState?: unknown,
): IncomingMessage {
  return {
    bodyText: JSON.stringify({
      conversation_id: "conv-1",
      workspace_id: "ws-1",
      project_id: "proj-1",
      viewer_user_id: "user-1",
      user_content: "帮我规划",
      memory_mode: memoryMode,
      workspace_state: workspaceState,
    }),
  } as unknown as IncomingMessage;
}

function createResponse(): ServerResponse {
  return {
    writeHead: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
    on: vi.fn(),
  } as unknown as ServerResponse;
}

function createContext(): RunContext {
  const sessionStore = new SessionStore();
  const stream = new EventStream();
  return {
    config,
    sessionStore,
    stream,
    fastapiClient: {
      startRun: vi.fn().mockResolvedValue({
        run_id: "run-1",
        status: "created",
        memory_context: wireMemoryContext,
      }),
    },
    toolRegistry: {},
    modelRouter: {},
    modelConfigStore: {},
    dotenvWriter: {},
    reloadDotEnv: vi.fn(),
  } as unknown as RunContext;
}

function expectMappedMemoryContext(): void {
  expect(executeRunMock).toHaveBeenCalledTimes(1);
  expect(executeRunMock.mock.calls[0]?.[1]).toMatchObject({
    viewerUserId: "user-1",
    memoryContext: {
      text: wireMemoryContext.text,
      usedMemoryIds: wireMemoryContext.used_memory_ids,
      usedMemoryTypes: wireMemoryContext.used_memory_types,
      guardedMemberNames: wireMemoryContext.guarded_member_names,
      memoryBackend: wireMemoryContext.memory_backend,
      retrievalCount: wireMemoryContext.retrieval_count,
      injectedCount: wireMemoryContext.injected_count,
      latencyMs: wireMemoryContext.latency_ms,
    },
  });
}

describe("memory_context route passthrough", () => {
  beforeEach(() => {
    executeRunMock.mockReset();
    executeRunMock.mockImplementation(async (state) => ({ ...state, status: "completed" }));
  });

  it("passes FastAPI memory_context through the real POST /runs route", async () => {
    await handleStartRun(createRequest(), createResponse(), {}, createContext());

    expectMappedMemoryContext();
  });

  it("passes FastAPI memory_context through the real POST /runs/stream route", async () => {
    await handleStartRunStream(createRequest(), createResponse(), {}, createContext());

    expectMappedMemoryContext();
  });

  it("forwards disabled memory mode to FastAPI for the R8 A group", async () => {
    const ctx = createContext();

    await handleStartRun(createRequest("disabled"), createResponse(), {}, ctx);

    expect(ctx.fastapiClient.startRun).toHaveBeenCalledWith(expect.objectContaining({
      memory_mode: "disabled",
    }));
  });

  it("returns runtime memory evidence without the memory text", async () => {
    const response = createResponse();
    executeRunMock.mockImplementationOnce(async (state, input, ...args) => {
      input.memoryContext.outputGuardStatus = "repaired";
      input.memoryContext.outputGuardModelCalls = 3;
      const callbacks = args.at(-1) as { onComplete: (value: unknown) => void };
      callbacks.onComplete({ ...state, status: "completed" });
      return { ...state, status: "completed" };
    });

    await handleStartRunStream(createRequest("enabled"), response, {}, createContext());

    const writes = vi.mocked(response.write).mock.calls.flat().join("");
    expect(writes).toContain('"memory_evidence"');
    expect(writes).toContain('"mode":"enabled"');
    expect(writes).toContain('"injected_count":2');
    expect(writes).toContain('"output_guard_status":"repaired"');
    expect(writes).toContain('"output_guard_model_calls":3');
    expect(writes).not.toContain(wireMemoryContext.text);
  });

  it("sanitizes internal IDs in streamed and final model output", async () => {
    const response = createResponse();
    const workspaceState = {
      members: [{ user_id: "user-wang", display_name: "小王" }],
      project: {
        tasks: [{ id: "task-api", title: "后端 API 开发" }],
      },
    };
    executeRunMock.mockImplementationOnce(async (state, ...args) => {
      const stream = args[4] as EventStream;
      const callbacks = args.at(-1) as { onComplete: (value: unknown) => void };
      stream.emit("agent.delta", {
        type: "agent.delta",
        runId: state.runId,
        payload: { content: "推荐 user-wang 负责 task-api。" },
      });
      callbacks.onComplete({ ...state, status: "completed" });
      return { ...state, status: "completed" };
    });

    await handleStartRunStream(
      createRequest("enabled", workspaceState),
      response,
      {},
      createContext(),
    );

    const writes = vi.mocked(response.write).mock.calls.flat().join("");
    expect(writes).toContain("推荐 小王 负责 后端 API 开发");
    expect(writes).not.toContain("user-wang");
    expect(writes).not.toContain("task-api");
  });
});

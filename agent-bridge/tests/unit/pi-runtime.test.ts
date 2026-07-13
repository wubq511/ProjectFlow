import { describe, expect, it } from "vitest";
import { EventStream } from "../../src/events/stream.js";
import { executeRun } from "../../src/runtime/pi-runtime.js";
import { ModelRouter } from "../../src/runtime/model-router.js";
import { createRunState } from "../../src/types/run-state.js";
import { successResult } from "../../src/types/tool-result.js";
import type { ProjectFlowToolResult } from "../../src/types/tool-result.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";
import type { FastapiClient } from "../../src/tools/fastapi-client.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerMockTools } from "../../src/tools/mock-tools.js";
import type { WireAppendRequest, WireAppendResponse } from "../../src/types/wire.js";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

function createState() {
  return createRunState({
    conversationId: "conv_1",
    workspaceId: "ws_1",
    projectId: "proj_1",
    model: { provider: "mock", name: "mock-model" },
    maxSteps: 8,
    maxToolCalls: 6,
    timeoutMs: 180000,
  });
}

/** Default skill context for tests that need action mode (tool execution). */
function defaultSkillContext() {
  return {
    name: "test-skill",
    description: "Test skill for action mode",
    body: "skill body",
    allowedTools: ["mock_get_workspace_state", "generate_stage_plan_proposal", "analyze_checkins_and_risks", "blocked_tool", "allowed_tool"],
  };
}

function createModelRouter(): ModelRouter {
  // Create a minimal mock ModelConfigStore for the mock provider
  const mockStore = {
    list: () => [],
    listWire: () => [],
    get: () => undefined,
    getValid: () => undefined,
    getDefault: () => undefined,
    load: async () => {},
    add: async () => { throw new Error("not implemented"); },
    update: async () => { throw new Error("not implemented"); },
    delete: async () => { throw new Error("not implemented"); },
    persist: async () => {},
  } as unknown as import("../../src/config/model-config-store.js").ModelConfigStore;
  return new ModelRouter(mockStore);
}

function createFastapiClient(calls: WireAppendRequest[]): FastapiClient {
  let eventSeq = 0;
  return {
    appendEvents: async (_runId: string, request: WireAppendRequest): Promise<WireAppendResponse> => {
      calls.push(request);
      return {
        state_version: calls.length,
        events: (request.events ?? []).map((event) => ({
          client_event_id: event.client_event_id,
          agent_event_id: `agent_event_${++eventSeq}`,
          event_seq: eventSeq,
        })),
        tool_results: (request.tool_results ?? []).map((result) => ({
          tool_call_id: result.tool_call_id,
          agent_event_id: `agent_event_tool_${result.tool_call_id}`,
          persisted: true,
        })),
      };
    },
  } as unknown as FastapiClient;
}

function makeManifest(
  name: string,
  overrides: Partial<Pick<ProjectFlowToolManifest, "riskCategory" | "effects" | "privacy" | "trace">> = {},
): ProjectFlowToolManifest {
  return {
    schemaVersion: 1,
    name,
    version: 1,
    description: `Tool ${name}`,
    riskCategory: overrides.riskCategory ?? "read_only",
    modelCallable: true,
    sidecarOnly: false,
    humanTriggeredOnly: false,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object" },
    execution: { mode: "parallel", maxConcurrency: 1, providerParallelToolCallsAllowed: true },
    timeoutMs: 5000,
    retry: { maxAttempts: 1, retryOn: [] },
    resultLimit: { maxBytes: 32768, redaction: "none" },
    backend: { owner: "fastapi", endpoint: `/internal/agent-tools/${name}`, method: "POST" },
    effects: overrides.effects ?? { effectType: "none", idempotencyKeyRequired: false, replaySafe: true },
    privacy: overrides.privacy ?? { dataClassification: "public", traceIncludeInputs: true, traceIncludeOutputs: true },
    errors: { modelVisibleErrorPolicy: "normalized_summary" },
    resume: { manifestVersion: 1, incompatibleVersionPolicy: "regenerate" },
    trace: overrides.trace ?? { emits: [] },
  };
}

describe("pi-runtime", () => {
  it("runs a complete mock provider/tool loop", async () => {
    const calls: WireAppendRequest[] = [];
    const registry = new ToolRegistry();
    registerMockTools(registry);

    const state = await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "跑一次 mock loop",
        skillContext: defaultSkillContext(),
      },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      new EventStream(),
    );

    expect(state.status).toBe("completed");
    expect(state.lastEventSeq).toBeGreaterThan(0);
    expect(calls.some((call) => call.tool_results?.[0]?.tool_name === "mock_get_workspace_state")).toBe(true);
  });

  it("persists durable lifecycle boundaries while streaming token deltas live-only", async () => {
    const calls: WireAppendRequest[] = [];
    const streamed: string[] = [];
    const stream = new EventStream();
    stream.subscribe((message) => {
      streamed.push(`${message.data.type}:${message.data.eventSeq}`);
    });
    const registry = new ToolRegistry();
    registerMockTools(registry);

    await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "跑一次 mock loop",
        skillContext: defaultSkillContext(),
      },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      stream,
    );

    expect(calls.some((call) => call.events?.some((event) => event.type === "agent.started"))).toBe(true);
    expect(calls.some((call) => call.events?.some((event) => event.type === "tool.started"))).toBe(true);
    expect(calls.some((call) => call.events?.some((event) => event.type === "tool.completed"))).toBe(true);
    expect(calls.some((call) => call.events?.some((event) => event.type === "agent.delta"))).toBe(false);
    expect(calls.some((call) => call.state_patch?.status === "context_building")).toBe(true);
    expect(calls.some((call) => call.state_patch?.status === "tool_preparing")).toBe(true);
    expect(streamed.some((item) => item.startsWith("agent.started:0"))).toBe(false);
    expect(streamed.some((item) => item.startsWith("tool.started:0"))).toBe(false);
  });

  it("streams provider text deltas without persisting one event per token", async () => {
    const calls: WireAppendRequest[] = [];
    const streamed: string[] = [];
    const eventStream = new EventStream();
    eventStream.subscribe((message) => streamed.push(`${message.data.type}:${message.data.eventSeq}`));
    const registry = new ToolRegistry();

    const deltaStreamFn: StreamFn = (model) => {
      const stream = createAssistantMessageEventStream();
      const usage: Usage = {
        input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const partial: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.name, usage, stopReason: "stop", timestamp: Date.now(),
      };
      const message: AssistantMessage = { ...partial, content: [{ type: "text", text: "完整回答" }] };
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "完整", partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "回答", partial });
        stream.push({ type: "text_end", contentIndex: 0, content: "完整回答", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    };

    await executeRun(
      createState(),
      { conversationId: "conv_1", workspaceId: "ws_1", projectId: "proj_1", userContent: "直接回答" },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      eventStream,
      { streamFn: deltaStreamFn },
    );

    expect(streamed.filter((event) => event.startsWith("agent.delta:0"))).toHaveLength(4);
    expect(calls.flatMap((call) => call.events ?? []).some((event) => event.type === "agent.delta")).toBe(false);
    expect(calls.flatMap((call) => call.events ?? []).some((event) => event.type === "agent.output_captured")).toBe(true);
  });

  it("persists and streams proposal product events from proposal side-effect tool results", async () => {
    const calls: WireAppendRequest[] = [];
    const streamed: string[] = [];
    const stream = new EventStream();
    stream.subscribe((message) => {
      streamed.push(message.data.type);
    });
    const registry = new ToolRegistry();
    registry.register({
      manifest: makeManifest("generate_stage_plan_proposal", {
        riskCategory: "draft_only",
        effects: { effectType: "proposal_create", idempotencyKeyRequired: true, replaySafe: true },
      }),
      execute: async (): Promise<ProjectFlowToolResult> => ({
        status: "success",
        data: { proposal_id: "prop_1" },
        sideEffectStatus: "proposal_persisted",
        links: { proposalId: "prop_1", agentEventId: "event_1", createdIds: ["prop_1"] },
        observation: "阶段计划草案已创建",
        trace: { redacted: true },
      }),
    });

    await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "生成计划",
        skillContext: {
          ...defaultSkillContext(),
          allowedTools: ["generate_stage_plan_proposal"],
        },
      },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      stream,
    );

    const proposalEvent = calls
      .flatMap((call) => call.events ?? [])
      .find((event) => event.type === "proposal.created");
    expect(proposalEvent).toBeDefined();
    expect(proposalEvent?.payload).toMatchObject({
      run_id: expect.any(String),
      conversation_id: "conv_1",
      workspace_id: "ws_1",
      project_id: "proj_1",
      tool_call_id: "mock_tool_call_1",
      tool_name: "generate_stage_plan_proposal",
      proposal_id: "prop_1",
      agent_event_id: "event_1",
      created_ids: ["prop_1"],
    });
    const proposalToolResult = calls
      .flatMap((call) => call.tool_results ?? [])
      .find((result) => result.tool_name === "generate_stage_plan_proposal");
    expect(proposalToolResult?.result).toMatchObject({
      side_effect_status: "proposal_persisted",
      idempotency_key: expect.any(String),
      links: {
        proposal_id: "prop_1",
        agent_event_id: "event_1",
        created_ids: ["prop_1"],
      },
    });
    expect(streamed).toContain("proposal.created");
  });

  it("persists advisory product events from advisory side-effect tool results", async () => {
    const calls: WireAppendRequest[] = [];
    const registry = new ToolRegistry();
    registry.register({
      manifest: makeManifest("analyze_checkins_and_risks", {
        riskCategory: "advisory_write",
        effects: { effectType: "advisory_record_create", idempotencyKeyRequired: true, replaySafe: true },
      }),
      execute: async (): Promise<ProjectFlowToolResult> => ({
        status: "success",
        data: { created_ids: ["risk_1", "card_1"] },
        sideEffectStatus: "advisory_record_persisted",
        links: { agentEventId: "event_2", createdIds: ["risk_1", "card_1"] },
        observation: "已创建风险与行动卡",
        trace: { redacted: true },
      }),
    });

    await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "分析风险",
        skillContext: {
          ...defaultSkillContext(),
          allowedTools: ["analyze_checkins_and_risks"],
        },
      },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      new EventStream(),
    );

    const advisoryEvent = calls
      .flatMap((call) => call.events ?? [])
      .find((event) => event.type === "advisory_record.created");
    expect(advisoryEvent).toBeDefined();
    expect(advisoryEvent?.payload).toMatchObject({
      tool_name: "analyze_checkins_and_risks",
      created_ids: ["risk_1", "card_1"],
      agent_event_id: "event_2",
    });
  });

  it("applies skill allowed-tools to actual Pi runtime tools", async () => {
    const calls: WireAppendRequest[] = [];
    const registry = new ToolRegistry();
    registry.register({
      manifest: makeManifest("blocked_tool"),
      execute: async () => successResult({}, "blocked"),
    });
    registry.register({
      manifest: makeManifest("allowed_tool"),
      execute: async () => successResult({}, "allowed"),
    });

    await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "使用 skill",
        skillContext: {
          name: "test-skill",
          description: "test",
          body: "body",
          allowedTools: ["allowed_tool"],
        },
      },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      new EventStream(),
    );

    expect(calls.some((call) => call.tool_results?.[0]?.tool_name === "allowed_tool")).toBe(true);
  });

  it("returns cancelled when the run signal is already aborted", async () => {
    const registry = new ToolRegistry();
    registerMockTools(registry);
    const controller = new AbortController();
    controller.abort();

    const state = await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "取消",
      },
      registry,
      createModelRouter(),
      createFastapiClient([]),
      new EventStream(),
      { signal: controller.signal },
    );

    expect(state.status).toBe("cancelled");
  });

  it("sets failed state and emits failure event when model returns stopReason=error", async () => {
    const calls: WireAppendRequest[] = [];
    const registry = new ToolRegistry();
    registerMockTools(registry);

    const EMPTY_USAGE: Usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    const errorStreamFn: StreamFn = (model, _context, _options) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "模型发生错误" }],
          api: model.api,
          provider: model.provider,
          model: model.name,
          usage: EMPTY_USAGE,
          stopReason: "error",
          timestamp: Date.now(),
        };
        stream.push({ type: "done", reason: "error", message });
      });
      return stream;
    };

    const state = await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "触发模型错误",
      },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      new EventStream(),
      { streamFn: errorStreamFn },
    );

    expect(state.status).toBe("failed");
    expect(calls.some((call) => call.state_patch?.status === "failed")).toBe(true);
    expect(
      calls.some((call) =>
        call.events?.some((event) => event.type === "agent.failed" || event.type === "run.failed"),
      ),
    ).toBe(true);
    // A failed run must NOT emit agent.completed — only agent.failed
    expect(
      calls.some((call) => call.events?.some((event) => event.type === "agent.completed")),
    ).toBe(false);
  });

  it("injects _memory metadata into agent.started event payload (R2 observability)", async () => {
    const calls: WireAppendRequest[] = [];
    const registry = new ToolRegistry();
    registerMockTools(registry);

    await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "帮我分工",
        skillContext: defaultSkillContext(),
        memoryContext: {
          text: "以下是与当前项目相关的历史记忆：\n1. [边界] MVP 不做外部集成",
          usedMemoryIds: ["mem-1", "mem-2"],
          memoryBackend: "fts5",
          retrievalCount: 10,
          injectedCount: 2,
          latencyMs: 15.5,
        },
      },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      new EventStream(),
    );

    // Find the agent.started event in the persisted calls
    const agentStarted = calls
      .flatMap((call) => call.events ?? [])
      .find((event) => event.type === "agent.started");

    expect(agentStarted).toBeDefined();
    expect(agentStarted?.payload).toMatchObject({
      _memory: {
        used: true,
        backend: "fts5",
        used_memory_ids: ["mem-1", "mem-2"],
        retrieval_count: 10,
        injected_count: 2,
        latency_ms: 15.5,
      },
    });
  });

  it("injects _memory used=false when memoryContext is null (R2 observability)", async () => {
    const calls: WireAppendRequest[] = [];
    const registry = new ToolRegistry();
    registerMockTools(registry);

    await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "帮我分工",
        skillContext: defaultSkillContext(),
        memoryContext: null,
      },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      new EventStream(),
    );

    const agentStarted = calls
      .flatMap((call) => call.events ?? [])
      .find((event) => event.type === "agent.started");

    expect(agentStarted).toBeDefined();
    expect(agentStarted?.payload).toMatchObject({
      _memory: {
        used: false,
        backend: "none",
        used_memory_ids: [],
        retrieval_count: 0,
        injected_count: 0,
        latency_ms: 0,
      },
    });
  });

  it("does not include _memory in sideEffects (R2 constraint)", async () => {
    const registry = new ToolRegistry();
    registerMockTools(registry);

    const state = await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: "帮我分工",
        skillContext: defaultSkillContext(),
        memoryContext: {
          text: "记忆内容",
          usedMemoryIds: ["mem-1"],
          memoryBackend: "fts5",
          retrievalCount: 5,
          injectedCount: 1,
          latencyMs: 10,
        },
      },
      registry,
      createModelRouter(),
      createFastapiClient([]),
      new EventStream(),
    );

    // sideEffects only records tool calls, never memory usage
    for (const effect of state.sideEffects) {
      expect(effect).not.toHaveProperty("_memory");
      expect(effect).not.toHaveProperty("used_memory_ids");
    }
  });

  it("sends current user content exactly once — no duplication in context.messages", async () => {
    const registry = new ToolRegistry();
    registerMockTools(registry);

    const USER_CONTENT = "检查重复内容";

    // Use a custom streamFn that captures context.messages on each model call.
    // Pi's runAgentLoop appends the prompt to context.messages internally, then
    // appends assistant/tool messages as the loop progresses. By capturing
    // context.messages at each call, we can count how many times the user content
    // appears.
    const capturedContexts: unknown[][] = [];
    const capturingStreamFn: StreamFn = (model, context, options) => {
      capturedContexts.push([...(context.messages ?? [])]);
      const stream = createAssistantMessageEventStream();
      const usage: Usage = {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "回答" }],
        api: model.api, provider: model.provider, model: model.name,
        usage, stopReason: "stop", timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    };

    await executeRun(
      createState(),
      {
        conversationId: "conv_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        userContent: USER_CONTENT,
        skillContext: defaultSkillContext(),
      },
      registry,
      createModelRouter(),
      createFastapiClient([]),
      new EventStream(),
      { streamFn: capturingStreamFn },
    );

    // The streamFn should have been called at least once
    expect(capturedContexts.length).toBeGreaterThanOrEqual(1);

    // Count how many times the user content appears across all context.messages
    // captured during model calls. Before the fix, the user message was both
    // pre-populated in agentContext.messages AND added by runAgentLoop's prompt
    // argument, causing it to appear twice. After the fix, agentContext.messages
    // starts empty and runAgentLoop adds the prompt exactly once.
    for (const msgs of capturedContexts) {
      const userContentOccurrences = msgs.filter(
        (m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes(USER_CONTENT),
      );
      expect(userContentOccurrences).toHaveLength(1);
    }
  });

});

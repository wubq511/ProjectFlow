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

function createModelRouter(): ModelRouter {
  return new ModelRouter({
    defaultProvider: "mock",
    defaultModel: "mock-model",
    providers: {},
  });
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

  it("persists lifecycle runtime events through the append API before streaming them", async () => {
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
      },
      registry,
      createModelRouter(),
      createFastapiClient(calls),
      stream,
    );

    expect(calls.some((call) => call.events?.some((event) => event.type === "agent.started"))).toBe(true);
    expect(calls.some((call) => call.events?.some((event) => event.type === "tool.started"))).toBe(true);
    expect(calls.some((call) => call.events?.some((event) => event.type === "tool.completed"))).toBe(true);
    expect(calls.some((call) => call.state_patch?.status === "context_building")).toBe(true);
    expect(calls.some((call) => call.state_patch?.status === "tool_running")).toBe(true);
    expect(streamed.some((item) => item.startsWith("agent.started:0"))).toBe(false);
    expect(streamed.some((item) => item.startsWith("tool.started:0"))).toBe(false);
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
});

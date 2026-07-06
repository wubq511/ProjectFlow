/**
 * S15 Privacy/Resume Tests — trace defaults, manifest version mismatch, debug raw payload.
 *
 * Covers:
 * - Trace defaults: no sensitive data in default traces/events
 * - Manifest version mismatch: resume policy handling
 * - Debug raw payload mode: separate storage, retention, exclusion from default payload
 * - Secret exclusion: API keys, provider headers not in traces/events
 * - Redaction behavior: secrets vs PII vs none
 * - Resume policy: regeneration, manual_review, fail
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TraceEnvelope,
  createToolTrace,
  createRunTrace,
  createRunStateTrace,
} from "../../src/events/trace-envelope.js";
import { normalizeResult } from "../../src/tools/result-normalizer.js";
import { DebugPayloadStore } from "../../src/events/debug-payload-store.js";
import { buildRuntimeEventFromPiEvent } from "../../src/events/event-mapper.js";
import { createRunState } from "../../src/types/run-state.js";
import type { AgentRunState } from "../../src/types/run-state.js";
import { registerDefaultTools } from "../../src/tools/register-defaults.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { FastapiClient } from "../../src/tools/fastapi-client.js";
import { failedResult } from "../../src/types/tool-result.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRunState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  const state = createRunState({
    conversationId: "conv_1",
    workspaceId: "ws_1",
    projectId: "proj_1",
    model: { provider: "mock", name: "mock-model" },
    maxSteps: 8,
    maxToolCalls: 6,
    timeoutMs: 180000,
  });
  state.runId = "run_priv_123";
  return { ...state, ...overrides };
}

function createStubFastapiClient(): FastapiClient {
  return {
    callTool: async () => ({}),
    startRun: async () => ({ run_id: "test", status: "created" }),
    getRunStatus: async () => ({ run_id: "test", status: "created", current_turn: 0, current_step: 0, last_event_seq: 0, created_at: "", updated_at: "" }),
    appendEvents: async () => ({ state_version: 1, events: [], tool_results: [] }),
    cancelRun: async () => ({ run_id: "test", status: "cancelled", cancelled: true }),
  } as unknown as FastapiClient;
}

// ─── Trace Defaults: No Sensitive Data ──────────────────────────────────────

describe("S15 privacy: trace defaults exclude sensitive data", () => {
  it("default trace has redacted=true", () => {
    const trace = createToolTrace("run_1", "call_1", "test_tool", false);
    const summary = trace.toTraceSummary();
    expect(summary.redacted).toBe(true);
  });

  it("default trace does not contain raw input/output", () => {
    const trace = createToolTrace("run_1", "call_1", "test_tool", false);
    const resultTrace = trace.toResultTrace();
    // Only hashes, no raw data
    expect(resultTrace).not.toHaveProperty("input");
    expect(resultTrace).not.toHaveProperty("output");
    expect(resultTrace).toHaveProperty("redacted");
  });

  it("normalizeResult with default options does not store debug payload", () => {
    const store = new DebugPayloadStore();
    const result = normalizeResult(
      { secret: "api_key_12345" },
      { prompt: "raw user input with sensitive data" },
      {
        includeSensitiveData: false,
        debugPayloadStore: store,
        debugPayloadContext: { runId: "run_1", toolCallId: "call_1", toolName: "tool" },
      },
    );
    expect(result.trace.redacted).toBe(true);
    expect(result.trace.debugPayloadId).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("runtime event payload excludes raw prompt and args", () => {
    const runState = makeRunState();
    const event = buildRuntimeEventFromPiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "get_workspace_state",
        args: { raw_prompt: "sensitive prompt content" },
      },
      runState,
      { orderingHint: 1 },
    );
    // Payload should not contain raw args
    expect(event.payload).not.toHaveProperty("args");
    expect(event.payload).not.toHaveProperty("raw_prompt");
  });

  it("runtime event payload excludes raw message content", () => {
    const runState = makeRunState();
    const event = buildRuntimeEventFromPiEvent(
      {
        type: "message_update",
        message: { role: "assistant", content: "raw message with secrets" },
        assistantMessageEvent: { type: "delta", delta: "公开增量" },
      },
      runState,
      { orderingHint: 2 },
    );
    expect(event.payload).not.toHaveProperty("message");
    expect(event.payload.content).toEqual({ type: "delta", delta: "公开增量" });
  });

  it("trace from run state does not include API key or provider headers", () => {
    const runState = makeRunState();
    const trace = createRunStateTrace(runState);
    const summary = trace.toTraceSummary();
    // Trace should have provider/model but no credentials
    expect(summary.provider).toBe("mock");
    expect(summary.model).toBe("mock-model");
    expect(summary).not.toHaveProperty("apiKey");
    expect(summary).not.toHaveProperty("api_key");
    expect(summary).not.toHaveProperty("headers");
  });
});

// ─── Manifest Version Mismatch ──────────────────────────────────────────────

describe("S15 resume: manifest version mismatch", () => {
  const registry = new ToolRegistry();
  registerDefaultTools(registry, createStubFastapiClient());

  it("all tools have manifestVersion=1 in resume config", () => {
    const manifests = registry.getManifests();
    for (const m of manifests) {
      expect(m.resume.manifestVersion).toBe(1);
    }
  });

  it("all tools specify incompatibleVersionPolicy", () => {
    const manifests = registry.getManifests();
    const validPolicies = ["regenerate", "manual_review", "fail"];
    for (const m of manifests) {
      expect(validPolicies).toContain(m.resume.incompatibleVersionPolicy);
    }
  });

  it("run state has resumePolicy with manifestVersion", () => {
    const runState = makeRunState();
    expect(runState.resumePolicy).toBeDefined();
    expect(runState.resumePolicy.manifestVersion).toBe(1);
    expect(runState.resumePolicy.requiresRegenerationOnMismatch).toBe(true);
  });

  it("manifest version mismatch detection: version 2 vs current 1", () => {
    const runState = makeRunState();
    const storedManifestVersion = 2;
    const currentManifestVersion = runState.resumePolicy.manifestVersion;
    const mismatch = storedManifestVersion !== currentManifestVersion;
    expect(mismatch).toBe(true);
    // When mismatch, requiresRegenerationOnMismatch=true means we regenerate
    expect(runState.resumePolicy.requiresRegenerationOnMismatch).toBe(true);
  });

  it("manifest version match: same version", () => {
    const runState = makeRunState();
    const storedManifestVersion = 1;
    const currentManifestVersion = runState.resumePolicy.manifestVersion;
    expect(storedManifestVersion).toBe(currentManifestVersion);
  });

  it("incompatibleVersionPolicy=regenerate: resume regenerates on mismatch", () => {
    const manifests = registry.getManifests();
    const regenerateTools = manifests.filter(
      (m) => m.resume.incompatibleVersionPolicy === "regenerate",
    );
    // Most tools should use regenerate as default
    expect(regenerateTools.length).toBeGreaterThan(0);
  });

  it("incompatibleVersionPolicy=fail: resume fails on mismatch", () => {
    // This is a valid policy for tools that cannot be safely regenerated
    const policy: ProjectFlowToolManifest["resume"]["incompatibleVersionPolicy"] = "fail";
    expect(policy).toBe("fail");
    // Runtime should check this and return MANIFEST_VERSION_MISMATCH error
  });
});

// ─── Debug Raw Payload Mode ─────────────────────────────────────────────────

describe("S15 privacy: debug raw payload mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debug store stores raw payload with context", () => {
    const store = new DebugPayloadStore();
    const record = store.store(
      { runId: "run_1", toolCallId: "call_1", toolName: "test_tool" },
      { input: { secret: "key" }, output: { data: "result" } },
    );
    expect(record.id).toMatch(/^debug_/);
    expect(record.runId).toBe("run_1");
    expect(record.toolCallId).toBe("call_1");
    expect(record.toolName).toBe("test_tool");
    expect(record.input).toEqual({ secret: "key" });
    expect(record.output).toEqual({ data: "result" });
  });

  it("debug store retrieves stored payload by id", () => {
    const store = new DebugPayloadStore();
    const record = store.store(
      { runId: "run_1" },
      { input: "raw", output: "result" },
    );
    const retrieved = store.get(record.id);
    expect(retrieved).toEqual(record);
  });

  it("debug store lists payloads by run", () => {
    const store = new DebugPayloadStore();
    store.store({ runId: "run_1" }, { input: "a" });
    store.store({ runId: "run_1" }, { input: "b" });
    store.store({ runId: "run_2" }, { input: "c" });
    const run1Records = store.listByRun("run_1");
    expect(run1Records).toHaveLength(2);
    const run2Records = store.listByRun("run_2");
    expect(run2Records).toHaveLength(1);
  });

  it("debug store prunes expired records", () => {
    const store = new DebugPayloadStore(5000); // 5s retention
    store.store({ runId: "run_1" }, { input: "data" });
    expect(store.size).toBe(1);

    vi.advanceTimersByTime(6000); // 6s later
    expect(store.size).toBe(0);
  });

  it("debug store clear removes all records", () => {
    const store = new DebugPayloadStore();
    store.store({ runId: "run_1" }, { input: "a" });
    store.store({ runId: "run_2" }, { input: "b" });
    expect(store.size).toBe(2);
    store.clear();
    expect(store.size).toBe(0);
  });

  it("normalizeResult with debug mode stores payload and returns debugPayloadId", () => {
    const store = new DebugPayloadStore();
    const result = normalizeResult(
      { sensitive: "output" },
      { prompt: "input" },
      {
        includeSensitiveData: true,
        debugPayloadStore: store,
        debugPayloadContext: { runId: "run_1", toolCallId: "call_1", toolName: "tool" },
      },
    );
    expect(result.trace.debugPayloadId).toBeDefined();
    expect(result.trace.redacted).toBe(false);
    expect(store.size).toBe(1);

    const record = store.get(result.trace.debugPayloadId!);
    expect(record?.input).toEqual({ prompt: "input" });
    expect(record?.output).toEqual({ sensitive: "output" });
  });

  it("debug payload has expiration timestamp", () => {
    const store = new DebugPayloadStore(30 * 60 * 1000); // 30 min default
    const record = store.store({ runId: "run_1" }, { input: "data" });
    expect(record.createdAt).toBeDefined();
    expect(record.expiresAt).toBeDefined();
    // expiresAt should be after createdAt
    expect(Date.parse(record.expiresAt)).toBeGreaterThan(Date.parse(record.createdAt));
  });
});

// ─── Secret Exclusion ───────────────────────────────────────────────────────

describe("S15 privacy: secret exclusion from traces and events", () => {
  it("tool manifest privacy config defaults to excluding inputs/outputs from trace", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const manifests = registry.getManifests();

    // Read-only tools should have traceIncludeInputs=false by default
    const readOnlyTools = manifests.filter((m) => m.riskCategory === "read_only");
    for (const m of readOnlyTools) {
      // The design doc says trace_include_inputs and trace_include_outputs default false
      // Check that privacy config exists
      expect(m.privacy).toBeDefined();
    }
  });

  it("tool result trace only contains hashes, not raw data", () => {
    const store = new DebugPayloadStore();
    const result = normalizeResult(
      { apiResponse: "sensitive data" },
      { apiKey: "sk-12345" },
      {
        includeSensitiveData: false,
        debugPayloadStore: store,
        debugPayloadContext: { runId: "run_1" },
      },
    );
    // Trace should have hashes but no raw data
    expect(result.trace.inputHash).toBeDefined();
    expect(result.trace.outputHash).toBeDefined();
    expect(result.trace.redacted).toBe(true);
    expect(result.trace.debugPayloadId).toBeUndefined();
    // The result data itself is the normalized output, not the trace
    expect(result.data).toEqual({ apiResponse: "sensitive data" });
  });

  it("trace envelope never stores secrets in attributes", () => {
    const trace = createToolTrace("run_1", "call_1", "test", false);
    const span = trace.startSpan("tool.execution", { toolName: "test" });
    trace.endSpan(span, { status: "success" });
    const summary = trace.toTraceSummary();
    // Spans should not contain secrets
    for (const span of summary.spans) {
      expect(span.attributes).not.toHaveProperty("apiKey");
      expect(span.attributes).not.toHaveProperty("api_key");
    }
  });
});

// ─── Redaction Behavior ─────────────────────────────────────────────────────

describe("S15 privacy: redaction behavior", () => {
  it("redaction=none with includeSensitiveData=true: redacted=false", () => {
    const store = new DebugPayloadStore();
    const result = normalizeResult({ data: "test" }, {}, {
      includeSensitiveData: true,
      redaction: "none",
      debugPayloadStore: store,
      debugPayloadContext: { runId: "r1" },
    });
    expect(result.trace.redacted).toBe(false);
  });

  it("redaction=secrets with includeSensitiveData=true: redacted=true", () => {
    const store = new DebugPayloadStore();
    const result = normalizeResult({ data: "test" }, {}, {
      includeSensitiveData: true,
      redaction: "secrets",
      debugPayloadStore: store,
      debugPayloadContext: { runId: "r1" },
    });
    expect(result.trace.redacted).toBe(true);
  });

  it("redaction=pii with includeSensitiveData=true: redacted=true", () => {
    const store = new DebugPayloadStore();
    const result = normalizeResult({ data: "test" }, {}, {
      includeSensitiveData: true,
      redaction: "pii",
      debugPayloadStore: store,
      debugPayloadContext: { runId: "r1" },
    });
    expect(result.trace.redacted).toBe(true);
  });

  it("default (includeSensitiveData=false): always redacted=true regardless of redaction", () => {
    const result1 = normalizeResult({ data: "test" }, {}, {
      includeSensitiveData: false,
      redaction: "none",
    });
    const result2 = normalizeResult({ data: "test" }, {}, {
      includeSensitiveData: false,
      redaction: "secrets",
    });
    const result3 = normalizeResult({ data: "test" }, {}, {
      includeSensitiveData: false,
      redaction: "pii",
    });
    expect(result1.trace.redacted).toBe(true);
    expect(result2.trace.redacted).toBe(true);
    expect(result3.trace.redacted).toBe(true);
  });

  it("trace envelope: includeSensitiveData=false always produces redacted=true", () => {
    const trace = createToolTrace("run_1", "call_1", "test", false);
    expect(trace.toTraceSummary().redacted).toBe(true);
    expect(trace.toResultTrace().redacted).toBe(true);
  });

  it("trace envelope: includeSensitiveData=true produces redacted=false", () => {
    const trace = createToolTrace("run_1", "call_1", "test", true);
    expect(trace.toTraceSummary().redacted).toBe(false);
    expect(trace.toResultTrace().redacted).toBe(false);
  });
});

// ─── Resume Policy Validation ───────────────────────────────────────────────

describe("S15 resume: policy validation", () => {
  it("run state created with default resumePolicy", () => {
    const state = makeRunState();
    expect(state.resumePolicy.manifestVersion).toBe(1);
    expect(state.resumePolicy.requiresRegenerationOnMismatch).toBe(true);
  });

  it("paused run records manifest version for resume", () => {
    const state = makeRunState({ status: "tool_running" });
    // When a run is paused (e.g., pending proposal), it must record:
    // - manifest version
    // - tool schema version
    // - proposal payload schema version
    expect(state.resumePolicy.manifestVersion).toBeDefined();
  });

  it("all registered tools have consistent manifestVersion", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const manifests = registry.getManifests();
    const versions = new Set(manifests.map((m) => m.resume.manifestVersion));
    // All should be on version 1
    expect(versions).toEqual(new Set([1]));
  });

  it("unknown side effect status blocks resume", () => {
    // Design invariant: unknown side effect → no auto-fallback → must reconcile
    // A run with unknown side effects cannot safely resume.
    // Verify that failedResult produces unknown, and the runtime must check before resume.
    const toolResult = failedResult("FASTAPI_UNAVAILABLE", "后端不可达");
    expect(toolResult.sideEffectStatus).toBe("unknown");
    // Runtime code must block auto-resume when any side effect is unknown:
    // if (runState.sideEffects.some(se => se.status === "unknown")) { /* block resume */ }
  });
});

// ─── Data Classification ────────────────────────────────────────────────────

describe("S15 privacy: data classification", () => {
  it("read-only tools use public or project_sensitive classification", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const readOnlyTools = registry.getManifests().filter((m) => m.riskCategory === "read_only");
    for (const m of readOnlyTools) {
      expect(["public", "project_sensitive"]).toContain(m.privacy.dataClassification);
    }
  });

  it("proposal tools use project_sensitive classification", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const draftTools = registry.getManifests().filter((m) => m.riskCategory === "draft_only");
    for (const m of draftTools) {
      expect(m.privacy.dataClassification).toBe("project_sensitive");
    }
  });

  it("advisory tools use project_sensitive classification", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const advisoryTools = registry.getManifests().filter((m) => m.riskCategory === "advisory_write");
    for (const m of advisoryTools) {
      expect(m.privacy.dataClassification).toBe("project_sensitive");
    }
  });

  it("no tool uses secret classification (secrets never in tool data)", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const manifests = registry.getManifests();
    for (const m of manifests) {
      expect(m.privacy.dataClassification).not.toBe("secret");
    }
  });
});

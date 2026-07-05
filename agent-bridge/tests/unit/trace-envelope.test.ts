/**
 * Tests for TraceEnvelope — run/tool/proposal correlation.
 *
 * Verifies:
 * - createToolTrace / createRunTrace / createRunStateTrace factories
 * - startSpan / endSpan lifecycle
 * - toTraceSummary() produces snake_case output
 * - toRuntimeTraceSummary() produces camelCase output
 * - toResultTrace() produces wire-format trace
 * - redacted flag follows includeSensitiveData
 * - hashValue produces consistent short hex
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TraceEnvelope,
  createToolTrace,
  createRunTrace,
  createRunStateTrace,
} from "../../src/events/trace-envelope.js";
import type { AgentRunState } from "../../src/types/run-state.js";
import { createRunState } from "../../src/types/run-state.js";

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
  state.runId = "run_test_123";
  return { ...state, ...overrides };
}

describe("TraceEnvelope", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createToolTrace", () => {
    it("creates an envelope with tool context", () => {
      const trace = createToolTrace("run_1", "call_1", "get_workspace_state", false);
      const summary = trace.toTraceSummary();

      expect(summary.run_id).toBe("run_1");
      expect(summary.tool_call_id).toBe("call_1");
      expect(summary.tool_name).toBe("get_workspace_state");
      expect(summary.redacted).toBe(true);
    });

    it("sets redacted=false when includeSensitiveData is true", () => {
      const trace = createToolTrace("run_1", "call_1", "test_tool", true);
      const summary = trace.toTraceSummary();

      expect(summary.redacted).toBe(false);
    });
  });

  describe("createRunTrace", () => {
    it("creates an envelope with run context only", () => {
      const trace = createRunTrace("run_1", false);
      const summary = trace.toTraceSummary();

      expect(summary.run_id).toBe("run_1");
      expect(summary).not.toHaveProperty("tool_call_id");
      expect(summary).not.toHaveProperty("tool_name");
      expect(summary.redacted).toBe(true);
    });
  });

  describe("createRunStateTrace", () => {
    it("creates an envelope from a full AgentRunState", () => {
      const runState = makeRunState();
      const trace = createRunStateTrace(runState, {
        toolCallId: "call_1",
        toolName: "generate_stage_plan_proposal",
        proposalId: "prop_1",
      });
      const summary = trace.toTraceSummary();

      expect(summary.run_id).toBe("run_test_123");
      expect(summary.conversation_id).toBe("conv_1");
      expect(summary.workspace_id).toBe("ws_1");
      expect(summary.project_id).toBe("proj_1");
      expect(summary.tool_call_id).toBe("call_1");
      expect(summary.tool_name).toBe("generate_stage_plan_proposal");
      expect(summary.proposal_id).toBe("prop_1");
      expect(summary.provider).toBe("mock");
      expect(summary.model).toBe("mock-model");
      expect(summary.run_state).toEqual({
        status: "created",
        current_step: 0,
        state_schema_version: 1,
      });
      expect(summary.budget).toEqual({
        max_steps: 8,
        max_tool_calls: 6,
        timeout_ms: 180000,
      });
    });

    it("defaults redacted to true when includeSensitiveData not specified", () => {
      const runState = makeRunState();
      const trace = createRunStateTrace(runState);
      const summary = trace.toTraceSummary();

      expect(summary.redacted).toBe(true);
    });
  });

  describe("spans", () => {
    it("records start and end times for spans", () => {
      const trace = createToolTrace("run_1", "call_1", "test", false);

      const span = trace.startSpan("tool.execution");
      vi.advanceTimersByTime(50);
      trace.endSpan(span, { status: "success" });

      const summary = trace.toTraceSummary();
      expect(summary.spans.length).toBe(1);
      expect(summary.spans[0]!.name).toBe("tool.execution");
      expect(summary.spans[0]!.end_ms).toBeGreaterThan(summary.spans[0]!.start_ms);
      expect(summary.spans[0]!.duration_ms).toBe(50);
      expect(summary.spans[0]!.attributes).toEqual({ status: "success" });
    });

    it("merges end attributes with start attributes", () => {
      const trace = createToolTrace("run_1", "call_1", "test", false);

      const span = trace.startSpan("tool.execution", { toolName: "test" });
      trace.endSpan(span, { status: "error" });

      const summary = trace.toTraceSummary();
      expect(summary.spans[0]!.attributes).toEqual({
        toolName: "test",
        status: "error",
      });
    });

    it("supports multiple spans", () => {
      const trace = createToolTrace("run_1", "call_1", "test", false);

      trace.startSpan("span_1");
      trace.startSpan("span_2");
      trace.startSpan("span_3");

      const summary = trace.toTraceSummary();
      expect(summary.spans.length).toBe(3);
    });
  });

  describe("toTraceSummary (snake_case)", () => {
    it("produces snake_case keys", () => {
      const runState = makeRunState();
      const trace = createRunStateTrace(runState);
      const summary = trace.toTraceSummary();

      expect(summary).toHaveProperty("run_id");
      expect(summary).toHaveProperty("conversation_id");
      expect(summary).toHaveProperty("workspace_id");
      expect(summary).toHaveProperty("project_id");
      // run_state and budget are nested objects
      expect(summary.run_state).toHaveProperty("state_schema_version");
      expect(summary.budget).toHaveProperty("max_steps");
      expect(summary.budget).toHaveProperty("max_tool_calls");
      expect(summary.budget).toHaveProperty("timeout_ms");
    });

    it("omits optional fields when not set", () => {
      const trace = createRunTrace("run_1", false);
      const summary = trace.toTraceSummary();

      expect(summary).not.toHaveProperty("conversation_id");
      expect(summary).not.toHaveProperty("workspace_id");
      expect(summary).not.toHaveProperty("project_id");
      expect(summary).not.toHaveProperty("tool_call_id");
      expect(summary).not.toHaveProperty("tool_name");
      expect(summary).not.toHaveProperty("proposal_id");
      expect(summary).not.toHaveProperty("provider");
      expect(summary).not.toHaveProperty("model");
      expect(summary).not.toHaveProperty("run_state");
      expect(summary).not.toHaveProperty("budget");
    });
  });

  describe("toRuntimeTraceSummary (camelCase)", () => {
    it("produces camelCase keys", () => {
      const runState = makeRunState();
      const trace = createRunStateTrace(runState, {
        toolCallId: "call_1",
        toolName: "test_tool",
      });
      const summary = trace.toRuntimeTraceSummary();

      expect(summary).toHaveProperty("runId");
      expect(summary).toHaveProperty("conversationId");
      expect(summary).toHaveProperty("workspaceId");
      expect(summary).toHaveProperty("projectId");
      expect(summary).toHaveProperty("toolCallId");
      expect(summary).toHaveProperty("toolName");
      expect(summary).toHaveProperty("provider");
      expect(summary).toHaveProperty("model");
      expect(summary).toHaveProperty("runState");
      expect(summary).toHaveProperty("budget");
    });

    it("matches the TraceSummary type structure", () => {
      const runState = makeRunState();
      const trace = createRunStateTrace(runState);
      const summary = trace.toRuntimeTraceSummary();

      expect(summary.redacted).toBe(true);
      expect(summary.runState?.stateSchemaVersion).toBe(1);
    });
  });

  describe("toResultTrace", () => {
    it("includes input and output hashes when provided", () => {
      const trace = createToolTrace("run_1", "call_1", "test", false);
      const result = trace.toResultTrace("hash_input_123", "hash_output_456");

      expect(result.input_hash).toBe("hash_input_123");
      expect(result.output_hash).toBe("hash_output_456");
      expect(result.redacted).toBe(true);
    });

    it("omits hashes when not provided", () => {
      const trace = createToolTrace("run_1", "call_1", "test", false);
      const result = trace.toResultTrace();

      expect(result).not.toHaveProperty("input_hash");
      expect(result).not.toHaveProperty("output_hash");
      expect(result.redacted).toBe(true);
    });

    it("sets redacted=false when includeSensitiveData is true", () => {
      const trace = createToolTrace("run_1", "call_1", "test", true);
      const result = trace.toResultTrace();

      expect(result.redacted).toBe(false);
    });
  });

  describe("hashValue", () => {
    it("produces a 16-char hex string", () => {
      const trace = createToolTrace("run_1", "call_1", "test", false);
      const hash = trace.hashValue("test input");

      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("produces consistent hashes for the same input", () => {
      const trace = createToolTrace("run_1", "call_1", "test", false);
      const hash1 = trace.hashValue("same input");
      const hash2 = trace.hashValue("same input");

      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different inputs", () => {
      const trace = createToolTrace("run_1", "call_1", "test", false);
      const hash1 = trace.hashValue("input_a");
      const hash2 = trace.hashValue("input_b");

      expect(hash1).not.toBe(hash2);
    });
  });
});

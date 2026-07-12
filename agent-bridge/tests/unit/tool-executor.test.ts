/**
 * ToolExecutor tests — enforcement, timeout, retry, error taxonomy.
 *
 * Verifies: input validation, policy, timeout, retry with backoff,
 * idempotency, result bounding, error classification.
 */

import { describe, it, expect, vi } from "vitest";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";
import type { ToolExecutionContext } from "../../src/tools/registry.js";

function makeManifest(overrides: Partial<ProjectFlowToolManifest> = {}): ProjectFlowToolManifest {
  return {
    schemaVersion: 1, name: "test-tool", version: 1, description: "Test",
    riskCategory: "read_only", modelCallable: true, sidecarOnly: false, humanTriggeredOnly: false,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    inputSchema: { type: "object", properties: {} }, outputSchema: {},
    execution: { mode: "parallel", maxConcurrency: 1, providerParallelToolCallsAllowed: true },
    timeoutMs: 5000, retry: { maxAttempts: 1, retryOn: [] },
    resultLimit: { maxBytes: 32768, redaction: "none" },
    backend: { owner: "fastapi", endpoint: "/test", method: "POST" },
    effects: { effectType: "none", idempotencyKeyRequired: false, replaySafe: true },
    privacy: { dataClassification: "public", traceIncludeInputs: false, traceIncludeOutputs: false },
    errors: { modelVisibleErrorPolicy: "normalized_summary" },
    resume: { manifestVersion: 1, incompatibleVersionPolicy: "regenerate" },
    trace: { emits: [] },
    ...overrides,
  };
}

function makeContext(): ToolExecutionContext {
  return {
    runId: "run-1", toolCallId: "tc-1", conversationId: "conv-1",
    workspaceId: "ws-1", projectId: "proj-1", toolName: "test-tool",
    toolVersion: 1, manifestVersion: 1, idempotencyKey: "run-1_tc-1",
  };
}

describe("ToolExecutor", () => {
  describe("input validation", () => {
    it("rejects non-object params", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest({
        inputSchema: { type: "object", properties: {}, required: ["name"] },
      });
      registry.register({ manifest, execute: async () => ({}) });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("test-tool", "not-an-object", makeContext(), manifest);

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("VALIDATION");
    });

    it("rejects missing required fields", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest({
        inputSchema: { type: "object", properties: {}, required: ["name"] },
      });
      registry.register({ manifest, execute: async () => ({}) });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("test-tool", {}, makeContext(), manifest);

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("VALIDATION");
    });
  });

  describe("policy enforcement", () => {
    it("denies human-triggered tools", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest({ humanTriggeredOnly: true, modelCallable: false });
      registry.register({ manifest, execute: async () => ({}) });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("test-tool", {}, makeContext(), manifest);

      // Policy denials are mapped to "failed" status by the executor
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("POLICY");
    });
  });

  describe("timeout", () => {
    it("returns timeout result when tool exceeds timeout", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest({ timeoutMs: 1000 }); // 1s timeout (minimum allowed)
      registry.register({
        manifest,
        execute: async () => {
          await new Promise((r) => setTimeout(r, 3000)); // takes 3s
          return {};
        },
      });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("test-tool", {}, makeContext(), manifest);

      expect(result.status).toBe("timeout");
    });
  });

  describe("retry", () => {
    it("retries transient errors when manifest allows", async () => {
      let attempts = 0;
      const registry = new ToolRegistry();
      const manifest = makeManifest({
        retry: { maxAttempts: 3, retryOn: ["timeout"] },
        timeoutMs: 10000,
      });
      registry.register({
        manifest,
        execute: async () => {
          attempts++;
          if (attempts < 3) {
            // Use timeout status which IS retryable
            return { status: "timeout", observation: "transient error", sideEffectStatus: "no_side_effect" };
          }
          return { status: "success", observation: "ok", sideEffectStatus: "no_side_effect" };
        },
      });

      const executor = new ToolExecutor(registry, {
        backoffFn: () => 0, // no delay for tests
        jitterFn: () => 1,
      });
      const result = await executor.execute("test-tool", {}, makeContext(), manifest);

      expect(attempts).toBe(3);
      expect(result.status).toBe("success");
    });

    it("does not retry validation errors", async () => {
      let attempts = 0;
      const registry = new ToolRegistry();
      const manifest = makeManifest({
        retry: { maxAttempts: 3, retryOn: ["validation"] },
        inputSchema: { type: "object", properties: {}, required: ["name"] },
      });
      registry.register({ manifest, execute: async () => { attempts++; return {}; } });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("test-tool", {}, makeContext(), manifest);

      expect(attempts).toBe(0); // never reached execute
      expect(result.status).toBe("failed");
    });

    it("does not retry when side effect is unknown", async () => {
      let attempts = 0;
      const registry = new ToolRegistry();
      const manifest = makeManifest({ retry: { maxAttempts: 3, retryOn: ["transient"] } });
      registry.register({
        manifest,
        execute: async () => {
          attempts++;
          return { status: "failed", observation: "unknown side effect", sideEffectStatus: "unknown" };
        },
      });

      const executor = new ToolExecutor(registry, {
        backoffFn: () => 0,
        jitterFn: () => 1,
      });
      const result = await executor.execute("test-tool", {}, makeContext(), manifest);

      expect(attempts).toBe(1); // no retry
      expect(result.sideEffectStatus).toBe("unknown");
    });
  });

  describe("error taxonomy", () => {
    it("classifies timeout correctly", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest({ timeoutMs: 1000 }); // 1s minimum
      registry.register({
        manifest,
        execute: async () => { await new Promise((r) => setTimeout(r, 3000)); return {}; },
      });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("test-tool", {}, makeContext(), manifest);

      expect(result.status).toBe("timeout");
    });

    it("classifies cancellation correctly", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest();
      registry.register({ manifest, execute: async () => ({}) });

      const controller = new AbortController();
      controller.abort();

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("test-tool", {}, makeContext(), manifest, controller.signal);

      expect(result.status).toBe("aborted");
    });
  });

  describe("ledger", () => {
    it("records ledger entries for each execution", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest();
      registry.register({ manifest, execute: async () => ({ status: "success", observation: "ok", sideEffectStatus: "no_side_effect" }) });

      const executor = new ToolExecutor(registry);
      await executor.execute("test-tool", {}, makeContext(), manifest);

      const ledger = executor.getLedger();
      expect(ledger.length).toBe(1);
      expect(ledger[0]!.toolName).toBe("test-tool");
      expect(ledger[0]!.resultStatus).toBe("success");
    });

    it("records multiple attempts for retries", async () => {
      let attempts = 0;
      const registry = new ToolRegistry();
      const manifest = makeManifest({ retry: { maxAttempts: 3, retryOn: ["timeout"] }, timeoutMs: 10000 });
      registry.register({
        manifest,
        execute: async () => {
          attempts++;
          if (attempts < 3) {
            return { status: "timeout", observation: "timeout", sideEffectStatus: "no_side_effect" };
          }
          return { status: "success", observation: "ok", sideEffectStatus: "no_side_effect" };
        },
      });

      const executor = new ToolExecutor(registry, {
        backoffFn: () => 0,
        jitterFn: () => 1,
      });
      await executor.execute("test-tool", {}, makeContext(), manifest);

      const ledger = executor.getRunLedger("run-1");
      expect(ledger.length).toBe(3);
      expect(ledger[0]!.attempt).toBe(1);
      expect(ledger[2]!.attempt).toBe(3);
    });

    it("persists large results and exposes only a bounded resource reference", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest({ resultLimit: { maxBytes: 65536, redaction: "none" } });
      registry.register({
        manifest,
        execute: async () => ({ status: "success", data: { content: "中".repeat(5000) }, observation: "ok", sideEffectStatus: "no_side_effect" }),
      });
      const persisted: Array<{ id: string; content: string }> = [];
      const executor = new ToolExecutor(registry, {
        onLargeResult: async (ref, content) => { persisted.push({ id: ref.resourceId, content }); },
      });

      const result = await executor.execute("test-tool", {}, makeContext(), manifest);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.content.length).toBeGreaterThan(4096);
      expect((result.data as Record<string, unknown>).resource_ref).toBeTruthy();
      expect(executor.getLedger()[0]!.resourceRef?.hasMore).toBe(true);
    });
  });
});

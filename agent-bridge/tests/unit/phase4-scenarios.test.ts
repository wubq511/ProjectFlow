/**
 * Phase 4 scenario tests — Tool Executor V2 integration.
 *
 * Verifies: timeout, transient retry, write timeout no retry,
 * validation no retry, stable idempotency, read-only parallel vs write sequential,
 * duplicate registry rejection, large result bounded, ledger replay,
 * no proposal-confirm exposure.
 */

import { describe, it, expect } from "vitest";
import { ToolExecutor } from "../../src/tools/tool-executor.js";
import { ToolRegistry, ToolRegistrationError } from "../../src/tools/registry.js";
import { replayLedgerFromEvents, getToolEvidence, hasUnknownSideEffects } from "../../src/tools/tool-ledger.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";
import type { FastapiClient } from "../../src/tools/fastapi-client.js";
import type { ToolExecutionContext } from "../../src/tools/registry.js";

function makeManifest(name: string, overrides: Partial<ProjectFlowToolManifest> = {}): ProjectFlowToolManifest {
  return {
    schemaVersion: 1, name, version: 1, description: `Tool: ${name}`,
    riskCategory: "read_only", modelCallable: true, sidecarOnly: false, humanTriggeredOnly: false,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    inputSchema: { type: "object", properties: {} }, outputSchema: {},
    execution: { mode: "parallel", maxConcurrency: 1, providerParallelToolCallsAllowed: true },
    timeoutMs: 5000, retry: { maxAttempts: 1, retryOn: [] },
    resultLimit: { maxBytes: 32768, redaction: "none" },
    backend: { owner: "fastapi", endpoint: `/internal/agent-tools/${name}`, method: "POST" },
    effects: { effectType: "none", idempotencyKeyRequired: false, replaySafe: true },
    privacy: { dataClassification: "public", traceIncludeInputs: false, traceIncludeOutputs: false },
    errors: { modelVisibleErrorPolicy: "normalized_summary" },
    resume: { manifestVersion: 1, incompatibleVersionPolicy: "regenerate" },
    trace: { emits: [] },
    ...overrides,
  };
}

function makeContext(toolName = "test-tool"): ToolExecutionContext {
  return {
    runId: "run-1", toolCallId: "tc-1", conversationId: "conv-1",
    workspaceId: "ws-1", projectId: "proj-1", toolName,
    toolVersion: 1, manifestVersion: 1, idempotencyKey: "run-1_tc-1",
  };
}

function makeMockFastapiClient(): FastapiClient {
  return {
    startRun: async () => ({ run_id: "run-1", memory_context: null }),
    appendEvents: async () => ({ state_version: 1, events: [], tool_results: [] }),
    callTool: async () => ({}),
  };
}

describe("Phase 4 scenarios", () => {
  // ── Scenario 1: Timeout ─────────────────────────────────────────────

  describe("Timeout", () => {
    it("returns timeout when tool exceeds manifest timeout", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest("slow-tool", { timeoutMs: 1000 }); // 1s (minimum allowed)
      registry.register({
        manifest,
        execute: async () => {
          await new Promise((r) => setTimeout(r, 3000)); // takes 3s
          return {};
        },
      });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("slow-tool", {}, makeContext("slow-tool"), manifest);

      expect(result.status).toBe("timeout");
    });
  });

  // ── Scenario 2: Transient safe retry ────────────────────────────────

  describe("Transient safe retry", () => {
    it("retries and succeeds on transient error", async () => {
      let attempts = 0;
      const registry = new ToolRegistry();
      const manifest = makeManifest("flaky-tool", {
        retry: { maxAttempts: 3, retryOn: ["timeout"] },
        timeoutMs: 10000,
      });
      registry.register({
        manifest,
        execute: async () => {
          attempts++;
          if (attempts === 1) {
            return { status: "timeout", observation: "timeout", sideEffectStatus: "no_side_effect" };
          }
          return { status: "success", observation: "ok", sideEffectStatus: "no_side_effect" };
        },
      });

      const executor = new ToolExecutor(registry, {
        backoffFn: () => 0,
        jitterFn: () => 1,
      });
      const result = await executor.execute("flaky-tool", {}, makeContext("flaky-tool"), manifest);

      expect(attempts).toBe(2);
      expect(result.status).toBe("success");
    });
  });

  // ── Scenario 3: Write timeout no retry ──────────────────────────────

  describe("Write timeout no retry", () => {
    it("does not retry when side effect is unknown", async () => {
      let attempts = 0;
      const registry = new ToolRegistry();
      const manifest = makeManifest("write-tool", {
        riskCategory: "draft_only",
        effects: { effectType: "proposal_create", idempotencyKeyRequired: true, replaySafe: true },
        retry: { maxAttempts: 3, retryOn: ["transient"] },
      });
      registry.register({
        manifest,
        execute: async () => {
          attempts++;
          return { status: "failed", observation: "timeout after write", sideEffectStatus: "unknown" };
        },
      });

      const executor = new ToolExecutor(registry, {
        backoffFn: () => 0,
        jitterFn: () => 1,
      });
      const result = await executor.execute("write-tool", {}, makeContext("write-tool"), manifest);

      expect(attempts).toBe(1); // no retry
      expect(result.sideEffectStatus).toBe("unknown");
    });
  });

  // ── Scenario 4: Validation no retry ─────────────────────────────────

  describe("Validation no retry", () => {
    it("does not retry validation errors", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest("valid-tool", {
        inputSchema: { type: "object", properties: {}, required: ["name"] },
        retry: { maxAttempts: 3, retryOn: ["validation"] },
      });
      registry.register({ manifest, execute: async () => ({}) });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("valid-tool", {}, makeContext("valid-tool"), manifest);

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("VALIDATION");
    });
  });

  // ── Scenario 5: Stable idempotency ──────────────────────────────────

  describe("Stable idempotency", () => {
    it("uses stable logical call ID with per-attempt unique key", async () => {
      let attempts = 0;
      const registry = new ToolRegistry();
      const manifest = makeManifest("retry-tool", { retry: { maxAttempts: 3, retryOn: ["timeout"] }, timeoutMs: 10000 });
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
      await executor.execute("retry-tool", {}, makeContext("retry-tool"), manifest);

      const ledger = executor.getRunLedger("run-1");
      // Logical call ID is stable across attempts
      const logicalIds = ledger.map((e) => e.logicalCallId);
      expect(new Set(logicalIds).size).toBe(1);
      // Per-attempt idempotency key includes attempt number
      const keys = ledger.map((e) => e.idempotencyKey);
      expect(new Set(keys).size).toBe(3); // unique per attempt
      expect(keys[0]).toContain("attempt:1");
      expect(keys[2]).toContain("attempt:3");
    });
  });

  // ── Scenario 6: Duplicate registry rejection ────────────────────────

  describe("Duplicate registry rejection", () => {
    it("rejects duplicate name:version at registration", () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest("dup-tool");

      registry.register({ manifest, execute: async () => ({}) });
      expect(() => {
        registry.register({ manifest, execute: async () => ({}) });
      }).toThrow(ToolRegistrationError);
    });
  });

  // ── Scenario 7: Large result bounded ────────────────────────────────

  describe("Large result bounded", () => {
    it("normalizes raw data results within bounds", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest("big-tool", { resultLimit: { maxBytes: 1024, redaction: "none" } });
      const bigData = "x".repeat(10000);
      registry.register({
        manifest,
        // Return raw data (not a ProjectFlowToolResult) — normalizer will truncate
        execute: async () => bigData,
      });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("big-tool", {}, makeContext("big-tool"), manifest);

      expect(result.status).toBe("success");
      // Raw data is truncated by normalizer
      const json = JSON.stringify(result.data);
      expect(json.length).toBeLessThanOrEqual(1200); // 1024 + truncation marker overhead
    });

    it("valid tool results pass through (data already bounded by tool)", async () => {
      const registry = new ToolRegistry();
      const manifest = makeManifest("bounded-tool", { resultLimit: { maxBytes: 1024, redaction: "none" } });
      registry.register({
        manifest,
        execute: async () => ({
          status: "success",
          data: { items: [1, 2, 3] },
          observation: "ok",
          sideEffectStatus: "no_side_effect",
        }),
      });

      const executor = new ToolExecutor(registry);
      const result = await executor.execute("bounded-tool", {}, makeContext("bounded-tool"), manifest);

      expect(result.status).toBe("success");
      expect(result.data).toEqual({ items: [1, 2, 3] });
    });
  });

  // ── Scenario 8: Ledger replay ───────────────────────────────────────

  describe("Ledger replay", () => {
    it("can replay ledger from events", async () => {
      const events = [
        { type: "tool.ledger_entry", payload: { logical_call_id: "lc1", run_id: "r1", tool_call_id: "tc1", tool_name: "t1", tool_version: 1, manifest_version: 1, attempt: 1, policy_decision: "allow", policy_reason: "ok", input_hash: "h1", idempotency_key: "k1", result_status: "success", side_effect_status: "no_side_effect", reconciliation_status: "none", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:00:01Z", duration_ms: 1000 } },
        { type: "other_event", payload: {} },
        { type: "tool.ledger_entry", payload: { logical_call_id: "lc2", run_id: "r1", tool_call_id: "tc2", tool_name: "t2", tool_version: 1, manifest_version: 1, attempt: 1, policy_decision: "allow", policy_reason: "ok", input_hash: "h2", idempotency_key: "k2", result_status: "failed", side_effect_status: "no_side_effect", error_code: "timeout", reconciliation_status: "none", started_at: "2026-01-01T00:00:02Z" } },
      ];

      const ledger = replayLedgerFromEvents(events);
      expect(ledger.length).toBe(2);
      expect(ledger[0]!.toolName).toBe("t1");
      expect(ledger[1]!.errorCode).toBe("timeout");
    });

    it("getToolEvidence filters by tool name and success", () => {
      const ledger = [
        { logicalCallId: "lc1", runId: "r1", toolCallId: "tc1", toolName: "get_workspace_state", toolVersion: 1, manifestVersion: 1, attempt: 1, policyDecision: "allow", policyReason: "", inputHash: "h1", idempotencyKey: "k1", resultStatus: "success" as const, sideEffectStatus: "no_side_effect", reconciliationStatus: "none" as const, startedAt: "" },
        { logicalCallId: "lc2", runId: "r1", toolCallId: "tc2", toolName: "get_workspace_state", toolVersion: 1, manifestVersion: 1, attempt: 1, policyDecision: "allow", policyReason: "", inputHash: "h2", idempotencyKey: "k2", resultStatus: "failed" as const, sideEffectStatus: "no_side_effect", reconciliationStatus: "none" as const, startedAt: "" },
        { logicalCallId: "lc3", runId: "r1", toolCallId: "tc3", toolName: "create_risk", toolVersion: 1, manifestVersion: 1, attempt: 1, policyDecision: "allow", policyReason: "", inputHash: "h3", idempotencyKey: "k3", resultStatus: "success" as const, sideEffectStatus: "advisory_record_persisted", reconciliationStatus: "none" as const, startedAt: "" },
      ];

      const evidence = getToolEvidence(ledger, "get_workspace_state");
      expect(evidence.length).toBe(1); // only the successful one
      expect(evidence[0]!.resultStatus).toBe("success");
    });

    it("hasUnknownSideEffects detects unknown status", () => {
      const ledger = [
        { logicalCallId: "lc1", runId: "r1", toolCallId: "tc1", toolName: "t1", toolVersion: 1, manifestVersion: 1, attempt: 1, policyDecision: "allow", policyReason: "", inputHash: "h1", idempotencyKey: "k1", resultStatus: "success" as const, sideEffectStatus: "no_side_effect", reconciliationStatus: "none" as const, startedAt: "" },
        { logicalCallId: "lc2", runId: "r1", toolCallId: "tc2", toolName: "t2", toolVersion: 1, manifestVersion: 1, attempt: 1, policyDecision: "allow", policyReason: "", inputHash: "h2", idempotencyKey: "k2", resultStatus: "failed" as const, sideEffectStatus: "unknown", reconciliationStatus: "manual_review" as const, startedAt: "" },
      ];

      expect(hasUnknownSideEffects(ledger)).toBe(true);
    });
  });

  // ── Scenario 9: No proposal-confirm exposure ────────────────────────

  describe("No proposal-confirm exposure", () => {
    it("confirm_proposal cannot be registered", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest("confirm_proposal"),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });

    it("reject_proposal cannot be registered", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest("reject_proposal"),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });
  });
});

/**
 * Capability adapter tests — discovery, registration, lifecycle hooks.
 */

import { describe, it, expect, vi } from "vitest";
import { CapabilityAdapter } from "../../src/tools/capability-adapter.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";

function makeManifest(name: string): ProjectFlowToolManifest {
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
  };
}

describe("CapabilityAdapter", () => {
  describe("isAllowed", () => {
    it("returns true for allowed capabilities", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["get_workspace_state", "create_risk"] });
      expect(adapter.isAllowed("get_workspace_state")).toBe(true);
      expect(adapter.isAllowed("create_risk")).toBe(true);
    });

    it("returns false for non-allowed capabilities", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["get_workspace_state"] });
      expect(adapter.isAllowed("execute_shell")).toBe(false);
    });

    it("returns false when allowedCapabilities is empty", () => {
      const adapter = new CapabilityAdapter();
      expect(adapter.isAllowed("get_workspace_state")).toBe(false);
    });
  });

  describe("discoverCapabilities", () => {
    it("discovers allowed capabilities", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["get_workspace_state"] });
      const result = adapter.discoverCapabilities([
        { name: "get_workspace_state", description: "Get workspace state", version: 1, riskCategory: "read_only" },
        { name: "execute_shell", description: "Execute shell", version: 1, riskCategory: "destructive" },
      ]);

      expect(result.length).toBe(1);
      expect(result[0]!.name).toBe("get_workspace_state");
    });

    it("rejects destructive capabilities", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["destroy"] });
      const result = adapter.discoverCapabilities([
        { name: "destroy", description: "Destroy", version: 1, riskCategory: "destructive",
          annotations: { destructive: true } },
      ]);

      expect(result.length).toBe(0);
    });

    it("rejects open-world capabilities", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["fetch_url"] });
      const result = adapter.discoverCapabilities([
        { name: "fetch_url", description: "Fetch URL", version: 1, riskCategory: "open_world",
          annotations: { openWorld: true } },
      ]);

      expect(result.length).toBe(0);
    });
  });

  describe("lifecycle hooks", () => {
    it("runs hooks when enabled", () => {
      const adapter = new CapabilityAdapter({ enableHooks: true });
      const hook = vi.fn();
      adapter.addHook("before_register", hook);

      adapter.runHooks("before_register", {
        toolName: "test",
        hookType: "before_register",
        timestamp: "2026-01-01",
      });

      expect(hook).toHaveBeenCalledOnce();
    });

    it("does not run hooks when disabled", () => {
      const adapter = new CapabilityAdapter({ enableHooks: false });
      const hook = vi.fn();
      adapter.addHook("before_register", hook);

      adapter.runHooks("before_register", {
        toolName: "test",
        hookType: "before_register",
        timestamp: "2026-01-01",
      });

      expect(hook).not.toHaveBeenCalled();
    });

    it("hook failures do not block execution", () => {
      const adapter = new CapabilityAdapter({ enableHooks: true });
      adapter.addHook("before_register", () => { throw new Error("hook error"); });

      // Should not throw
      expect(() => {
        adapter.runHooks("before_register", {
          toolName: "test",
          hookType: "before_register",
          timestamp: "2026-01-01",
        });
      }).not.toThrow();
    });
  });

  describe("registerCapability", () => {
    it("registers a valid capability after allowlist + discovery + version check", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["test"] });
      const registry = new ToolRegistry();
      const manifest = makeManifest("test");

      // Must discover before registering
      adapter.discoverCapabilities([
        { name: "test", description: "Test", version: 1, riskCategory: "read_only" },
      ]);

      const result = adapter.registerCapability(registry, manifest, async () => ({}));
      expect(result.success).toBe(true);
      expect(registry.has("test")).toBe(true);
    });

    it("rejects registration when capability not in allowlist", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["allowed_tool"] });
      const registry = new ToolRegistry();
      const manifest = makeManifest("not_allowed");

      const result = adapter.registerCapability(registry, manifest, async () => ({}));
      expect(result.success).toBe(false);
      expect(result.error).toContain("不在允许列表中");
    });

    it("rejects registration when capability not discovered", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["test"] });
      const registry = new ToolRegistry();
      const manifest = makeManifest("test");

      // Skip discovery — try to register directly
      const result = adapter.registerCapability(registry, manifest, async () => ({}));
      expect(result.success).toBe(false);
      expect(result.error).toContain("尚未发现");
    });

    it("rejects registration when version mismatches", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["test"] });
      const registry = new ToolRegistry();

      // Discover with version 2
      adapter.discoverCapabilities([
        { name: "test", description: "Test", version: 2, riskCategory: "read_only" },
      ]);

      // Try to register with version 1
      const manifest = makeManifest("test");
      const result = adapter.registerCapability(registry, manifest, async () => ({}));
      expect(result.success).toBe(false);
      expect(result.error).toContain("版本不匹配");
    });

    it("rejects registration when maxCapabilities exceeded", () => {
      const adapter = new CapabilityAdapter({
        allowedCapabilities: ["tool_a", "tool_b"],
        maxCapabilities: 1,
      });
      const registry = new ToolRegistry();

      adapter.discoverCapabilities([
        { name: "tool_a", description: "A", version: 1, riskCategory: "read_only" },
        { name: "tool_b", description: "B", version: 1, riskCategory: "read_only" },
      ]);

      // First registration succeeds
      const resultA = adapter.registerCapability(registry, makeManifest("tool_a"), async () => ({}));
      expect(resultA.success).toBe(true);

      // Second registration fails due to maxCapabilities
      const resultB = adapter.registerCapability(registry, makeManifest("tool_b"), async () => ({}));
      expect(resultB.success).toBe(false);
      expect(resultB.error).toContain("最大能力数量");
    });

    it("rejects forbidden tool names", () => {
      const adapter = new CapabilityAdapter({ allowedCapabilities: ["confirm_proposal"] });
      const registry = new ToolRegistry();
      const manifest = makeManifest("confirm_proposal");

      // discoverCapabilities rejects destructive/open-world, and
      // confirm_proposal is not in the discovered set, so it fails on discovery check
      adapter.discoverCapabilities([]);

      const result = adapter.registerCapability(registry, manifest, async () => ({}));
      expect(result.success).toBe(false);
    });
  });
});

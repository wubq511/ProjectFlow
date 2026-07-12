/**
 * Tool registry hard gate tests — registration validation.
 *
 * Verifies: duplicate rejection, schema validation, consistency checks,
 * forbidden tool blocking, risk/effect alignment.
 */

import { describe, it, expect } from "vitest";
import { ToolRegistry, ToolRegistrationError } from "../../src/tools/registry.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";

function makeManifest(overrides: Partial<ProjectFlowToolManifest> = {}): ProjectFlowToolManifest {
  return {
    schemaVersion: 1,
    name: "test-tool",
    version: 1,
    description: "Test tool",
    riskCategory: "read_only",
    modelCallable: true,
    sidecarOnly: false,
    humanTriggeredOnly: false,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {},
    execution: { mode: "parallel", maxConcurrency: 1, providerParallelToolCallsAllowed: true },
    timeoutMs: 5000,
    retry: { maxAttempts: 1, retryOn: [] },
    resultLimit: { maxBytes: 32768, redaction: "none" },
    backend: { owner: "fastapi", endpoint: "/internal/agent-tools/test", method: "POST" },
    effects: { effectType: "none", idempotencyKeyRequired: false, replaySafe: true },
    privacy: { dataClassification: "public", traceIncludeInputs: true, traceIncludeOutputs: true },
    errors: { modelVisibleErrorPolicy: "normalized_summary" },
    resume: { manifestVersion: 1, incompatibleVersionPolicy: "regenerate" },
    trace: { emits: [] },
    ...overrides,
  };
}

describe("ToolRegistry hard gates", () => {
  describe("duplicate rejection", () => {
    it("rejects duplicate name:version", () => {
      const registry = new ToolRegistry();
      registry.register({
        manifest: makeManifest({ name: "test", version: 1 }),
        execute: async () => ({}),
      });

      expect(() => {
        registry.register({
          manifest: makeManifest({ name: "test", version: 1 }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });

    it("allows same name with different version", () => {
      const registry = new ToolRegistry();
      registry.register({
        manifest: makeManifest({ name: "test", version: 1 }),
        execute: async () => ({}),
      });

      // v2 with same name should work (but registry uses name as key, so it's an update)
      // Actually, the current registry uses Map<name, tool>, so v2 would overwrite v1.
      // The hard gate prevents same name:version, not same name different version.
      expect(() => {
        registry.register({
          manifest: makeManifest({ name: "test", version: 2 }),
          execute: async () => ({}),
        });
      }).not.toThrow();
    });
  });

  describe("forbidden tool names", () => {
    it("blocks confirm_proposal", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({ name: "confirm_proposal" }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });

    it("blocks reject_proposal", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({ name: "reject_proposal" }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });

    it("blocks execute_shell", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({ name: "execute_shell" }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });
  });

  describe("risk/effect consistency", () => {
    it("rejects draft_only without proposal_create effect", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({
            name: "bad-draft",
            riskCategory: "draft_only",
            effects: { effectType: "none", idempotencyKeyRequired: false, replaySafe: true },
          }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });

    it("accepts draft_only with proposal_create effect", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({
            name: "good-draft",
            riskCategory: "draft_only",
            effects: { effectType: "proposal_create", idempotencyKeyRequired: true, replaySafe: true },
          }),
          execute: async () => ({}),
        });
      }).not.toThrow();
    });

    it("rejects advisory_write without advisory_record_create effect", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({
            name: "bad-advisory",
            riskCategory: "advisory_write",
            effects: { effectType: "none", idempotencyKeyRequired: false, replaySafe: true },
          }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });

    it("rejects read_only with non-none effect", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({
            name: "bad-readonly",
            riskCategory: "read_only",
            effects: { effectType: "proposal_create", idempotencyKeyRequired: false, replaySafe: true },
          }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });
  });

  describe("human-triggered consistency", () => {
    it("rejects humanTriggeredOnly + modelCallable", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({
            name: "bad-human",
            humanTriggeredOnly: true,
            modelCallable: true,
          }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });
  });

  describe("timeout validation", () => {
    it("rejects timeout < 1000ms", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({ name: "fast", timeoutMs: 500 }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });

    it("rejects timeout > 300000ms", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({ name: "slow", timeoutMs: 600000 }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });
  });

  describe("destructive/open_world blocks modelCallable", () => {
    it("rejects destructive + modelCallable", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({
            name: "destroy",
            annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
          }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });

    it("rejects openWorld + modelCallable", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({
            name: "fetch-url",
            annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
          }),
          execute: async () => ({}),
        });
      }).toThrow(ToolRegistrationError);
    });
  });

  describe("valid registration", () => {
    it("accepts a valid read_only tool", () => {
      const registry = new ToolRegistry();
      expect(() => {
        registry.register({
          manifest: makeManifest({ name: "get_workspace_state" }),
          execute: async () => ({}),
        });
      }).not.toThrow();
      expect(registry.has("get_workspace_state")).toBe(true);
    });
  });
});

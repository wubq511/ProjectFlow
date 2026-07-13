/**
 * Tests for ModelRouter — registry-based model resolution.
 *
 * ModelRouter resolves model config entries from the ModelConfigStore registry.
 * Actual API calls are handled by Pi SDK model objects via resolveRealModel().
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ModelRouter } from "../../src/runtime/model-router.js";
import type { ModelConfigStore } from "../../src/config/model-config-store.js";
import type { ModelConfigEntryRuntime } from "../../src/types/model-config.js";

/** Minimal mock ModelConfigStore for testing. */
function createMockStore(entries: ModelConfigEntryRuntime[], defaultId?: string): ModelConfigStore {
  return {
    list: () => entries,
    listWire: () => entries,
    get: (id: string) => entries.find((e) => e.id === id),
    getValid: (id: string) => {
      const e = entries.find((e) => e.id === id);
      return e?.valid ? e : undefined;
    },
    getDefault: () => (defaultId ? entries.find((e) => e.id === defaultId) : entries.find((e) => e.isDefault && e.valid)),
    load: async () => {},
    add: async () => { throw new Error("not implemented"); },
    update: async () => { throw new Error("not implemented"); },
    delete: async () => { throw new Error("not implemented"); },
    persist: async () => {},
  } as unknown as ModelConfigStore;
}

const VALID_DEEPSEEK: ModelConfigEntryRuntime = {
  id: "deepseek-v4-flash",
  provider: "deepseek",
  name: "deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
  apiKeyEnvVar: "DEEPSEEK_API_KEY",
  isDefault: true,
  capabilities: { thinking: true, vision: false },
  apiKeySet: true,
  apiKeySuffix: "abcd",
  valid: true,
  invalidReason: undefined,
  resolvedBaseUrl: undefined,
};

const VALID_XIAOMI: ModelConfigEntryRuntime = {
  id: "mimo-v2.5",
  provider: "xiaomi",
  name: "mimo-v2.5",
  displayName: "MiMo V2.5",
  apiKeyEnvVar: "XIAOMI_API_KEY",
  isDefault: false,
  capabilities: { thinking: true, vision: true },
  apiKeySet: true,
  apiKeySuffix: "efgh",
  valid: true,
  invalidReason: undefined,
  resolvedBaseUrl: undefined,
};

const INVALID_ENTRY: ModelConfigEntryRuntime = {
  id: "bad-model",
  provider: "unknown-provider",
  name: "some-model",
  displayName: "Bad Model",
  apiKeyEnvVar: "MISSING_KEY",
  isDefault: false,
  capabilities: { thinking: false, vision: false },
  apiKeySet: false,
  apiKeySuffix: undefined,
  valid: false,
  invalidReason: "API key not set",
  resolvedBaseUrl: undefined,
};

describe("ModelRouter", () => {
  describe("resolve", () => {
    it("returns default when no id provided", () => {
      const store = createMockStore([VALID_DEEPSEEK, VALID_XIAOMI]);
      const router = new ModelRouter(store);
      const config = router.resolve();

      expect(config?.id).toBe("deepseek-v4-flash");
      expect(config?.provider).toBe("deepseek");
    });

    it("returns entry by id", () => {
      const store = createMockStore([VALID_DEEPSEEK, VALID_XIAOMI]);
      const router = new ModelRouter(store);
      const config = router.resolve("mimo-v2.5");

      expect(config?.id).toBe("mimo-v2.5");
      expect(config?.provider).toBe("xiaomi");
    });

    it("returns undefined for invalid entry id (no silent fallback)", () => {
      const store = createMockStore([VALID_DEEPSEEK, INVALID_ENTRY]);
      const router = new ModelRouter(store);
      const config = router.resolve("bad-model");

      // Invalid entries are NOT silently resolved — caller must handle
      expect(config).toBeUndefined();
    });

    it("returns undefined when id not found (no silent fallback)", () => {
      const store = createMockStore([VALID_DEEPSEEK]);
      const router = new ModelRouter(store);
      const config = router.resolve("nonexistent");

      // Unknown id is NOT silently resolved — caller must handle
      expect(config).toBeUndefined();
    });

    it("returns undefined when no entries exist", () => {
      const store = createMockStore([]);
      const router = new ModelRouter(store);
      const config = router.resolve();

      expect(config).toBeUndefined();
    });
  });

  describe("resolveWithMeta", () => {
    it("returns entry without fallback reason for valid id", () => {
      const store = createMockStore([VALID_DEEPSEEK, VALID_XIAOMI]);
      const router = new ModelRouter(store);
      const result = router.resolveWithMeta("mimo-v2.5");

      expect(result.entry?.id).toBe("mimo-v2.5");
      expect(result.fallbackReason).toBeUndefined();
      expect(result.requestedId).toBe("mimo-v2.5");
    });

    it("returns entry without fallback reason when no id", () => {
      const store = createMockStore([VALID_DEEPSEEK, VALID_XIAOMI]);
      const router = new ModelRouter(store);
      const result = router.resolveWithMeta();

      expect(result.entry?.id).toBe("deepseek-v4-flash");
      expect(result.fallbackReason).toBeUndefined();
      expect(result.requestedId).toBeUndefined();
    });

    it("returns resolutionFailed for invalid entry id", () => {
      const store = createMockStore([VALID_DEEPSEEK, INVALID_ENTRY]);
      const router = new ModelRouter(store);
      const result = router.resolveWithMeta("bad-model");

      expect(result.entry).toBeUndefined();
      expect(result.resolutionFailed).toBe(true);
      expect(result.fallbackReason).toContain("bad-model");
      expect(result.requestedId).toBe("bad-model");
    });

    it("returns resolutionFailed for nonexistent id", () => {
      const store = createMockStore([VALID_DEEPSEEK]);
      const router = new ModelRouter(store);
      const result = router.resolveWithMeta("nonexistent");

      expect(result.entry).toBeUndefined();
      expect(result.resolutionFailed).toBe(true);
      expect(result.fallbackReason).toContain("nonexistent");
      expect(result.requestedId).toBe("nonexistent");
    });

    it("resolves by provider:name composite key", () => {
      const store = createMockStore([VALID_DEEPSEEK, VALID_XIAOMI]);
      const router = new ModelRouter(store);
      const result = router.resolveWithMeta("xiaomi:mimo-v2.5");

      expect(result.entry?.id).toBe("mimo-v2.5");
      expect(result.fallbackReason).toBeUndefined();
    });

    it("returns resolutionFailed when explicit id and no default exists", () => {
      const store = createMockStore([INVALID_ENTRY]);
      const router = new ModelRouter(store);
      const result = router.resolveWithMeta("nonexistent");

      expect(result.entry).toBeUndefined();
      expect(result.resolutionFailed).toBe(true);
      expect(result.fallbackReason).toContain("nonexistent");
    });
  });

  describe("list", () => {
    it("returns all entries including invalid", () => {
      const store = createMockStore([VALID_DEEPSEEK, INVALID_ENTRY]);
      const router = new ModelRouter(store);
      const list = router.list();

      expect(list).toHaveLength(2);
    });
  });

  describe("getDefault", () => {
    it("returns the default entry", () => {
      const store = createMockStore([VALID_DEEPSEEK, VALID_XIAOMI]);
      const router = new ModelRouter(store);
      const def = router.getDefault();

      expect(def?.id).toBe("deepseek-v4-flash");
    });

    it("returns undefined when no default", () => {
      const store = createMockStore([VALID_XIAOMI]);
      const router = new ModelRouter(store);
      const def = router.getDefault();

      expect(def).toBeUndefined();
    });
  });
});

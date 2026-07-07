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

    it("falls back to default for invalid entry id", () => {
      const store = createMockStore([VALID_DEEPSEEK, INVALID_ENTRY]);
      const router = new ModelRouter(store);
      const config = router.resolve("bad-model");

      // Invalid entries are skipped, falls back to default
      expect(config?.id).toBe("deepseek-v4-flash");
    });

    it("falls back to default when id not found", () => {
      const store = createMockStore([VALID_DEEPSEEK]);
      const router = new ModelRouter(store);
      const config = router.resolve("nonexistent");

      expect(config?.id).toBe("deepseek-v4-flash");
    });

    it("returns undefined when no entries exist", () => {
      const store = createMockStore([]);
      const router = new ModelRouter(store);
      const config = router.resolve();

      expect(config).toBeUndefined();
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

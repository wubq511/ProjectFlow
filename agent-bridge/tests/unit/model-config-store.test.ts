/**
 * Tests for ModelConfigStore — default validation, atomic default clearing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { ModelConfigStore, type CatalogValidator, type CatalogModelInfo } from "../../src/config/model-config-store.js";

const TEST_DIR = resolve(tmpdir(), `model-config-store-test-${Date.now()}`);
const TEST_FILE = resolve(TEST_DIR, "model-configs.json");

const MOCK_ENV = {
  DEEPSEEK_API_KEY: "sk-test1234",
  XIAOMI_API_KEY: "sk-test5678",
};

function configsJson(models: Record<string, unknown>[]): string {
  return JSON.stringify({ models }, null, 2);
}

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("ModelConfigStore", () => {
  describe("load — default validation", () => {
    it("loads successfully with exactly one default", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
        { id: "b", provider: "xiaomi", name: "b", displayName: "B", apiKeyEnvVar: "XIAOMI_API_KEY", isDefault: false, capabilities: { thinking: true, vision: true } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      const defaults = store.list().filter((e) => e.isDefault && e.valid);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]!.id).toBe("a");
    });

    it("rejects zero defaults", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: false, capabilities: { thinking: true, vision: false } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await expect(store.load(MOCK_ENV)).rejects.toThrow("必须有且只有一个有效默认项");
    });

    it("rejects multiple defaults", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
        { id: "b", provider: "xiaomi", name: "b", displayName: "B", apiKeyEnvVar: "XIAOMI_API_KEY", isDefault: true, capabilities: { thinking: true, vision: true } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await expect(store.load(MOCK_ENV)).rejects.toThrow("必须有且只有一个有效默认项");
    });
  });

  describe("update — atomic default clearing", () => {
    it("setting new default clears old default", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
        { id: "b", provider: "xiaomi", name: "b", displayName: "B", apiKeyEnvVar: "XIAOMI_API_KEY", isDefault: false, capabilities: { thinking: true, vision: true } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      // Set b as default
      await store.update("b", { isDefault: true }, MOCK_ENV);

      const entries = store.list();
      const a = entries.find((e) => e.id === "a")!;
      const b = entries.find((e) => e.id === "b")!;

      expect(a.isDefault).toBe(false);
      expect(b.isDefault).toBe(true);
    });

    it("rejects removing last default", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      await expect(store.update("a", { isDefault: false }, MOCK_ENV)).rejects.toThrow("不能移除最后一个默认项");
    });
  });

  describe("add — atomic default clearing", () => {
    it("adding new default clears old default", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      await store.add({
        id: "b",
        provider: "xiaomi",
        name: "b",
        displayName: "B",
        apiKeyEnvVar: "XIAOMI_API_KEY",
        isDefault: true,
        capabilities: { thinking: true, vision: true },
      }, MOCK_ENV);

      const entries = store.list();
      const a = entries.find((e) => e.id === "a")!;
      const b = entries.find((e) => e.id === "b")!;

      expect(a.isDefault).toBe(false);
      expect(b.isDefault).toBe(true);
    });
  });

  describe("delete — prevent deleting last default", () => {
    it("rejects deleting last valid default", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
        { id: "b", provider: "xiaomi", name: "b", displayName: "B", apiKeyEnvVar: "XIAOMI_API_KEY", isDefault: false, capabilities: { thinking: true, vision: true } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      await expect(store.delete("a")).rejects.toThrow("不能删除最后一个有效默认模型配置");
    });

    it("allows deleting non-default entry", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
        { id: "b", provider: "xiaomi", name: "b", displayName: "B", apiKeyEnvVar: "XIAOMI_API_KEY", isDefault: false, capabilities: { thinking: true, vision: true } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      await store.delete("b");
      expect(store.list()).toHaveLength(1);
    });
  });

  describe("getDefault", () => {
    it("returns the single default", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
        { id: "b", provider: "xiaomi", name: "b", displayName: "B", apiKeyEnvVar: "XIAOMI_API_KEY", isDefault: false, capabilities: { thinking: true, vision: true } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      const def = store.getDefault();
      expect(def?.id).toBe("a");
    });
  });

  describe("copy-on-write — mutation failure leaves memory unchanged", () => {
    it("add() with duplicate id does not corrupt entries", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      const before = store.list().map((e) => ({ id: e.id, isDefault: e.isDefault }));

      await expect(store.add({
        id: "a", provider: "deepseek", name: "a", displayName: "A",
        apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: false,
        capabilities: { thinking: true, vision: false },
      }, MOCK_ENV)).rejects.toThrow("已存在");

      const after = store.list().map((e) => ({ id: e.id, isDefault: e.isDefault }));
      expect(after).toEqual(before);
    });

    it("update() rejecting last default does not corrupt entries", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      const before = store.list().map((e) => ({ id: e.id, isDefault: e.isDefault }));

      await expect(store.update("a", { isDefault: false }, MOCK_ENV)).rejects.toThrow("不能移除最后一个默认项");

      const after = store.list().map((e) => ({ id: e.id, isDefault: e.isDefault }));
      expect(after).toEqual(before);
    });

    it("delete() rejecting last default does not corrupt entries", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
        { id: "b", provider: "xiaomi", name: "b", displayName: "B", apiKeyEnvVar: "XIAOMI_API_KEY", isDefault: false, capabilities: { thinking: true, vision: true } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      const before = store.list().map((e) => ({ id: e.id, isDefault: e.isDefault }));

      await expect(store.delete("a")).rejects.toThrow("不能删除最后一个有效默认模型配置");

      const after = store.list().map((e) => ({ id: e.id, isDefault: e.isDefault }));
      expect(after).toEqual(before);
    });

    it("failed reload preserves last valid entries", async () => {
      // Initial valid load
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
      ]));

      const store = new ModelConfigStore({ filePath: TEST_FILE });
      await store.load(MOCK_ENV);

      const beforeIds = store.list().map((e) => e.id);
      expect(beforeIds).toEqual(["a"]);

      // Overwrite file with invalid config (zero defaults)
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "a", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: false, capabilities: { thinking: true, vision: false } },
      ]));

      await expect(store.load(MOCK_ENV)).rejects.toThrow("必须有且只有一个有效默认项");

      // In-memory entries must still be the old valid state
      const afterIds = store.list().map((e) => e.id);
      expect(afterIds).toEqual(beforeIds);
      expect(store.getDefault()?.id).toBe("a");
    });
  });

  describe("catalog validation", () => {
    const CATALOG_MODEL: CatalogModelInfo = {
      id: "deepseek-v4-flash",
      name: "deepseek-v4-flash",
      reasoning: true,
      input: ["text"],
      contextWindow: 131072,
      maxTokens: 8192,
      thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
    };

    it("derives contextTokens and thinking from catalog", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "deepseek-v4-flash", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: false, vision: false } },
      ]));

      const validator: CatalogValidator = async (_p, _n) => CATALOG_MODEL;
      const store = new ModelConfigStore({ filePath: TEST_FILE, catalogValidator: validator });
      await store.load(MOCK_ENV);

      const entry = store.get("a")!;
      expect(entry.capabilities.contextTokens).toBe(131072);
      expect(entry.capabilities.thinking).toBe(true);
      expect(entry.capabilities.maxTokens).toBe(8192);
      expect(entry.capabilities.supportedThinkingLevels).toEqual(["low", "medium", "high"]);
    });

    it("marks built-in provider model invalid when not in catalog", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "nonexistent-model", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
      ]));

      const validatorFn = vi.fn<CatalogValidator>().mockResolvedValue(null);
      const store = new ModelConfigStore({ filePath: TEST_FILE, catalogValidator: validatorFn });

      // load() throws because the only default is now invalid
      await expect(store.load(MOCK_ENV)).rejects.toThrow("必须有且只有一个有效默认项");

      // Catalog was consulted (validator was called)
      expect(validatorFn).toHaveBeenCalledWith("deepseek", "nonexistent-model");

      // Copy-on-write: entries are empty since load never completed successfully
      expect(store.list()).toHaveLength(0);
    });

    it("allows openai-compatible model not in catalog", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "compat", provider: "openai-compatible", name: "custom-model", displayName: "Custom", baseUrl: "http://localhost:8080/v1", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: false, vision: false } },
      ]));

      const validator: CatalogValidator = async () => null;
      const store = new ModelConfigStore({ filePath: TEST_FILE, catalogValidator: validator });
      await store.load(MOCK_ENV);

      const entry = store.get("compat")!;
      expect(entry.valid).toBe(true);
    });

    it("catalog infrastructure failure does not invalidate entries", async () => {
      await writeFile(TEST_FILE, configsJson([
        { id: "a", provider: "deepseek", name: "deepseek-v4-flash", displayName: "A", apiKeyEnvVar: "DEEPSEEK_API_KEY", isDefault: true, capabilities: { thinking: true, vision: false } },
      ]));

      const validator: CatalogValidator = async () => { throw new Error("import failed"); };
      const store = new ModelConfigStore({ filePath: TEST_FILE, catalogValidator: validator });
      await store.load(MOCK_ENV);

      const entry = store.get("a")!;
      // Infrastructure failure → entry stays valid (non-fatal)
      expect(entry.valid).toBe(true);
    });
  });
});

/**
 * Tests for ModelRouter — multi-provider model routing.
 *
 * Verifies:
 * - resolve() returns mock config for mock provider
 * - resolve() returns configured provider config
 * - resolve() throws for unconfigured provider
 * - resolve() uses default provider/model when not specified
 * - getEndpoint() returns correct URLs
 * - getAuthHeaders() returns correct headers per provider
 * - createModelRouterFromEnv() reads env vars correctly
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ModelRouter, createModelRouterFromEnv } from "../../src/runtime/model-router.js";
import type { ModelRouterConfig, ProviderConfig } from "../../src/runtime/model-router.js";

const openaiProvider: ProviderConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test-123",
  defaultModel: "gpt-4o-mini",
};

const anthropicProvider: ProviderConfig = {
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "sk-ant-test-456",
  defaultModel: "claude-sonnet-4-20250514",
};

const openrouterProvider: ProviderConfig = {
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-or-test-789",
  defaultModel: "openai/gpt-4o-mini",
};

function makeRouter(overrides: Partial<ModelRouterConfig> = {}): ModelRouter {
  return new ModelRouter({
    defaultProvider: "mock",
    defaultModel: "mock-model",
    providers: {},
    ...overrides,
  });
}

describe("ModelRouter", () => {
  describe("resolve", () => {
    it("returns mock config for mock provider", () => {
      const router = makeRouter();
      const config = router.resolve("mock", "mock-model");

      expect(config.provider).toBe("mock");
      expect(config.name).toBe("mock-model");
      expect(config.apiKey).toBeUndefined();
      expect(config.baseUrl).toBeUndefined();
    });

    it("returns configured provider config", () => {
      const router = makeRouter({
        providers: { openai: openaiProvider },
      });
      const config = router.resolve("openai", "gpt-4o");

      expect(config.provider).toBe("openai");
      expect(config.name).toBe("gpt-4o");
      expect(config.apiKey).toBe("sk-test-123");
      expect(config.baseUrl).toBe("https://api.openai.com/v1");
    });

    it("uses router defaultModel when model not specified", () => {
      const router = makeRouter({
        defaultModel: "router-default",
        providers: { openai: openaiProvider },
      });
      const config = router.resolve("openai");

      expect(config.name).toBe("router-default");
    });

    it("uses provider defaultModel when router defaultModel is falsy", () => {
      const router = new ModelRouter({
        defaultProvider: "mock",
        defaultModel: "",
        providers: { openai: openaiProvider },
      });
      const config = router.resolve("openai");

      expect(config.name).toBe("gpt-4o-mini");
    });

    it("uses default provider when not specified", () => {
      const router = makeRouter({
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        providers: { openai: openaiProvider },
      });
      const config = router.resolve();

      expect(config.provider).toBe("openai");
      expect(config.name).toBe("gpt-4o");
    });

    it("uses default model when not specified and provider has no defaultModel", () => {
      const router = makeRouter({
        defaultProvider: "mock",
        defaultModel: "default-model",
      });
      const config = router.resolve("mock");

      expect(config.name).toBe("default-model");
    });

    it("throws for unconfigured provider", () => {
      const router = makeRouter();

      expect(() => router.resolve("openai")).toThrow("未配置的模型提供商");
    });

    it("supports deepseek provider", () => {
      const router = makeRouter({
        providers: {
          deepseek: {
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "sk-ds-test",
            defaultModel: "deepseek-chat",
          },
        },
      });
      const config = router.resolve("deepseek", "deepseek-chat");

      expect(config.provider).toBe("deepseek");
      expect(config.name).toBe("deepseek-chat");
      expect(config.baseUrl).toBe("https://api.deepseek.com/v1");
    });

    it("supports openrouter provider", () => {
      const router = makeRouter({
        providers: { openrouter: openrouterProvider },
      });
      const config = router.resolve("openrouter", "openai/gpt-4o-mini");

      expect(config.provider).toBe("openrouter");
      expect(config.name).toBe("openai/gpt-4o-mini");
    });
  });

  describe("getEndpoint", () => {
    it("returns mock URL for mock provider", () => {
      const router = makeRouter();
      expect(router.getEndpoint("mock")).toBe("http://localhost:mock");
    });

    it("returns provider baseUrl", () => {
      const router = makeRouter({ providers: { openai: openaiProvider } });
      expect(router.getEndpoint("openai")).toBe("https://api.openai.com/v1");
    });

    it("throws for unconfigured provider", () => {
      const router = makeRouter();
      expect(() => router.getEndpoint("openai")).toThrow("未配置的模型提供商");
    });
  });

  describe("getAuthHeaders", () => {
    it("returns empty headers for mock provider", () => {
      const router = makeRouter();
      expect(router.getAuthHeaders("mock")).toEqual({});
    });

    it("returns Bearer token for OpenAI provider", () => {
      const router = makeRouter({ providers: { openai: openaiProvider } });
      const headers = router.getAuthHeaders("openai");

      expect(headers.Authorization).toBe("Bearer sk-test-123");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("returns x-api-key for Anthropic provider", () => {
      const router = makeRouter({ providers: { anthropic: anthropicProvider } });
      const headers = router.getAuthHeaders("anthropic");

      expect(headers["x-api-key"]).toBe("sk-ant-test-456");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers.Authorization).toBeUndefined();
    });

    it("returns Bearer token for OpenRouter provider", () => {
      const router = makeRouter({ providers: { openrouter: openrouterProvider } });
      const headers = router.getAuthHeaders("openrouter");

      expect(headers.Authorization).toBe("Bearer sk-or-test-789");
    });

    it("returns empty headers for unconfigured provider", () => {
      const router = makeRouter();
      expect(router.getAuthHeaders("openai")).toEqual({});
    });

    it("includes custom headers from provider config", () => {
      const router = makeRouter({
        providers: {
          openai: {
            ...openaiProvider,
            headers: { "X-Custom-Header": "custom-value" },
          },
        },
      });
      const headers = router.getAuthHeaders("openai");

      expect(headers["X-Custom-Header"]).toBe("custom-value");
    });
  });
});

describe("createModelRouterFromEnv", () => {
  it("creates a mock router when no env vars set", () => {
    const router = createModelRouterFromEnv({});
    const config = router.resolve();

    expect(config.provider).toBe("mock");
    expect(config.name).toBe("mock-model");
  });

  it("creates OpenAI provider from OPENAI_API_KEY", () => {
    const router = createModelRouterFromEnv({
      OPENAI_API_KEY: "sk-test",
    });
    const config = router.resolve("openai");

    expect(config.provider).toBe("openai");
    expect(config.apiKey).toBe("sk-test");
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("uses custom OpenAI base URL from env", () => {
    const router = createModelRouterFromEnv({
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "https://custom.openai.com/v1",
    });
    const config = router.resolve("openai");

    expect(config.baseUrl).toBe("https://custom.openai.com/v1");
  });

  it("uses custom OpenAI model from env when explicitly requested", () => {
    const router = createModelRouterFromEnv({
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-4o",
    });
    const config = router.resolve("openai", "gpt-4o");

    expect(config.name).toBe("gpt-4o");
  });

  it("creates OpenRouter provider from OPENROUTER_API_KEY", () => {
    const router = createModelRouterFromEnv({
      OPENROUTER_API_KEY: "sk-or-test",
    });
    const config = router.resolve("openrouter");

    expect(config.provider).toBe("openrouter");
    expect(config.apiKey).toBe("sk-or-test");
    expect(config.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("creates DeepSeek provider from DEEPSEEK_API_KEY", () => {
    const router = createModelRouterFromEnv({
      DEEPSEEK_API_KEY: "sk-ds-test",
    });
    const config = router.resolve("deepseek");

    expect(config.provider).toBe("deepseek");
    expect(config.apiKey).toBe("sk-ds-test");
    expect(config.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("creates Anthropic provider from ANTHROPIC_API_KEY", () => {
    const router = createModelRouterFromEnv({
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    const config = router.resolve("anthropic");

    expect(config.provider).toBe("anthropic");
    expect(config.apiKey).toBe("sk-ant-test");
    expect(config.baseUrl).toBe("https://api.anthropic.com/v1");
  });

  it("uses DEFAULT_MODEL_PROVIDER and DEFAULT_MODEL_NAME", () => {
    const router = createModelRouterFromEnv({
      DEFAULT_MODEL_PROVIDER: "openai",
      DEFAULT_MODEL_NAME: "gpt-4o",
      OPENAI_API_KEY: "sk-test",
    });
    const config = router.resolve();

    expect(config.provider).toBe("openai");
    expect(config.name).toBe("gpt-4o");
  });

  it("creates multiple providers simultaneously", () => {
    const router = createModelRouterFromEnv({
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
      DEEPSEEK_API_KEY: "sk-ds",
    });

    expect(router.resolve("openai").apiKey).toBe("sk-openai");
    expect(router.resolve("anthropic").apiKey).toBe("sk-ant");
    expect(router.resolve("deepseek").apiKey).toBe("sk-ds");
  });
});

/**
 * ModelConfigEntry — a single model configuration in the registry.
 *
 * Stored in `model-configs.json` (sidecar directory).
 * API keys are NOT stored here — only the env var name that holds the key.
 */

export interface ModelCapabilities {
  thinking: boolean;
  vision: boolean;
}

/** On-disk format (what's in model-configs.json) */
export interface ModelConfigEntry {
  /** Unique identifier for CRUD and frontend selection */
  id: string;
  /** Pi SDK provider name (deepseek, openai, anthropic, xiaomi, xiaomi-token-plan-cn, openrouter, openai-compatible, mock, …) */
  provider: string;
  /** Pi SDK model ID or custom model name */
  name: string;
  /** Display name shown in frontend */
  displayName: string;
  /** Custom endpoint URL (required for openai-compatible, optional override for others) */
  baseUrl?: string;
  /** Env var name to read baseUrl from (alternative to baseUrl) */
  baseUrlEnvVar?: string;
  /** Env var name that holds the API key */
  apiKeyEnvVar: string;
  /** Whether this is the default model */
  isDefault: boolean;
  /** Model capabilities */
  capabilities: ModelCapabilities;
}

/** Runtime-enriched format (after validation + env lookup) */
export interface ModelConfigEntryRuntime extends ModelConfigEntry {
  /** Whether the apiKeyEnvVar has a value in process.env */
  apiKeySet: boolean;
  /** Last 4 chars of the API key for display (e.g. "4b8"), or null */
  apiKeySuffix: string | null;
  /** Whether this entry passed validation */
  valid: boolean;
  /** If invalid, the reason */
  invalidReason: string | null;
  /** Resolved baseUrl (from baseUrl field or baseUrlEnvVar env lookup) */
  resolvedBaseUrl?: string;
}

/** Wire format for API responses (apiKey never exposed, only status) */
export interface ModelConfigEntryWire {
  id: string;
  provider: string;
  name: string;
  displayName: string;
  baseUrl?: string;
  baseUrlEnvVar?: string;
  apiKeyEnvVar: string;
  apiKeySet: boolean;
  apiKeySuffix: string | null;
  isDefault: boolean;
  capabilities: ModelCapabilities;
  valid: boolean;
  invalidReason: string | null;
}

/** Provider catalog model (for frontend "add model" dropdown) */
export interface ProviderCatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
}

/** Top-level model-configs.json structure */
export interface ModelConfigsFile {
  models: ModelConfigEntry[];
}

/** Known Pi SDK provider IDs that we support */
export type KnownProvider =
  | "deepseek"
  | "openai"
  | "anthropic"
  | "xiaomi"
  | "xiaomi-token-plan-cn"
  | "openrouter"
  | "openai-compatible"
  | "mock";

/** All supported provider IDs (known + any custom string) */
export type ProviderId = KnownProvider | (string & {});

/** Built-in provider list for frontend dropdown */
export const BUILTIN_PROVIDERS: { id: KnownProvider; displayName: string }[] = [
  { id: "deepseek", displayName: "DeepSeek" },
  { id: "openai", displayName: "OpenAI" },
  { id: "anthropic", displayName: "Anthropic" },
  { id: "xiaomi", displayName: "小米 (MiMo)" },
  { id: "xiaomi-token-plan-cn", displayName: "小米 Token 计费（国内）" },
  { id: "openrouter", displayName: "OpenRouter" },
  { id: "openai-compatible", displayName: "自定义（OpenAI 兼容）" },
  { id: "mock", displayName: "Mock（测试）" },
];

/** Default API key env var names per provider */
export const DEFAULT_API_KEY_ENV_VARS: Partial<Record<KnownProvider, string>> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
  mock: "",
};

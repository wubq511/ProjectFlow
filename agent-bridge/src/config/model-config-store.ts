/**
 * ModelConfigStore — reads, validates, and writes model-configs.json.
 *
 * On startup: loads the file, validates each entry, enriches with runtime info.
 * On CRUD: updates the in-memory registry and persists to disk.
 * On reload: re-reads from disk and re-validates.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ModelConfigEntry,
  ModelConfigEntryRuntime,
  ModelConfigsFile,
  ModelConfigEntryWire,
} from "@/types/model-config.js";

/** Catalog model info from Pi SDK (subset of Model fields relevant for validation). */
export interface CatalogModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
}

/** Async validator that checks a provider/name against the Pi SDK catalog. */
export type CatalogValidator = (provider: string, name: string) => Promise<CatalogModelInfo | null>;

export interface ModelConfigStoreConfig {
  /** Absolute path to model-configs.json */
  filePath: string;
  /** Optional async catalog validator (e.g. backed by getProviderCatalogModels). */
  catalogValidator?: CatalogValidator;
}

export class ModelConfigStore {
  private readonly filePath: string;
  private readonly catalogValidator?: CatalogValidator;
  private entries: ModelConfigEntryRuntime[] = [];

  constructor(config: ModelConfigStoreConfig) {
    this.filePath = config.filePath;
    this.catalogValidator = config.catalogValidator;
  }

  /** Load and validate from disk. Call on startup and reload. Copy-on-write: preserves last valid entries on failure. */
  async load(env: Record<string, string | undefined> = process.env): Promise<void> {
    const raw = await readFile(this.filePath, "utf-8");
    const parsed: ModelConfigsFile = JSON.parse(raw);
    // Work on a temporary array — don't touch this.entries until all validation passes
    const candidates = validateAndEnrich(parsed.models, env);

    // Catalog validation: derive capabilities from Pi SDK catalog where available
    if (this.catalogValidator) {
      await this.validateCatalog(candidates);
    }

    // Validate exactly one valid default
    const validDefaults = candidates.filter((e) => e.isDefault && e.valid);
    if (validDefaults.length === 0) {
      throw new Error("模型配置必须有且只有一个有效默认项，当前无有效默认项");
    }
    if (validDefaults.length > 1) {
      throw new Error(
        `模型配置必须有且只有一个有效默认项，当前有 ${validDefaults.length} 个: ${validDefaults.map((e) => e.id).join(", ")}`,
      );
    }

    // All validation passed — atomic swap
    this.entries = candidates;
  }

  /**
   * Validate entries against Pi SDK catalog and derive capability facts.
   *
   * For known built-in providers (not mock/openai-compatible/openrouter):
   * - Model must exist in catalog; missing → mark invalid
   * - Derive contextTokens from catalog contextWindow
   * - Derive thinking from catalog reasoning
   *
   * For openai-compatible/openrouter:
   * - Catalog lookup is best-effort; missing model is OK (custom names allowed)
   * - Still derive capabilities when catalog hit occurs
   *
   * Catalog infrastructure failure (e.g. import error) is always non-fatal.
   */
  private async validateCatalog(entries: ModelConfigEntryRuntime[]): Promise<void> {
    /** Providers where catalog is authoritative (missing model = invalid). */
    const AUTHORITATIVE_PROVIDERS = new Set(["deepseek", "openai", "anthropic", "xiaomi", "xiaomi-token-plan-cn"]);

    for (const entry of entries) {
      // Skip mock — catalog is not applicable
      if (entry.provider === "mock") continue;

      const isAuthoritative = AUTHORITATIVE_PROVIDERS.has(entry.provider);

      try {
        const catalogInfo = await this.catalogValidator!(entry.provider, entry.name);
        if (catalogInfo) {
          // Derive capabilities from catalog
          entry.capabilities.contextTokens = catalogInfo.contextWindow;
          entry.capabilities.maxTokens = catalogInfo.maxTokens;
          // Derive thinking support from catalog reasoning flag
          entry.capabilities.thinking = catalogInfo.reasoning;
          // Derive supported thinking levels from catalog thinkingLevelMap
          if (catalogInfo.thinkingLevelMap) {
            entry.capabilities.supportedThinkingLevels = Object.entries(catalogInfo.thinkingLevelMap)
              .filter(([, v]) => v !== null)
              .map(([k]) => k);
          }
          // Derive vision from catalog input types
          entry.capabilities.vision = catalogInfo.input.includes("image");
        } else {
          // Model not found in catalog
          if (isAuthoritative) {
            // Built-in provider model must exist in catalog
            entry.valid = false;
            entry.invalidReason = `模型 "${entry.name}" 未在 ${entry.provider} catalog 中找到`;
            console.warn(
              `[agent-bridge] 模型 "${entry.id}" (${entry.provider}:${entry.name}) 未在 catalog 中找到，已标记无效`,
            );
          } else {
            // openai-compatible/openrouter: custom names are allowed
            console.info(
              `[agent-bridge] 模型 "${entry.id}" (${entry.provider}:${entry.name}) 未在 catalog 中找到（自定义模型允许）`,
            );
          }
        }
      } catch (err) {
        // Catalog infrastructure failure — non-fatal, log and continue
        // Distinguish from model-not-found: the lookup itself failed
        console.warn(
          `[agent-bridge] 模型 "${entry.id}" catalog 查询异常（非模型不存在）: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Get all entries (runtime-enriched). */
  list(): ModelConfigEntryRuntime[] {
    return [...this.entries];
  }

  /** Get all entries as wire format (for API responses). */
  listWire(): ModelConfigEntryWire[] {
    return this.entries.map(toWire);
  }

  /** Get a single entry by id. */
  get(id: string): ModelConfigEntryRuntime | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Get the default entry. */
  getDefault(): ModelConfigEntryRuntime | undefined {
    return this.entries.find((e) => e.isDefault && e.valid);
  }

  /** Get a valid entry by id (for runtime resolution). */
  getValid(id: string): ModelConfigEntryRuntime | undefined {
    const entry = this.get(id);
    return entry?.valid ? entry : undefined;
  }

  /** Add a new entry. Validates and persists. Copy-on-write: never mutates this.entries until persist succeeds. */
  async add(entry: ModelConfigEntry, env: Record<string, string | undefined> = process.env): Promise<ModelConfigEntryRuntime> {
    const existing = this.entries.find((e) => e.id === entry.id);
    if (existing) {
      throw new Error(`模型配置 ID "${entry.id}" 已存在`);
    }

    // Work on a copy: clear defaults on copies, not the live array
    const copiedEntries = this.entries.map((e) => ({ ...e }));
    if (entry.isDefault) {
      for (const e of copiedEntries) {
        if (e.isDefault) e.isDefault = false;
      }
    }

    const enriched = validateAndEnrich([entry], env, copiedEntries)[0]!;

    // Build the new entries array and validate exactly one default
    const newEntries = [...copiedEntries, enriched];
    const validDefaults = newEntries.filter((e) => e.isDefault && e.valid);
    if (validDefaults.length === 0) {
      throw new Error("模型配置必须有且只有一个有效默认项，当前无有效默认项");
    }
    if (validDefaults.length > 1) {
      throw new Error(
        `模型配置必须有且只有一个有效默认项，当前有 ${validDefaults.length} 个: ${validDefaults.map((e) => e.id).join(", ")}`,
      );
    }

    // Atomic: replace in-memory and persist together
    const previousEntries = this.entries;
    this.entries = newEntries;
    try {
      await this.persist();
    } catch (err) {
      // Rollback in-memory on persist failure — restore exact pre-mutation state
      this.entries = previousEntries;
      throw err;
    }
    return enriched;
  }

  /** Update an existing entry. Validates and persists. Copy-on-write: never mutates this.entries until persist succeeds. */
  async update(id: string, patch: Partial<ModelConfigEntry>, env: Record<string, string | undefined> = process.env): Promise<ModelConfigEntryRuntime> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`模型配置 ID "${id}" 不存在`);
    }

    const current = this.entries[idx]!;
    const updated: ModelConfigEntry = {
      id: patch.id ?? current.id,
      provider: patch.provider ?? current.provider,
      name: patch.name ?? current.name,
      displayName: patch.displayName ?? current.displayName,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      baseUrlEnvVar: patch.baseUrlEnvVar ?? current.baseUrlEnvVar,
      apiKeyEnvVar: patch.apiKeyEnvVar ?? current.apiKeyEnvVar,
      isDefault: patch.isDefault ?? current.isDefault,
      capabilities: patch.capabilities ?? current.capabilities,
    };

    // If id changed, check for conflict (before touching copies)
    if (updated.id !== id && this.entries.some((e) => e.id === updated.id)) {
      throw new Error(`模型配置 ID "${updated.id}" 已存在`);
    }

    // Work on a copy: clear defaults on copies, not the live array
    const copiedEntries = this.entries.map((e) => ({ ...e }));
    if (updated.isDefault && !current.isDefault) {
      for (const e of copiedEntries) {
        if (e.id !== id && e.isDefault) e.isDefault = false;
      }
    }

    const enriched = validateAndEnrich([updated], env, copiedEntries)[0]!;

    // Build new entries array with the update applied
    const newEntries = [...copiedEntries];
    newEntries[idx] = enriched;

    // Validate exactly one valid default
    const validDefaults = newEntries.filter((e) => e.isDefault && e.valid);
    if (validDefaults.length === 0) {
      throw new Error("模型配置必须有且只有一个有效默认项，不能移除最后一个默认项");
    }
    if (validDefaults.length > 1) {
      throw new Error(
        `模型配置必须有且只有一个有效默认项，当前有 ${validDefaults.length} 个: ${validDefaults.map((e) => e.id).join(", ")}`,
      );
    }

    // Atomic: replace in-memory and persist together
    const previousEntries = this.entries;
    this.entries = newEntries;
    try {
      await this.persist();
    } catch (err) {
      // Rollback in-memory on persist failure
      this.entries = previousEntries;
      throw err;
    }
    return enriched;
  }

  /** Delete an entry by id. Persists. Copy-on-write: never mutates this.entries until validation passes. */
  async delete(id: string): Promise<void> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`模型配置 ID "${id}" 不存在`);
    }
    const entry = this.entries[idx]!;

    // Build new entries array (without the deleted entry) and validate
    const newEntries = this.entries.filter((_, i) => i !== idx);

    // Prevent deleting the last valid default
    if (entry.isDefault && entry.valid) {
      const remainingDefaults = newEntries.filter((e) => e.isDefault && e.valid);
      if (remainingDefaults.length === 0) {
        throw new Error("不能删除最后一个有效默认模型配置，请先设置其他模型为默认");
      }
    }

    // Atomic: replace in-memory and persist together
    const previousEntries = this.entries;
    this.entries = newEntries;
    try {
      await this.persist();
    } catch (err) {
      // Rollback in-memory on persist failure
      this.entries = previousEntries;
      throw err;
    }
  }

  /** Persist current entries to disk (atomic write). */
  private async persist(): Promise<void> {
    const file: ModelConfigsFile = {
      models: this.entries.map((e) => ({
        id: e.id,
        provider: e.provider,
        name: e.name,
        displayName: e.displayName,
        ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
        ...(e.baseUrlEnvVar ? { baseUrlEnvVar: e.baseUrlEnvVar } : {}),
        apiKeyEnvVar: e.apiKeyEnvVar,
        isDefault: e.isDefault,
        capabilities: e.capabilities,
      })),
    };
    // Atomic write: temp file in same dir, then rename
    const dir = resolve(this.filePath, "..");
    const tmpPath = resolve(dir, `.model-configs-write-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tmpPath, JSON.stringify(file, null, 2) + "\n", "utf-8");
    await rename(tmpPath, this.filePath);
  }

  /** Get the file path (for file watcher). */
  getFilePath(): string {
    return this.filePath;
  }
}

// ─── Validation & Enrichment ───────────────────────────────────────────

function validateAndEnrich(
  entries: ModelConfigEntry[],
  env: Record<string, string | undefined>,
  existingEntries?: ModelConfigEntryRuntime[],
): ModelConfigEntryRuntime[] {
  const ids = new Set<string>();
  let defaultCount = 0;

  // Count defaults among existing entries (for add/update context)
  if (existingEntries) {
    for (const e of existingEntries) {
      if (e.isDefault && e.valid) defaultCount++;
    }
  }

  return entries.map((entry) => {
    const reasons: string[] = [];

    // Check id uniqueness
    if (ids.has(entry.id)) {
      reasons.push(`ID "${entry.id}" 重复`);
    }
    ids.add(entry.id);

    // Check required fields
    if (!entry.provider) reasons.push("provider 不能为空");
    if (!entry.name) reasons.push("name 不能为空");
    if (!entry.displayName) reasons.push("displayName 不能为空");
    if (!entry.apiKeyEnvVar && entry.provider !== "mock") reasons.push("apiKeyEnvVar 不能为空");

    // Check isDefault — count for validation
    if (entry.isDefault) defaultCount++;

    // Check capabilities
    if (!entry.capabilities || typeof entry.capabilities.thinking !== "boolean" || typeof entry.capabilities.vision !== "boolean") {
      reasons.push("capabilities 格式错误");
    }

    // Check API key
    const apiKeyValue = env[entry.apiKeyEnvVar];
    const apiKeySet = !!apiKeyValue;
    // Only expose last 4 chars; never expose short keys in full
    const apiKeySuffix = apiKeyValue && apiKeyValue.length >= 4
      ? apiKeyValue.slice(-4)
      : apiKeyValue ? "****" : null;

    if (!apiKeySet && entry.provider !== "mock") {
      reasons.push(`环境变量 ${entry.apiKeyEnvVar} 未设置`);
    }

    // Resolve baseUrl
    const resolvedBaseUrl = entry.baseUrl ?? (entry.baseUrlEnvVar ? env[entry.baseUrlEnvVar] : undefined);

    // For openai-compatible, baseUrl is required
    if (entry.provider === "openai-compatible" && !resolvedBaseUrl) {
      reasons.push("openai-compatible 必须设置 baseUrl 或 baseUrlEnvVar");
    }

    const valid = reasons.length === 0;

    if (!valid) {
      console.warn(`[agent-bridge] 模型配置 "${entry.id}" 无效: ${reasons.join("; ")}`);
    }

    return {
      ...entry,
      apiKeySet,
      apiKeySuffix,
      valid,
      invalidReason: valid ? null : reasons.join("; "),
      resolvedBaseUrl,
    };
  });
}

// ─── Wire Format Conversion ───────────────────────────────────────────

function toWire(entry: ModelConfigEntryRuntime): ModelConfigEntryWire {
  return {
    id: entry.id,
    provider: entry.provider,
    name: entry.name,
    displayName: entry.displayName,
    baseUrl: entry.baseUrl,
    baseUrlEnvVar: entry.baseUrlEnvVar,
    apiKeyEnvVar: entry.apiKeyEnvVar,
    apiKeySet: entry.apiKeySet,
    apiKeySuffix: entry.apiKeySuffix,
    isDefault: entry.isDefault,
    capabilities: entry.capabilities,
    valid: entry.valid,
    invalidReason: entry.invalidReason,
  };
}

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

export interface ModelConfigStoreConfig {
  /** Absolute path to model-configs.json */
  filePath: string;
}

export class ModelConfigStore {
  private readonly filePath: string;
  private entries: ModelConfigEntryRuntime[] = [];

  constructor(config: ModelConfigStoreConfig) {
    this.filePath = config.filePath;
  }

  /** Load and validate from disk. Call on startup and reload. */
  async load(env: Record<string, string | undefined> = process.env): Promise<void> {
    const raw = await readFile(this.filePath, "utf-8");
    const parsed: ModelConfigsFile = JSON.parse(raw);
    this.entries = validateAndEnrich(parsed.models, env);
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

  /** Add a new entry. Validates and persists. */
  async add(entry: ModelConfigEntry, env: Record<string, string | undefined> = process.env): Promise<ModelConfigEntryRuntime> {
    const existing = this.entries.find((e) => e.id === entry.id);
    if (existing) {
      throw new Error(`模型配置 ID "${entry.id}" 已存在`);
    }

    const enriched = validateAndEnrich([entry], env)[0]!;
    this.entries.push(enriched);
    await this.persist();
    return enriched;
  }

  /** Update an existing entry. Validates and persists. */
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

    const enriched = validateAndEnrich([updated], env)[0]!;

    // If id changed, check for conflict
    if (updated.id !== id && this.entries.some((e) => e.id === updated.id)) {
      throw new Error(`模型配置 ID "${updated.id}" 已存在`);
    }

    this.entries[idx] = enriched;
    await this.persist();
    return enriched;
  }

  /** Delete an entry by id. Persists. */
  async delete(id: string): Promise<void> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`模型配置 ID "${id}" 不存在`);
    }
    this.entries.splice(idx, 1);
    await this.persist();
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
): ModelConfigEntryRuntime[] {
  const ids = new Set<string>();
  let defaultCount = 0;

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

    // Check isDefault
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

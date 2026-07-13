/**
 * Model router — resolves model configuration from the registry.
 *
 * The registry is loaded from `model-configs.json` via ModelConfigStore.
 * This module answers: "which model config entry?" for a given id,
 * and provides the default model.
 *
 * Actual API calls (URL, auth, request format) are handled entirely by Pi SDK
 * model objects obtained via `resolveRealModel()` in pi-runtime.ts.
 */

import type { ModelConfigStore } from "@/config/model-config-store.js";
import type { ModelConfigEntryRuntime } from "@/types/model-config.js";

/** Result of model resolution with metadata about how the entry was selected. */
export interface ModelResolveResult {
  /** The resolved model config entry. */
  entry: ModelConfigEntryRuntime | undefined;
  /** If the resolved entry differs from what was requested, the reason. */
  fallbackReason?: string;
  /** The originally requested model id (if any). */
  requestedId?: string;
  /** True when an explicit id was provided but could not be resolved — caller must NOT silently proceed. */
  resolutionFailed?: boolean;
}

export class ModelRouter {
  private readonly store: ModelConfigStore;

  constructor(store: ModelConfigStore) {
    this.store = store;
  }

  /** Resolve a model config entry by id, falling back to the default. */
  resolve(id?: string): ModelConfigEntryRuntime | undefined {
    return this.resolveWithMeta(id).entry;
  }

  /**
   * Resolve with metadata about fallback. Silent mismatch is impossible.
   *
   * When an explicit id is provided but cannot be resolved, `resolutionFailed`
   * is true and `entry` is undefined — the caller MUST NOT silently proceed
   * with a fallback model. Only when no id is provided does the default apply.
   */
  resolveWithMeta(id?: string): ModelResolveResult {
    if (id) {
      // Try exact id match first
      const entry = this.store.getValid(id);
      if (entry) return { entry, requestedId: id };
      // Fallback: try provider:name composite key
      if (id.includes(":")) {
        const [provider, name] = id.split(":", 2);
        const byProviderName = this.list().find(
          (e) => e.valid && e.provider === provider && e.name === name,
        );
        if (byProviderName) return { entry: byProviderName, requestedId: id };
      }
      // Explicit id provided but not found/valid — fail explicitly, do NOT fall back
      return {
        entry: undefined,
        requestedId: id,
        resolutionFailed: true,
        fallbackReason: `请求的模型 "${id}" 无效或不存在，请检查模型配置`,
      };
    }
    // No id — use default (this is normal, not a fallback)
    return { entry: this.store.getDefault() };
  }

  /** List all entries (including invalid ones for display). */
  list(): ModelConfigEntryRuntime[] {
    return this.store.list();
  }

  /** Get the default entry. */
  getDefault(): ModelConfigEntryRuntime | undefined {
    return this.store.getDefault();
  }

  /** Get the underlying store (for routes that need direct access). */
  getStore(): ModelConfigStore {
    return this.store;
  }
}

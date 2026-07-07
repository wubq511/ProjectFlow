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

export class ModelRouter {
  private readonly store: ModelConfigStore;

  constructor(store: ModelConfigStore) {
    this.store = store;
  }

  /** Resolve a model config entry by id, falling back to the default. */
  resolve(id?: string): ModelConfigEntryRuntime | undefined {
    if (id) {
      // Try exact id match first
      const entry = this.store.getValid(id);
      if (entry) return entry;
      // Fallback: try provider:name composite key
      if (id.includes(":")) {
        const [provider, name] = id.split(":", 2);
        const byProviderName = this.list().find(
          (e) => e.valid && e.provider === provider && e.name === name,
        );
        if (byProviderName) return byProviderName;
      }
    }
    return this.store.getDefault();
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

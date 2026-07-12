/**
 * Capability Adapter — controlled MCP-style capability discovery and registration.
 *
 * Only allows pre-approved ProjectFlow capabilities.
 * Discovery returns bounded metadata; full schema loaded on demand.
 * Registration passes through ToolRegistry hard gates.
 *
 * Lifecycle hooks allow deterministic enforcement/telemetry only.
 * Generic shell/file/SQL/URL/open-world is rejected.
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Phase 6
 */

import type { ProjectFlowToolManifest } from "@/types/tool-manifest.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Capability descriptor returned by discovery.
 */
export interface CapabilityDescriptor {
  name: string;
  description: string;
  version: number;
  riskCategory: string;
  annotations: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;
  };
  /** Whether full schema is available on demand */
  schemaAvailable: boolean;
}

/**
 * Lifecycle hook types.
 */
export type LifecycleHookType =
  | "before_register"    // before tool registration
  | "after_register"     // after successful registration
  | "before_execute"     // before tool execution
  | "after_execute"      // after tool execution
  | "on_error";          // on tool execution error

/**
 * Lifecycle hook context.
 */
export interface LifecycleHookContext {
  toolName: string;
  hookType: LifecycleHookType;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Lifecycle hook function.
 * Must be deterministic and cannot mutate primary state.
 */
export type LifecycleHook = (context: LifecycleHookContext) => void;

/**
 * Capability adapter configuration.
 */
export interface CapabilityAdapterConfig {
  /** Allowed capability names (empty = no capabilities) */
  allowedCapabilities: string[];
  /** Whether to enable lifecycle hooks */
  enableHooks: boolean;
  /** Maximum number of registered capabilities */
  maxCapabilities: number;
}

const DEFAULT_CONFIG: CapabilityAdapterConfig = {
  allowedCapabilities: [],
  enableHooks: false,
  maxCapabilities: 50,
};

/**
 * Capability adapter — controlled discovery and registration.
 */
export class CapabilityAdapter {
  private readonly config: CapabilityAdapterConfig;
  private readonly hooks: Map<LifecycleHookType, LifecycleHook[]> = new Map();
  private readonly discoveredCapabilities: Map<string, CapabilityDescriptor> = new Map();

  constructor(config: Partial<CapabilityAdapterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a lifecycle hook.
   * Hooks are deterministic and cannot mutate primary state.
   */
  addHook(type: LifecycleHookType, hook: LifecycleHook): void {
    if (!this.config.enableHooks) return;
    const hooks = this.hooks.get(type) ?? [];
    hooks.push(hook);
    this.hooks.set(type, hooks);
  }

  /**
   * Run lifecycle hooks for a given type.
   * Hook failures are logged but do not block execution.
   */
  runHooks(type: LifecycleHookType, context: LifecycleHookContext): void {
    if (!this.config.enableHooks) return;
    const hooks = this.hooks.get(type) ?? [];
    for (const hook of hooks) {
      try {
        hook(context);
      } catch (err) {
        console.warn(`[capability-adapter] hook ${type} failed for ${context.toolName}:`, err);
      }
    }
  }

  /**
   * Check if a capability name is allowed.
   */
  isAllowed(capabilityName: string): boolean {
    return this.config.allowedCapabilities.includes(capabilityName);
  }

  /**
   * Discover capabilities from a source (bounded metadata only).
   * Full schema is loaded on demand via getCapabilitySchema().
   */
  discoverCapabilities(
    source: Array<{ name: string; description: string; version: number; riskCategory: string; annotations?: Record<string, boolean> }>,
  ): CapabilityDescriptor[] {
    const descriptors: CapabilityDescriptor[] = [];

    for (const item of source) {
      // Only allow pre-approved capabilities
      if (!this.isAllowed(item.name)) continue;

      // Reject destructive/open-world
      if (item.annotations?.destructive || item.annotations?.openWorld) continue;

      const descriptor: CapabilityDescriptor = {
        name: item.name,
        description: item.description,
        version: item.version,
        riskCategory: item.riskCategory,
        annotations: {
          readOnly: item.annotations?.readOnly ?? false,
          destructive: item.annotations?.destructive ?? false,
          idempotent: item.annotations?.idempotent ?? true,
          openWorld: item.annotations?.openWorld ?? false,
        },
        schemaAvailable: true,
      };

      this.discoveredCapabilities.set(descriptor.name, descriptor);
      descriptors.push(descriptor);
    }

    return descriptors;
  }

  /**
   * Get a discovered capability by name.
   */
  getCapability(name: string): CapabilityDescriptor | undefined {
    return this.discoveredCapabilities.get(name);
  }

  /**
   * Register a capability as a tool in the registry.
   * Enforces allowlist, discovery, version, and maxCapabilities checks.
   * Hooks are fail-open (telemetry); enforcement is fail-closed.
   */
  registerCapability(
    registry: ToolRegistry,
    manifest: ProjectFlowToolManifest,
    executeFn: (args: Record<string, unknown>, context: unknown) => Promise<unknown>,
  ): { success: boolean; error?: string } {
    // Enforcement checks (fail-closed) — P1 fix

    // 1. Check allowlist
    if (!this.isAllowed(manifest.name)) {
      return { success: false, error: `能力 ${manifest.name} 不在允许列表中` };
    }

    // 2. Check discovery — must be discovered before registration
    const discovered = this.discoveredCapabilities.get(manifest.name);
    if (!discovered) {
      return { success: false, error: `能力 ${manifest.name} 尚未发现，无法注册` };
    }

    // 3. Check version match
    if (discovered.version !== manifest.version) {
      return {
        success: false,
        error: `能力 ${manifest.name} 版本不匹配: 发现版本 ${discovered.version}, 注册版本 ${manifest.version}`,
      };
    }

    // 4. Check maxCapabilities
    if (registry.size >= this.config.maxCapabilities) {
      return {
        success: false,
        error: `已达到最大能力数量限制 (${this.config.maxCapabilities})`,
      };
    }

    // Run before_register hook (fail-open — telemetry only)
    this.runHooks("before_register", {
      toolName: manifest.name,
      hookType: "before_register",
      timestamp: new Date().toISOString(),
    });

    try {
      registry.register({ manifest, execute: executeFn });

      // Run after_register hook (fail-open)
      this.runHooks("after_register", {
        toolName: manifest.name,
        hookType: "after_register",
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      // Run on_error hook (fail-open)
      this.runHooks("on_error", {
        toolName: manifest.name,
        hookType: "on_error",
        timestamp: new Date().toISOString(),
        metadata: { error },
      });

      return { success: false, error };
    }
  }

  /**
   * Get all discovered capabilities (bounded metadata).
   */
  listCapabilities(): CapabilityDescriptor[] {
    return Array.from(this.discoveredCapabilities.values());
  }
}

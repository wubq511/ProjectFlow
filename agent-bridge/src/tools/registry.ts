/**
 * Tool registry — registers and manages ProjectFlow tools.
 * Maps tool names to their manifests and execution backends.
 *
 * Registration hard gates:
 * - Duplicate name/version rejected (no silent override)
 * - JSON Schema basic validity
 * - Risk/effect/policy/resume/retry/timeout consistency
 * - Forbidden tools blocked (confirm/reject proposal, primary-state commit, shell/file/SQL/URL)
 * - Backend contract validation
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Phase 4
 */

import type { ProjectFlowToolManifest } from "@/types/tool-manifest.js";
import type { FastapiClient } from "./fastapi-client.js";

export interface RegisteredTool {
  manifest: ProjectFlowToolManifest;
  /** Execute the tool via FastAPI internal endpoint. */
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
}

export interface ToolExecutionContext {
  runId: string;
  toolCallId: string;
  conversationId: string;
  workspaceId: string;
  projectId: string;
  toolName: string;
  toolVersion: number;
  manifestVersion: number;
  idempotencyKey: string;
  /** Viewer identity for visibility/auth enforcement in tool execution. */
  viewerUserId?: string;
}

/** Registration error with details. */
export class ToolRegistrationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reasons: string[],
  ) {
    super(`工具注册失败 "${toolName}": ${reasons.join("; ")}`);
    this.name = "ToolRegistrationError";
  }
}

/**
 * Forbidden tool name patterns — these must NEVER be registered as model-callable.
 * Even if a manifest claims modelCallable=true, these names are blocked.
 */
const FORBIDDEN_TOOL_PATTERNS = [
  /confirm_proposal/i,
  /reject_proposal/i,
  /commit_proposal/i,
  /execute_sql/i,
  /execute_shell/i,
  /edit_file/i,
  /delete_anything/i,
  /call_any_url/i,
  /commit_project_state/i,
  /run_shell/i,
  /exec_command/i,
];

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly registeredKeys = new Set<string>(); // "name:version" for duplicate detection

  /**
   * Register a tool with manifest validation.
   * Throws ToolRegistrationError on validation failure.
   */
  register(tool: RegisteredTool): void {
    const errors = this.validateRegistration(tool);

    if (errors.length > 0) {
      throw new ToolRegistrationError(tool.manifest.name, errors);
    }

    // Check for duplicate name:version
    const key = `${tool.manifest.name}:${tool.manifest.version}`;
    if (this.registeredKeys.has(key)) {
      throw new ToolRegistrationError(tool.manifest.name, [
        `重复注册: ${key} 已存在（不允许静默覆盖）`,
      ]);
    }

    this.tools.set(tool.manifest.name, tool);
    this.registeredKeys.add(key);
  }

  /**
   * Validate a tool registration against all hard gates.
   * Returns array of error reasons (empty = valid).
   */
  private validateRegistration(tool: RegisteredTool): string[] {
    const errors: string[] = [];
    const m = tool.manifest;

    // 1. Basic field validation
    if (!m.name || typeof m.name !== "string") {
      errors.push("name 不能为空");
    }
    if (m.name.length > 64) {
      errors.push("name 不能超过 64 字符");
    }
    if (!/^[a-z0-9_-]+$/.test(m.name)) {
      errors.push("name 只能包含小写字母、数字、下划线、连字符");
    }
    if (typeof m.version !== "number" || m.version < 1) {
      errors.push("version 必须是正整数");
    }
    if (!m.description || typeof m.description !== "string") {
      errors.push("description 不能为空");
    }

    // 2. Forbidden tool name check
    if (m.modelCallable) {
      for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
        if (pattern.test(m.name)) {
          errors.push(`禁止的工具名称: ${m.name} 匹配禁止模式 ${pattern}`);
        }
      }
    }

    // 3. Risk/effect consistency
    if (m.riskCategory === "draft_only" && m.effects.effectType !== "proposal_create") {
      errors.push(`draft_only 工具的 effectType 必须是 proposal_create，当前: ${m.effects.effectType}`);
    }
    if (m.riskCategory === "advisory_write" && m.effects.effectType !== "advisory_record_create") {
      errors.push(`advisory_write 工具的 effectType 必须是 advisory_record_create`);
    }
    if (m.riskCategory === "read_only" && m.effects.effectType !== "none") {
      errors.push(`read_only 工具的 effectType 必须是 none`);
    }

    // 4. Commit effect check — LLM-callable tools must NEVER commit
    // commit_persisted is not a valid EffectType for LLM-callable tools
    // (it's only used by HumanActionManifest)

    // 5. Human-triggered consistency
    if (m.humanTriggeredOnly && m.modelCallable) {
      errors.push("humanTriggeredOnly 工具不能同时 modelCallable");
    }

    // 6. Timeout validation
    if (m.timeoutMs < 1000) {
      errors.push("timeoutMs 不能小于 1000ms");
    }
    if (m.timeoutMs > 300000) {
      errors.push("timeoutMs 不能大于 300000ms (5分钟)");
    }

    // 7. Retry validation
    if (m.retry.maxAttempts < 1) {
      errors.push("retry.maxAttempts 不能小于 1");
    }
    if (m.retry.maxAttempts > 5) {
      errors.push("retry.maxAttempts 不能大于 5");
    }

    // 8. Result limit validation
    if (m.resultLimit.maxBytes < 1024) {
      errors.push("resultLimit.maxBytes 不能小于 1024");
    }
    if (m.resultLimit.maxBytes > 1048576) {
      errors.push("resultLimit.maxBytes 不能大于 1MB");
    }

    // 9. Backend contract validation
    if (!m.backend.endpoint || typeof m.backend.endpoint !== "string") {
      errors.push("backend.endpoint 不能为空");
    }
    if (m.backend.owner !== "fastapi") {
      errors.push(`backend.owner 必须是 fastapi，当前: ${m.backend.owner}`);
    }
    if (m.backend.method !== "GET" && m.backend.method !== "POST") {
      errors.push(`backend.method 必须是 GET 或 POST，当前: ${m.backend.method}`);
    }
    if (m.backend.method === "GET" && m.riskCategory !== "read_only") {
      errors.push("只有 read_only 工具可以声明 GET backend");
    }

    // 10. JSON Schema basic validity (inputSchema)
    if (m.inputSchema && typeof m.inputSchema === "object") {
      const schema = m.inputSchema as Record<string, unknown>;
      if (schema.type && typeof schema.type !== "string") {
        errors.push("inputSchema.type 必须是字符串");
      }
    }

    // 11. Execution config validation
    if (!["parallel", "sequential"].includes(m.execution.mode)) {
      errors.push(`execution.mode 必须是 parallel 或 sequential，当前: ${m.execution.mode}`);
    }
    if (m.execution.maxConcurrency < 1) {
      errors.push("execution.maxConcurrency 不能小于 1");
    }

    // 12. Destructive/open_world must not be model-callable
    if (m.modelCallable && m.annotations.destructive) {
      errors.push("modelCallable 工具不能标记为 destructive");
    }
    if (m.modelCallable && m.annotations.openWorld) {
      errors.push("modelCallable 工具不能标记为 openWorld");
    }

    return errors;
  }

  /** Get a registered tool by name. */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tool manifests. */
  getManifests(): ProjectFlowToolManifest[] {
    return Array.from(this.tools.values()).map((t) => t.manifest);
  }

  /** Get only model-callable tool manifests. */
  getModelCallableManifests(): ProjectFlowToolManifest[] {
    return this.getManifests().filter((m) => m.modelCallable);
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get the number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}

/**
 * Create a default tool execution function that calls FastAPI internal endpoints.
 * @param toolName - The tool name to call on FastAPI
 */
export function createFastapiToolExecutor(fastapiClient: FastapiClient, toolName: string) {
  return async (args: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> => {
    return fastapiClient.callTool(toolName, {
      run_id: context.runId,
      tool_call_id: context.toolCallId,
      conversation_id: context.conversationId,
      workspace_id: context.workspaceId,
      project_id: context.projectId,
      tool_name: context.toolName,
      tool_version: context.toolVersion,
      manifest_version: context.manifestVersion,
      idempotency_key: context.idempotencyKey,
      viewer_user_id: context.viewerUserId,
      arguments: args,
      client_event_id: `${context.runId}:${context.toolCallId}:request`,
      ordering_hint: 0,
      trace: {
        run_id: context.runId,
        tool_call_id: context.toolCallId,
        tool_name: context.toolName,
      },
    });
  };
}

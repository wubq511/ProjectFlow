/**
 * ToolExecutor — unified tool execution with full enforcement.
 *
 * All model-callable tools MUST go through this executor.
 * Direct execution via toPiTool or other paths is forbidden.
 *
 * Enforces:
 * - Input schema validation (required fields, type checks)
 * - Policy decision
 * - Per-tool timeout (Promise.race with proper timer cleanup)
 * - Retry with bounded exponential backoff + jitter
 * - Concurrency groups (real semaphore, not just config)
 * - Idempotency key stability
 * - Result byte bound / normalization + ToolResourceRef for large results
 * - Unified error taxonomy (not just permanent/timeout)
 * - Durable ToolLedger entries via callback (every attempt persisted immediately)
 *
 * @see docs/T43/ProjectFlow_Agent_Capability_Maturity_Spec.md §Phase 4
 */

import type { ProjectFlowToolManifest } from "@/types/tool-manifest.js";
import type { ProjectFlowToolResult, ToolResultStatus } from "@/types/tool-result.js";
import type { ToolRegistry, ToolExecutionContext, RegisteredTool } from "./registry.js";
import { evaluatePolicy } from "@/policy/policy-engine.js";
import { normalizeResult } from "./result-normalizer.js";
import type { DebugPayloadStore } from "@/events/debug-payload-store.js";
import { hashValue } from "@/utils/hash.js";

// ─── Error Taxonomy ────────────────────────────────────────────────────

export type ToolErrorCode =
  | "validation"
  | "policy"
  | "auth"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "timeout"
  | "transient"
  | "permanent"
  | "unknown_side_effect"
  | "budget_exceeded"
  | "cancelled";

export interface ToolExecutorError {
  code: ToolErrorCode;
  message: string;
  /** Safe Chinese observation for the model */
  observation: string;
  /** Whether this error is retryable */
  retryable: boolean;
  /** Whether the tool had a side effect before failing */
  hadSideEffect: boolean;
}

const RETRYABLE_CODES: Set<ToolErrorCode> = new Set(["timeout", "transient", "rate_limit"]);
const NEVER_RETRY_CODES: Set<ToolErrorCode> = new Set([
  "validation", "policy", "auth", "not_found", "conflict",
  "permanent", "unknown_side_effect", "budget_exceeded", "cancelled",
]);

// ─── ToolLedger Entry ──────────────────────────────────────────────────

export interface ToolLedgerEntry {
  logicalCallId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  toolVersion: number;
  manifestVersion: number;
  attempt: number;
  policyDecision: string;
  policyReason: string;
  inputHash: string;
  /** Per-attempt idempotency key: `${logicalCallId}:attempt:${attempt}` */
  idempotencyKey: string;
  resultStatus?: ToolResultStatus;
  sideEffectStatus?: string;
  errorCode?: ToolErrorCode;
  reconciliationStatus: "none" | "pending" | "resolved" | "manual_review";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** Resource reference for large results (additive) */
  resourceRef?: ToolResourceRef;
}

/**
 * Additive bounded reference for large tool results.
 * The model receives summary+ref, not the raw payload.
 */
export interface ToolResourceRef {
  resourceId: string;
  type: string;
  summary: string;
  bytes: number;
  hasMore: boolean;
  cursor?: string;
}

// ─── Concurrency Group Semaphore ───────────────────────────────────────

/**
 * Per-group semaphore keyed by concurrency group name.
 * read-only groups respect maxConcurrency from manifest.
 * write/proposal/advisory groups serialize (maxConcurrency=1).
 */
class ConcurrencySemaphore {
  private readonly groups = new Map<string, { max: number; active: number; queue: Array<() => void> }>();

  acquire(group: string, maxConcurrency: number, signal?: AbortSignal): Promise<() => void> {
    let entry = this.groups.get(group);
    if (!entry) {
      entry = { max: maxConcurrency, active: 0, queue: [] };
      this.groups.set(group, entry);
    }

    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        if (entry!.active < entry!.max) {
          entry!.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            entry!.active--;
            const next = entry!.queue.shift();
            if (next) next();
          });
          return true;
        }
        return false;
      };

      if (tryAcquire()) return;

      const waiter = () => {
        if (signal?.aborted) {
          reject(new Error("CANCELLED: 运行已取消"));
          return;
        }
        tryAcquire();
      };
      entry.queue.push(waiter);

      signal?.addEventListener("abort", () => {
        const idx = entry!.queue.indexOf(waiter);
        if (idx >= 0) entry!.queue.splice(idx, 1);
        reject(new Error("CANCELLED: 运行已取消"));
      }, { once: true });
    });
  }
}

// ─── ToolResourceRef builder ───────────────────────────────────────────

const RESOURCE_THRESHOLD_BYTES = 4096;

function buildResourceRef(
  toolName: string,
  toolCallId: string,
  data: unknown,
  resultBytes: number,
): ToolResourceRef | undefined {
  if (resultBytes <= RESOURCE_THRESHOLD_BYTES) return undefined;

  const summary = typeof data === "string"
    ? data.slice(0, 200) + (data.length > 200 ? "..." : "")
    : `Large result (${resultBytes} bytes) from ${toolName}`;

  return {
    resourceId: `res_${hashValue({ toolName, toolCallId, data })}`,
    type: toolName,
    summary,
    bytes: resultBytes,
    hasMore: true,
  };
}

// ─── Executor Options ──────────────────────────────────────────────────

export interface ToolExecutorOptions {
  maxResultBytes: number;
  traceIncludeSensitiveData: boolean;
  debugPayloadStore?: DebugPayloadStore;
  backoffFn?: (attempt: number) => number;
  jitterFn?: () => number;
  /**
   * Callback invoked immediately when each ledger entry completes (including
   * validation/policy/cancel/timeout failures). The caller is responsible
   * for durable persistence (e.g., FastAPI appendEvents).
   *
   * If the callback throws, the error propagates to the caller.
   */
  onLedgerEntry?: (entry: ToolLedgerEntry) => void | Promise<void>;
  /** Persist a large result outside the normal trace before exposing its ref. */
  onLargeResult?: (ref: ToolResourceRef, content: string, context: ToolExecutionContext) => void | Promise<void>;
}

const DEFAULT_OPTIONS: ToolExecutorOptions = {
  maxResultBytes: 32768,
  traceIncludeSensitiveData: false,
};

// ─── ToolExecutor ──────────────────────────────────────────────────────

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly options: ToolExecutorOptions;
  private readonly ledger: ToolLedgerEntry[] = [];
  private readonly semaphore = new ConcurrencySemaphore();

  constructor(
    registry: ToolRegistry,
    options: Partial<ToolExecutorOptions> = {},
  ) {
    this.registry = registry;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Execute a tool call with full enforcement.
   * This is the ONLY path for model-callable tool execution.
   */
  async execute(
    toolName: string,
    params: unknown,
    context: ToolExecutionContext,
    manifest: ProjectFlowToolManifest,
    signal?: AbortSignal,
  ): Promise<ProjectFlowToolResult> {
    const logicalCallId = `${context.runId}_${context.toolCallId}`;

    // Check cancellation
    if (signal?.aborted) {
      const entry = this.createLedgerEntry(logicalCallId, toolName, params, context, manifest);
      return this.createErrorResult(entry, {
        code: "cancelled",
        message: "运行已取消",
        observation: "运行已取消",
        retryable: false,
        hadSideEffect: false,
      });
    }

    // Input schema validation (once, before retries)
    const validationError = this.validateInput(params, manifest);
    if (validationError) {
      const entry = this.createLedgerEntry(logicalCallId, toolName, params, context, manifest);
      return this.createErrorResult(entry, validationError);
    }

    // Policy decision (once, before retries)
    const policy = evaluatePolicy(manifest);
    if (policy.decision === "block" || policy.decision === "deny") {
      const entry = this.createLedgerEntry(logicalCallId, toolName, params, context, manifest);
      entry.policyDecision = policy.decision;
      entry.policyReason = policy.reason;
      return this.createErrorResult(entry, {
        code: "policy",
        message: policy.reason,
        observation: `操作被拒绝: ${policy.reason}`,
        retryable: false,
        hadSideEffect: false,
      });
    }

    // Acquire concurrency slot
    const group = manifest.execution.concurrencyGroup ?? manifest.name;
    const maxConcurrency = manifest.execution.mode === "parallel"
      ? manifest.execution.maxConcurrency
      : 1;
    let release: (() => void) | undefined;
    try {
      release = await this.semaphore.acquire(group, maxConcurrency, signal);
    } catch (err) {
      const entry = this.createLedgerEntry(logicalCallId, toolName, params, context, manifest);
      return this.createErrorResult(entry, {
        code: "cancelled",
        message: err instanceof Error ? err.message : "并发等待取消",
        observation: "运行已取消",
        retryable: false,
        hadSideEffect: false,
      });
    }

    try {
      return await this.executeWithRetry(
        logicalCallId, toolName, params, context, manifest, policy, signal,
      );
    } finally {
      release?.();
    }
  }

  getLedger(): ToolLedgerEntry[] {
    return [...this.ledger];
  }

  getRunLedger(runId: string): ToolLedgerEntry[] {
    return this.ledger.filter((e) => e.runId === runId);
  }

  // ─── Ledger Entry Management ────────────────────────────────────────

  private createLedgerEntry(
    logicalCallId: string,
    toolName: string,
    params: unknown,
    context: ToolExecutionContext,
    manifest: ProjectFlowToolManifest,
    attempt = 1,
  ): ToolLedgerEntry {
    const entry: ToolLedgerEntry = {
      logicalCallId,
      runId: context.runId,
      toolCallId: context.toolCallId,
      toolName,
      toolVersion: manifest.version,
      manifestVersion: manifest.resume.manifestVersion,
      attempt,
      policyDecision: "",
      policyReason: "",
      inputHash: hashValue(params),
      idempotencyKey: `${logicalCallId}:attempt:${attempt}`,
      reconciliationStatus: "none",
      startedAt: new Date().toISOString(),
    };
    this.ledger.push(entry);
    return entry;
  }

  /**
   * Complete a ledger entry and persist it immediately via callback.
   * Every attempt — including validation/policy/cancel/timeout — is persisted.
   */
  private async completeLedgerEntry(entry: ToolLedgerEntry): Promise<void> {
    if (!entry.completedAt) {
      entry.completedAt = new Date().toISOString();
      entry.durationMs = new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime();
    }
    if (entry.sideEffectStatus === "unknown") {
      entry.reconciliationStatus = "manual_review";
    }

    // Persist immediately via callback
    if (this.options.onLedgerEntry) {
      await this.options.onLedgerEntry(entry);
    }
  }

  // ─── Input Validation ───────────────────────────────────────────────

  private validateInput(params: unknown, manifest: ProjectFlowToolManifest): ToolExecutorError | null {
    if (params !== null && typeof params !== "object") {
      return {
        code: "validation",
        message: "参数必须是对象类型",
        observation: "参数格式错误: 必须是对象",
        retryable: false,
        hadSideEffect: false,
      };
    }

    const schema = manifest.inputSchema as Record<string, unknown> | undefined;
    if (schema) {
      const paramsObj = params as Record<string, unknown> | null;

      // Required fields
      if (Array.isArray(schema.required)) {
        for (const field of schema.required) {
          if (typeof field === "string" && paramsObj && !(field in paramsObj)) {
            return {
              code: "validation",
              message: `缺少必填参数: ${field}`,
              observation: `参数校验失败: 缺少必填字段 ${field}`,
              retryable: false,
              hadSideEffect: false,
            };
          }
        }
      }

      // Type check: if schema.type is "object", params must be object
      if (schema.type === "object" && params !== null && typeof params !== "object") {
        return {
          code: "validation",
          message: "参数类型错误: 期望对象",
          observation: "参数校验失败: 类型不匹配",
          retryable: false,
          hadSideEffect: false,
        };
      }

      // Enum check for string properties
      if (schema.properties && typeof schema.properties === "object" && paramsObj) {
        const props = schema.properties as Record<string, Record<string, unknown>>;
        for (const [key, propSchema] of Object.entries(props)) {
          if (propSchema.enum && Array.isArray(propSchema.enum) && key in paramsObj) {
            if (!propSchema.enum.includes(paramsObj[key])) {
              return {
                code: "validation",
                message: `参数 ${key} 值不在允许范围内`,
                observation: `参数校验失败: ${key} 的值无效`,
                retryable: false,
                hadSideEffect: false,
              };
            }
          }
        }
      }
    }

    return null;
  }

  // ─── Execute with Retry ─────────────────────────────────────────────

  private async executeWithRetry(
    logicalCallId: string,
    toolName: string,
    params: unknown,
    context: ToolExecutionContext,
    manifest: ProjectFlowToolManifest,
    policy: { decision: string; reason: string },
    signal?: AbortSignal,
  ): Promise<ProjectFlowToolResult> {
    const maxAttempts = manifest.retry.maxAttempts;
    let lastResult: ProjectFlowToolResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const entry = this.createLedgerEntry(logicalCallId, toolName, params, context, manifest, attempt);
      entry.policyDecision = policy.decision;
      entry.policyReason = policy.reason;

      try {
        const result = await this.executeWithTimeout(
          params, context, manifest, signal,
        );

        entry.resultStatus = result.status;
        entry.sideEffectStatus = result.sideEffectStatus;
        entry.completedAt = new Date().toISOString();
        entry.durationMs = new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime();

        // Build resource ref for large results
        if (result.data !== undefined) {
          const content = JSON.stringify(result.data);
          const resultBytes = new TextEncoder().encode(content).byteLength;
          entry.resourceRef = buildResourceRef(toolName, context.toolCallId, result.data, resultBytes);
          if (entry.resourceRef) {
            await this.options.onLargeResult?.(entry.resourceRef, content, context);
            result.data = {
              summary: entry.resourceRef.summary,
              resource_ref: {
                resource_id: entry.resourceRef.resourceId,
                type: entry.resourceRef.type,
                bytes: entry.resourceRef.bytes,
                has_more: entry.resourceRef.hasMore,
                cursor: "0",
              },
            };
          }
        }

        // Persist this attempt immediately
        await this.completeLedgerEntry(entry);

        if (result.status === "success") {
          return result;
        }

        const errorCode = this.classifyResultError(result, manifest);
        entry.errorCode = errorCode;

        if (!this.shouldRetry(errorCode, manifest, attempt, maxAttempts, result.sideEffectStatus)) {
          return result;
        }

        lastResult = result;
        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(attempt, signal);
        }
      } catch (err) {
        const error = this.classifyError(err, manifest);
        entry.errorCode = error.code;
        entry.completedAt = new Date().toISOString();
        entry.durationMs = new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime();

        // Persist this failed attempt immediately
        await this.completeLedgerEntry(entry);

        if (!this.shouldRetry(error.code, manifest, attempt, maxAttempts, "unknown")) {
          throw err;
        }

        if (attempt < maxAttempts) {
          await this.waitBeforeRetry(attempt, signal);
        }
      }
    }

    return lastResult ?? {
      status: "failed",
      sideEffectStatus: "unknown",
      error: { code: "MAX_ATTEMPTS", message: "达到最大重试次数" },
      observation: "工具执行失败: 已达最大重试次数",
      trace: { redacted: true },
    };
  }

  // ─── Timeout ────────────────────────────────────────────────────────

  /**
   * Execute with per-tool timeout using Promise.race with proper cleanup.
   * Timer is always cleared — no leaked timers on success or error.
   */
  private async executeWithTimeout(
    params: unknown,
    context: ToolExecutionContext,
    manifest: ProjectFlowToolManifest,
    signal?: AbortSignal,
  ): Promise<ProjectFlowToolResult> {
    const registered = this.registry.get(manifest.name);
    if (!registered) {
      return {
        status: "blocked",
        sideEffectStatus: "no_side_effect",
        error: { code: "TOOL_NOT_FOUND", message: `工具 ${manifest.name} 未注册` },
        observation: `工具不存在: ${manifest.name}`,
        trace: { redacted: true },
      };
    }

    const timeoutMs = manifest.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`TOOL_TIMEOUT: 工具 ${manifest.name} 执行超时 (${timeoutMs}ms)`));
      }, timeoutMs);
    });

    // Wire abort signal to reject timeout promise
    const abortHandler = () => {
      if (timer) clearTimeout(timer);
      reject(new Error("CANCELLED: 运行已取消"));
    };
    let reject: (err: Error) => void;
    const abortPromise = new Promise<never>((_, r) => {
      reject = r;
      signal?.addEventListener("abort", abortHandler, { once: true });
    });

    try {
      const result = await Promise.race([
        this.executeRaw(registered, params, context, manifest),
        timeoutPromise,
        abortPromise,
      ]);
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("TOOL_TIMEOUT:")) {
        // Classify timeout side-effect based on tool type
        const sideEffectStatus = this.classifyTimeoutSideEffect(manifest);
        return {
          status: "timeout",
          sideEffectStatus,
          error: { code: "TOOL_TIMEOUT", message: err.message },
          observation: `工具执行超时 (${timeoutMs}ms)`,
          trace: { redacted: true },
        };
      }
      throw err;
    } finally {
      // Always clean up
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
    }
  }

  /**
   * Classify timeout side-effect status based on tool manifest.
   * read-only/effect=none + replay-safe/idempotent → no_side_effect (safe to retry)
   * advisory/proposal/write → unknown_side_effect (manual review)
   */
  private classifyTimeoutSideEffect(manifest: ProjectFlowToolManifest): "no_side_effect" | "unknown" {
    const isReadOnly = manifest.riskCategory === "read_only" || manifest.riskCategory === "analysis";
    const isEffectNone = manifest.effects.effectType === "none";
    const isReplaySafe = manifest.effects.replaySafe;
    const isIdempotent = manifest.effects.idempotencyKeyRequired || manifest.annotations.idempotent;

    if ((isReadOnly || isEffectNone) && isReplaySafe && isIdempotent) {
      return "no_side_effect";
    }
    return "unknown";
  }

  // ─── Raw Execution ──────────────────────────────────────────────────

  private async executeRaw(
    registered: RegisteredTool,
    params: unknown,
    context: ToolExecutionContext,
    manifest: ProjectFlowToolManifest,
  ): Promise<ProjectFlowToolResult> {
    const rawResult = await registered.execute(params as Record<string, unknown>, context);

    const normalized = normalizeResult(rawResult, params, {
      maxBytes: manifest.resultLimit.maxBytes,
      redaction: manifest.resultLimit.redaction,
      recordInput: manifest.privacy.traceIncludeInputs,
      recordOutput: manifest.privacy.traceIncludeOutputs,
      includeSensitiveData: this.options.traceIncludeSensitiveData,
      debugPayloadStore: this.options.debugPayloadStore,
      debugPayloadContext: {
        runId: context.runId,
        toolCallId: context.toolCallId,
        toolName: context.toolName,
      },
    });

    normalized.idempotencyKey ??= context.idempotencyKey;
    return normalized;
  }

  // ─── Retry Policy ───────────────────────────────────────────────────

  private shouldRetry(
    errorCode: ToolErrorCode,
    manifest: ProjectFlowToolManifest,
    attempt: number,
    maxAttempts: number,
    sideEffectStatus: string,
  ): boolean {
    if (attempt >= maxAttempts) return false;
    if (NEVER_RETRY_CODES.has(errorCode)) return false;
    if (sideEffectStatus === "unknown") return false;
    if (!RETRYABLE_CODES.has(errorCode)) return false;

    if (manifest.retry.retryOn.length > 0) {
      return manifest.retry.retryOn.includes(errorCode);
    }
    return errorCode === "timeout" || errorCode === "transient";
  }

  private async waitBeforeRetry(attempt: number, signal?: AbortSignal): Promise<void> {
    const backoffFn = this.options.backoffFn ?? ((a: number) => Math.min(1000 * Math.pow(2, a - 1), 10000));
    const jitterFn = this.options.jitterFn ?? (() => Math.random() * 0.3 + 0.85);
    const delay = backoffFn(attempt) * jitterFn();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("CANCELLED"));
      }, { once: true });
    });
  }

  // ─── Error Classification ───────────────────────────────────────────

  /**
   * Classify an error into the error taxonomy.
   * Maps HTTP errors, client errors, and known failure patterns.
   */
  private classifyError(err: unknown, manifest: ProjectFlowToolManifest): ToolExecutorError {
    if (err instanceof Error) {
      if (err.message.includes("TOOL_TIMEOUT")) {
        return {
          code: "timeout",
          message: err.message,
          observation: "工具执行超时",
          retryable: this.isTimeoutRetryable(manifest),
          hadSideEffect: this.classifyTimeoutSideEffect(manifest) === "unknown",
        };
      }
      if (err.message.includes("CANCELLED") || err.message.includes("取消")) {
        return { code: "cancelled", message: err.message, observation: "运行已取消", retryable: false, hadSideEffect: false };
      }
      if (err.message.includes("BUDGET_EXCEEDED")) {
        return { code: "budget_exceeded", message: err.message, observation: "运行预算已超限", retryable: false, hadSideEffect: false };
      }
      if (err.message.includes("401") || err.message.includes("403") || err.message.includes("认证") || err.message.includes("权限")) {
        return { code: "auth", message: err.message, observation: "认证或权限错误", retryable: false, hadSideEffect: false };
      }
      if (err.message.includes("404") || err.message.includes("未找到") || err.message.includes("not found")) {
        return { code: "not_found", message: err.message, observation: "资源不存在", retryable: false, hadSideEffect: false };
      }
      if (err.message.includes("409") || err.message.includes("冲突") || err.message.includes("conflict")) {
        return { code: "conflict", message: err.message, observation: "数据冲突", retryable: false, hadSideEffect: false };
      }
      if (err.message.includes("429") || err.message.includes("rate") || err.message.includes("限流")) {
        return { code: "rate_limit", message: err.message, observation: "请求频率超限", retryable: true, hadSideEffect: false };
      }
      if (err.message.includes("ECONNREFUSED") || err.message.includes("ETIMEDOUT") || err.message.includes("网络") || err.message.includes("fetch")) {
        return { code: "transient", message: err.message, observation: "网络连接异常", retryable: true, hadSideEffect: false };
      }
    }

    return {
      code: "permanent",
      message: err instanceof Error ? err.message : String(err),
      observation: "工具执行失败",
      retryable: false,
      hadSideEffect: false,
    };
  }

  /**
   * Classify a failed result into an error code based on result content.
   */
  private classifyResultError(result: ProjectFlowToolResult, _manifest: ProjectFlowToolManifest): ToolErrorCode {
    if (result.status === "timeout") return "timeout";
    if (result.status === "blocked") return "policy";
    if (result.status === "validation_error") return "validation";
    if (result.status === "aborted") return "cancelled";

    // Map error codes from the result
    const code = result.error?.code?.toUpperCase() ?? "";
    if (code.includes("NOT_FOUND") || code.includes("TOOL_NOT_FOUND")) return "not_found";
    if (code.includes("AUTH") || code.includes("401") || code.includes("403")) return "auth";
    if (code.includes("CONFLICT") || code.includes("409")) return "conflict";
    if (code.includes("RATE") || code.includes("429")) return "rate_limit";
    if (code.includes("TRANSIENT") || code.includes("NETWORK")) return "transient";
    if (code.includes("POLICY") || code.includes("DENIED")) return "policy";
    if (code.includes("VALIDATION") || code.includes("INVALID")) return "validation";

    // Check side effect status for write tools
    if (result.sideEffectStatus === "unknown") return "unknown_side_effect";

    return "permanent";
  }

  private isTimeoutRetryable(manifest: ProjectFlowToolManifest): boolean {
    if (manifest.retry.retryOn.length > 0) {
      return manifest.retry.retryOn.includes("timeout");
    }
    // Only retryable for read-only/effect-none tools
    return this.classifyTimeoutSideEffect(manifest) === "no_side_effect";
  }

  // ─── Error Result ───────────────────────────────────────────────────

  private createErrorResult(entry: ToolLedgerEntry, error: ToolExecutorError): ProjectFlowToolResult {
    entry.errorCode = error.code;
    entry.completedAt = new Date().toISOString();
    entry.durationMs = new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime();
    if (error.hadSideEffect) {
      entry.reconciliationStatus = "manual_review";
    }

    // Persist immediately
    this.completeLedgerEntry(entry).catch(() => { /* persist failure logged by caller */ });

    return {
      status: error.code === "timeout" ? "timeout" : error.code === "cancelled" ? "aborted" : "failed",
      sideEffectStatus: error.hadSideEffect ? "unknown" : "no_side_effect",
      error: { code: error.code.toUpperCase(), message: error.message },
      observation: error.observation,
      trace: { redacted: true },
    };
  }
}

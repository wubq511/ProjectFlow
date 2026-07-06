/**
 * Result normalizer — normalizes, truncates, and hashes tool results.
 * Ensures every result has bounded payload and proper trace metadata.
 */

import type { ProjectFlowToolResult, ToolTrace } from "@/types/tool-result.js";
import { hashValue } from "@/utils/hash.js";
import type { DebugPayloadContext, DebugPayloadStore } from "@/events/debug-payload-store.js";

export interface NormalizeOptions {
  maxBytes: number;
  redaction: "none" | "secrets" | "pii";
  recordInput: boolean;
  recordOutput: boolean;
  includeSensitiveData: boolean;
  debugPayloadStore?: DebugPayloadStore;
  debugPayloadContext?: DebugPayloadContext;
}

const DEFAULT_OPTIONS: NormalizeOptions = {
  maxBytes: 32768,
  redaction: "none",
  recordInput: true,
  recordOutput: true,
  includeSensitiveData: false,
};

/**
 * Normalize a tool result: ensure shape, truncate payload, compute hashes.
 */
export function normalizeResult(
  result: unknown,
  inputArgs: unknown,
  options: Partial<NormalizeOptions> = {},
): ProjectFlowToolResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // If result is already a valid ProjectFlowToolResult, normalize it
  if (isToolResult(result)) {
    const normalized = normalizeToolResultShape(result);
    return {
      ...normalized,
      trace: buildTrace(inputArgs, normalized.data, opts),
    };
  }

  // Otherwise, wrap raw data into a success result
  const truncated = truncateData(result, opts.maxBytes);
  return {
    status: "success",
    data: truncated,
    sideEffectStatus: "no_side_effect",
    observation: typeof truncated === "string" ? truncated.slice(0, 200) : "操作完成",
    trace: buildTrace(inputArgs, truncated, opts),
  };
}

function isToolResult(value: unknown): value is ProjectFlowToolResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.status === "string" && typeof obj.observation === "string";
}

function normalizeToolResultShape(value: ProjectFlowToolResult | Record<string, unknown>): ProjectFlowToolResult {
  const obj = value as Record<string, unknown>;
  const links = normalizeLinks(obj.links);
  const trace = normalizeTrace(obj.trace);

  return {
    status: obj.status as ProjectFlowToolResult["status"],
    ...(obj.data !== undefined ? { data: obj.data } : {}),
    ...(obj.error !== undefined ? { error: obj.error as ProjectFlowToolResult["error"] } : {}),
    sideEffectStatus: (obj.sideEffectStatus ?? obj.side_effect_status ?? "no_side_effect") as ProjectFlowToolResult["sideEffectStatus"],
    ...(obj.idempotencyKey || obj.idempotency_key
      ? { idempotencyKey: (obj.idempotencyKey ?? obj.idempotency_key) as string }
      : {}),
    ...(links ? { links } : {}),
    observation: obj.observation as string,
    trace,
  };
}

function normalizeLinks(value: unknown): ProjectFlowToolResult["links"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  return {
    ...(obj.agentEventId || obj.agent_event_id
      ? { agentEventId: (obj.agentEventId ?? obj.agent_event_id) as string }
      : {}),
    ...(obj.agentRunId || obj.agent_run_id
      ? { agentRunId: (obj.agentRunId ?? obj.agent_run_id) as string }
      : {}),
    ...(obj.proposalId || obj.proposal_id
      ? { proposalId: (obj.proposalId ?? obj.proposal_id) as string }
      : {}),
    ...(Array.isArray(obj.createdIds)
      ? { createdIds: obj.createdIds as string[] }
      : Array.isArray(obj.created_ids)
        ? { createdIds: obj.created_ids as string[] }
        : {}),
  };
}

function normalizeTrace(value: unknown): ToolTrace {
  if (typeof value !== "object" || value === null) return { redacted: true };
  const obj = value as Record<string, unknown>;
  return {
    ...(obj.inputHash || obj.input_hash ? { inputHash: (obj.inputHash ?? obj.input_hash) as string } : {}),
    ...(obj.outputHash || obj.output_hash ? { outputHash: (obj.outputHash ?? obj.output_hash) as string } : {}),
    ...(obj.debugPayloadId || obj.debug_payload_id
      ? { debugPayloadId: (obj.debugPayloadId ?? obj.debug_payload_id) as string }
      : {}),
    redacted: typeof obj.redacted === "boolean" ? obj.redacted : true,
  };
}

function buildTrace(input: unknown, output: unknown, opts: NormalizeOptions): ToolTrace {
  const debugPayloadId = opts.includeSensitiveData && opts.debugPayloadStore && opts.debugPayloadContext
    ? opts.debugPayloadStore.store(opts.debugPayloadContext, { input, output }).id
    : undefined;

  return {
    inputHash: opts.recordInput ? hashValue(input) : undefined,
    outputHash: opts.recordOutput ? hashValue(output) : undefined,
    ...(debugPayloadId ? { debugPayloadId } : {}),
    redacted: !opts.includeSensitiveData || opts.redaction !== "none",
  };
}

/**
 * Truncate data to fit within maxBytes.
 * Uses JSON serialization to measure size.
 * Falls back to safe string truncation if JSON.parse fails.
 */
export function truncateData(data: unknown, maxBytes: number): unknown {
  if (data === undefined || data === null) return data;

  const json = JSON.stringify(data);
  if (json.length <= maxBytes) return data;

  // For strings, truncate directly
  if (typeof data === "string") {
    return data.slice(0, maxBytes) + "...[截断]";
  }

  // For objects, try safe JSON truncation
  const safeSlice = json.slice(0, maxBytes - 20);
  try {
    return JSON.parse(safeSlice + '"...[截断]"}');
  } catch {
    // If JSON is malformed after truncation, return a safe summary
    return { _truncated: true, _original_size: json.length, _preview: safeSlice.slice(0, 200) };
  }
}

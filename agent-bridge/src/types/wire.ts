/**
 * Wire format adapter — converts between snake_case (FastAPI wire format)
 * and camelCase (TypeScript internal).
 *
 * Convention: All JSON payloads on the wire use snake_case.
 * TypeScript code uses camelCase internally.
 */

// ─── Conversion Utilities ─────────────────────────────────────────────

/** Convert camelCase to snake_case */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Convert snake_case to camelCase */
export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** Recursively convert object keys to camelCase */
export function camelizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(camelizeKeys);
  }
  if (obj !== null && typeof obj === "object" && !(obj instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[toCamelCase(key)] = camelizeKeys(value);
    }
    return result;
  }
  return obj;
}

/** Recursively convert object keys to snake_case */
export function snakifyKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(snakifyKeys);
  }
  if (obj !== null && typeof obj === "object" && !(obj instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[toSnakeCase(key)] = snakifyKeys(value);
    }
    return result;
  }
  return obj;
}

// ─── Wire Format Types (snake_case, matching FastAPI schemas) ─────────

/** Thinking/reasoning level for models that support it. */
export type WireThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface WireRunStartRequest {
  conversation_id: string;
  workspace_id: string;
  project_id: string;
  user_message_id?: string;
  user_content?: string;
  viewer_user_id?: string;
  workspace_state?: unknown;
  recent_messages?: unknown[];
  pending_proposals?: unknown[];
  memory_mode?: "enabled" | "disabled";
  runtime_config?: {
    model?: { provider: string; name: string };
    skill?: string;
    max_steps?: number;
    max_tool_calls?: number;
    timeout_ms?: number;
    trace_include_sensitive_data?: boolean;
    thinking_level?: WireThinkingLevel;
    /** Evaluator-only hard ceilings. Rejected unless APP_ENV=evaluation and instance headers match. */
    evaluation_budget?: {
      max_input_tokens: number;
      max_output_tokens: number;
      max_request_count: number;
      max_cost_usd: number;
    };
  };
}

export interface WireMemoryContext {
  text: string;
  used_memory_ids: string[];
  used_memory_types?: string[];
  guarded_member_names?: string[];
  memory_backend: string;
  retrieval_count: number;
  injected_count: number;
  latency_ms: number;
}

export interface WireRunStartResponse {
  run_id: string;
  status: string;
  memory_context?: WireMemoryContext | null;
}

export interface WireRunStatusResponse {
  run_id: string;
  status: string;
  current_turn: number;
  current_step: number;
  last_event_seq: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface WireRunCancelRequest {
  reason?: string;
}

export interface WireRunCancelResponse {
  run_id: string;
  status: string;
  cancelled: boolean;
}

export interface WireAppendRequest {
  idempotency_key: string;
  expected_state_version?: number;
  state_patch?: Record<string, unknown>;
  events?: WireEventAppendItem[];
  tool_results?: WireToolResultAppendItem[];
}

export interface WireEventAppendItem {
  client_event_id: string;
  type: string;
  ordering_hint?: number;
  payload?: Record<string, unknown>;
  trace?: Record<string, unknown>;
}

export interface WireToolResultAppendItem {
  tool_call_id: string;
  tool_name: string;
  tool_version: number;
  result: WireProjectFlowToolResult;
}

export interface WireProjectFlowToolResult {
  status: string;
  data?: unknown;
  error?: { code: string; reason?: string; message: string; details?: unknown };
  side_effect_status: string;
  idempotency_key?: string;
  links?: {
    agent_event_id?: string;
    agent_run_id?: string;
    proposal_id?: string;
    created_ids?: string[];
  };
  observation: string;
  trace: { input_hash?: string; output_hash?: string; debug_payload_id?: string; redacted: boolean };
}

export interface WireAppendResponse {
  state_version: number;
  events: WireEventAppendResponse[];
  tool_results: WireToolResultAppendResponse[];
}

export interface WireEventAppendResponse {
  client_event_id: string;
  agent_event_id: string;
  event_seq: number;
}

export interface WireToolResultAppendResponse {
  tool_call_id: string;
  agent_event_id: string;
  persisted: boolean;
}

// ─── Parsers (wire → internal, with validation) ──────────────────────

export function parseRunStartRequest(data: unknown): WireRunStartRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.conversation_id !== "string") return null;
  if (typeof obj.workspace_id !== "string") return null;
  if (typeof obj.project_id !== "string") return null;
  return data as WireRunStartRequest;
}

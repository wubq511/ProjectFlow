/**
 * T46-2 (Issue #95) — Authenticated evaluation evidence snapshot client.
 *
 * Calls `GET /internal/evaluation/evidence` on the FastAPI backend with the
 * two independent auth gates required by `require_evaluation_evidence_access`:
 *
 * 1. Sidecar service token (`Authorization: Bearer ...`) — same as other
 *    `/internal/*` endpoints.
 * 2. Evaluator-owned instance identity (`X-Evaluation-Nonce` +
 *    `X-Evaluation-Instance-Id`) — same as the destructive seed endpoint.
 *
 * The client is intentionally thin:
 * - It does NOT import any runtime, router, verifier or business service.
 * - It only fetches a normalized, viewer-scoped, read-only snapshot that the
 *   backend has already produced. It cannot mutate state, create runs,
 *   confirm proposals, or alter ProjectMemory.
 * - It validates the `schema_version` field against
 *   {@link EVIDENCE_SNAPSHOT_SCHEMA_VERSION} so a backend/client version
 *   mismatch fails closed instead of silently misreading the payload.
 *
 * Errors are redacted: only the operation name and HTTP status are surfaced
 * in the thrown message. Response bodies, private IDs, secrets and absolute
 * paths are never logged — the backend's evidence snapshot intentionally
 * omits them, but the client also defends against accidental leakage in any
 * error payload.
 */

import {
  EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  type EvidenceSnapshot,
} from "./contract-v2.js";

export interface EvidenceClientConfig {
  backendBaseUrl: string;
  /** Internal service token shared between sidecar and FastAPI. */
  internalServiceToken: string;
  /** Evaluator-owned nonce bound to the isolated backend instance. */
  evaluationNonce: string;
  /** Evaluator-owned instance ID bound to the isolated backend instance. */
  evaluationInstanceId: string;
  /** Optional fetch implementation; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

export interface EvidenceRequest {
  workspaceId: string;
  viewerUserId: string;
  projectId?: string;
  conversationId?: string;
  runId?: string;
}

const REDACTED_ERROR = "评估证据快照获取失败";

function buildHeaders(config: EvidenceClientConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.internalServiceToken}`,
    "X-Evaluation-Nonce": config.evaluationNonce,
    "X-Evaluation-Instance-Id": config.evaluationInstanceId,
    Accept: "application/json",
  };
}

function buildUrl(base: string, req: EvidenceRequest): string {
  const url = new URL(`${base.replace(/\/$/, "")}/internal/evaluation/evidence`);
  url.searchParams.set("workspace_id", req.workspaceId);
  url.searchParams.set("viewer_user_id", req.viewerUserId);
  if (req.projectId) url.searchParams.set("project_id", req.projectId);
  if (req.conversationId) url.searchParams.set("conversation_id", req.conversationId);
  if (req.runId) url.searchParams.set("run_id", req.runId);
  return url.toString();
}

/**
 * Fetch a normalized, viewer-scoped evidence snapshot.
 *
 * @throws Error with a redacted message (HTTP status only) if the request
 *   fails, the response is not valid JSON, or the `schema_version` field
 *   does not match {@link EVIDENCE_SNAPSHOT_SCHEMA_VERSION}.
 */
export async function fetchEvidenceSnapshot(
  config: EvidenceClientConfig,
  req: EvidenceRequest,
): Promise<EvidenceSnapshot> {
  const fetchFn = config.fetchFn ?? fetch;
  const url = buildUrl(config.backendBaseUrl, req);
  const headers = buildHeaders(config);

  let response: Response;
  try {
    response = await fetchFn(url, { method: "GET", headers });
  } catch {
    // Network errors carry no status; do not include err.message verbatim
    // because it may reference local paths or secrets in some environments.
    throw new Error(`${REDACTED_ERROR}: 网络请求异常`);
  }

  if (!response.ok) {
    throw new Error(`${REDACTED_ERROR}: HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${REDACTED_ERROR}: 响应不是合法 JSON`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${REDACTED_ERROR}: 响应不是 JSON 对象`);
  }

  const record = payload as Record<string, unknown>;
  const schemaVersion = record["schema_version"];
  if (
    typeof schemaVersion !== "number"
    || schemaVersion !== EVIDENCE_SNAPSHOT_SCHEMA_VERSION
  ) {
    // Do not echo the actual value — a future backend could put unexpected
    // content in the field. Fail closed with a generic mismatch message.
    throw new Error(
      `${REDACTED_ERROR}: schema_version 不匹配 (期望 ${EVIDENCE_SNAPSHOT_SCHEMA_VERSION})`,
    );
  }

  return payload as EvidenceSnapshot;
}


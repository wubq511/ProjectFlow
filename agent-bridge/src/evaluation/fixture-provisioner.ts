/**
 * Evaluation fixture provisioner.
 *
 * Provisions an isolated observation fixture by:
 * 1. Seeding the demo state (POST /api/seed/demo)
 * 2. Fetching fresh workspace state (GET /api/workspaces/{id}/state)
 * 3. Creating a new conversation (POST /api/projects/{id}/agent-conversations)
 *
 * Each call returns a fresh {@link PublicSeamIdentity} so that effectful
 * scenarios cannot collide across repetitions.
 *
 * Errors are redacted: only the operation name and HTTP status are included
 * in the thrown message. Response bodies, private IDs, and secrets are never logged.
 */

import type { PublicSeamIdentity } from "./http-public-seam-runner.js";

export interface FixtureProvisionerConfig {
  backendBaseUrl: string;
  workspaceId: string;
  projectId: string;
  viewerUserId: string;
  adminToken?: string;
  fetchFn?: typeof fetch;
  evaluationNonce?: string;
  evaluationInstanceId?: string;
}

interface SeedDemoResponse {
  // Seed endpoint returns varying shapes; we only need success/failure.
}

interface WorkspaceStateResponse {
  workspace: Record<string, unknown>;
  // Additional fields may exist; we pass the entire response as workspace state.
}

interface ConversationResponse {
  id: string;
  // Additional fields may exist.
}

async function postJson<T>(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function getJson<T>(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetchFn(url, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * Provision a fresh observation fixture and return a new identity.
 *
 * Sequentially:
 * 1. POST {backendBaseUrl}/api/seed/demo — reset demo state
 * 2. GET {backendBaseUrl}/api/workspaces/{workspaceId}/state — fetch fresh state
 * 3. POST {backendBaseUrl}/api/projects/{projectId}/agent-conversations — create conversation
 *
 * @throws Error with redacted message containing only operation name + HTTP status.
 */
export async function provisionObservationFixture(
  config: FixtureProvisionerConfig,
): Promise<PublicSeamIdentity> {
  const fetchFn = config.fetchFn ?? fetch;
  const base = config.backendBaseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = config.adminToken
    ? { "X-ProjectFlow-Admin-Token": config.adminToken }
    : {};
  if (config.evaluationNonce) {
    headers["X-Evaluation-Nonce"] = config.evaluationNonce;
  }
  if (config.evaluationInstanceId) {
    headers["X-Evaluation-Instance-Id"] = config.evaluationInstanceId;
  }

  // Step 1: Seed demo state.
  try {
    await postJson<SeedDemoResponse>(fetchFn, `${base}/api/seed/demo`, {}, headers);
  } catch (err) {
    const status = err instanceof Error ? err.message : "未知错误";
    throw new Error(`重置并生成评测夹具失败: ${status}`);
  }

  // Step 2: Fetch fresh workspace state.
  let workspaceState: Record<string, unknown>;
  try {
    const stateResponse = await getJson<WorkspaceStateResponse>(
      fetchFn,
      `${base}/api/workspaces/${config.workspaceId}/state`,
      headers,
    );
    workspaceState = stateResponse as unknown as Record<string, unknown>;
  } catch (err) {
    const status = err instanceof Error ? err.message : "未知错误";
    throw new Error(`读取评测工作区状态失败: ${status}`);
  }

  // Step 3: Create a new conversation.
  let conversationId: string;
  try {
    const convResponse = await postJson<ConversationResponse>(
      fetchFn,
      `${base}/api/projects/${config.projectId}/agent-conversations`,
      { viewer_user_id: config.viewerUserId },
      headers,
    );
    conversationId = convResponse.id;
    if (typeof conversationId !== "string" || !conversationId) {
      throw new Error("HTTP 200 但响应缺少会话 ID");
    }
  } catch (err) {
    const status = err instanceof Error ? err.message : "未知错误";
    throw new Error(`创建评测会话失败: ${status}`);
  }

  return {
    conversationId,
    workspaceId: config.workspaceId,
    projectId: config.projectId,
    viewerUserId: config.viewerUserId,
    workspaceState,
  };
}

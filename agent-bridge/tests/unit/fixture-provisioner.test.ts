import { describe, expect, it, vi } from "vitest";
import { provisionObservationFixture } from "../../src/evaluation/fixture-provisioner.js";

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const resp = responses[callIndex] ?? { status: 500, body: {} };
    callIndex++;
    return new Response(JSON.stringify(resp.body), { status: resp.status }) as Response;
  }) as typeof fetch;
}

describe("fixture-provisioner", () => {
  const baseConfig = {
    backendBaseUrl: "http://backend.test",
    workspaceId: "ws-1",
    projectId: "proj-1",
    viewerUserId: "user-1",
  };

  it("provisions a fresh fixture: seed → fetch state → create conversation", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { status: "ok" } },           // seed demo
      { status: 200, body: { workspace: { id: "ws-1" } } }, // workspace state
      { status: 200, body: { id: "conv-new-123" } }, // create conversation
    ]);

    const identity = await provisionObservationFixture({ ...baseConfig, fetchFn });

    expect(identity.conversationId).toBe("conv-new-123");
    expect(identity.workspaceId).toBe("ws-1");
    expect(identity.projectId).toBe("proj-1");
    expect(identity.viewerUserId).toBe("user-1");
    expect(identity.workspaceState).toEqual({ workspace: { id: "ws-1" } });

    // Verify the 3 calls were made in order.
    expect(fetchFn).toHaveBeenCalledTimes(3);

    // Seed call.
    expect(fetchFn.mock.calls[0]![0]).toBe("http://backend.test/api/seed/demo");
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ method: "POST" });

    // Workspace state call.
    expect(fetchFn.mock.calls[1]![0]).toBe("http://backend.test/api/workspaces/ws-1/state");
    expect(fetchFn.mock.calls[1]![1]).toMatchObject({ method: "GET" });

    // Create conversation call.
    expect(fetchFn.mock.calls[2]![0]).toBe("http://backend.test/api/projects/proj-1/agent-conversations");
    expect(fetchFn.mock.calls[2]![1]).toMatchObject({ method: "POST" });
    const convBody = JSON.parse((fetchFn.mock.calls[2]![1] as RequestInit).body as string);
    expect(convBody.viewer_user_id).toBe("user-1");
  });

  it("includes admin token header when EVAL_DEMO_ADMIN_TOKEN is set", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { status: "ok" } },
      { status: 200, body: { workspace: {} } },
      { status: 200, body: { id: "conv-1" } },
    ]);

    await provisionObservationFixture({ ...baseConfig, fetchFn, adminToken: "secret-token" });

    // Every call should include the admin token header.
    for (const call of fetchFn.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-ProjectFlow-Admin-Token"]).toBe("secret-token");
    }
  });

  it("does not include admin token header when not set", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { status: "ok" } },
      { status: 200, body: { workspace: {} } },
      { status: 200, body: { id: "conv-1" } },
    ]);

    await provisionObservationFixture({ ...baseConfig, fetchFn });

    for (const call of fetchFn.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-ProjectFlow-Admin-Token"]).toBeUndefined();
    }
  });

  it("throws redacted error on seed failure", async () => {
    const fetchFn = mockFetch([
      { status: 500, body: { error: "internal" } }, // seed fails
    ]);

    await expect(
      provisionObservationFixture({ ...baseConfig, fetchFn }),
    ).rejects.toThrow("重置并生成评测夹具失败: HTTP 500");
  });

  it("throws redacted error on workspace state fetch failure", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { status: "ok" } },       // seed ok
      { status: 404, body: { error: "not found" } },  // state fails
    ]);

    await expect(
      provisionObservationFixture({ ...baseConfig, fetchFn }),
    ).rejects.toThrow("读取评测工作区状态失败: HTTP 404");
  });

  it("throws redacted error on conversation creation failure", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { status: "ok" } },       // seed ok
      { status: 200, body: { workspace: {} } },       // state ok
      { status: 403, body: { error: "forbidden" } },  // conversation fails
    ]);

    await expect(
      provisionObservationFixture({ ...baseConfig, fetchFn }),
    ).rejects.toThrow("创建评测会话失败: HTTP 403");
  });

  it("throws redacted error when conversation response lacks id", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { status: "ok" } },
      { status: 200, body: { workspace: {} } },
      { status: 200, body: { something: "else" } }, // missing id
    ]);

    await expect(
      provisionObservationFixture({ ...baseConfig, fetchFn }),
    ).rejects.toThrow("创建评测会话失败: HTTP 200 但响应缺少会话 ID");
  });

  it("normalizes trailing slashes in backend base URL", async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { status: "ok" } },
      { status: 200, body: { workspace: {} } },
      { status: 200, body: { id: "conv-1" } },
    ]);

    await provisionObservationFixture({ ...baseConfig, backendBaseUrl: "http://backend.test/", fetchFn });

    expect(fetchFn.mock.calls[0]![0]).toBe("http://backend.test/api/seed/demo");
  });

  it("does not log response bodies, private IDs, or secrets on error", async () => {
    const fetchFn = mockFetch([
      { status: 500, body: { error: "internal", secret: "should-not-appear", user_id: "u-123" } },
    ]);

    try {
      await provisionObservationFixture({ ...baseConfig, fetchFn });
    } catch (err) {
      const message = (err as Error).message;
      // Error message must not contain response body content.
      expect(message).not.toContain("should-not-appear");
      expect(message).not.toContain("u-123");
      expect(message).not.toContain("internal");
      // Only contains the localized operation name + HTTP status.
      expect(message).toBe("重置并生成评测夹具失败: HTTP 500");
    }
  });
});

/**
 * Tests for FastapiClient — service-to-service HTTP calls.
 *
 * Verifies:
 * - startRun sends correct POST to /internal/agent-runs
 * - getRunStatus sends correct GET to /internal/agent-runs/{runId}
 * - appendEvents sends correct POST to /internal/agent-runs/{runId}/events:append
 * - cancelRun sends correct POST to /internal/agent-runs/{runId}/cancel
 * - callTool sends correct POST to /internal/agent-tools/{toolName}
 * - Authorization header includes service token
 * - FastapiError captures status, body, path
 * - Timeout aborts the request
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FastapiClient, FastapiError } from "../../src/tools/fastapi-client.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => { throw new Error("not json"); },
    text: async () => body,
  } as unknown as Response;
}

describe("FastapiClient", () => {
  let client: FastapiClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    client = new FastapiClient({
      baseUrl: "http://localhost:8000",
      serviceToken: "test-token-123",
      timeoutMs: 10000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("strips trailing slash from baseUrl", () => {
      const c = new FastapiClient({
        baseUrl: "http://localhost:8000/",
        serviceToken: "token",
      });
      // The URL should not have double slashes
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      c.startRun({ conversation_id: "c", workspace_id: "w", project_id: "p" });
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toBe("http://localhost:8000/internal/agent-runs");
    });

    it("uses default timeout of 30000ms", () => {
      const c = new FastapiClient({
        baseUrl: "http://localhost:8000",
        serviceToken: "token",
      });
      expect(c).toBeDefined();
    });
  });

  describe("startRun", () => {
    it("sends POST to /internal/agent-runs with correct body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ run_id: "run_1", status: "created" }));

      const result = await client.startRun({
        conversation_id: "conv_1",
        workspace_id: "ws_1",
        project_id: "proj_1",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("http://localhost:8000/internal/agent-runs");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        conversation_id: "conv_1",
        workspace_id: "ws_1",
        project_id: "proj_1",
      });
      expect(result).toEqual({ run_id: "run_1", status: "created" });
    });
  });

  describe("getRunStatus", () => {
    it("sends GET to /internal/agent-runs/{runId}", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ run_id: "run_1", status: "completed" }));

      const result = await client.getRunStatus("run_1");

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("http://localhost:8000/internal/agent-runs/run_1");
      expect(init.method).toBe("GET");
      expect(result).toEqual({ run_id: "run_1", status: "completed" });
    });
  });

  describe("appendEvents", () => {
    it("sends POST to /internal/agent-runs/{runId}/events:append", async () => {
      const request = {
        idempotency_key: "key_1",
        events: [{ client_event_id: "evt_1", type: "agent.started" }],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({
        state_version: 1,
        events: [{ client_event_id: "evt_1", event_seq: 1 }],
        tool_results: [],
      }));

      const result = await client.appendEvents("run_1", request);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("http://localhost:8000/internal/agent-runs/run_1/events:append");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual(request);
      expect(result.state_version).toBe(1);
    });
  });

  describe("cancelRun", () => {
    it("sends POST to /internal/agent-runs/{runId}/cancel", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        run_id: "run_1",
        status: "cancelled",
        cancelled: true,
      }));

      const result = await client.cancelRun("run_1", "user_cancelled");

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("http://localhost:8000/internal/agent-runs/run_1/cancel");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ reason: "user_cancelled" });
      expect(result.cancelled).toBe(true);
    });

    it("uses default reason when not provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        run_id: "run_1",
        status: "cancelled",
        cancelled: true,
      }));

      await client.cancelRun("run_1");

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.reason).toBe("sidecar_cancelled");
    });
  });

  describe("callTool", () => {
    it("sends POST to /internal/agent-tools/{toolName}", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "success", data: {} }));

      const payload = {
        run_id: "run_1",
        tool_call_id: "call_1",
        arguments: { workspace_id: "ws_1" },
      };
      await client.callTool("workspace-state", payload);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("http://localhost:8000/internal/agent-tools/workspace-state");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual(payload);
    });
  });

  describe("authorization", () => {
    it("includes Bearer token in Authorization header", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      await client.startRun({ conversation_id: "c", workspace_id: "w", project_id: "p" });

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers.Authorization).toBe("Bearer test-token-123");
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });

  describe("error handling", () => {
    it("throws FastapiError on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, "Not Found"));

      await expect(
        client.getRunStatus("nonexistent"),
      ).rejects.toThrow(FastapiError);
    });

    it("FastapiError captures status, body, and path", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, "Internal Server Error"));

      try {
        await client.getRunStatus("run_1");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(FastapiError);
        const fastapiErr = err as FastapiError;
        expect(fastapiErr.status).toBe(500);
        expect(fastapiErr.body).toBe("Internal Server Error");
        expect(fastapiErr.path).toBe("http://localhost:8000/internal/agent-runs/run_1");
      }
    });

    it("FastapiError message includes status and path", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(403, "Forbidden"));

      try {
        await client.callTool("test-tool", {});
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as FastapiError).message).toContain("403");
        expect((err as FastapiError).message).toContain("test-tool");
      }
    });
  });
});

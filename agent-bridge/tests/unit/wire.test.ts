import { describe, it, expect } from "vitest";
import {
  toSnakeCase,
  toCamelCase,
  camelizeKeys,
  snakifyKeys,
  parseRunStartRequest,
} from "../../src/types/wire.js";
import type { WireRunStartResponse } from "../../src/types/wire.js";

describe("wire format", () => {
  describe("toSnakeCase", () => {
    it("converts camelCase to snake_case", () => {
      expect(toSnakeCase("camelCase")).toBe("camel_case");
      expect(toSnakeCase("runId")).toBe("run_id");
      expect(toSnakeCase("toolCallId")).toBe("tool_call_id");
      expect(toSnakeCase("already")).toBe("already");
    });
  });

  describe("toCamelCase", () => {
    it("converts snake_case to camelCase", () => {
      expect(toCamelCase("snake_case")).toBe("snakeCase");
      expect(toCamelCase("run_id")).toBe("runId");
      expect(toCamelCase("tool_call_id")).toBe("toolCallId");
      expect(toCamelCase("already")).toBe("already");
    });
  });

  describe("camelizeKeys", () => {
    it("converts object keys to camelCase", () => {
      const input = { run_id: "123", tool_name: "test", nested_obj: { inner_val: 42 } };
      const result = camelizeKeys(input) as any;
      expect(result.runId).toBe("123");
      expect(result.toolName).toBe("test");
      expect(result.nestedObj.innerVal).toBe(42);
    });

    it("handles arrays", () => {
      const input = [{ item_id: 1 }, { item_id: 2 }];
      const result = camelizeKeys(input) as any[];
      expect(result[0].itemId).toBe(1);
      expect(result[1].itemId).toBe(2);
    });

    it("handles null and primitives", () => {
      expect(camelizeKeys(null)).toBe(null);
      expect(camelizeKeys("hello")).toBe("hello");
      expect(camelizeKeys(42)).toBe(42);
    });
  });

  describe("snakifyKeys", () => {
    it("converts object keys to snake_case", () => {
      const input = { runId: "123", toolName: "test", nestedObj: { innerVal: 42 } };
      const result = snakifyKeys(input) as any;
      expect(result.run_id).toBe("123");
      expect(result.tool_name).toBe("test");
      expect(result.nested_obj.inner_val).toBe(42);
    });
  });

  describe("parseRunStartRequest", () => {
    it("parses valid request", () => {
      const input = {
        conversation_id: "conv_123",
        workspace_id: "ws_456",
        project_id: "proj_789",
      };
      const result = parseRunStartRequest(input);
      expect(result).not.toBeNull();
      expect(result!.conversation_id).toBe("conv_123");
      expect(result!.workspace_id).toBe("ws_456");
      expect(result!.project_id).toBe("proj_789");
    });

    it("rejects invalid request (missing required fields)", () => {
      expect(parseRunStartRequest({})).toBeNull();
      expect(parseRunStartRequest({ conversation_id: "c" })).toBeNull();
      expect(parseRunStartRequest(null)).toBeNull();
      expect(parseRunStartRequest("string")).toBeNull();
    });
  });

  describe("WireRunStartResponse with memory_context", () => {
    it("accepts response with memory_context", () => {
      const resp: WireRunStartResponse = {
        run_id: "run_1",
        status: "created",
        memory_context: {
          text: "历史记忆内容",
          used_memory_ids: ["mem-1", "mem-2"],
          used_memory_types: ["member_constraint", "assignment"],
          guarded_member_names: ["小林"],
          memory_backend: "fts5",
          retrieval_count: 10,
          injected_count: 2,
          latency_ms: 15.5,
        },
      };
      expect(resp.run_id).toBe("run_1");
      expect(resp.memory_context).not.toBeNull();
      expect(resp.memory_context!.text).toBe("历史记忆内容");
      expect(resp.memory_context!.used_memory_ids).toEqual(["mem-1", "mem-2"]);
      expect(resp.memory_context!.used_memory_types).toEqual(["member_constraint", "assignment"]);
      expect(resp.memory_context!.guarded_member_names).toEqual(["小林"]);
      expect(resp.memory_context!.memory_backend).toBe("fts5");
      expect(resp.memory_context!.injected_count).toBe(2);
    });

    it("accepts response with null memory_context", () => {
      const resp: WireRunStartResponse = {
        run_id: "run_2",
        status: "created",
        memory_context: null,
      };
      expect(resp.memory_context).toBeNull();
    });

    it("accepts response without memory_context (backward compatible)", () => {
      const resp: WireRunStartResponse = {
        run_id: "run_3",
        status: "created",
      };
      expect(resp.memory_context).toBeUndefined();
    });
  });
});

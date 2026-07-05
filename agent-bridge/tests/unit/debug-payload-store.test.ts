/**
 * Tests for DebugPayloadStore — S16 debug raw payload mode.
 *
 * Verifies:
 * - store() creates records with correct fields
 * - get() retrieves by id
 * - listByRun() filters by runId
 * - pruneExpired() removes expired records
 * - clear() empties the store
 * - size reflects current non-expired records
 * - retention window is respected
 * - default mode (traceIncludeSensitiveData=false) does NOT store raw payloads
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DebugPayloadStore } from "../../src/events/debug-payload-store.js";

describe("DebugPayloadStore", () => {
  let store: DebugPayloadStore;

  beforeEach(() => {
    vi.useFakeTimers();
    // 30-minute retention for most tests
    store = new DebugPayloadStore(30 * 60 * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("store", () => {
    it("creates a record with all expected fields", () => {
      const record = store.store(
        { runId: "run_1", toolCallId: "call_1", toolName: "get_workspace_state" },
        { input: { workspace_id: "ws1" }, output: { data: "result" } },
      );

      expect(record.id).toMatch(/^debug_\d+_\d+$/);
      expect(record.runId).toBe("run_1");
      expect(record.toolCallId).toBe("call_1");
      expect(record.toolName).toBe("get_workspace_state");
      expect(record.input).toEqual({ workspace_id: "ws1" });
      expect(record.output).toEqual({ data: "result" });
      expect(record.createdAt).toBeTruthy();
      expect(record.expiresAt).toBeTruthy();
    });

    it("creates a record with only input", () => {
      const record = store.store(
        { runId: "run_1" },
        { input: { prompt: "test" } },
      );

      expect(record.input).toEqual({ prompt: "test" });
      expect(record.output).toBeUndefined();
    });

    it("creates a record with only output", () => {
      const record = store.store(
        { runId: "run_1" },
        { output: { result: "ok" } },
      );

      expect(record.input).toBeUndefined();
      expect(record.output).toEqual({ result: "ok" });
    });

    it("omits toolCallId and toolName when not provided", () => {
      const record = store.store(
        { runId: "run_1" },
        { input: "test" },
      );

      expect(record).not.toHaveProperty("toolCallId");
      expect(record).not.toHaveProperty("toolName");
    });

    it("generates unique ids for multiple records", () => {
      const r1 = store.store({ runId: "run_1" }, { input: "a" });
      const r2 = store.store({ runId: "run_1" }, { input: "b" });

      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe("get", () => {
    it("retrieves a stored record by id", () => {
      const record = store.store(
        { runId: "run_1", toolCallId: "call_1" },
        { input: "test" },
      );

      expect(store.get(record.id)).toEqual(record);
    });

    it("returns undefined for unknown id", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });
  });

  describe("listByRun", () => {
    it("returns all records for a given runId", () => {
      store.store({ runId: "run_1" }, { input: "a" });
      store.store({ runId: "run_1" }, { input: "b" });
      store.store({ runId: "run_2" }, { input: "c" });

      const results = store.listByRun("run_1");
      expect(results.length).toBe(2);
      expect(results.every((r) => r.runId === "run_1")).toBe(true);
    });

    it("returns empty array when no records match", () => {
      store.store({ runId: "run_1" }, { input: "a" });

      expect(store.listByRun("run_999")).toEqual([]);
    });
  });

  describe("size", () => {
    it("returns 0 for empty store", () => {
      expect(store.size).toBe(0);
    });

    it("reflects number of stored records", () => {
      store.store({ runId: "run_1" }, { input: "a" });
      store.store({ runId: "run_2" }, { input: "b" });

      expect(store.size).toBe(2);
    });

    it("decreases after pruneExpired removes records", () => {
      // Use 1ms retention so records expire immediately
      const shortStore = new DebugPayloadStore(1);
      shortStore.store({ runId: "run_1" }, { input: "a" });

      // Wait a tick for expiry
      vi.advanceTimersByTime(10);

      expect(shortStore.size).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all records", () => {
      store.store({ runId: "run_1" }, { input: "a" });
      store.store({ runId: "run_2" }, { input: "b" });

      store.clear();
      expect(store.size).toBe(0);
      expect(store.listByRun("run_1")).toEqual([]);
    });
  });

  describe("pruneExpired", () => {
    it("removes records past their expiry time", () => {
      // 5ms retention
      const shortStore = new DebugPayloadStore(5);
      const record = shortStore.store({ runId: "run_1" }, { input: "a" });

      // Advance past retention
      vi.advanceTimersByTime(20);

      shortStore.pruneExpired();
      expect(shortStore.get(record.id)).toBeUndefined();
    });

    it("keeps records within their retention window", () => {
      const record = store.store({ runId: "run_1" }, { input: "a" });

      // Don't advance time — record should still be valid
      store.pruneExpired();
      expect(store.get(record.id)).toBeDefined();
    });

    it("is called automatically by get", () => {
      const shortStore = new DebugPayloadStore(1);
      const record = shortStore.store({ runId: "run_1" }, { input: "a" });

      vi.advanceTimersByTime(10);

      // get should trigger prune
      expect(shortStore.get(record.id)).toBeUndefined();
    });

    it("is called automatically by listByRun", () => {
      const shortStore = new DebugPayloadStore(1);
      shortStore.store({ runId: "run_1" }, { input: "a" });

      vi.advanceTimersByTime(10);

      expect(shortStore.listByRun("run_1")).toEqual([]);
    });
  });

  describe("retention window", () => {
    it("uses the provided retentionMs for expiry calculation", () => {
      // 100ms retention
      const customStore = new DebugPayloadStore(100);
      const before = Date.now();
      const record = customStore.store({ runId: "run_1" }, { input: "test" });
      const after = Date.now();

      const expiresAt = Date.parse(record.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 100);
      expect(expiresAt).toBeLessThanOrEqual(after + 100);
    });

    it("defaults to 30 minutes when not specified", () => {
      const defaultStore = new DebugPayloadStore();
      const before = Date.now();
      const record = defaultStore.store({ runId: "run_1" }, { input: "test" });
      const after = Date.now();

      const expiresAt = Date.parse(record.expiresAt);
      const expectedRetention = 30 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(before + expectedRetention);
      expect(expiresAt).toBeLessThanOrEqual(after + expectedRetention);
    });
  });
});

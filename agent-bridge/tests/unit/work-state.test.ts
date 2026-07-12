/**
 * WorkState tests — state transitions, versioning, terminal states.
 */

import { describe, it, expect } from "vitest";
import {
  createInitialWorkState,
  transitionWorkState,
  isValidWorkTransition,
  isTerminalWorkState,
  workStateToUserMessage,
} from "../../src/runtime/work-state.js";

describe("WorkState", () => {
  describe("createInitialWorkState", () => {
    it("starts in understanding state", () => {
      const ws = createInitialWorkState();
      expect(ws.status).toBe("understanding");
      expect(ws.version).toBe(1);
      expect(ws.expectedVersion).toBe(0);
      expect(ws.schemaVersion).toBe(1);
    });
  });

  describe("transitionWorkState", () => {
    it("allows valid transitions", () => {
      const ws = createInitialWorkState();
      const next = transitionWorkState(ws, "planning", ws.version, "creating plan");
      expect(next.status).toBe("planning");
      expect(next.version).toBe(2);
      expect(next.expectedVersion).toBe(1);
    });

    it("rejects invalid transitions", () => {
      const ws = createInitialWorkState();
      // understanding → verifying is NOT valid (must go through planning/executing first)
      expect(() => transitionWorkState(ws, "verifying", ws.version)).toThrow("Illegal WorkState transition");
    });

    it("rejects stale version", () => {
      const ws = createInitialWorkState();
      expect(() => transitionWorkState(ws, "planning", 999, "stale")).toThrow("version mismatch");
    });

    it("tracks currentStepId", () => {
      const ws = createInitialWorkState();
      const next = transitionWorkState(ws, "executing", ws.version, "running", "step-1");
      expect(next.currentStepId).toBe("step-1");
    });
  });

  describe("isValidWorkTransition", () => {
    it("understanding → planning is valid", () => {
      expect(isValidWorkTransition("understanding", "planning")).toBe(true);
    });

    it("understanding → completed is valid", () => {
      expect(isValidWorkTransition("understanding", "completed")).toBe(true);
    });

    it("completed → anything is invalid", () => {
      expect(isValidWorkTransition("completed", "executing")).toBe(false);
      expect(isValidWorkTransition("completed", "failed")).toBe(false);
    });

    it("executing → verifying is valid", () => {
      expect(isValidWorkTransition("executing", "verifying")).toBe(true);
    });
  });

  describe("isTerminalWorkState", () => {
    it("completed is terminal", () => {
      expect(isTerminalWorkState("completed")).toBe(true);
    });

    it("partial is terminal", () => {
      expect(isTerminalWorkState("partial")).toBe(true);
    });

    it("executing is not terminal", () => {
      expect(isTerminalWorkState("executing")).toBe(false);
    });
  });

  describe("workStateToUserMessage", () => {
    it("returns Chinese messages for all states", () => {
      expect(workStateToUserMessage("understanding")).toContain("理解");
      expect(workStateToUserMessage("planning")).toContain("计划");
      expect(workStateToUserMessage("executing")).toContain("执行");
      expect(workStateToUserMessage("verifying")).toContain("验证");
      expect(workStateToUserMessage("completed")).toContain("完成");
    });
  });
});

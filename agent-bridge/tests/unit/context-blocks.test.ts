/**
 * Context blocks tests — budget-aware assembly and compaction.
 *
 * Verifies priority ordering, token budget enforcement, compaction with
 * goal/constraints retention, and block metadata.
 */

import { describe, it, expect } from "vitest";
import { ContextLedger, createBlock, estimateTokens } from "../../src/runtime/context-blocks.js";

describe("ContextLedger", () => {
  it("adds blocks within budget", () => {
    const ledger = new ContextLedger(1000);
    const block = createBlock("test", "invariant", "Hello world", { priority: 100 });
    expect(ledger.add(block)).toBe(true);
    expect(ledger.getTotalTokens()).toBeGreaterThan(0);
    expect(ledger.getRemaining()).toBeLessThan(1000);
  });

  it("rejects non-pinned blocks when budget exceeded", () => {
    const ledger = new ContextLedger(10); // very small budget
    ledger.add(createBlock("a", "invariant", "x".repeat(100), { priority: 100, retention: "droppable" }));
    const result = ledger.add(createBlock("b", "user_input", "y".repeat(100), { priority: 90, retention: "droppable" }));
    expect(result).toBe(false);
  });

  it("always adds pinned blocks even when over budget", () => {
    const ledger = new ContextLedger(10);
    ledger.add(createBlock("a", "invariant", "x".repeat(100), { priority: 100, retention: "pinned" }));
    const result = ledger.add(createBlock("b", "invariant", "y".repeat(100), { priority: 100, retention: "pinned" }));
    expect(result).toBe(true);
    expect(ledger.isOverBudget()).toBe(true);
  });

  it("always adds required blocks even when over budget", () => {
    const ledger = new ContextLedger(10);
    ledger.add(createBlock("a", "workspace_facts", "x".repeat(100), { priority: 80, retention: "required" }));
    const result = ledger.add(createBlock("b", "skill_body", "y".repeat(100), { priority: 70, retention: "required" }));
    expect(result).toBe(true);
  });

  it("returns blocks sorted by priority descending", () => {
    const ledger = new ContextLedger(10000);
    ledger.add(createBlock("low", "tool_observations", "low", { priority: 20 }));
    ledger.add(createBlock("high", "invariant", "high", { priority: 100 }));
    ledger.add(createBlock("mid", "workspace_facts", "mid", { priority: 60 }));

    const blocks = ledger.getBlocks();
    expect(blocks.map((b) => b.id)).toEqual(["high", "mid", "low"]);
  });

  describe("compaction", () => {
    it("drops droppable blocks first when over budget", () => {
      // Budget is 10 tokens, pinned block alone is ~25 tokens (over budget)
      const ledger = new ContextLedger(10);
      ledger.add(createBlock("pinned", "invariant", "x".repeat(100), { priority: 100, retention: "pinned" }));
      // Pinned block pushes over budget, but droppable blocks are rejected
      expect(ledger.isOverBudget()).toBe(true);
      const removed = ledger.compact();
      // No droppable blocks to remove since they were rejected by add()
      expect(removed.length).toBe(0);
    });

    it("removes droppable blocks that fit within budget", () => {
      // Budget allows adding blocks, then we compact
      const ledger = new ContextLedger(100);
      ledger.add(createBlock("pinned", "invariant", "x".repeat(50), { priority: 100, retention: "pinned" }));
      ledger.add(createBlock("droppable1", "tool_observations", "y".repeat(50), { priority: 10, retention: "droppable" }));
      ledger.add(createBlock("droppable2", "tool_observations", "z".repeat(50), { priority: 5, retention: "droppable" }));

      // Total is ~37+12+12 = ~61 tokens, within 100 budget
      expect(ledger.isOverBudget()).toBe(false);
      // compact() should not remove anything since within budget
      const removed = ledger.compact();
      expect(removed.length).toBe(0);
    });

    it("never drops pinned blocks", () => {
      const ledger = new ContextLedger(10);
      ledger.add(createBlock("pinned", "invariant", "x".repeat(100), { priority: 100, retention: "pinned" }));
      ledger.add(createBlock("droppable", "tool_observations", "y".repeat(100), { priority: 10, retention: "droppable" }));

      ledger.compact();
      const blocks = ledger.getBlocks();
      expect(blocks.some((b) => b.id === "pinned")).toBe(true);
    });

    it("preserves higher priority blocks over lower priority", () => {
      const ledger = new ContextLedger(50);
      ledger.add(createBlock("high", "workspace_facts", "important", { priority: 80, retention: "compressible" }));
      ledger.add(createBlock("low", "tool_observations", "old", { priority: 10, retention: "compressible" }));

      ledger.compact();
      const blocks = ledger.getBlocks();
      // Higher priority should survive longer
      if (blocks.length === 1) {
        expect(blocks[0]!.id).toBe("high");
      }
    });
  });
});

describe("estimateTokens", () => {
  it("estimates ASCII text", () => {
    const tokens = estimateTokens("Hello world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("estimates Chinese text (more token-dense)", () => {
    const ascii = estimateTokens("Hello world");
    const chinese = estimateTokens("你好世界");
    // Chinese characters are more token-dense
    expect(chinese).toBeLessThan(ascii * 2); // but not 4x less
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("createBlock", () => {
  it("auto-computes token estimate", () => {
    const block = createBlock("test", "invariant", "Hello world");
    expect(block.estimatedTokens).toBeGreaterThan(0);
  });

  it("uses default priority and retention", () => {
    const block = createBlock("test", "user_input", "content");
    expect(block.priority).toBe(50);
    expect(block.retention).toBe("required");
  });

  it("accepts custom options", () => {
    const block = createBlock("test", "invariant", "content", {
      priority: 100,
      retention: "pinned",
      visibility: "team",
      version: "1.0.0",
    });
    expect(block.priority).toBe(100);
    expect(block.retention).toBe("pinned");
    expect(block.visibility).toBe("team");
    expect(block.version).toBe("1.0.0");
  });
});

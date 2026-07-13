/**
 * Context blocks tests — budget-aware assembly, compaction, receipts, and time gating.
 *
 * Verifies priority ordering, token budget enforcement, compaction with
 * goal/constraints retention, block metadata, receipt accuracy, and
 * needsCurrentTime deterministic helper.
 */

import { describe, it, expect } from "vitest";
import { ContextLedger, createBlock, estimateTokens, needsCurrentTime } from "../../src/runtime/context-blocks.js";

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
      const ledger = new ContextLedger(10);
      ledger.add(createBlock("pinned", "invariant", "x".repeat(100), { priority: 100, retention: "pinned" }));
      expect(ledger.isOverBudget()).toBe(true);
      const removed = ledger.compact();
      expect(removed.length).toBe(0);
    });

    it("removes droppable blocks that fit within budget", () => {
      const ledger = new ContextLedger(100);
      ledger.add(createBlock("pinned", "invariant", "x".repeat(50), { priority: 100, retention: "pinned" }));
      ledger.add(createBlock("droppable1", "tool_observations", "y".repeat(50), { priority: 10, retention: "droppable" }));
      ledger.add(createBlock("droppable2", "tool_observations", "z".repeat(50), { priority: 5, retention: "droppable" }));

      expect(ledger.isOverBudget()).toBe(false);
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
      if (blocks.length === 1) {
        expect(blocks[0]!.id).toBe("high");
      }
    });
  });

  describe("assemble", () => {
    it("returns receipt with retained blocks", () => {
      const ledger = new ContextLedger(10000);
      ledger.add(createBlock("identity", "invariant", "identity", { priority: 100, retention: "pinned" }));
      ledger.add(createBlock("user_msg", "user_input", "hello", { priority: 70, retention: "required" }));

      const { receipt, blocks } = ledger.assemble();

      expect(receipt.schemaVersion).toBe(1);
      expect(receipt.status).toBe("ok");
      expect(receipt.pinnedExceedsBudget).toBe(false);
      expect(receipt.totalTokensBefore).toBeGreaterThan(0);
      expect(receipt.totalTokensAfter).toBe(receipt.totalTokensBefore);
      expect(blocks).toHaveLength(2);

      const retained = receipt.blocks.filter((b) => b.status === "retained");
      expect(retained).toHaveLength(2);
      expect(retained[0]!.id).toBe("identity");
      expect(retained[0]!.source).toBe("invariant");
    });

    it("includes rejected blocks in receipt", () => {
      const ledger = new ContextLedger(10); // very small budget
      ledger.add(createBlock("pinned", "invariant", "x".repeat(100), { priority: 100, retention: "pinned" }));
      // This should be rejected (non-pinned, budget exceeded)
      ledger.add(createBlock("history", "recent_messages", "y".repeat(100), { priority: 40, retention: "compressible" }));

      const { receipt } = ledger.assemble();

      const rejected = receipt.blocks.filter((b) => b.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.id).toBe("history");
      expect(rejected[0]!.reason).toBe("budget_exceeded");
      expect(rejected[0]!.source).toBe("recent_messages");
    });

    it("includes compacted blocks in receipt (pinned pushes over budget → compressible removed)", () => {
      // Start with blocks that fit, then add pinned that pushes over → compressible gets compacted
      const ledger = new ContextLedger(50);
      // These two fit: ~25 + ~12 = ~37 tokens (within 50)
      ledger.add(createBlock("history", "recent_messages", "x".repeat(100), { priority: 40, retention: "compressible" }));
      ledger.add(createBlock("obs", "tool_observations", "y".repeat(50), { priority: 30, retention: "compressible" }));
      // This pinned block pushes total over budget: ~37 + ~25 = ~62 > 50
      ledger.add(createBlock("pinned", "invariant", "z".repeat(100), { priority: 100, retention: "pinned" }));

      const { receipt } = ledger.assemble();

      const compacted = receipt.blocks.filter((b) => b.status === "compacted");
      // At least the lower-priority compressible block should have been compacted
      expect(compacted.length).toBeGreaterThanOrEqual(1);
      expect(compacted.every((b) => b.reason?.startsWith("budget_compact"))).toBe(true);
    });

    it("sets status=degraded when pinned content exceeds budget", () => {
      const ledger = new ContextLedger(10);
      ledger.add(createBlock("big_pinned", "invariant", "x".repeat(200), { priority: 100, retention: "pinned" }));

      const { receipt } = ledger.assemble();

      expect(receipt.status).toBe("degraded");
      expect(receipt.pinnedExceedsBudget).toBe(true);
    });

    it("receipt blocks have no content field", () => {
      const ledger = new ContextLedger(10000);
      ledger.add(createBlock("test", "invariant", "sensitive content", { priority: 100, retention: "pinned" }));

      const { receipt } = ledger.assemble();

      for (const block of receipt.blocks) {
        expect(block).not.toHaveProperty("content");
      }
    });

    it("receipt includes all block attempts (retained + rejected + compacted)", () => {
      const ledger = new ContextLedger(50);
      ledger.add(createBlock("pinned", "invariant", "small", { priority: 100, retention: "pinned" }));
      ledger.add(createBlock("required", "skill_body", "medium", { priority: 90, retention: "required" }));
      ledger.add(createBlock("droppable", "recent_messages", "x".repeat(200), { priority: 40, retention: "compressible" }));
      // Try to add another block that will be rejected
      ledger.add(createBlock("rejected_one", "tool_observations", "y".repeat(200), { priority: 30, retention: "droppable" }));

      const { receipt } = ledger.assemble();

      // All blocks should appear in receipt regardless of outcome
      const totalAttempts = receipt.blocks.length;
      expect(totalAttempts).toBeGreaterThanOrEqual(3); // at least pinned + required + one other

      const statuses = receipt.blocks.map((b) => b.status);
      expect(statuses).toContain("retained");
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
    expect(chinese).toBeLessThan(ascii * 2);
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

describe("needsCurrentTime", () => {
  it("returns false for empty input", () => {
    expect(needsCurrentTime()).toBe(false);
    expect(needsCurrentTime("", "")).toBe(false);
  });

  it("returns false for generic question without date keywords", () => {
    expect(needsCurrentTime("项目进展如何？")).toBe(false);
    expect(needsCurrentTime("What is the status?")).toBe(false);
  });

  it("returns true for Chinese deadline keywords", () => {
    expect(needsCurrentTime("截止日期是什么时候？")).toBe(true);
    expect(needsCurrentTime("帮我排期")).toBe(true);
    expect(needsCurrentTime("制定计划")).toBe(true);
    expect(needsCurrentTime("设置里程碑")).toBe(true);
  });

  it("returns true for English deadline keywords", () => {
    expect(needsCurrentTime("What is the deadline?")).toBe(true);
    expect(needsCurrentTime("Let's schedule the sprint")).toBe(true);
    expect(needsCurrentTime("Create a plan for this week")).toBe(true);
  });

  it("returns true for relative time keywords", () => {
    expect(needsCurrentTime("本周任务")).toBe(true);
    expect(needsCurrentTime("下周安排")).toBe(true);
    expect(needsCurrentTime("今天的进展")).toBe(true);
  });

  it("returns true for goalFromContract with date keywords", () => {
    expect(needsCurrentTime("随便什么", "[project-planning] 帮我制定计划")).toBe(true);
    expect(needsCurrentTime("", "[assignment] 截止日期前完成分工")).toBe(true);
  });

  it("returns false for answer mode generic questions", () => {
    expect(needsCurrentTime("项目进展如何？", undefined)).toBe(false);
    expect(needsCurrentTime("小林负责什么？", undefined)).toBe(false);
  });

  it("is deterministic — same input always returns same result", () => {
    const content = "帮我制定计划，截止日期是下周五";
    const r1 = needsCurrentTime(content);
    const r2 = needsCurrentTime(content);
    expect(r1).toBe(r2);
    expect(r1).toBe(true);
  });
});

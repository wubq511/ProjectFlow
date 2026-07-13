/**
 * Context budget tests — budget-aware assembly and compaction integration.
 *
 * Verifies that buildContext with maxContextTokens:
 * - Creates blocks from real data
 * - Orders stable prefix before dynamic suffix
 * - Pins goal/constraints/pending proposals/memory provenance
 * - Compacts lower-priority blocks when over budget
 * - Records compaction metadata with receipt
 * - Preserves safety rules through compaction
 * - Injects outcome contract in action mode only
 * - Gates current time on date-sensitivity
 */

import { describe, it, expect } from "vitest";
import { buildContext } from "../../src/runtime/context-builder.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";

function makeManifest(name: string): ProjectFlowToolManifest {
  return {
    schemaVersion: 1,
    name,
    version: 1,
    description: `Tool: ${name}`,
    riskCategory: "read_only",
    modelCallable: true,
    sidecarOnly: false,
    humanTriggeredOnly: false,
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {},
    execution: { mode: "parallel", maxConcurrency: 1, providerParallelToolCallsAllowed: true },
    timeoutMs: 5000,
    retry: { maxAttempts: 1, retryOn: [] },
    resultLimit: { maxBytes: 32768, redaction: "none" },
    backend: { owner: "fastapi", endpoint: `/internal/agent-tools/${name}`, method: "POST" },
    effects: { effectType: "none", idempotencyKeyRequired: false, replaySafe: true },
    privacy: { dataClassification: "public", traceIncludeInputs: true, traceIncludeOutputs: true },
    errors: { modelVisibleErrorPolicy: "normalized_summary" },
    resume: { manifestVersion: 1, incompatibleVersionPolicy: "regenerate" },
    trace: { emits: [] },
  };
}

describe("Context budget-aware assembly", () => {
  it("returns compaction metadata when maxContextTokens is set", () => {
    const result = buildContext({
      userContent: "你好",
      toolManifests: [],
      maxContextTokens: 32000,
    });

    expect(result.compaction).toBeDefined();
    expect(result.compaction!.totalTokensBefore).toBeGreaterThan(0);
    expect(result.compaction!.totalTokensAfter).toBeGreaterThan(0);
    expect(result.compaction!.pinnedPreserved).toBe(true);
  });

  it("does not return compaction metadata when maxContextTokens is not set", () => {
    const result = buildContext({
      userContent: "你好",
      toolManifests: [],
    });

    expect(result.compaction).toBeUndefined();
  });

  it("pins identity and domain rules (never dropped)", () => {
    const result = buildContext({
      userContent: "你好",
      toolManifests: [],
      maxContextTokens: 32000,
    });

    expect(result.compaction).toBeDefined();
    const retained = result.compaction!.retainedBlocks;
    expect(retained.some((b) => b.id === "identity")).toBe(true);
    expect(retained.some((b) => b.id === "domain_rules")).toBe(true);
  });

  it("pins pending proposals (never dropped)", () => {
    const result = buildContext({
      userContent: "你好",
      pendingProposals: [{ id: "p1", type: "plan" }],
      toolManifests: [],
      maxContextTokens: 32000,
    });

    expect(result.compaction).toBeDefined();
    const retained = result.compaction!.retainedBlocks;
    expect(retained.some((b) => b.id === "pending_proposals")).toBe(true);
    expect(result.userMessage).toContain("pending_proposals");
  });

  it("pins memory rules when memory is present", () => {
    const result = buildContext({
      userContent: "你好",
      toolManifests: [],
      memoryContext: {
        text: "记忆内容",
        usedMemoryIds: ["mem-1"],
        memoryBackend: "fts5",
        retrievalCount: 1,
        injectedCount: 1,
        latencyMs: 5,
      },
      maxContextTokens: 32000,
    });

    expect(result.compaction).toBeDefined();
    const retained = result.compaction!.retainedBlocks;
    expect(retained.some((b) => b.id === "memory_rules")).toBe(true);
    expect(retained.some((b) => b.id === "project_memory")).toBe(true);
  });

  it("recent_messages block is compressible", () => {
    const result = buildContext({
      userContent: "你好",
      recentMessages: [
        { role: "user", content: "之前的消息" },
        { role: "assistant", content: "之前的回答" },
      ],
      toolManifests: [],
      maxContextTokens: 32000,
    });

    expect(result.compaction).toBeDefined();
    const retained = result.compaction!.retainedBlocks;
    const recentMsg = retained.find((b) => b.id === "recent_messages");
    if (recentMsg) {
      expect(recentMsg.retention).toBe("compressible");
    }
  });

  it("preserves ID mapping table (pinned)", () => {
    const result = buildContext({
      userContent: "你好",
      workspaceState: {
        project: {
          id: "proj-1",
          name: "测试项目",
          stages: [{ id: "s1", name: "方向澄清" }],
        },
      },
      toolManifests: [],
      maxContextTokens: 32000,
    });

    expect(result.compaction).toBeDefined();
    const retained = result.compaction!.retainedBlocks;
    expect(retained.some((b) => b.id === "id_mapping")).toBe(true);
    expect(result.systemPrompt).toContain("ID → 名称");
  });

  it("skill body block is required", () => {
    const result = buildContext({
      userContent: "帮我制定计划",
      toolManifests: [makeManifest("get_workspace_state")],
      skillContext: {
        name: "project-planning",
        description: "阶段计划",
        body: "skill body content",
        allowedTools: ["get_workspace_state"],
      },
      maxContextTokens: 32000,
    });

    expect(result.compaction).toBeDefined();
    const retained = result.compaction!.retainedBlocks;
    const skillBlock = retained.find((b) => b.id === "skill_body");
    expect(skillBlock).toBeDefined();
    expect(skillBlock!.retention).toBe("required");
  });

  it("answer mode produces no tools", () => {
    const result = buildContext({
      userContent: "你好",
      toolManifests: [makeManifest("get_workspace_state")],
      isAnswerMode: true,
      maxContextTokens: 32000,
    });

    expect(result.tools).toEqual([]);
    expect(result.systemPrompt).toContain("可以直接回答");
  });

  it("action mode includes tools", () => {
    const result = buildContext({
      userContent: "帮我制定计划",
      toolManifests: [makeManifest("get_workspace_state"), makeManifest("generate_stage_plan_proposal")],
      skillContext: {
        name: "project-planning",
        description: "阶段计划",
        body: "",
        allowedTools: ["get_workspace_state", "generate_stage_plan_proposal"],
      },
      maxContextTokens: 32000,
    });

    expect(result.tools.length).toBe(2);
    expect(result.systemPrompt).toContain("必须使用工具");
  });

  // ── Prompt ordering: stable prefix before dynamic suffix ──────────

  describe("prompt ordering", () => {
    it("skill body appears before ID mapping table in system prompt", () => {
      const result = buildContext({
        userContent: "帮我制定计划",
        workspaceState: { project: { id: "proj-1", name: "测试" } },
        toolManifests: [makeManifest("get_workspace_state")],
        skillContext: {
          name: "project-planning",
          description: "阶段计划",
          body: "SKILL_BODY_CONTENT",
          allowedTools: ["get_workspace_state"],
        },
        maxContextTokens: 32000,
      });

      const skillIdx = result.systemPrompt.indexOf("SKILL_BODY_CONTENT");
      // Use the table header to find the actual id_mapping block (not the identity text mention)
      const idMapIdx = result.systemPrompt.indexOf("## ID → 名称 对照表");
      expect(skillIdx).toBeGreaterThan(-1);
      expect(idMapIdx).toBeGreaterThan(-1);
      expect(skillIdx).toBeLessThan(idMapIdx);
    });

    it("identity appears before skill body in system prompt", () => {
      const result = buildContext({
        userContent: "帮我制定计划",
        toolManifests: [makeManifest("get_workspace_state")],
        skillContext: {
          name: "project-planning",
          description: "阶段计划",
          body: "SKILL_BODY",
          allowedTools: ["get_workspace_state"],
        },
        maxContextTokens: 32000,
      });

      const identityIdx = result.systemPrompt.indexOf("ProjectFlow");
      const skillIdx = result.systemPrompt.indexOf("SKILL_BODY");
      expect(identityIdx).toBeLessThan(skillIdx);
    });

    it("kernel marker appears exactly once (no duplication)", () => {
      const result = buildContext({
        userContent: "你好",
        toolManifests: [],
        promptKernelVersion: "2.0.0",
        maxContextTokens: 32000,
      });

      const matches = result.systemPrompt.match(/\[prompt_kernel:/g);
      expect(matches).toHaveLength(1);
    });
  });

  // ── Outcome contract (action mode only) ───────────────────────────

  describe("outcome contract", () => {
    it("injects outcome contract block in action mode", () => {
      const result = buildContext({
        userContent: "帮我制定计划",
        toolManifests: [makeManifest("get_workspace_state")],
        skillContext: {
          name: "project-planning",
          description: "阶段计划",
          body: "",
          allowedTools: ["get_workspace_state"],
        },
        outcomeContract: {
          normalizedGoal: "[project-planning] 帮我制定计划",
          constraints: ["不得直接修改 Primary Project State"],
          successCriteria: ["调用必要的工具"],
          effectCeiling: "proposal_only",
          completionMode: "complete",
        },
        maxContextTokens: 32000,
      });

      expect(result.systemPrompt).toContain("本次运行目标");
      expect(result.systemPrompt).toContain("帮我制定计划");
      expect(result.systemPrompt).toContain("proposal_only");
    });

    it("does not inject outcome contract in answer mode", () => {
      const result = buildContext({
        userContent: "项目进展如何？",
        toolManifests: [],
        isAnswerMode: true,
        outcomeContract: {
          normalizedGoal: "项目进展如何？",
          constraints: [],
          successCriteria: [],
          effectCeiling: "none",
          completionMode: "answer-only",
        },
        maxContextTokens: 32000,
      });

      expect(result.systemPrompt).not.toContain("本次运行目标");
    });
  });

  // ── Time gating ───────────────────────────────────────────────────

  describe("time gating", () => {
    it("includes current time when date-sensitive content present", () => {
      const result = buildContext({
        userContent: "帮我制定计划，截止日期是下周五",
        toolManifests: [],
        currentTime: "2026-07-13T10:00:00Z",
        maxContextTokens: 32000,
      });

      expect(result.userMessage).toContain("当前时间: 2026-07-13");
    });

    it("omits current time for generic question without date keywords", () => {
      const result = buildContext({
        userContent: "项目进展如何？",
        toolManifests: [],
        currentTime: "2026-07-13T10:00:00Z",
        maxContextTokens: 32000,
      });

      expect(result.systemPrompt).not.toContain("当前时间");
      expect(result.userMessage).not.toContain("当前时间");
    });

    it("includes time when goalFromContract has date keywords", () => {
      const result = buildContext({
        userContent: "执行任务",
        toolManifests: [],
        currentTime: "2026-07-13T10:00:00Z",
        outcomeContract: {
          normalizedGoal: "[project-planning] 制定截止日期前的计划",
          constraints: [],
          successCriteria: [],
          effectCeiling: "proposal_only",
          completionMode: "complete",
        },
        maxContextTokens: 32000,
      });

      expect(result.userMessage).toContain("当前时间");
    });
  });

  // ── Receipt accuracy ──────────────────────────────────────────────

  describe("receipt", () => {
    it("includes receipt in compaction metadata", () => {
      const result = buildContext({
        userContent: "你好",
        toolManifests: [],
        maxContextTokens: 32000,
      });

      expect(result.compaction!.receipt).toBeDefined();
      expect(result.compaction!.receipt.schemaVersion).toBe(1);
      expect(result.compaction!.receipt.blocks.length).toBeGreaterThan(0);
    });

    it("receipt has no content field on any block", () => {
      const result = buildContext({
        userContent: "你好",
        toolManifests: [],
        maxContextTokens: 32000,
      });

      for (const block of result.compaction!.receipt.blocks) {
        expect(block).not.toHaveProperty("content");
      }
    });

    it("receipt includes id, source, retention, estimatedTokens, status for each block", () => {
      const result = buildContext({
        userContent: "你好",
        toolManifests: [],
        maxContextTokens: 32000,
      });

      for (const block of result.compaction!.receipt.blocks) {
        expect(block).toHaveProperty("id");
        expect(block).toHaveProperty("source");
        expect(block).toHaveProperty("retention");
        expect(block).toHaveProperty("estimatedTokens");
        expect(block).toHaveProperty("status");
        expect(["retained", "compacted", "rejected"]).toContain(block.status);
      }
    });

    it("receipt status is 'ok' when within budget", () => {
      const result = buildContext({
        userContent: "你好",
        toolManifests: [],
        maxContextTokens: 32000,
      });

      expect(result.compaction!.receipt.status).toBe("ok");
    });

    it("receipt status is 'degraded' when pinned content exceeds budget", () => {
      const result = buildContext({
        userContent: "帮我制定详细的阶段计划，包含所有任务拆解、分工推荐和风险分析",
        workspaceState: {
          project: {
            id: "proj-1",
            name: "测试项目".repeat(100),
            idea: "很长的想法".repeat(100),
            stages: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: `阶段${i}`, goal: "目标".repeat(50) })),
            tasks: Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, title: `任务${i}`, description: "描述".repeat(50) })),
          },
        },
        toolManifests: [makeManifest("get_workspace_state")],
        skillContext: {
          name: "project-planning",
          description: "阶段计划",
          body: "skill body".repeat(100),
          allowedTools: ["get_workspace_state"],
        },
        pendingProposals: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, type: "plan", content: "提案内容".repeat(50) })),
        memoryContext: {
          text: "很长的记忆内容".repeat(100),
          usedMemoryIds: ["mem-1"],
          memoryBackend: "fts5",
          retrievalCount: 1,
          injectedCount: 1,
          latencyMs: 5,
        },
        maxContextTokens: 100, // very small budget
      });

      // With such a small budget, pinned content should exceed it
      expect(result.compaction!.receipt.pinnedExceedsBudget).toBe(true);
      expect(result.compaction!.receipt.status).toBe("degraded");
    });
  });
});

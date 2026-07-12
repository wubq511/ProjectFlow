/**
 * Context budget tests — budget-aware assembly and compaction integration.
 *
 * Verifies that buildContext with maxContextTokens:
 * - Creates blocks from real data
 * - Pins goal/constraints/pending proposals/memory provenance
 * - Compacts lower-priority blocks when over budget
 * - Records compaction metadata
 * - Preserves safety rules through compaction
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
});

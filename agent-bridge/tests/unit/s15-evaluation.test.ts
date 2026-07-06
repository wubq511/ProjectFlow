/**
 * S15 Evaluation Tests — 21 Test Matrix scenarios.
 *
 * Covers:
 * - Skill selection: all 6 skills with diverse user messages and workspace states
 * - Tool evaluation: all risk categories, manifest validation, policy decisions
 * - Cross-concern: skill→tool mapping, proposal/advisory boundary, execution mode
 */

import { describe, it, expect } from "vitest";
import { selectSkill } from "../../src/skills/skill-selector.js";
import type { SkillMetadata } from "../../src/skills/skill-index.js";
import {
  evaluatePolicy,
  canExecuteInParallel,
  validateManifestSafety,
} from "../../src/policy/policy-engine.js";
import { checkProposalCreation } from "../../src/policy/proposal-boundary.js";
import { checkAdvisoryCreation, requiresReplanProposal } from "../../src/policy/advisory-boundary.js";
import {
  createReadOnlyTools,
  createProposalTools,
  createAdvisoryTools,
} from "../../src/tools/projectflow-tools.js";
import { registerDefaultTools } from "../../src/tools/register-defaults.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";
import type { FastapiClient } from "../../src/tools/fastapi-client.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    name: "test-skill",
    description: "Test skill",
    location: "/skills/test-skill/SKILL.md",
    allowedTools: ["get_workspace_state"],
    references: [],
    ...overrides,
  };
}

const ALL_SKILLS: SkillMetadata[] = [
  makeSkill({ name: "project-intake", description: "当项目目标模糊、缺少方向卡时触发", allowedTools: ["get_workspace_state", "list_pending_proposals", "generate_direction_card_proposal"] }),
  makeSkill({ name: "project-planning", description: "当需要阶段计划时触发", allowedTools: ["get_workspace_state", "list_pending_proposals", "generate_stage_plan_proposal"] }),
  makeSkill({ name: "task-breakdown", description: "当需要拆分任务时触发", allowedTools: ["get_workspace_state", "generate_task_breakdown_proposal"] }),
  makeSkill({ name: "assignment-planning", description: "当需要分工时触发", allowedTools: ["get_workspace_state", "recommend_assignment"] }),
  makeSkill({ name: "risk-replan", description: "当有阻塞任务、风险或需要重新规划时触发", allowedTools: ["get_workspace_state", "analyze_checkins_and_risks", "generate_replan_proposal"] }),
  makeSkill({ name: "project-status", description: "当用户询问项目进展时触发", allowedTools: ["get_workspace_state", "get_timeline_slice"] }),
];

function createStubFastapiClient(): FastapiClient {
  return {
    callTool: async () => ({}),
    startRun: async () => ({ run_id: "test", status: "created" }),
    getRunStatus: async () => ({ run_id: "test", status: "created", current_turn: 0, current_step: 0, last_event_seq: 0, created_at: "", updated_at: "" }),
    appendEvents: async () => ({ state_version: 1, events: [], tool_results: [] }),
    cancelRun: async () => ({ run_id: "test", status: "cancelled", cancelled: true }),
  } as unknown as FastapiClient;
}

// ─── Skill Selection Test Matrix ────────────────────────────────────────────

describe("S15 evaluation: skill selection matrix", () => {
  // Matrix: skill × user message pattern
  const matrix = [
    // project-intake
    { skill: "project-intake", message: "我有一个新想法", ctx: { hasDirectionCard: false }, expected: "project-intake" },
    { skill: "project-intake", message: "项目方向不太清楚", ctx: { hasDirectionCard: false }, expected: "project-intake" },
    { skill: "project-intake", message: "帮我梳理一下目标", ctx: { hasDirectionCard: false }, expected: "project-intake" },

    // project-planning
    { skill: "project-planning", message: "帮我制定阶段计划", ctx: {}, expected: "project-planning" },
    { skill: "project-planning", message: "项目需要规划一下", ctx: {}, expected: "project-planning" },
    { skill: "project-planning", message: "按三周节奏生成计划", ctx: {}, expected: "project-planning" },

    // task-breakdown
    { skill: "task-breakdown", message: "帮我拆分任务", ctx: {}, expected: "task-breakdown" },
    { skill: "task-breakdown", message: "需要分解一下工作", ctx: {}, expected: "task-breakdown" },
    { skill: "task-breakdown", message: "把需求拆成具体任务", ctx: {}, expected: "task-breakdown" },

    // assignment-planning
    { skill: "assignment-planning", message: "谁做比较合适", ctx: {}, expected: "assignment-planning" },
    { skill: "assignment-planning", message: "帮我分工", ctx: {}, expected: "assignment-planning" },
    { skill: "assignment-planning", message: "分配一下工作", ctx: {}, expected: "assignment-planning" },

    // risk-replan
    { skill: "risk-replan", message: "有任务阻塞了", ctx: { hasBlockedTasks: true }, expected: "risk-replan" },
    { skill: "risk-replan", message: "项目遇到风险了", ctx: { hasBlockedTasks: true }, expected: "risk-replan" },
    { skill: "risk-replan", message: "有延期风险需要重新规划", ctx: { hasBlockedTasks: true }, expected: "risk-replan" },

    // project-status
    { skill: "project-status", message: "项目进展如何", ctx: {}, expected: "project-status" },
    { skill: "project-status", message: "当前进度怎么样", ctx: {}, expected: "project-status" },
    { skill: "project-status", message: "看看项目状态", ctx: {}, expected: "project-status" },
  ] as const;

  for (const { skill, message, ctx, expected } of matrix) {
    it(`selects ${expected} for "${message}" (context: ${JSON.stringify(ctx)})`, () => {
      const result = selectSkill(ALL_SKILLS, { userMessage: message, ...ctx });
      expect(result).not.toBeNull();
      expect(result!.skill.name).toBe(expected);
      expect(result!.confidence).toBeGreaterThan(0);
    });
  }

  it("returns null or low confidence for completely unrelated message", () => {
    const result = selectSkill(ALL_SKILLS, { userMessage: "今天天气不错" });
    if (result) {
      expect(result.confidence).toBeLessThanOrEqual(0.6);
    }
  });

  it("risk-replan gets confidence boost from hasBlockedTasks=true", () => {
    const result = selectSkill(ALL_SKILLS, {
      userMessage: "有阻塞需要处理",
      hasBlockedTasks: true,
    });
    expect(result).not.toBeNull();
    expect(result!.skill.name).toBe("risk-replan");
    expect(result!.confidence).toBeGreaterThan(0.5);
  });
});

// ─── Tool Evaluation Test Matrix ────────────────────────────────────────────

describe("S15 evaluation: tool evaluation matrix", () => {
  const registry = new ToolRegistry();
  registerDefaultTools(registry, createStubFastapiClient());

  it("all 12 default tools are registered", () => {
    expect(registry.size).toBe(12);
  });

  // Risk category → policy decision matrix
  const riskCategoryMatrix: Array<{
    toolName: string;
    expectedCategory: ProjectFlowToolManifest["riskCategory"];
    expectedDecision: "allow" | "deny" | "block";
  }> = [
    { toolName: "get_workspace_state", expectedCategory: "read_only", expectedDecision: "allow" },
    { toolName: "get_agent_conversation", expectedCategory: "read_only", expectedDecision: "allow" },
    { toolName: "list_pending_proposals", expectedCategory: "read_only", expectedDecision: "allow" },
    { toolName: "get_timeline_slice", expectedCategory: "read_only", expectedDecision: "allow" },
    { toolName: "generate_stage_plan_proposal", expectedCategory: "draft_only", expectedDecision: "allow" },
    { toolName: "generate_direction_card_proposal", expectedCategory: "draft_only", expectedDecision: "allow" },
    { toolName: "generate_task_breakdown_proposal", expectedCategory: "draft_only", expectedDecision: "allow" },
    { toolName: "generate_replan_proposal", expectedCategory: "draft_only", expectedDecision: "allow" },
    { toolName: "recommend_assignment", expectedCategory: "draft_only", expectedDecision: "allow" },
    { toolName: "analyze_checkins_and_risks", expectedCategory: "advisory_write", expectedDecision: "allow" },
    { toolName: "create_risk", expectedCategory: "advisory_write", expectedDecision: "allow" },
    { toolName: "create_checkin", expectedCategory: "advisory_write", expectedDecision: "allow" },
  ];

  for (const { toolName, expectedCategory, expectedDecision } of riskCategoryMatrix) {
    it(`${toolName}: riskCategory=${expectedCategory}, policy=${expectedDecision}`, () => {
      const tool = registry.get(toolName);
      expect(tool).toBeDefined();
      expect(tool!.manifest.riskCategory).toBe(expectedCategory);
      const policy = evaluatePolicy(tool!.manifest);
      expect(policy.decision).toBe(expectedDecision);
    });
  }

  // Effect type matrix
  const effectMatrix: Array<{ toolName: string; expectedEffect: string }> = [
    { toolName: "get_workspace_state", expectedEffect: "none" },
    { toolName: "generate_stage_plan_proposal", expectedEffect: "proposal_create" },
    { toolName: "generate_replan_proposal", expectedEffect: "proposal_create" },
    { toolName: "recommend_assignment", expectedEffect: "proposal_create" },
    { toolName: "analyze_checkins_and_risks", expectedEffect: "advisory_record_create" },
    { toolName: "create_risk", expectedEffect: "advisory_record_create" },
    { toolName: "create_checkin", expectedEffect: "advisory_record_create" },
  ];

  for (const { toolName, expectedEffect } of effectMatrix) {
    it(`${toolName}: effectType=${expectedEffect}`, () => {
      const tool = registry.get(toolName);
      expect(tool!.manifest.effects.effectType).toBe(expectedEffect);
    });
  }
});

// ─── Cross-concern: Skill → Tool Mapping ────────────────────────────────────

describe("S15 evaluation: skill → tool mapping", () => {
  it("project-intake allowed-tools are all registered and model-callable", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const allowedTools = ["get_workspace_state", "list_pending_proposals", "generate_direction_card_proposal"];
    for (const toolName of allowedTools) {
      expect(registry.has(toolName)).toBe(true);
      expect(registry.get(toolName)!.manifest.modelCallable).toBe(true);
    }
  });

  it("project-planning allowed-tools are all registered and model-callable", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const allowedTools = ["get_workspace_state", "list_pending_proposals", "generate_stage_plan_proposal"];
    for (const toolName of allowedTools) {
      expect(registry.has(toolName)).toBe(true);
      expect(registry.get(toolName)!.manifest.modelCallable).toBe(true);
    }
  });

  it("task-breakdown allowed-tools are all registered", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const allowedTools = ["get_workspace_state", "generate_task_breakdown_proposal"];
    for (const toolName of allowedTools) {
      expect(registry.has(toolName)).toBe(true);
    }
  });

  it("assignment-planning allowed-tools are all registered", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const allowedTools = ["get_workspace_state", "recommend_assignment"];
    for (const toolName of allowedTools) {
      expect(registry.has(toolName)).toBe(true);
    }
  });

  it("risk-replan allowed-tools are all registered", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const allowedTools = ["get_workspace_state", "analyze_checkins_and_risks", "generate_replan_proposal"];
    for (const toolName of allowedTools) {
      expect(registry.has(toolName)).toBe(true);
    }
  });

  it("project-status allowed-tools are all registered", () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry, createStubFastapiClient());
    const allowedTools = ["get_workspace_state", "get_timeline_slice"];
    for (const toolName of allowedTools) {
      expect(registry.has(toolName)).toBe(true);
    }
  });
});

// ─── Proposal/Advisory Boundary Evaluation ──────────────────────────────────

describe("S15 evaluation: proposal/advisory boundary", () => {
  const registry = new ToolRegistry();
  registerDefaultTools(registry, createStubFastapiClient());

  it("all draft_only tools pass proposal boundary check", () => {
    const draftTools = ["generate_stage_plan_proposal", "generate_direction_card_proposal", "generate_task_breakdown_proposal", "generate_replan_proposal", "recommend_assignment"];
    for (const name of draftTools) {
      const m = registry.get(name)!.manifest;
      const result = checkProposalCreation(m);
      expect(result.allowed).toBe(true);
    }
  });

  it("all advisory_write tools pass advisory boundary check", () => {
    const advisoryTools = ["analyze_checkins_and_risks", "create_risk", "create_checkin"];
    for (const name of advisoryTools) {
      const m = registry.get(name)!.manifest;
      const result = checkAdvisoryCreation(m);
      expect(result.allowed).toBe(true);
    }
  });

  it("read-only tools fail proposal boundary check", () => {
    const readOnlyTools = ["get_workspace_state", "get_agent_conversation", "list_pending_proposals", "get_timeline_slice"];
    for (const name of readOnlyTools) {
      const m = registry.get(name)!.manifest;
      const result = checkProposalCreation(m);
      expect(result.allowed).toBe(false);
    }
  });

  it("read-only tools fail advisory boundary check", () => {
    const readOnlyTools = ["get_workspace_state", "get_agent_conversation"];
    for (const name of readOnlyTools) {
      const m = registry.get(name)!.manifest;
      const result = checkAdvisoryCreation(m);
      expect(result.allowed).toBe(false);
    }
  });

  it("no LLM-callable tool has commit_persisted effect", () => {
    const manifests = registry.getModelCallableManifests();
    for (const m of manifests) {
      expect(m.effects.effectType).not.toBe("commit_persisted");
    }
  });

  it("all proposal tools have proposalConfirmation config", () => {
    const draftTools = ["generate_stage_plan_proposal", "generate_direction_card_proposal", "generate_task_breakdown_proposal", "generate_replan_proposal", "recommend_assignment"];
    for (const name of draftTools) {
      const m = registry.get(name)!.manifest;
      expect(m.proposalConfirmation).toBeDefined();
      expect(m.proposalConfirmation!.createsProposal).toBe(true);
      expect(m.proposalConfirmation!.requiredBeforeCommit).toBe(true);
    }
  });

  it("advisory tools do NOT have proposalConfirmation config", () => {
    const advisoryTools = ["analyze_checkins_and_risks", "create_risk", "create_checkin"];
    for (const name of advisoryTools) {
      const m = registry.get(name)!.manifest;
      expect(m.proposalConfirmation).toBeUndefined();
    }
  });
});

// ─── Execution Mode Evaluation ──────────────────────────────────────────────

describe("S15 evaluation: execution mode", () => {
  const registry = new ToolRegistry();
  registerDefaultTools(registry, createStubFastapiClient());

  it("all read-only tools have parallel execution mode", () => {
    const readOnlyTools = ["get_workspace_state", "get_agent_conversation", "list_pending_proposals", "get_timeline_slice"];
    for (const name of readOnlyTools) {
      expect(registry.get(name)!.manifest.execution.mode).toBe("parallel");
    }
  });

  it("all proposal tools have sequential execution mode", () => {
    const draftTools = ["generate_stage_plan_proposal", "generate_direction_card_proposal", "generate_task_breakdown_proposal", "generate_replan_proposal", "recommend_assignment"];
    for (const name of draftTools) {
      expect(registry.get(name)!.manifest.execution.mode).toBe("sequential");
    }
  });

  it("all advisory tools have sequential execution mode", () => {
    const advisoryTools = ["analyze_checkins_and_risks", "create_risk", "create_checkin"];
    for (const name of advisoryTools) {
      expect(registry.get(name)!.manifest.execution.mode).toBe("sequential");
    }
  });

  it("read-only tools allow provider parallel tool calls", () => {
    const readOnlyTools = ["get_workspace_state", "get_agent_conversation", "list_pending_proposals", "get_timeline_slice"];
    for (const name of readOnlyTools) {
      expect(registry.get(name)!.manifest.execution.providerParallelToolCallsAllowed).toBe(true);
    }
  });

  it("proposal tools disallow provider parallel tool calls", () => {
    const draftTools = ["generate_stage_plan_proposal", "generate_replan_proposal", "recommend_assignment"];
    for (const name of draftTools) {
      expect(registry.get(name)!.manifest.execution.providerParallelToolCallsAllowed).toBe(false);
    }
  });

  it("canExecuteInParallel is true for read-only tools only", () => {
    const readOnlyManifests = ["get_workspace_state", "get_agent_conversation", "list_pending_proposals", "get_timeline_slice"]
      .map((name) => registry.get(name)!.manifest);
    expect(canExecuteInParallel(readOnlyManifests)).toBe(true);

    const mixedManifests = [registry.get("get_workspace_state")!.manifest, registry.get("generate_stage_plan_proposal")!.manifest];
    expect(canExecuteInParallel(mixedManifests)).toBe(false);
  });

  it("proposal tools use project_proposal_write concurrency group", () => {
    const draftTools = ["generate_stage_plan_proposal", "generate_direction_card_proposal", "generate_task_breakdown_proposal", "generate_replan_proposal", "recommend_assignment"];
    for (const name of draftTools) {
      expect(registry.get(name)!.manifest.execution.concurrencyGroup).toBe("project_proposal_write");
    }
  });

  it("advisory tools use project_advisory_write concurrency group", () => {
    const advisoryTools = ["analyze_checkins_and_risks", "create_risk", "create_checkin"];
    for (const name of advisoryTools) {
      expect(registry.get(name)!.manifest.execution.concurrencyGroup).toBe("project_advisory_write");
    }
  });
});

// ─── Manifest Safety Evaluation ─────────────────────────────────────────────

describe("S15 evaluation: manifest safety", () => {
  const registry = new ToolRegistry();
  registerDefaultTools(registry, createStubFastapiClient());

  it("all registered tools pass validateManifestSafety", () => {
    const manifests = registry.getManifests();
    for (const m of manifests) {
      const errors = validateManifestSafety(m);
      expect(errors).toHaveLength(0);
    }
  });

  it("all registered tools have valid backend endpoints", () => {
    const manifests = registry.getManifests();
    for (const m of manifests) {
      expect(m.backend.owner).toBe("fastapi");
      expect(m.backend.method).toBe("POST");
      expect(m.backend.endpoint).toMatch(/^POST \/internal\/agent-tools\//);
    }
  });

  it("all registered tools have idempotency key required for write tools", () => {
    const manifests = registry.getManifests();
    for (const m of manifests) {
      if (m.effects.effectType !== "none") {
        expect(m.effects.idempotencyKeyRequired).toBe(true);
      }
    }
  });

  it("all registered tools have replaySafe=true for advisory and proposal tools", () => {
    const manifests = registry.getManifests();
    for (const m of manifests) {
      if (m.effects.effectType === "proposal_create" || m.effects.effectType === "advisory_record_create") {
        expect(m.effects.replaySafe).toBe(true);
      }
    }
  });
});

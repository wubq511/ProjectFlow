/**
 * Tests for ProjectFlow read-only tools.
 * Verifies manifest completeness, read-only semantics, registration, and that
 * each executor routes through the unified POST /internal/agent-tools/{name}
 * contract via createFastapiToolExecutor (not public GET).
 */

import { describe, it, expect } from "vitest";
import { createReadOnlyTools, createProposalTools } from "../../src/tools/projectflow-tools.js";
import { registerDefaultTools } from "../../src/tools/register-defaults.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { FastapiClient } from "../../src/tools/fastapi-client.js";
import type { ProjectFlowToolManifest } from "../../src/types/tool-manifest.js";
import type { ToolExecutionContext } from "../../src/tools/registry.js";

// Stub FastapiClient for tests. callTool records invocations so we can assert
// that executors route through the unified internal contract.
function createStubFastapiClient(): FastapiClient & {
  calls: Array<{ toolName: string; payload: Record<string, unknown> }>;
} {
  const calls: Array<{ toolName: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    callTool: async (toolName: string, payload: Record<string, unknown>) => {
      calls.push({ toolName, payload });
      return { status: "success", data: { toolName, payload } };
    },
    startRun: async () => ({ run_id: "test", status: "created" }),
    getRunStatus: async () => ({ run_id: "test", status: "created", current_turn: 0, current_step: 0, last_event_seq: 0, created_at: "", updated_at: "" }),
    appendEvents: async () => ({ state_version: 1, events: [], tool_results: [] }),
    cancelRun: async () => ({ run_id: "test", status: "cancelled", cancelled: true }),
  } as unknown as FastapiClient & {
    calls: Array<{ toolName: string; payload: Record<string, unknown> }>;
  };
}

const TOOL_NAMES = [
  "get_workspace_state",
  "get_agent_conversation",
  "list_pending_proposals",
  "get_timeline_slice",
];

const DEFAULT_TOOL_NAMES = [
  ...TOOL_NAMES,
  "generate_stage_plan_proposal",
  "analyze_checkins_and_risks",
  "generate_replan_proposal",
  "recommend_assignment",
  "generate_direction_card_proposal",
  "generate_task_breakdown_proposal",
];

// Map manifest tool name → internal endpoint tool name (POST /internal/agent-tools/{name})
const INTERNAL_TOOL_NAME: Record<string, string> = {
  get_workspace_state: "workspace-state",
  get_agent_conversation: "conversation",
  list_pending_proposals: "pending-proposals",
  get_timeline_slice: "timeline-slice",
  generate_stage_plan_proposal: "stage-plan-proposal",
  analyze_checkins_and_risks: "checkins-and-risks-analysis",
  generate_replan_proposal: "replan-proposal",
  recommend_assignment: "assignment-recommendation",
  generate_direction_card_proposal: "direction-card-proposal",
  generate_task_breakdown_proposal: "task-breakdown-proposal",
};

const INTERNAL_ENDPOINT: Record<string, string> = {
  get_workspace_state: "POST /internal/agent-tools/workspace-state",
  get_agent_conversation: "POST /internal/agent-tools/conversation",
  list_pending_proposals: "POST /internal/agent-tools/pending-proposals",
  get_timeline_slice: "POST /internal/agent-tools/timeline-slice",
  generate_stage_plan_proposal: "POST /internal/agent-tools/stage-plan-proposal",
  analyze_checkins_and_risks: "POST /internal/agent-tools/checkins-and-risks-analysis",
  generate_replan_proposal: "POST /internal/agent-tools/replan-proposal",
  recommend_assignment: "POST /internal/agent-tools/assignment-recommendation",
  generate_direction_card_proposal: "POST /internal/agent-tools/direction-card-proposal",
  generate_task_breakdown_proposal: "POST /internal/agent-tools/task-breakdown-proposal",
};

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: "run_test",
    toolCallId: "call_test",
    conversationId: "conv_test",
    workspaceId: "ws_test",
    projectId: "proj_test",
    toolName: "get_workspace_state",
    toolVersion: 1,
    manifestVersion: 1,
    idempotencyKey: "run_test:call_test:v1",
    ...overrides,
  };
}

describe("projectflow-tools", () => {
  describe("createReadOnlyTools", () => {
    it("returns exactly 4 tools", () => {
      const tools = createReadOnlyTools(createStubFastapiClient());
      expect(tools.length).toBe(4);
    });

    it("each tool has a unique name", () => {
      const tools = createReadOnlyTools(createStubFastapiClient());
      const names = tools.map((t) => t.manifest.name);
      expect(names.sort()).toEqual([...TOOL_NAMES].sort());
    });

    it("each tool has an execute function", () => {
      const tools = createReadOnlyTools(createStubFastapiClient());
      for (const tool of tools) {
        expect(typeof tool.execute).toBe("function");
      }
    });
  });

  describe("manifest completeness", () => {
    const tools = createReadOnlyTools(createStubFastapiClient());

    for (const tool of tools) {
      const m = tool.manifest;

      describe(m.name, () => {
        it("has schemaVersion", () => {
          expect(m.schemaVersion).toBe(1);
        });

        it("has version", () => {
          expect(m.version).toBe(1);
        });

        it("has non-empty description", () => {
          expect(m.description.length).toBeGreaterThan(0);
        });

        it("has inputSchema", () => {
          expect(m.inputSchema).toBeDefined();
        });

        it("has outputSchema", () => {
          expect(m.outputSchema).toBeDefined();
        });

        it("has backend config with POST method and internal endpoint", () => {
          expect(m.backend).toBeDefined();
          expect(m.backend.owner).toBe("fastapi");
          expect(m.backend.method).toBe("POST");
          expect(m.backend.endpoint).toBe(INTERNAL_ENDPOINT[m.name]);
          expect(m.backend.endpoint).toMatch(/^POST \/internal\/agent-tools\//);
        });

        it("has execution config", () => {
          expect(m.execution).toBeDefined();
          expect(typeof m.execution.maxConcurrency).toBe("number");
        });

        it("has timeoutMs > 0", () => {
          expect(m.timeoutMs).toBeGreaterThan(0);
        });

        it("has retry config", () => {
          expect(m.retry).toBeDefined();
          expect(typeof m.retry.maxAttempts).toBe("number");
        });

        it("has resultLimit config", () => {
          expect(m.resultLimit).toBeDefined();
          expect(typeof m.resultLimit.maxBytes).toBe("number");
          expect(m.resultLimit.maxBytes).toBeGreaterThan(0);
        });

        it("has effects config", () => {
          expect(m.effects).toBeDefined();
        });

        it("has privacy config", () => {
          expect(m.privacy).toBeDefined();
          expect(m.privacy.dataClassification).toBeDefined();
        });

        it("has errors config", () => {
          expect(m.errors).toBeDefined();
          expect(m.errors.modelVisibleErrorPolicy).toBeDefined();
        });

        it("has resume config", () => {
          expect(m.resume).toBeDefined();
          expect(m.resume.manifestVersion).toBe(1);
        });

        it("has trace config", () => {
          expect(m.trace).toBeDefined();
          expect(Array.isArray(m.trace.emits)).toBe(true);
        });
      });
    }
  });

  describe("read-only semantics", () => {
    const tools = createReadOnlyTools(createStubFastapiClient());

    for (const tool of tools) {
      const m = tool.manifest;

      describe(m.name, () => {
        it("riskCategory is read_only", () => {
          expect(m.riskCategory).toBe("read_only");
        });

        it("annotations.readOnly is true", () => {
          expect(m.annotations.readOnly).toBe(true);
        });

        it("annotations.destructive is false", () => {
          expect(m.annotations.destructive).toBe(false);
        });

        it("annotations.openWorld is false", () => {
          expect(m.annotations.openWorld).toBe(false);
        });

        it("effects.effectType is none", () => {
          expect(m.effects.effectType).toBe("none");
        });

        it("effects.idempotencyKeyRequired is false", () => {
          expect(m.effects.idempotencyKeyRequired).toBe(false);
        });

        it("effects.replaySafe is true", () => {
          expect(m.effects.replaySafe).toBe(true);
        });

        it("execution.mode is parallel", () => {
          expect(m.execution.mode).toBe("parallel");
        });

        it("modelCallable is true", () => {
          expect(m.modelCallable).toBe(true);
        });

        it("sidecarOnly is false", () => {
          expect(m.sidecarOnly).toBe(false);
        });

        it("humanTriggeredOnly is false", () => {
          expect(m.humanTriggeredOnly).toBe(false);
        });
      });
    }
  });

  describe("no commit effect on LLM-callable tools", () => {
    const tools = createReadOnlyTools(createStubFastapiClient());

    for (const tool of tools) {
      it(`${tool.manifest.name} does not have commit_persisted effect`, () => {
        expect(tool.manifest.effects.effectType).not.toBe("commit_persisted");
      });
    }
  });

  // ─── recommend_assignment (proposal tool) ──────────────────────────────

  describe("createProposalTools", () => {
    it("returns all proposal tools", () => {
      const tools = createProposalTools(createStubFastapiClient());
      const names = tools.map((tool) => tool.manifest.name).sort();
      expect(names).toEqual([
        "generate_direction_card_proposal",
        "generate_replan_proposal",
        "generate_stage_plan_proposal",
        "generate_task_breakdown_proposal",
        "recommend_assignment",
      ]);
    });

    it("each tool has an execute function", () => {
      const tools = createProposalTools(createStubFastapiClient());
      for (const tool of tools) {
        expect(typeof tool.execute).toBe("function");
      }
    });
  });

  describe("recommend_assignment manifest completeness", () => {
    const tools = createProposalTools(createStubFastapiClient());
    const m = tools.find((tool) => tool.manifest.name === "recommend_assignment")!.manifest;

    it("has schemaVersion 1", () => {
      expect(m.schemaVersion).toBe(1);
    });

    it("has version 1", () => {
      expect(m.version).toBe(1);
    });

    it("has non-empty description", () => {
      expect(m.description.length).toBeGreaterThan(0);
    });

    it("has inputSchema with required fields", () => {
      expect(m.inputSchema).toBeDefined();
      const schema = m.inputSchema as { required: string[] };
      expect(schema.required).toContain("stage_id");
      expect(schema.required).toContain("task_id");
      expect(schema.required).toContain("recommended_owner_user_id");
      expect(schema.required).toContain("reason");
    });

    it("has outputSchema", () => {
      expect(m.outputSchema).toBeDefined();
    });

    it("has backend config with POST method and internal endpoint", () => {
      expect(m.backend.owner).toBe("fastapi");
      expect(m.backend.method).toBe("POST");
      expect(m.backend.endpoint).toContain("/internal/agent-tools/assignment-recommendation");
    });

    it("has execution config", () => {
      expect(m.execution).toBeDefined();
      expect(m.execution.mode).toBe("sequential");
    });

    it("has timeoutMs > 0", () => {
      expect(m.timeoutMs).toBeGreaterThan(0);
    });

    it("has retry config", () => {
      expect(m.retry).toBeDefined();
      expect(typeof m.retry.maxAttempts).toBe("number");
    });

    it("has resultLimit config", () => {
      expect(m.resultLimit).toBeDefined();
      expect(typeof m.resultLimit.maxBytes).toBe("number");
      expect(m.resultLimit.maxBytes).toBeGreaterThan(0);
    });

    it("has effects config with proposal_create", () => {
      expect(m.effects).toBeDefined();
      expect(m.effects.effectType).toBe("proposal_create");
      expect(m.effects.idempotencyKeyRequired).toBe(true);
      expect(m.effects.replaySafe).toBe(true);
    });

    it("has proposalConfirmation config", () => {
      expect(m.proposalConfirmation).toBeDefined();
      expect(m.proposalConfirmation!.createsProposal).toBe(true);
      expect(m.proposalConfirmation!.requiredBeforeCommit).toBe(true);
    });

    it("has privacy config", () => {
      expect(m.privacy).toBeDefined();
      expect(m.privacy.dataClassification).toBe("project_sensitive");
    });

    it("has errors config", () => {
      expect(m.errors).toBeDefined();
      expect(m.errors.modelVisibleErrorPolicy).toBe("normalized_summary");
    });

    it("has resume config", () => {
      expect(m.resume).toBeDefined();
      expect(m.resume.manifestVersion).toBe(1);
    });

    it("has trace config", () => {
      expect(m.trace).toBeDefined();
      expect(Array.isArray(m.trace.emits)).toBe(true);
    });
  });

  describe("recommend_assignment proposal semantics", () => {
    const tools = createProposalTools(createStubFastapiClient());
    const m = tools.find((tool) => tool.manifest.name === "recommend_assignment")!.manifest;

    it("riskCategory is draft_only", () => {
      expect(m.riskCategory).toBe("draft_only");
    });

    it("annotations.readOnly is false", () => {
      expect(m.annotations.readOnly).toBe(false);
    });

    it("annotations.destructive is false", () => {
      expect(m.annotations.destructive).toBe(false);
    });

    it("annotations.openWorld is false", () => {
      expect(m.annotations.openWorld).toBe(false);
    });

    it("modelCallable is true", () => {
      expect(m.modelCallable).toBe(true);
    });

    it("sidecarOnly is false", () => {
      expect(m.sidecarOnly).toBe(false);
    });

    it("humanTriggeredOnly is false", () => {
      expect(m.humanTriggeredOnly).toBe(false);
    });

    it("does not have commit_persisted effect", () => {
      expect(m.effects.effectType).not.toBe("commit_persisted");
    });

    it("execution mode is sequential", () => {
      expect(m.execution.mode).toBe("sequential");
    });

    it("concurrencyGroup is project_proposal_write", () => {
      expect(m.execution.concurrencyGroup).toBe("project_proposal_write");
    });

    it("idempotencyKeyRequired is true", () => {
      expect(m.effects.idempotencyKeyRequired).toBe(true);
    });

    it("replaySafe is true", () => {
      expect(m.effects.replaySafe).toBe(true);
    });
  });

  describe("recommend_assignment executor routes correctly", () => {
    it("calls POST /internal/agent-tools/assignment-recommendation with args in arguments", async () => {
      const client = createStubFastapiClient();
      const tools = createProposalTools(client);
      const tool = tools.find((t) => t.manifest.name === "recommend_assignment")!;
      const args = {
        stage_id: "s1",
        task_id: "t1",
        recommended_owner_user_id: "u1",
        reason: "技能匹配",
      };
      await tool.execute(args, makeContext({ toolName: "recommend_assignment" }));
      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.toolName).toBe("assignment-recommendation");
      expect(client.calls[0]!.payload.arguments).toEqual(args);
      expect(client.calls[0]!.payload.run_id).toBe("run_test");
      expect(client.calls[0]!.payload.tool_call_id).toBe("call_test");
      expect(client.calls[0]!.payload.idempotency_key).toBe("run_test:call_test:v1");
    });
  });

  describe("executor routes through unified internal contract", () => {
    it("get_workspace_state calls POST /internal/agent-tools/workspace-state with args in arguments", async () => {
      const client = createStubFastapiClient();
      const tools = createReadOnlyTools(client);
      const tool = tools.find((t) => t.manifest.name === "get_workspace_state")!;
      await tool.execute({ workspace_id: "ws1", project_id: "p1" }, makeContext());
      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.toolName).toBe("workspace-state");
      expect(client.calls[0]!.payload.arguments).toEqual({ workspace_id: "ws1", project_id: "p1" });
      expect(client.calls[0]!.payload.run_id).toBe("run_test");
      expect(client.calls[0]!.payload.tool_call_id).toBe("call_test");
      expect(client.calls[0]!.payload.idempotency_key).toBe("run_test:call_test:v1");
    });

    it("get_agent_conversation calls POST /internal/agent-tools/conversation", async () => {
      const client = createStubFastapiClient();
      const tools = createReadOnlyTools(client);
      const tool = tools.find((t) => t.manifest.name === "get_agent_conversation")!;
      await tool.execute({ project_id: "p1" }, makeContext());
      expect(client.calls[0]!.toolName).toBe("conversation");
      expect(client.calls[0]!.payload.arguments).toEqual({ project_id: "p1" });
    });

    it("list_pending_proposals calls POST /internal/agent-tools/pending-proposals (status filter applied by backend)", async () => {
      const client = createStubFastapiClient();
      const tools = createReadOnlyTools(client);
      const tool = tools.find((t) => t.manifest.name === "list_pending_proposals")!;
      await tool.execute({ project_id: "p1" }, makeContext());
      expect(client.calls[0]!.toolName).toBe("pending-proposals");
      expect(client.calls[0]!.payload.arguments).toEqual({ project_id: "p1" });
    });

    it("get_timeline_slice passes limit/since/event_types through arguments", async () => {
      const client = createStubFastapiClient();
      const tools = createReadOnlyTools(client);
      const tool = tools.find((t) => t.manifest.name === "get_timeline_slice")!;
      await tool.execute(
        { project_id: "p1", limit: 10, since: "2026-07-01T00:00:00Z", event_types: ["agent.started"] },
        makeContext(),
      );
      expect(client.calls[0]!.toolName).toBe("timeline-slice");
      expect(client.calls[0]!.payload.arguments).toEqual({
        project_id: "p1",
        limit: 10,
        since: "2026-07-01T00:00:00Z",
        event_types: ["agent.started"],
      });
    });

    it("each tool maps to the expected internal tool name", () => {
      const tools = createReadOnlyTools(createStubFastapiClient());
      for (const tool of tools) {
        const expected = INTERNAL_TOOL_NAME[tool.manifest.name];
        expect(expected).toBeDefined();
      }
    });
  });

  describe("registerDefaultTools", () => {
    it("registers all default tools into the registry", () => {
      const registry = new ToolRegistry();
      const client = createStubFastapiClient();
      registerDefaultTools(registry, client);
      expect(registry.size).toBe(10);
      for (const name of DEFAULT_TOOL_NAMES) {
        expect(registry.has(name)).toBe(true);
      }
    });

    it("all registered tools are model-callable", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry, createStubFastapiClient());
      const manifests = registry.getModelCallableManifests();
      expect(manifests.length).toBe(10);
    });

    it("getManifests returns all default manifests", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry, createStubFastapiClient());
      const manifests = registry.getManifests();
      expect(manifests.length).toBe(10);
      const names = manifests.map((m: ProjectFlowToolManifest) => m.name).sort();
      expect(names).toEqual([...DEFAULT_TOOL_NAMES].sort());
    });

    it("registers generate_stage_plan_proposal as a draft-only proposal tool", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry, createStubFastapiClient());
      const tool = registry.get("generate_stage_plan_proposal");
      expect(tool).toBeDefined();

      const manifest = tool!.manifest;
      expect(manifest.riskCategory).toBe("draft_only");
      expect(manifest.annotations.readOnly).toBe(false);
      expect(manifest.annotations.destructive).toBe(false);
      expect(manifest.annotations.idempotent).toBe(true);
      expect(manifest.execution.mode).toBe("sequential");
      expect(manifest.execution.concurrencyGroup).toBe("project_proposal_write");
      expect(manifest.execution.providerParallelToolCallsAllowed).toBe(false);
      expect(manifest.effects.effectType).toBe("proposal_create");
      expect(manifest.effects.idempotencyKeyRequired).toBe(true);
      expect(manifest.backend.endpoint).toBe("POST /internal/agent-tools/stage-plan-proposal");
      expect(manifest.proposalConfirmation?.createsProposal).toBe(true);
      expect(manifest.proposalConfirmation?.requiredBeforeCommit).toBe(true);
    });

    it("generate_stage_plan_proposal executor calls POST /internal/agent-tools/stage-plan-proposal", async () => {
      const client = createStubFastapiClient();
      const registry = new ToolRegistry();
      registerDefaultTools(registry, client);
      const tool = registry.get("generate_stage_plan_proposal")!;

      await tool.execute(
        { project_id: "p1", workspace_id: "ws1", user_instruction: "按三周节奏生成阶段计划。" },
        makeContext({ toolName: "generate_stage_plan_proposal" }),
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.toolName).toBe("stage-plan-proposal");
      expect(client.calls[0]!.payload.tool_name).toBe("generate_stage_plan_proposal");
      expect(client.calls[0]!.payload.arguments).toEqual({
        project_id: "p1",
        workspace_id: "ws1",
        user_instruction: "按三周节奏生成阶段计划。",
      });
    });

    it("registers generate_replan_proposal as a draft-only proposal tool", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry, createStubFastapiClient());
      const tool = registry.get("generate_replan_proposal");
      expect(tool).toBeDefined();

      const manifest = tool!.manifest;
      expect(manifest.riskCategory).toBe("draft_only");
      expect(manifest.annotations.readOnly).toBe(false);
      expect(manifest.annotations.destructive).toBe(false);
      expect(manifest.annotations.idempotent).toBe(true);
      expect(manifest.execution.mode).toBe("sequential");
      expect(manifest.execution.concurrencyGroup).toBe("project_proposal_write");
      expect(manifest.execution.providerParallelToolCallsAllowed).toBe(false);
      expect(manifest.effects.effectType).toBe("proposal_create");
      expect(manifest.effects.idempotencyKeyRequired).toBe(true);
      expect(manifest.backend.endpoint).toBe("POST /internal/agent-tools/replan-proposal");
      expect(manifest.proposalConfirmation?.createsProposal).toBe(true);
      expect(manifest.proposalConfirmation?.requiredBeforeCommit).toBe(true);
    });

    it("registers analyze_checkins_and_risks as an advisory-write tool", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry, createStubFastapiClient());
      const tool = registry.get("analyze_checkins_and_risks");
      expect(tool).toBeDefined();

      const manifest = tool!.manifest;
      expect(manifest.riskCategory).toBe("advisory_write");
      expect(manifest.annotations.readOnly).toBe(false);
      expect(manifest.annotations.destructive).toBe(false);
      expect(manifest.annotations.idempotent).toBe(true);
      expect(manifest.execution.mode).toBe("sequential");
      expect(manifest.execution.concurrencyGroup).toBe("project_advisory_write");
      expect(manifest.execution.providerParallelToolCallsAllowed).toBe(false);
      expect(manifest.effects.effectType).toBe("advisory_record_create");
      expect(manifest.effects.idempotencyKeyRequired).toBe(true);
      expect(manifest.backend.endpoint).toBe("POST /internal/agent-tools/checkins-and-risks-analysis");
      expect(manifest.proposalConfirmation).toBeUndefined();
    });

    it("analyze_checkins_and_risks executor calls POST /internal/agent-tools/checkins-and-risks-analysis", async () => {
      const client = createStubFastapiClient();
      const registry = new ToolRegistry();
      registerDefaultTools(registry, client);
      const tool = registry.get("analyze_checkins_and_risks")!;

      await tool.execute(
        { project_id: "p1", workspace_id: "ws1", user_instruction: "Analyze latest blockers and risks." },
        makeContext({ toolName: "analyze_checkins_and_risks" }),
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.toolName).toBe("checkins-and-risks-analysis");
      expect(client.calls[0]!.payload.tool_name).toBe("analyze_checkins_and_risks");
      expect(client.calls[0]!.payload.arguments).toEqual({
        project_id: "p1",
        workspace_id: "ws1",
        user_instruction: "Analyze latest blockers and risks.",
      });
    });

    it("generate_replan_proposal executor calls POST /internal/agent-tools/replan-proposal", async () => {
      const client = createStubFastapiClient();
      const registry = new ToolRegistry();
      registerDefaultTools(registry, client);
      const tool = registry.get("generate_replan_proposal")!;

      await tool.execute(
        { project_id: "p1", user_instruction: "根据签到阻塞生成计划调整草案。" },
        makeContext({ toolName: "generate_replan_proposal" }),
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.toolName).toBe("replan-proposal");
      expect(client.calls[0]!.payload.tool_name).toBe("generate_replan_proposal");
      expect(client.calls[0]!.payload.arguments).toEqual({
        project_id: "p1",
        user_instruction: "根据签到阻塞生成计划调整草案。",
      });
    });

    it("registers recommend_assignment as a draft-only proposal tool", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry, createStubFastapiClient());
      const tool = registry.get("recommend_assignment");
      expect(tool).toBeDefined();

      const manifest = tool!.manifest;
      expect(manifest.riskCategory).toBe("draft_only");
      expect(manifest.annotations.readOnly).toBe(false);
      expect(manifest.annotations.destructive).toBe(false);
      expect(manifest.annotations.idempotent).toBe(true);
      expect(manifest.execution.mode).toBe("sequential");
      expect(manifest.execution.concurrencyGroup).toBe("project_proposal_write");
      expect(manifest.execution.providerParallelToolCallsAllowed).toBe(false);
      expect(manifest.effects.effectType).toBe("proposal_create");
      expect(manifest.effects.idempotencyKeyRequired).toBe(true);
      expect(manifest.backend.endpoint).toBe("POST /internal/agent-tools/assignment-recommendation");
      expect(manifest.proposalConfirmation?.createsProposal).toBe(true);
      expect(manifest.proposalConfirmation?.requiredBeforeCommit).toBe(true);
    });

    it("recommend_assignment executor calls POST /internal/agent-tools/assignment-recommendation", async () => {
      const client = createStubFastapiClient();
      const registry = new ToolRegistry();
      registerDefaultTools(registry, client);
      const tool = registry.get("recommend_assignment")!;

      await tool.execute(
        {
          stage_id: "s1",
          task_id: "t1",
          recommended_owner_user_id: "u1",
          reason: "技能匹配",
        },
        makeContext({ toolName: "recommend_assignment" }),
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.toolName).toBe("assignment-recommendation");
      expect(client.calls[0]!.payload.tool_name).toBe("recommend_assignment");
      expect(client.calls[0]!.payload.arguments).toEqual({
        stage_id: "s1",
        task_id: "t1",
        recommended_owner_user_id: "u1",
        reason: "技能匹配",
      });
    });

    it("registers generate_direction_card_proposal as a draft-only proposal tool", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry, createStubFastapiClient());
      const tool = registry.get("generate_direction_card_proposal");
      expect(tool).toBeDefined();

      const manifest = tool!.manifest;
      expect(manifest.riskCategory).toBe("draft_only");
      expect(manifest.annotations.readOnly).toBe(false);
      expect(manifest.annotations.destructive).toBe(false);
      expect(manifest.annotations.idempotent).toBe(true);
      expect(manifest.execution.mode).toBe("sequential");
      expect(manifest.execution.concurrencyGroup).toBe("project_proposal_write");
      expect(manifest.execution.providerParallelToolCallsAllowed).toBe(false);
      expect(manifest.effects.effectType).toBe("proposal_create");
      expect(manifest.effects.idempotencyKeyRequired).toBe(true);
      expect(manifest.backend.endpoint).toBe("POST /internal/agent-tools/direction-card-proposal");
      expect(manifest.proposalConfirmation?.createsProposal).toBe(true);
      expect(manifest.proposalConfirmation?.requiredBeforeCommit).toBe(true);
    });

    it("generate_direction_card_proposal executor calls POST /internal/agent-tools/direction-card-proposal", async () => {
      const client = createStubFastapiClient();
      const registry = new ToolRegistry();
      registerDefaultTools(registry, client);
      const tool = registry.get("generate_direction_card_proposal")!;

      await tool.execute(
        { project_id: "p1", workspace_id: "ws1", user_instruction: "基于项目idea生成方向卡。" },
        makeContext({ toolName: "generate_direction_card_proposal" }),
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.toolName).toBe("direction-card-proposal");
      expect(client.calls[0]!.payload.tool_name).toBe("generate_direction_card_proposal");
      expect(client.calls[0]!.payload.arguments).toEqual({
        project_id: "p1",
        workspace_id: "ws1",
        user_instruction: "基于项目idea生成方向卡。",
      });
    });

    it("registers generate_task_breakdown_proposal as a draft-only proposal tool", () => {
      const registry = new ToolRegistry();
      registerDefaultTools(registry, createStubFastapiClient());
      const tool = registry.get("generate_task_breakdown_proposal");
      expect(tool).toBeDefined();

      const manifest = tool!.manifest;
      expect(manifest.riskCategory).toBe("draft_only");
      expect(manifest.annotations.readOnly).toBe(false);
      expect(manifest.annotations.destructive).toBe(false);
      expect(manifest.annotations.idempotent).toBe(true);
      expect(manifest.execution.mode).toBe("sequential");
      expect(manifest.execution.concurrencyGroup).toBe("project_proposal_write");
      expect(manifest.execution.providerParallelToolCallsAllowed).toBe(false);
      expect(manifest.effects.effectType).toBe("proposal_create");
      expect(manifest.effects.idempotencyKeyRequired).toBe(true);
      expect(manifest.backend.endpoint).toBe("POST /internal/agent-tools/task-breakdown-proposal");
      expect(manifest.proposalConfirmation?.createsProposal).toBe(true);
      expect(manifest.proposalConfirmation?.requiredBeforeCommit).toBe(true);
    });

    it("generate_task_breakdown_proposal executor calls POST /internal/agent-tools/task-breakdown-proposal", async () => {
      const client = createStubFastapiClient();
      const registry = new ToolRegistry();
      registerDefaultTools(registry, client);
      const tool = registry.get("generate_task_breakdown_proposal")!;

      await tool.execute(
        { project_id: "p1", workspace_id: "ws1", user_instruction: "拆解项目需求为具体任务。" },
        makeContext({ toolName: "generate_task_breakdown_proposal" }),
      );

      expect(client.calls.length).toBe(1);
      expect(client.calls[0]!.toolName).toBe("task-breakdown-proposal");
      expect(client.calls[0]!.payload.tool_name).toBe("generate_task_breakdown_proposal");
      expect(client.calls[0]!.payload.arguments).toEqual({
        project_id: "p1",
        workspace_id: "ws1",
        user_instruction: "拆解项目需求为具体任务。",
      });
    });
  });
});

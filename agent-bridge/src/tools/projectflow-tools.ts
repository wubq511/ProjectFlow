/**
 * ProjectFlow tool definitions.
 *
 * Read-only tools allow the Agent to query workspace state, conversation
 * history, pending proposals, and timeline events without modifying state.
 * Proposal tools create reviewable draft records but never commit primary
 * project state.
 *
 * All tools go through the unified internal contract:
 *   POST /internal/agent-tools/{tool-name}
 * with a single envelope (run_id, tool_call_id, arguments, trace, ...) built by
 * createFastapiToolExecutor.
 */

import type { ProjectFlowToolManifest } from "@/types/tool-manifest.js";
import type { FastapiClient } from "./fastapi-client.js";
import type { RegisteredTool } from "./registry.js";
import { createFastapiToolExecutor } from "./registry.js";

// ─── Shared manifest defaults ────────────────────────────────────────────────

const READ_ONLY_DEFAULTS = {
  schemaVersion: 1,
  version: 1,
  riskCategory: "read_only" as const,
  modelCallable: true,
  sidecarOnly: false,
  humanTriggeredOnly: false,
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  execution: {
    mode: "parallel" as const,
    maxConcurrency: 4,
    providerParallelToolCallsAllowed: true,
  },
  timeoutMs: 30000,
  retry: {
    maxAttempts: 2,
    retryOn: ["timeout", "network_error"],
  },
  resultLimit: {
    maxBytes: 65536,
    redaction: "none" as const,
  },
  effects: {
    effectType: "none" as const,
    idempotencyKeyRequired: false,
    replaySafe: true,
  },
  privacy: {
    dataClassification: "project_sensitive" as const,
    traceIncludeInputs: false,
    traceIncludeOutputs: false,
  },
  errors: {
    modelVisibleErrorPolicy: "normalized_summary" as const,
  },
  resume: {
    manifestVersion: 1,
    incompatibleVersionPolicy: "regenerate" as const,
  },
  trace: {
    emits: ["tool.started", "tool.completed"],
  },
};

const PROPOSAL_DEFAULTS = {
  schemaVersion: 1,
  version: 1,
  riskCategory: "draft_only" as const,
  modelCallable: true,
  sidecarOnly: false,
  humanTriggeredOnly: false,
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  execution: {
    mode: "sequential" as const,
    concurrencyGroup: "project_proposal_write",
    maxConcurrency: 1,
    providerParallelToolCallsAllowed: false,
  },
  timeoutMs: 120000,
  retry: {
    maxAttempts: 1,
    retryOn: ["timeout", "network_error"],
  },
  resultLimit: {
    maxBytes: 65536,
    redaction: "secrets" as const,
  },
  effects: {
    effectType: "proposal_create" as const,
    idempotencyKeyRequired: true,
    replaySafe: true,
  },
  proposalConfirmation: {
    createsProposal: true,
    requiredBeforeCommit: true,
    publicActionOnly: true,
    resumesModelLoopByDefault: false as const,
  },
  privacy: {
    dataClassification: "project_sensitive" as const,
    traceIncludeInputs: false,
    traceIncludeOutputs: false,
  },
  errors: {
    modelVisibleErrorPolicy: "normalized_summary" as const,
  },
  resume: {
    manifestVersion: 1,
    incompatibleVersionPolicy: "regenerate" as const,
  },
  trace: {
    emits: ["tool.started", "tool.completed", "proposal.created"],
  },
};

const ADVISORY_WRITE_DEFAULTS = {
  schemaVersion: 1,
  version: 1,
  riskCategory: "advisory_write" as const,
  modelCallable: true,
  sidecarOnly: false,
  humanTriggeredOnly: false,
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  execution: {
    mode: "sequential" as const,
    concurrencyGroup: "project_advisory_write",
    maxConcurrency: 1,
    providerParallelToolCallsAllowed: false,
  },
  timeoutMs: 120000,
  retry: {
    maxAttempts: 1,
    retryOn: ["timeout", "network_error"],
  },
  resultLimit: {
    maxBytes: 65536,
    redaction: "secrets" as const,
  },
  effects: {
    effectType: "advisory_record_create" as const,
    idempotencyKeyRequired: true,
    replaySafe: true,
  },
  privacy: {
    dataClassification: "project_sensitive" as const,
    traceIncludeInputs: false,
    traceIncludeOutputs: false,
  },
  errors: {
    modelVisibleErrorPolicy: "normalized_summary" as const,
  },
  resume: {
    manifestVersion: 1,
    incompatibleVersionPolicy: "regenerate" as const,
  },
  trace: {
    emits: ["tool.started", "tool.completed", "advisory_record.created"],
  },
};

// ─── Tool: get_workspace_state ────────────────────────────────────────────────

const getWorkspaceStateManifest: ProjectFlowToolManifest = {
  ...READ_ONLY_DEFAULTS,
  name: "get_workspace_state",
  description: "读取当前工作区的完整状态，包括成员、项目、阶段、任务、分工、签到和资源信息。",
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    type: "object",
    description: "WorkspaceStateResponse — 包含 workspace_id, workspace_name, members, project, current_date, timezone",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/workspace-state",
    method: "POST",
  },
};

// ─── Tool: get_agent_conversation ─────────────────────────────────────────────

const getAgentConversationManifest: ProjectFlowToolManifest = {
  ...READ_ONLY_DEFAULTS,
  name: "get_agent_conversation",
  description: "读取当前项目的 Agent 对话历史，包括近期消息和 linked artifacts。",
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    type: "object",
    description: "AgentConversationRead — 包含 conversation_id, project_id, messages, artifacts",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/conversation",
    method: "POST",
  },
};

// ─── Tool: list_pending_proposals ─────────────────────────────────────────────

const listPendingProposalsManifest: ProjectFlowToolManifest = {
  ...READ_ONLY_DEFAULTS,
  name: "list_pending_proposals",
  description: "查询当前项目中未处理的 Agent Proposal，避免重复生成冲突方案。",
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    type: "array",
    description: "AgentProposalRead[] — 每个包含 id, proposal_type, status, created_at, payload",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/pending-proposals",
    method: "POST",
  },
};

// ─── Tool: get_timeline_slice ─────────────────────────────────────────────────

const getTimelineSliceManifest: ProjectFlowToolManifest = {
  ...READ_ONLY_DEFAULTS,
  name: "get_timeline_slice",
  description: "读取项目近期的 AgentEvent timeline，帮助理解刚发生过什么操作和决策。支持按时间和事件类型过滤。",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "返回条数上限（默认 20）" },
      since: { type: "string", description: "只返回此时间之后的事件（ISO 8601 格式，如 2026-07-01T00:00:00Z）" },
      event_types: {
        type: "array",
        items: { type: "string" },
        description: "只返回指定类型的事件（如 agent.started, tool.completed）",
      },
    },
  },
  outputSchema: {
    type: "array",
    description: "AgentEventRead[] — 每个包含 id, event_type, status, input_snapshot, output_snapshot, created_at",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/timeline-slice",
    method: "POST",
  },
};

const readToolResourceManifest: ProjectFlowToolManifest = {
  ...READ_ONLY_DEFAULTS,
  name: "read_tool_resource",
  description: "分页读取当前运行中大型工具结果的后续内容。仅能读取同一 run 已返回的 resource_ref。",
  inputSchema: {
    type: "object",
    properties: {
      resource_id: { type: "string", description: "工具结果返回的 resource_id" },
      cursor: { type: "number", description: "下一页 cursor，首次为 0" },
      limit: { type: "number", description: "每页字节数，最大 65536" },
    },
    required: ["resource_id"],
  },
  outputSchema: {
    type: "object",
    description: "Base64 编码的分页内容、next_cursor、has_more 与内容哈希",
  },
  backend: {
    owner: "fastapi",
    endpoint: "GET /internal/agent-runs/{run_id}/resources/{resource_id}",
    method: "POST",
  },
};

// ─── Tool: generate_stage_plan_proposal ──────────────────────────────────────

const generateStagePlanProposalManifest: ProjectFlowToolManifest = {
  ...PROPOSAL_DEFAULTS,
  name: "generate_stage_plan_proposal",
  description: "根据当前项目状态生成待确认的阶段计划草案，不直接创建或修改 Stage/Project 主事实。",
  inputSchema: {
    type: "object",
    properties: {
      user_instruction: { type: "string", description: "本次阶段计划的用户意图或约束（可选）" },
      output: {
        type: "object",
        description: "阶段计划内容",
        properties: {
          reason: { type: "string", description: "计划理由" },
          requires_confirmation: { type: "boolean" },
          stages: { type: "array", description: "阶段列表" },
        },
        required: ["reason", "stages"],
      },
    },
  },
  outputSchema: {
    type: "object",
    description: "ProjectFlowToolResult — success 时 links.proposal_id 指向 pending plan AgentProposal",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/stage-plan-proposal",
    method: "POST",
  },
};

const generateReplanProposalManifest: ProjectFlowToolManifest = {
  ...PROPOSAL_DEFAULTS,
  name: "generate_replan_proposal",
  description: "根据当前项目状态、签到和风险信号生成待确认的计划调整草案，不直接修改任务、阶段或负责人。",
  inputSchema: {
    type: "object",
    properties: {
      user_instruction: { type: "string", description: "本次重规划的用户意图或触发原因（可选）" },
      output: {
        type: "object",
        description: "重规划内容",
        properties: {
          reason: { type: "string", description: "调整原因" },
          impact: { type: "string", description: "影响描述" },
        },
        required: ["reason", "impact"],
      },
    },
  },
  outputSchema: {
    type: "object",
    description: "ProjectFlowToolResult — success 时 links.proposal_id 指向 pending replan AgentProposal",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/replan-proposal",
    method: "POST",
  },
};

const generateDirectionCardProposalManifest: ProjectFlowToolManifest = {
  ...PROPOSAL_DEFAULTS,
  name: "generate_direction_card_proposal",
  description: "根据当前项目信息生成待确认的方向卡草案，不直接写入 Project。",
  inputSchema: {
    type: "object",
    properties: {
      user_instruction: { type: "string", description: "本次方向卡的补充意图或约束（可选）" },
      output: {
        type: "object",
        description: "方向卡内容",
        properties: {
          reason: { type: "string", description: "分析理由" },
          problem: { type: "string", description: "核心问题" },
          users: { type: "string", description: "目标用户" },
          value: { type: "string", description: "核心价值" },
          deliverables: { type: "array", items: { type: "string" }, description: "交付物" },
        },
        required: ["reason", "problem", "users", "value", "deliverables"],
      },
    },
  },
  outputSchema: {
    type: "object",
    description: "ProjectFlowToolResult — success 时 links.proposal_id 指向 pending clarify AgentProposal",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/direction-card-proposal",
    method: "POST",
  },
};

const generateTaskBreakdownProposalManifest: ProjectFlowToolManifest = {
  ...PROPOSAL_DEFAULTS,
  name: "generate_task_breakdown_proposal",
  description: `根据当前项目和阶段信息生成待确认的任务拆解草案，不直接创建 Task。
⚠️ 枚举值用英文：priority=P0|P1|P2`,
  inputSchema: {
    type: "object",
    required: ["output"],
    properties: {
      stage_id: { type: "string", description: "阶段 UUID（可选）" },
      user_instruction: { type: "string", description: "补充意图或约束（可选）" },
      output: {
        type: "object",
        description: "任务拆解内容",
        properties: {
          reason: { type: "string", description: "拆解理由" },
          requires_confirmation: { type: "boolean" },
          tasks: { type: "array", description: "任务列表" },
        },
        required: ["reason", "requires_confirmation", "tasks"],
      },
    },
  },
  outputSchema: {
    type: "object",
    description: "ProjectFlowToolResult — success 时 links.proposal_id 指向 pending breakdown AgentProposal",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/task-breakdown-proposal",
    method: "POST",
  },
};

const analyzeCheckinsAndRisksManifest: ProjectFlowToolManifest = {
  ...ADVISORY_WRITE_DEFAULTS,
  name: "analyze_checkins_and_risks",
  description: `分析签到和风险信号，幂等创建 advisory Risk/ActionCard 记录。
⚠️ 所有枚举值必须用英文原始值（不要翻译成中文）：
- RiskType enum: deadline / dependency / workload / scope / review / assignment / checkin
- RiskSeverity enum: low / medium / high
- TaskStatus enum: not_started / in_progress / done / blocked / cancelled`,
  inputSchema: {
    type: "object",
    properties: {
      user_instruction: { type: "string", description: "本次分析的补充意图或约束（可选）" },
      checkin_analysis_output: {
        type: "object",
        description: `签到分析结果示例:
{
  "reason": "分析理由（中文）",
  "summary": "签到摘要（中文）",
  "task_updates": [{"task_id": "任务UUID", "user_id": "成员UUID", "status": "in_progress", "progress_note": "进度说明", "blocker": "阻塞原因（可选）"}],
  "risks": [{"type": "deadline", "severity": "high", "title": "风险标题", "description": "风险描述", "evidence": ["证据1"], "recommendation": "建议", "stage_id": "阶段UUID（可选）"}]
}`,
        properties: {
          reason: { type: "string", description: "分析理由" },
          summary: { type: "string", description: "签到摘要" },
          task_updates: { type: "array", items: { type: "object" }, description: "任务状态更新列表" },
          risks: { type: "array", items: { type: "object" }, description: "关联风险列表" },
        },
        required: ["reason", "summary"],
      },
      risk_analysis_output: {
        type: "object",
        description: `风险分析结果示例:
{
  "reason": "分析理由（中文）",
  "risks": [{"type": "deadline", "severity": "high", "title": "风险标题", "description": "风险描述", "evidence": ["证据1"], "recommendation": "建议", "stage_id": "阶段UUID（可选）"}]
}`,
        properties: {
          reason: { type: "string", description: "分析理由" },
          risks: { type: "array", items: { type: "object" }, description: "风险列表" },
        },
        required: ["reason"],
      },
      action_cards: {
        type: "array",
        description: "可选的 ActionCard 记录",
        items: { type: "object" },
      },
    },
  },
  outputSchema: {
    type: "object",
    description: "ProjectFlowToolResult - success 时返回 created_ids，以及需要后续 generate_replan_proposal 处理的 replan_signal。",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/checkins-and-risks-analysis",
    method: "POST",
  },
};

// ─── Tool: recommend_assignment ───────────────────────────────────────────────

const recommendAssignmentManifest: ProjectFlowToolManifest = {
  ...PROPOSAL_DEFAULTS,
  name: "recommend_assignment",
  description:
    "生成分工建议：为指定任务推荐负责人和备选负责人，创建 AssignmentProposal 待确认记录。不直接写入 Task.owner_user_id，需人工确认后才生效。",
  inputSchema: {
    type: "object",
    properties: {
      stage_id: { type: "string", description: "阶段 ID" },
      task_id: { type: "string", description: "任务 ID" },
      recommended_owner_user_id: { type: "string", description: "推荐负责人用户 ID" },
      backup_owner_user_id: { type: "string", description: "备选负责人用户 ID（可选）" },
      reason: { type: "string", description: "推荐理由" },
      skill_match: { type: "string", description: "技能匹配说明（可选）" },
      availability_match: { type: "string", description: "时间匹配说明（可选）" },
      preference_match: { type: "string", description: "意向匹配说明（可选）" },
      constraint_respected: { type: "string", description: "限制条件遵守说明（可选）" },
      risk_note: { type: "string", description: "风险提示（可选）" },
    },
    required: ["stage_id", "task_id", "recommended_owner_user_id", "reason"],
  },
  outputSchema: {
    type: "object",
    description:
      "ProjectFlowToolResult — status=success, data=AssignmentProposalRead (id, project_id, stage_id, task_id, recommended_owner_user_id, backup_owner_user_id, reason, status, created_at), side_effect_status=proposal_persisted, links.proposal_id, links.created_ids",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/assignment-recommendation",
    method: "POST",
  },
};

// ─── Advisory Write Tool: create_risk ───────────────────────────────────────

const createRiskManifest: ProjectFlowToolManifest = {
  schemaVersion: 1,
  version: 1,
  name: "create_risk",
  description:
    "创建风险记录：记录项目风险类型、严重程度、证据和建议。Risk 是 Advisory Project Record，可直接创建，无需提案确认。",
  riskCategory: "advisory_write",
  modelCallable: true,
  sidecarOnly: false,
  humanTriggeredOnly: false,
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  execution: {
    mode: "sequential",
    concurrencyGroup: "project_advisory_write",
    maxConcurrency: 1,
    providerParallelToolCallsAllowed: false,
  },
  timeoutMs: 30_000,
  retry: { maxAttempts: 1, retryOn: ["timeout", "network_error"] },
  resultLimit: { maxBytes: 50_000, redaction: "secrets" as const },
  effects: {
    effectType: "advisory_record_create",
    idempotencyKeyRequired: true,
    replaySafe: true,
  },
  proposalConfirmation: undefined,
  privacy: {
    dataClassification: "project_sensitive" as const,
    traceIncludeInputs: false,
    traceIncludeOutputs: false,
  },
  errors: { modelVisibleErrorPolicy: "normalized_summary" },
  resume: {
    manifestVersion: 1,
    incompatibleVersionPolicy: "regenerate" as const,
  },
  trace: { emits: ["agent.tool_call"] },
  inputSchema: {
    type: "object",
    required: ["type", "severity", "title", "description", "evidence", "recommendation"],
    properties: {
      type: { type: "string", enum: ["deadline", "dependency", "workload", "scope", "review", "assignment", "checkin"] },
      severity: { type: "string", enum: ["low", "medium", "high"] },
      title: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", minLength: 1, maxLength: 2000 },
      evidence: { type: "array", items: { type: "string" }, minItems: 1 },
      recommendation: { type: "string", minLength: 1, maxLength: 1000 },
      stage_id: { type: "string" },
      task_id: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    description:
      "ProjectFlowToolResult — status=success, data=RiskRead (id, project_id, type, severity, title, description, evidence, recommendation, status), side_effect_status=advisory_record_persisted, links.created_ids",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/create-risk",
    method: "POST",
  },
};

// ─── Advisory Write Tool: create_checkin ────────────────────────────────────

const createCheckinManifest: ProjectFlowToolManifest = {
  schemaVersion: 1,
  version: 1,
  name: "create_checkin",
  description:
    "创建签到记录：为指定任务创建签到周期和响应，记录进度和阻塞。签到是 Advisory Project Record，可直接创建，无需提案确认。",
  riskCategory: "advisory_write",
  modelCallable: true,
  sidecarOnly: false,
  humanTriggeredOnly: false,
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
  },
  execution: {
    mode: "sequential",
    concurrencyGroup: "project_advisory_write",
    maxConcurrency: 1,
    providerParallelToolCallsAllowed: false,
  },
  timeoutMs: 30_000,
  retry: { maxAttempts: 1, retryOn: ["timeout", "network_error"] },
  resultLimit: { maxBytes: 50_000, redaction: "secrets" as const },
  effects: {
    effectType: "advisory_record_create",
    idempotencyKeyRequired: true,
    replaySafe: true,
  },
  proposalConfirmation: undefined,
  privacy: {
    dataClassification: "project_sensitive" as const,
    traceIncludeInputs: false,
    traceIncludeOutputs: false,
  },
  errors: { modelVisibleErrorPolicy: "normalized_summary" },
  resume: {
    manifestVersion: 1,
    incompatibleVersionPolicy: "regenerate" as const,
  },
  trace: { emits: ["agent.tool_call"] },
  inputSchema: {
    type: "object",
    required: ["task_id", "user_id", "what_done"],
    properties: {
      task_id: { type: "string" },
      what_done: { type: "string", minLength: 1, maxLength: 2000 },
      blocker: { type: "string" },
      user_id: { type: "string" },
      stage_id: { type: "string" },
      cadence_days: { type: "number", minimum: 1, default: 2 },
      available_hours_next_cycle: { type: "number", minimum: 0 },
      mood_or_confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
  },
  outputSchema: {
    type: "object",
    description:
      "ProjectFlowToolResult — status=success, data=CheckInRead (cycle + responses), side_effect_status=advisory_record_persisted, links.created_ids",
  },
  backend: {
    owner: "fastapi",
    endpoint: "POST /internal/agent-tools/create-checkin",
    method: "POST",
  },
};

// ─── Export: all tools ───────────────────────────────────────────────────────

/**
 * Build all ProjectFlow tools. Each executor is produced by
 * createFastapiToolExecutor, which wraps the args in the unified
 * POST /internal/agent-tools/{name} envelope (run_id, tool_call_id,
 * arguments, trace, idempotency_key, ...).
 *
 * The tool-specific args (workspace_id, project_id, limit, since, ...)
 * are passed by the caller as `args` and arrive at the backend as
 * `arguments`.
 */
export function createReadOnlyTools(fastapiClient: FastapiClient): RegisteredTool[] {
  return [
    {
      manifest: getWorkspaceStateManifest,
      execute: createFastapiToolExecutor(fastapiClient, "workspace-state"),
    },
    {
      manifest: getAgentConversationManifest,
      execute: createFastapiToolExecutor(fastapiClient, "conversation"),
    },
    {
      manifest: listPendingProposalsManifest,
      execute: createFastapiToolExecutor(fastapiClient, "pending-proposals"),
    },
    {
      manifest: getTimelineSliceManifest,
      execute: createFastapiToolExecutor(fastapiClient, "timeline-slice"),
    },
    {
      manifest: readToolResourceManifest,
      execute: async (args, context) => fastapiClient.readToolResource(
        context.runId,
        String(args.resource_id ?? ""),
        typeof args.cursor === "number" ? args.cursor : 0,
        typeof args.limit === "number" ? args.limit : 16_384,
      ),
    },
  ];
}

/** Build the draft-only stage plan proposal tool. */
export function createStagePlanProposalTool(fastapiClient: FastapiClient): RegisteredTool {
  return {
    manifest: generateStagePlanProposalManifest,
    execute: createFastapiToolExecutor(fastapiClient, "stage-plan-proposal"),
  };
}

/** Build the draft-only replan proposal tool. */
export function createReplanProposalTool(fastapiClient: FastapiClient): RegisteredTool {
  return {
    manifest: generateReplanProposalManifest,
    execute: createFastapiToolExecutor(fastapiClient, "replan-proposal"),
  };
}

/** Build the draft-only assignment proposal tool. */
export function createAssignmentProposalTool(fastapiClient: FastapiClient): RegisteredTool {
  return {
    manifest: recommendAssignmentManifest,
    execute: createFastapiToolExecutor(fastapiClient, "assignment-recommendation"),
  };
}

/** Build the draft-only direction card proposal tool. */
export function createDirectionCardProposalTool(fastapiClient: FastapiClient): RegisteredTool {
  return {
    manifest: generateDirectionCardProposalManifest,
    execute: createFastapiToolExecutor(fastapiClient, "direction-card-proposal"),
  };
}

/** Build the draft-only task breakdown proposal tool. */
export function createTaskBreakdownProposalTool(fastapiClient: FastapiClient): RegisteredTool {
  return {
    manifest: generateTaskBreakdownProposalManifest,
    execute: createFastapiToolExecutor(fastapiClient, "task-breakdown-proposal"),
  };
}

/** Build all draft-only proposal tools. */
export function createProposalTools(fastapiClient: FastapiClient): RegisteredTool[] {
  return [
    createStagePlanProposalTool(fastapiClient),
    createReplanProposalTool(fastapiClient),
    createAssignmentProposalTool(fastapiClient),
    createDirectionCardProposalTool(fastapiClient),
    createTaskBreakdownProposalTool(fastapiClient),
  ];
}

/** Build the advisory-write checkin/risk analysis tool. */
export function createCheckinsAndRisksAnalysisTool(fastapiClient: FastapiClient): RegisteredTool {
  return {
    manifest: analyzeCheckinsAndRisksManifest,
    execute: createFastapiToolExecutor(fastapiClient, "checkins-and-risks-analysis"),
  };
}

/** Build the advisory risk creation tool. */
export function createRiskTool(fastapiClient: FastapiClient): RegisteredTool {
  return {
    manifest: createRiskManifest,
    execute: createFastapiToolExecutor(fastapiClient, "create-risk"),
  };
}

/** Build the advisory check-in creation tool. */
export function createCheckinTool(fastapiClient: FastapiClient): RegisteredTool {
  return {
    manifest: createCheckinManifest,
    execute: createFastapiToolExecutor(fastapiClient, "create-checkin"),
  };
}

/** Build all advisory-write tools (risk, checkin, analysis). */
export function createAdvisoryTools(fastapiClient: FastapiClient): RegisteredTool[] {
  return [
    createCheckinsAndRisksAnalysisTool(fastapiClient),
    createRiskTool(fastapiClient),
    createCheckinTool(fastapiClient),
  ];
}

/** Build all default ProjectFlow tools registered for the sidecar runtime. */
export function createDefaultProjectFlowTools(fastapiClient: FastapiClient): RegisteredTool[] {
  return [
    ...createReadOnlyTools(fastapiClient),
    ...createProposalTools(fastapiClient),
    ...createAdvisoryTools(fastapiClient),
  ];
}

/**
 * ProjectFlow tool definitions.
 * Read-only tools allow the Agent to query workspace state, conversation
 * history, pending proposals, and timeline events without modifying state.
 * Proposal tools create reviewable draft records but never commit primary
 * project state.
 *
 * All tools go through the unified internal contract:
 *   POST /internal/agent-tools/{tool-name}
 * with a single envelope (run_id, tool_call_id, arguments, trace, ...) built by
 * createFastapiToolExecutor. Read-only semantics are expressed via the manifest
 * (risk_category=read_only, effects.effect_type=none), NOT via HTTP GET.
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

// ─── Tool: get_workspace_state ────────────────────────────────────────────────

const getWorkspaceStateManifest: ProjectFlowToolManifest = {
  ...READ_ONLY_DEFAULTS,
  name: "get_workspace_state",
  description: "读取当前工作区的完整状态，包括成员、项目、阶段、任务、分工、签到和资源信息。",
  inputSchema: {
    type: "object",
    properties: {
      workspace_id: { type: "string", description: "工作区 ID" },
      project_id: { type: "string", description: "项目 ID（可选，默认取最近创建的项目）" },
    },
    required: ["workspace_id"],
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
    properties: {
      project_id: { type: "string", description: "项目 ID" },
    },
    required: ["project_id"],
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
    properties: {
      project_id: { type: "string", description: "项目 ID" },
    },
    required: ["project_id"],
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
      project_id: { type: "string", description: "项目 ID" },
      limit: { type: "number", description: "返回条数上限（默认 20）" },
      since: { type: "string", description: "只返回此时间之后的事件（ISO 8601 格式，如 2026-07-01T00:00:00Z）" },
      event_types: {
        type: "array",
        items: { type: "string" },
        description: "只返回指定类型的事件（如 agent.started, tool.completed）",
      },
    },
    required: ["project_id"],
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

// ─── Tool: generate_replan_proposal ──────────────────────────────────────────

const generateReplanProposalManifest: ProjectFlowToolManifest = {
  ...PROPOSAL_DEFAULTS,
  name: "generate_replan_proposal",
  description: "根据当前项目状态、签到和风险信号生成待确认的计划调整草案，不直接修改任务、阶段或负责人。",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "项目 ID" },
      user_instruction: { type: "string", description: "本次重规划的用户意图或触发原因（可选）" },
    },
    required: ["project_id"],
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

// ─── Export: all read-only tools ──────────────────────────────────────────────

/**
 * Build the 4 read-only tools. Each executor is produced by
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
  ];
}

/** Build the draft-only replan proposal tool. */
export function createReplanProposalTool(fastapiClient: FastapiClient): RegisteredTool {
  return {
    manifest: generateReplanProposalManifest,
    execute: createFastapiToolExecutor(fastapiClient, "replan-proposal"),
  };
}

/** Build all default ProjectFlow tools registered for the sidecar runtime. */
export function createDefaultProjectFlowTools(fastapiClient: FastapiClient): RegisteredTool[] {
  return [
    ...createReadOnlyTools(fastapiClient),
    createReplanProposalTool(fastapiClient),
  ];
}

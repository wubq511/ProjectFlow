import type {
  User,
  CreateUserRequest,
  Workspace,
  CreateWorkspaceRequest,
  WorkspaceMembership,
  WorkspaceState,
  Invitation,
  CreateInvitationRequest,
  Skill,
  MemberProfile,
  UpsertMemberProfileRequest,
  Project,
  CreateProjectRequest,
  ProjectState,
  ProjectResource,
  AddResourceRequest,
  AgentProposal,
  AssignmentProposal,
  AssignmentResponse,
  AssignmentNegotiation,
  CheckInCycle,
  CheckInResponse,
  Risk,
  ActionCard,
  ProjectMemory,
  AgentEvent,
  AgentConversation,
  AgentConversationTurn,
  AgentSuggestion,
  AgentArtifact,
  AgentFlowResult,
  DemoResetResult,
  ModelConfigEntry,
  ProviderCatalogModel,
} from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api";
const SIDECAR_BASE_URL = process.env.NEXT_PUBLIC_SIDECAR_BASE_URL ?? "http://localhost:4000";

type BackendUser = Omit<User, "user_id"> & { id: string; user_id?: string };
type BackendWorkspace = Omit<Workspace, "workspace_id"> & { id: string; workspace_id?: string };
type BackendInvitation = Omit<Invitation, "invitation_id"> & { id: string; invitation_id?: string };
type BackendWorkspaceMember = {
  user_id: string;
  display_name: string;
  skills?: Skill[];
  available_hours_per_week?: number;
  role_preference?: string;
  interests?: string;
  constraints?: string;
};
type BackendWorkspaceState = {
  workspace_id: string;
  workspace_name: string;
  members: BackendWorkspaceMember[];
};
type BackendRisk = Omit<Risk, "evidence"> & { evidence: unknown[] | Record<string, unknown> };
type BackendProjectState = Omit<ProjectState, "workspace" | "members" | "risks"> & {
  workspace: BackendWorkspace;
  members: BackendUser[];
  risks: BackendRisk[];
};
type BackendAgentConversationTurn = Omit<AgentConversationTurn, "next_suggestions" | "suggestions" | "artifacts"> & {
  next_suggestions?: string[] | null;
  suggestions?: AgentSuggestion[] | null;
  artifacts?: AgentArtifact[] | null;
};

const EVIDENCE_LABELS: Record<string, string> = {
  source: "来源",
  detail: "事实",
  text: "事实",
  task_title: "任务",
  task_status: "任务状态",
  stage_name: "阶段",
  member_name: "成员",
  blocker: "阻塞",
  due_date: "截止日期",
  deadline: "截止日期",
  status: "状态",
  severity: "严重度",
  type: "类型",
  available_hours_next_cycle: "下周期可用时间",
  available_hours: "可用时间",
  recommendation: "建议",
};

function normalizeUser(user: BackendUser): User {
  return {
    ...user,
    user_id: user.user_id ?? user.id,
  };
}

function normalizeWorkspace(workspace: BackendWorkspace): Workspace {
  return {
    ...workspace,
    workspace_id: workspace.workspace_id ?? workspace.id,
  };
}

function normalizeInvitation(invitation: BackendInvitation): Invitation {
  return {
    ...invitation,
    invitation_id: invitation.invitation_id ?? invitation.id,
  };
}

function normalizeEvidenceItem(item: unknown): Risk["evidence"][number] {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return String(item);

  const readable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (value === null || value === undefined || value === "") continue;
    if (key.endsWith("_id") || key === "id") continue;
    const label = EVIDENCE_LABELS[key] ?? key;
    readable[label] = value;
  }

  if (Object.keys(readable).length === 0) {
    return "证据来自项目状态，暂无可展示的详细字段。";
  }
  return readable;
}

function normalizeRisk(risk: BackendRisk): Risk {
  const evidenceItems = Array.isArray(risk.evidence)
    ? risk.evidence
    : [risk.evidence];
  return {
    ...risk,
    evidence: evidenceItems.map(normalizeEvidenceItem),
  };
}

function normalizeProjectState(state: BackendProjectState): ProjectState {
  return {
    ...state,
    workspace: normalizeWorkspace(state.workspace),
    members: state.members.map(normalizeUser),
    risks: state.risks.map(normalizeRisk),
  };
}

function isMissingAggregateEndpoint(error: unknown) {
  return error instanceof Error && error.message.includes("请求失败：404");
}

async function request<T>(path: string, options?: RequestInit & { timeout?: number }): Promise<T> {
  const timeoutMs = options?.timeout ?? 120_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const { headers: customHeaders, ...restOptions } = options || {};
  const mergedHeaders = {
    "Content-Type": "application/json",
    ...(customHeaders instanceof Headers
      ? Object.fromEntries(customHeaders.entries())
      : customHeaders),
  };

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...restOptions,
      headers: mergedHeaders,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`请求失败：${response.status} ${body}`);
    }

    const text = await response.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`接口返回不是有效 JSON：${path}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

async function requestText(path: string, options?: RequestInit & { timeout?: number }): Promise<string> {
  const timeoutMs = options?.timeout ?? 120_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`请求失败：${response.status} ${body}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Project Memories ---
export async function listProjectMemories(projectId: string, viewerUserId: string): Promise<ProjectMemory[]> {
  return request<ProjectMemory[]>(
    `/projects/${encodeURIComponent(projectId)}/memories?viewer_user_id=${encodeURIComponent(viewerUserId)}`,
    { timeout: 30_000 },
  );
}

export async function exportProjectMemoriesMarkdown(projectId: string, viewerUserId: string): Promise<string> {
  return requestText(
    `/projects/${encodeURIComponent(projectId)}/memories.md?viewer_user_id=${encodeURIComponent(viewerUserId)}`,
    { timeout: 30_000 },
  );
}

// --- Users ---
export async function createUser(data: CreateUserRequest): Promise<User> {
  const user = await request<BackendUser>("/users", { method: "POST", body: JSON.stringify(data) });
  return normalizeUser(user);
}

export async function listUsers(): Promise<User[]> {
  const users = await request<BackendUser[]>("/users", { timeout: 10_000 });
  return users.map(normalizeUser);
}

export async function selectDemoUser(userId: string): Promise<void> {
  await request("/users/select-demo-user", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

// --- Workspaces ---
export async function createWorkspace(data: CreateWorkspaceRequest): Promise<Workspace> {
  const workspace = await request<BackendWorkspace>(
    `/workspaces?owner_user_id=${encodeURIComponent(data.owner_user_id)}`,
    {
      method: "POST",
      body: JSON.stringify({
        name: data.name,
        description: data.description ?? null,
        team_size: data.team_size,
        use_case: data.use_case,
      }),
    }
  );
  return normalizeWorkspace(workspace);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const workspaces = await request<BackendWorkspace[]>("/workspaces", { timeout: 10_000 });
  return workspaces.map(normalizeWorkspace);
}

export async function getWorkspaceState(workspaceId: string): Promise<WorkspaceState> {
  const [workspace, agentState, profiles, projects] = await Promise.all([
    getWorkspace(workspaceId),
    request<BackendWorkspaceState>(`/workspaces/${workspaceId}/state`),
    listMemberProfilesByWorkspace(workspaceId),
    listProjectsByWorkspace(workspaceId),
  ]);

  const members = agentState.members.map((member) => ({
    user_id: member.user_id,
    display_name: member.display_name,
    email: null,
    avatar_url: null,
    created_at: workspace.created_at,
  }));

  const memberships = members.map((member) => ({
    id: `${workspaceId}-${member.user_id}`,
    workspace_id: workspaceId,
    user_id: member.user_id,
    role: member.user_id === workspace.owner_user_id ? "owner" as const : "member" as const,
    joined_at: workspace.created_at,
  }));

  return {
    workspace,
    users: members,
    memberships,
    member_profiles: profiles,
    projects,
    members,
  };
}

export async function getWorkspace(workspaceId: string): Promise<Workspace> {
  const workspace = await request<BackendWorkspace>(`/workspaces/${workspaceId}`, { timeout: 10_000 });
  return normalizeWorkspace(workspace);
}

// --- Invitations ---
export async function createInvitation(
  workspaceId: string,
  data: CreateInvitationRequest,
): Promise<Invitation> {
  const invitation = await request<BackendInvitation>("/invitations", {
    method: "POST",
    body: JSON.stringify({
      workspace_id: workspaceId,
      invited_name: data.invited_name,
      invited_email: data.invited_email ?? null,
    }),
  });
  return normalizeInvitation(invitation);
}

export async function acceptInvitation(token: string, userId: string): Promise<void> {
  await request("/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ token, user_id: userId }),
  });
}

// --- Member Profile ---
// TODO: Replace upsertMemberProfile with a dedicated PUT endpoint to avoid the read-then-write race condition
export async function upsertMemberProfile(
  workspaceId: string,
  userId: string,
  data: UpsertMemberProfileRequest,
): Promise<MemberProfile> {
  const profiles = await listMemberProfilesByWorkspace(workspaceId);
  const existing = profiles.find((profile) => profile.user_id === userId);
  if (existing) {
    return request<MemberProfile>(`/member-profiles/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  return request<MemberProfile>("/member-profiles", {
    method: "POST",
    body: JSON.stringify({
      ...data,
      user_id: userId,
      workspace_id: workspaceId,
    }),
  });
}

export async function listMemberProfilesByWorkspace(workspaceId: string): Promise<MemberProfile[]> {
  return request<MemberProfile[]>(`/workspaces/${workspaceId}/profiles`, { timeout: 10_000 });
}

// --- Projects ---
export async function createProject(
  workspaceId: string,
  data: CreateProjectRequest,
): Promise<Project> {
  return request<Project>("/projects", {
    method: "POST",
    body: JSON.stringify({
      ...data,
      workspace_id: workspaceId,
    }),
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  return request<void>(`/projects/${projectId}`, { method: "DELETE" });
}

export async function getProject(projectId: string): Promise<Project> {
  return request<Project>(`/projects/${projectId}`);
}

export async function getProjectState(projectId: string): Promise<ProjectState> {
  try {
    const state = await request<BackendProjectState>(`/projects/${projectId}/state`);
    return normalizeProjectState(state);
  } catch (error) {
    if (!isMissingAggregateEndpoint(error)) {
      throw error;
    }
  }
  return getProjectStateFromSplitEndpoints(projectId);
}

async function getProjectStateFromSplitEndpoints(projectId: string): Promise<ProjectState> {
  const project = await getProject(projectId);
  const [
    workspace,
    resources,
    stages,
    tasks,
    allUsers,
    memberProfiles,
    projects,
    agentProposals,
    assignmentProposals,
    assignmentResponses,
    assignmentNegotiations,
    checkins,
    risks,
    actionCards,
    timeline,
  ] = await Promise.all([
    getWorkspace(project.workspace_id),
    listResourcesByProject(projectId),
    listStagesByProject(projectId),
    listTasksByProject(projectId),
    listUsers(),
    listMemberProfilesByWorkspace(project.workspace_id),
    listProjectsByWorkspace(project.workspace_id),
    listAgentProposalsByProject(projectId),
    listAssignmentProposalsByProject(projectId),
    listAssignmentResponsesByProject(projectId),
    listAssignmentNegotiationsByProject(projectId),
    listCheckinCyclesByProject(projectId),
    listRisksByProject(projectId),
    listActionCardsByProject(projectId),
    listTimelineByProject(projectId),
  ]);
  const workspaceMemberIds = new Set([
    workspace.owner_user_id,
    ...memberProfiles.map((profile) => profile.user_id),
  ]);
  const members = allUsers.filter((user) => workspaceMemberIds.has(user.user_id));
  const memberships: WorkspaceMembership[] = members.map((member) => ({
    id: `${workspace.workspace_id}-${member.user_id}`,
    workspace_id: workspace.workspace_id,
    user_id: member.user_id,
    role: member.user_id === workspace.owner_user_id ? "owner" : "member",
    joined_at: workspace.created_at,
  }));

  return {
    workspace,
    project,
    resources,
    members,
    memberships,
    member_profiles: memberProfiles,
    projects,
    stages,
    tasks,
    agent_proposals: agentProposals,
    assignment_proposals: assignmentProposals,
    assignment_responses: assignmentResponses,
    assignment_negotiations: assignmentNegotiations,
    checkins,
    risks,
    action_cards: actionCards,
    timeline,
  };
}

export async function listProjectsByWorkspace(workspaceId: string): Promise<Project[]> {
  return request<Project[]>(`/workspaces/${workspaceId}/projects`, { timeout: 10_000 });
}

// --- File Upload ---
export type UploadResult = {
  file_id: string
  original_name: string
}

export async function uploadFile(file: File): Promise<UploadResult> {
  const formData = new FormData()
  formData.append("file", file)
  const response = await fetch(`${API_BASE_URL}/uploads`, {
    method: "POST",
    body: formData,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`上传失败：${response.status} ${body}`)
  }
  return response.json()
}

// --- Project Resources ---
export async function addResource(
  projectId: string,
  data: AddResourceRequest,
): Promise<ProjectResource> {
  return request<ProjectResource>("/resources", {
    method: "POST",
    body: JSON.stringify({
      ...data,
      project_id: projectId,
    }),
  });
}

export async function deleteResource(resourceId: string): Promise<void> {
  return request<void>(`/resources/${resourceId}`, { method: "DELETE" });
}

export async function listResourcesByProject(projectId: string): Promise<ProjectResource[]> {
  return request<ProjectResource[]>(`/projects/${projectId}/resources`);
}

export async function listStagesByProject(projectId: string): Promise<ProjectState["stages"]> {
  return request<ProjectState["stages"]>(`/projects/${projectId}/stages`);
}

export async function listTasksByProject(projectId: string): Promise<ProjectState["tasks"]> {
  return request<ProjectState["tasks"]>(`/projects/${projectId}/tasks`);
}

export async function listAssignmentProposalsByProject(projectId: string): Promise<AssignmentProposal[]> {
  return request<AssignmentProposal[]>(`/projects/${projectId}/assignment-proposals`);
}

export async function listAgentProposalsByProject(projectId: string): Promise<AgentProposal[]> {
  return request<AgentProposal[]>(`/agent-proposals?project_id=${encodeURIComponent(projectId)}`);
}

export async function confirmAgentProposal(proposalId: string, confirmedBy: string): Promise<AgentProposal> {
  return request<AgentProposal>(`/agent-proposals/${proposalId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ confirmed_by: confirmedBy }),
  });
}

export async function rejectAgentProposal(proposalId: string, reason: string): Promise<AgentProposal> {
  return request<AgentProposal>(`/agent-proposals/${proposalId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export async function listAssignmentResponsesByProject(projectId: string): Promise<AssignmentResponse[]> {
  return request<AssignmentResponse[]>(`/projects/${projectId}/assignment-responses`);
}

export async function listAssignmentNegotiationsByProject(projectId: string): Promise<AssignmentNegotiation[]> {
  return request<AssignmentNegotiation[]>(`/projects/${projectId}/assignment-negotiations`);
}

export async function listCheckinCyclesByProject(projectId: string): Promise<CheckInCycle[]> {
  return request<CheckInCycle[]>(`/projects/${projectId}/checkin-cycles`);
}

export async function listRisksByProject(projectId: string): Promise<Risk[]> {
  const risks = await request<BackendRisk[]>(`/projects/${projectId}/risks`);
  return risks.map(normalizeRisk);
}

export async function listActionCardsByProject(projectId: string): Promise<ActionCard[]> {
  return request<ActionCard[]>(`/projects/${projectId}/action-cards`);
}

export async function listTimelineByProject(projectId: string): Promise<AgentEvent[]> {
  return request<AgentEvent[]>(`/projects/${projectId}/timeline`);
}

// --- Agent ---
export async function getAgentConversation(projectId: string): Promise<AgentConversation> {
  return request<AgentConversation>(`/projects/${projectId}/agent-conversation`);
}

const QUICK_REPLY_INSTRUCTION_MAP: Record<string, string> = {
  "生成下一步行动卡": "请执行 push 模块：生成下一步行动卡。用户点击了快捷回复「生成下一步行动卡」，请直接运行 push 模块生成行动卡。",
  "分析当前风险": "请执行 risk 模块：分析当前风险。用户点击了快捷回复「分析当前风险」，请直接运行 risk 模块进行风险分析。",
  "根据签到调整计划": "请执行 replan 模块：根据签到结果调整项目计划。用户点击了快捷回复「根据签到调整计划」，请直接运行 replan 模块生成计划调整草案。",
  "根据成员情况推荐分工": "请执行 assign 模块：根据成员情况推荐分工。用户点击了快捷回复「根据成员情况推荐分工」，请直接运行 assign 模块。",
  "把当前阶段拆成任务": "请执行 breakdown 模块：把当前阶段拆成可执行任务。用户点击了快捷回复「把当前阶段拆成任务」，请直接运行 breakdown 模块。",
  "按三周节奏生成阶段计划": "请执行 plan 模块：按三周节奏生成阶段计划。用户点击了快捷回复「按三周节奏生成阶段计划」，请直接运行 plan 模块。",
  "先帮我澄清方向": "请执行 clarify 模块：澄清项目方向。用户点击了快捷回复「先帮我澄清方向」，请直接运行 clarify 模块。",
};

function mapQuickReplyInstruction(label: string): string {
  return QUICK_REPLY_INSTRUCTION_MAP[label] ?? label;
}

function normalizeAgentConversationTurn(turn: BackendAgentConversationTurn): AgentConversationTurn {
  const suggestions = Array.isArray(turn.suggestions) && turn.suggestions.length > 0
    ? turn.suggestions
    : (turn.next_suggestions ?? []).slice(0, 3).map((label, index): AgentSuggestion => ({
        id: `suggestion-${index + 1}`,
        label,
        user_instruction: mapQuickReplyInstruction(label),
        priority: index === 0 ? "primary" : "secondary",
      }));

  return {
    ...turn,
    next_suggestions: turn.next_suggestions ?? suggestions.map((suggestion) => suggestion.label),
    suggestions,
    artifacts: Array.isArray(turn.artifacts) ? turn.artifacts : [],
  };
}

export async function sendAgentConversationMessage(
  conversationId: string,
  content: string,
): Promise<AgentConversationTurn> {
  const viewer_user_id = typeof window !== "undefined" && window.localStorage ? localStorage.getItem("projectflow:current-user-id") || undefined : undefined;
  const turn = await request<BackendAgentConversationTurn>(`/agent/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, viewer_user_id }),
  });
  return normalizeAgentConversationTurn(turn);
}

export type AgentStreamCallbacks = {
  onStatus: (status: { phase: string; module?: string; message: string }) => void;
  onToken: (token: string) => void;
  onDone: (turn: AgentConversationTurn) => void;
  onError: (error: string) => void;
};

export async function sendAgentConversationMessageStream(
  conversationId: string,
  content: string,
  callbacks: AgentStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const viewer_user_id = typeof window !== "undefined" && window.localStorage ? localStorage.getItem("projectflow:current-user-id") || undefined : undefined;
  const response = await fetch(`${API_BASE_URL}/agent/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, viewer_user_id }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`请求失败：${response.status} ${body}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取响应流");

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            switch (currentEvent) {
              case "status":
                callbacks.onStatus(data);
                break;
              case "token":
                callbacks.onToken(data.content);
                break;
              case "done":
                callbacks.onDone(normalizeAgentConversationTurn(data));
                break;
              case "error":
                callbacks.onError(data.message);
                break;
            }
          } catch {
            // skip malformed JSON
          }
          currentEvent = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Agent skill name mapping: frontend action key → sidecar skill name.
 * When the sidecar is available, we route through it instead of the legacy
 * Backend /agent/* endpoints.
 */
const SKILL_NAME_MAP: Record<string, string> = {
  clarify: "project-intake",
  plan: "project-planning",
  breakdown: "task-breakdown",
  assign: "assignment-planning",
  "active-push": "project-status",
  "check-in-analysis": "risk-replan",
  "risk-analysis": "risk-replan",
  replan: "risk-replan",
  negotiate: "assignment-planning",
  retrospective: "project-status",
};

const ENDPOINT_EVENT_TYPE_MAP: Record<string, string> = {
  clarify: "clarify",
  plan: "plan",
  breakdown: "breakdown",
  assign: "assign",
  "active-push": "push",
  "check-in-analysis": "checkin",
  "risk-analysis": "risk",
  replan: "replan",
  negotiate: "assign",
  retrospective: "retro",
};

async function runAgentFlow(
  projectId: string,
  endpoint: string,
  extraBody?: Record<string, unknown>,
  thinkingLevel?: import("./types").ThinkingLevel,
  model?: { provider: string; name: string },
): Promise<AgentFlowResult> {
  const project = await getProject(projectId);

  // T41 target architecture: Sidecar is the sole LLM caller
  const skillName = SKILL_NAME_MAP[endpoint];
  if (!skillName) {
    throw new Error(`No sidecar skill mapping for agent endpoint "${endpoint}"`);
  }

  // Build user_content: include user_instruction and any extra context (e.g. stage_id)
  const extraContext = Object.entries(extraBody ?? {})
    .filter(([key]) => key !== "user_instruction")
    .map(([key, val]) => `${key}=${val}`)
    .join(", ");
  const userContent = [
    extraBody?.user_instruction ?? `触发 ${endpoint}`,
    extraContext && `(${extraContext})`,
  ]
    .filter(Boolean)
    .join(" ");

  const sidecarResp = await fetch(`${SIDECAR_BASE_URL}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: `project-${projectId}`,
      workspace_id: project.workspace_id,
      project_id: projectId,
      viewer_user_id: typeof window !== "undefined" && window.localStorage ? localStorage.getItem("projectflow:current-user-id") || undefined : undefined,
      user_content: userContent,
      runtime_config: {
        skill: skillName,
        max_steps: 10,
        max_tool_calls: 20,
        ...(thinkingLevel && { thinking_level: thinkingLevel }),
        ...(model && { model }),
      },
    }),
  });

  if (!sidecarResp.ok) {
    throw new Error(`Sidecar run start failed: ${sidecarResp.status} ${sidecarResp.statusText}`);
  }

  const { run_id: runId } = (await sidecarResp.json()) as { run_id: string; status: string };

  // Step 2: Poll until completed/failed/cancelled
  const POLL_INTERVAL_MS = 1000;
  const POLL_TIMEOUT_MS = 300_000; // 5 minutes for long-running tasks like retro generation
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const startTime = Date.now();

  let runStatus: string = "running";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollResp = await fetch(`${SIDECAR_BASE_URL}/runs/${runId}`);
    if (!pollResp.ok) {
      if (pollResp.status === 404) {
        throw new Error(`Sidecar run ${runId} not found (404)`);
      }
      continue; // transient error, keep polling
    }
    const pollData = (await pollResp.json()) as { status: string };
    runStatus = pollData.status;
    if (runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled") break;
  }

  // Step 3: Return result based on final status
  // BUG FIX: Check terminal status BEFORE timeout to avoid race condition
  // where the last poll returns completed right at the deadline boundary
  const isTerminal = runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled";
  const timedOut = !isTerminal && Date.now() >= deadline;

  if (runStatus === "completed") {
    // Verify success: check timeline for a corresponding event
    try {
      const timeline = await listTimelineByProject(projectId);
      // BUG FIX: Use startTime (not startTime - 30s) as lower bound
      // to avoid matching events from a previous run
      const recentEvent = timeline.find(e => new Date(e.created_at).getTime() >= startTime);
      if (recentEvent) {
        return {
          event_type: recentEvent.event_type as AgentFlowResult["event_type"],
          status: recentEvent.status,
          attempts: 1,
          used_fallback: recentEvent.status === "fallback",
          output: recentEvent.output_snapshot ?? {},
          created_ids: [],
        };
      }
    } catch (e) {
      console.error("Failed to verify timeline event:", e);
    }
    // Sidecar completed but no matching timeline event — degraded success
    const fallbackEventType = ENDPOINT_EVENT_TYPE_MAP[endpoint] ?? "clarify";
    console.warn("Agent run completed but no matching timeline event found, fallback event_type=%s", fallbackEventType);
    return {
      event_type: fallbackEventType as AgentFlowResult["event_type"],
      status: "success",
      attempts: 1,
      used_fallback: false,
      output: {},
      created_ids: [],
    };
  }

  if (runStatus === "failed") {
    throw new Error(`Sidecar run ${runId} failed`);
  }

  if (runStatus === "cancelled") {
    throw new Error(`Sidecar run ${runId} was cancelled`);
  }

  if (timedOut) {
    const fallbackEventType = ENDPOINT_EVENT_TYPE_MAP[endpoint] ?? "clarify";
    console.warn("Agent run polling timed out after %dms, run status still: %s, returning degraded fallback", POLL_TIMEOUT_MS, runStatus);
    return {
      event_type: fallbackEventType as AgentFlowResult["event_type"],
      status: "fallback" as AgentFlowResult["status"],
      attempts: 1,
      used_fallback: true,
      output: {},
      created_ids: [],
    };
  }

  throw new Error(`Sidecar run ${runId} ended with unexpected status "${runStatus}"`);
}

type TL = import("./types").ThinkingLevel;
type ModelRef = { provider: string; name: string };

export async function runClarification(projectId: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "clarify", undefined, thinkingLevel, model);
}

export async function runPlanning(projectId: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "plan", undefined, thinkingLevel, model);
}

export async function runBreakdown(projectId: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "breakdown", undefined, thinkingLevel, model);
}

export async function runAssignment(projectId: string, stageId?: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "assign", stageId ? { stage_id: stageId } : undefined, thinkingLevel, model);
}

export async function runActivePush(projectId: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "active-push", undefined, thinkingLevel, model);
}

export async function runCheckinAnalysis(projectId: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "check-in-analysis", undefined, thinkingLevel, model);
}

export async function runRiskAnalysis(projectId: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "risk-analysis", undefined, thinkingLevel, model);
}

export async function runReplan(projectId: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "replan", undefined, thinkingLevel, model);
}

export async function runAgentNegotiate(projectId: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "negotiate", undefined, thinkingLevel, model);
}

export async function runRetrospective(projectId: string, thinkingLevel?: TL, model?: ModelRef): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "retrospective", undefined, thinkingLevel, model);
}

// --- Confirmation ---
export async function confirmAgentOutput(
  projectId: string,
  timelineEventId: string,
  confirmType: string,
  accepted: boolean,
  confirmedBy: string,
): Promise<void> {
  await request(`/projects/${projectId}/confirm`, {
    method: "POST",
    body: JSON.stringify({
      timeline_event_id: timelineEventId,
      confirm_type: confirmType,
      accepted,
      confirmed_by: confirmedBy,
    }),
  });
}

// --- Assignment ---
export async function respondToAssignment(
  proposalId: string,
  userId: string,
  response: "accept" | "reject",
  preferredTaskId?: string,
  reason?: string,
): Promise<AssignmentResponse> {
  return request<AssignmentResponse>(`/assignment-proposals/${proposalId}/responses`, {
    method: "POST",
    body: JSON.stringify({
      user_id: userId,
      response,
      preferred_task_id: preferredTaskId,
      reason,
    }),
  });
}

export async function startNegotiation(
  projectId: string,
  proposalId: string,
  fromUserId: string,
  desiredTaskId: string,
): Promise<AssignmentNegotiation> {
  // POST to the new backend endpoint which generates a readable agent_message
  return request<AssignmentNegotiation>(`/assignment-proposals/${proposalId}/negotiations`, {
    method: "POST",
    body: JSON.stringify({
      from_user_id: fromUserId,
      desired_task_id: desiredTaskId,
    }),
  });
}

export async function resolveNegotiation(
  negotiationId: string,
  accepted: boolean,
  resolvedBy: string,
): Promise<void> {
  await request(`/assignment-negotiations/${negotiationId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ accepted, resolved_by: resolvedBy }),
  });
}

export async function finalizeAssignments(stageId: string, finalizedBy: string): Promise<void> {
  await request(`/stages/${stageId}/assignments/finalize`, {
    method: "POST",
    body: JSON.stringify({ finalized_by: finalizedBy }),
  });
}

// --- Check-in ---
export async function createCheckinCycle(
  projectId: string,
  stageId: string,
  cadenceDays: number,
  startDate: string,
  createdByUserId: string,
): Promise<CheckInCycle> {
  return request<CheckInCycle>("/checkin-cycles", {
    method: "POST",
    body: JSON.stringify({
      project_id: projectId,
      stage_id: stageId,
      cadence_days: cadenceDays,
      start_date: startDate,
      created_by_user_id: createdByUserId,
    }),
  });
}

export async function submitCheckinResponse(
  cycleId: string,
  data: {
    project_id: string;
    stage_id: string;
    user_id: string;
    task_id?: string;
    what_done: string;
    blocker?: string;
    available_hours_next_cycle?: number;
    mood_or_confidence?: "low" | "medium" | "high";
  },
): Promise<CheckInResponse> {
  return request<CheckInResponse>(`/checkin-cycles/${cycleId}/responses`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// --- Task ---
export async function updateTaskStatus(
  taskId: string,
  data: {
    user_id: string;
    status: "not_started" | "in_progress" | "done" | "blocked";
    progress_note?: string;
    blocker?: string;
    available_hours_change?: number;
  },
): Promise<void> {
  await request(`/tasks/${taskId}/status-updates`, {
    method: "POST",
    body: JSON.stringify({
      task_id: taskId,
      user_id: data.user_id,
      status: data.status,
      progress_note: data.progress_note,
      blocker: data.blocker,
      available_hours_change: data.available_hours_change,
    }),
  });
}

export async function updateActionCardStatus(
  cardId: string,
  status: "done" | "dismissed",
): Promise<ActionCard> {
  return request<ActionCard>(`/action-cards/${cardId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function updateRiskStatus(
  riskId: string,
  status: "accepted" | "ignored" | "resolved",
): Promise<Risk> {
  const risk = await request<BackendRisk>(`/risks/${riskId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  return normalizeRisk(risk);
}

export async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: "owner" | "member" = "member",
): Promise<WorkspaceMembership> {
  return request<WorkspaceMembership>(`/workspaces/${workspaceId}/members`, {
    method: "POST",
    body: JSON.stringify({ user_id: userId, role }),
  });
}

export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  await request(`/workspaces/${workspaceId}/members/${userId}`, {
    method: "DELETE",
  });
}

// --- Seed / Reset ---
export async function loadDemoSeed(): Promise<{ status: string; summary: Record<string, number> }> {
  return request<{ status: string; summary: Record<string, number> }>("/seed/demo", {
    method: "POST",
  });
}

export async function resetDemoData(): Promise<{ status: string; deleted: Record<string, number> }> {
  return request<{ status: string; deleted: Record<string, number> }>("/seed/reset", {
    method: "POST",
  });
}

// --- Export ---
export async function exportReviewSummary(projectId: string): Promise<{ markdown: string }> {
  return request<{ markdown: string }>(`/projects/${projectId}/export/review-summary`, {
    method: "POST",
  });
}

// --- Demo ---
export async function resetDemo(): Promise<DemoResetResult> {
  return request<DemoResetResult>("/demo/reset", { method: "POST" });
}

// --- Model Configuration (Sidecar) ---

const BUILTIN_PROVIDERS = [
  { id: "deepseek", displayName: "DeepSeek" },
  { id: "openai", displayName: "OpenAI" },
  { id: "anthropic", displayName: "Anthropic" },
  { id: "xiaomi", displayName: "小米 (MiMo)" },
  { id: "xiaomi-token-plan-cn", displayName: "小米 Token 计费（国内）" },
  { id: "openrouter", displayName: "OpenRouter" },
  { id: "openai-compatible", displayName: "自定义（OpenAI 兼容）" },
  { id: "mock", displayName: "Mock（测试）" },
];

export { BUILTIN_PROVIDERS };

export async function getModelConfigs(): Promise<ModelConfigEntry[]> {
  const resp = await fetch(`${SIDECAR_BASE_URL}/config/models`);
  if (!resp.ok) throw new Error(`获取模型配置失败: ${resp.status}`);
  const data = (await resp.json()) as { models: ModelConfigEntry[] };
  return data.models;
}

export async function addModelConfig(entry: Omit<ModelConfigEntry, "apiKeySet" | "apiKeySuffix" | "valid" | "invalidReason">): Promise<ModelConfigEntry> {
  const resp = await fetch(`${SIDECAR_BASE_URL}/config/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  if (!resp.ok) throw new Error(`添加模型配置失败: ${resp.status}`);
  return resp.json() as Promise<ModelConfigEntry>;
}

export async function updateModelConfig(id: string, patch: Partial<ModelConfigEntry>): Promise<ModelConfigEntry> {
  const resp = await fetch(`${SIDECAR_BASE_URL}/config/models/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`更新模型配置失败: ${resp.status}`);
  return resp.json() as Promise<ModelConfigEntry>;
}

export async function deleteModelConfig(id: string): Promise<void> {
  const resp = await fetch(`${SIDECAR_BASE_URL}/config/models/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!resp.ok) throw new Error(`删除模型配置失败: ${resp.status}`);
}

export async function setModelApiKey(id: string, apiKey: string): Promise<void> {
  const resp = await fetch(`${SIDECAR_BASE_URL}/config/models/${encodeURIComponent(id)}/api-key`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  if (!resp.ok) throw new Error(`设置 API Key 失败: ${resp.status}`);
}

export async function reloadModelConfigs(): Promise<void> {
  const resp = await fetch(`${SIDECAR_BASE_URL}/config/reload`, {
    method: "POST",
  });
  if (!resp.ok) throw new Error(`重新加载配置失败: ${resp.status}`);
}

export async function getProviderCatalogModels(provider: string): Promise<ProviderCatalogModel[]> {
  const resp = await fetch(`${SIDECAR_BASE_URL}/config/providers/${encodeURIComponent(provider)}/models`);
  if (!resp.ok) throw new Error(`获取 provider catalog 失败: ${resp.status}`);
  const data = (await resp.json()) as { models: ProviderCatalogModel[] };
  return data.models;
}

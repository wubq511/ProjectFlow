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
  AgentEvent,
  AgentFlowResult,
  DemoResetResult,
} from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api";

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

function normalizeRisk(risk: BackendRisk): Risk {
  const evidenceItems = Array.isArray(risk.evidence)
    ? risk.evidence
    : Object.entries(risk.evidence).map(([key, value]) => `${key}: ${String(value)}`);
  return {
    ...risk,
    evidence: evidenceItems.map((item) =>
      typeof item === "string" ? item : JSON.stringify(item),
    ),
  };
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

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

// --- Users ---
export async function createUser(data: CreateUserRequest): Promise<User> {
  const user = await request<BackendUser>("/users", { method: "POST", body: JSON.stringify(data) });
  return normalizeUser(user);
}

export async function listUsers(): Promise<User[]> {
  const users = await request<BackendUser[]>("/users");
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
      }),
    },
  );
  return normalizeWorkspace(workspace);
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
  };
}

export async function getWorkspace(workspaceId: string): Promise<Workspace> {
  const workspace = await request<BackendWorkspace>(`/workspaces/${workspaceId}`);
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
  return request<MemberProfile[]>(`/workspaces/${workspaceId}/profiles`);
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

export async function getProject(projectId: string): Promise<Project> {
  return request<Project>(`/projects/${projectId}`);
}

export async function getProjectState(projectId: string): Promise<ProjectState> {
  const project = await getProject(projectId);
  const [
    workspace,
    resources,
    stages,
    tasks,
    allUsers,
    memberProfiles,
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

  return {
    workspace,
    project,
    resources,
    members,
    member_profiles: memberProfiles,
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
  return request<Project[]>(`/workspaces/${workspaceId}/projects`);
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

export async function rejectAgentProposal(proposalId: string): Promise<AgentProposal> {
  return request<AgentProposal>(`/agent-proposals/${proposalId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason: null }),
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
async function runAgentFlow(projectId: string, endpoint: string): Promise<AgentFlowResult> {
  const project = await getProject(projectId);
  return request<AgentFlowResult>(`/agent/${endpoint}`, {
    method: "POST",
    body: JSON.stringify({ workspace_id: project.workspace_id }),
  });
}

export async function runClarification(projectId: string): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "clarify");
}

export async function runPlanning(projectId: string): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "plan");
}

export async function runBreakdown(projectId: string): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "breakdown");
}

export async function runAssignment(projectId: string): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "assign");
}

export async function runActivePush(projectId: string): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "active-push");
}

export async function runCheckinAnalysis(projectId: string): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "check-in-analysis");
}

export async function runRiskAnalysis(projectId: string): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "risk-analysis");
}

export async function runReplan(projectId: string): Promise<AgentFlowResult> {
  return runAgentFlow(projectId, "replan");
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
  const proposal = await request<AssignmentProposal>(`/assignment-proposals/${proposalId}`);
  return request<AssignmentNegotiation>("/assignment-negotiations", {
    method: "POST",
    body: JSON.stringify({
      project_id: projectId,
      stage_id: proposal.stage_id,
      from_user_id: fromUserId,
      desired_task_id: desiredTaskId,
      current_owner_user_id: proposal.recommended_owner_user_id,
      agent_message: `成员 ${fromUserId} 拒绝分工 ${proposalId} 后，希望改做 ${desiredTaskId}。`,
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

// Domain types synced with backend schemas

// --- User / Account ---
export type User = {
  user_id: string;
  display_name: string;
  email?: string | null;
  avatar_url?: string | null;
  created_at: string;
};

export type CreateUserRequest = {
  display_name: string;
  email?: string | null;
};

// --- Workspace ---
export type Workspace = {
  workspace_id: string;
  name: string;
  owner_user_id: string;
  description?: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateWorkspaceRequest = {
  name: string;
  owner_user_id: string;
  description?: string | null;
  team_size?: number;
  use_case?: string;
};

export type WorkspaceMembership = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: "owner" | "member";
  joined_at: string;
};

// --- Invitation ---
export type Invitation = {
  invitation_id: string;
  workspace_id: string;
  invited_name: string;
  invited_email?: string | null;
  token: string;
  status: "pending" | "accepted" | "expired";
  created_at: string;
  accepted_at?: string | null;
};

export type CreateInvitationRequest = {
  invited_name: string;
  invited_email?: string | null;
};

// --- Member Profile ---
export type Skill = {
  name: string;
  level: number;
};

export type MemberProfile = {
  id: string;
  user_id: string;
  workspace_id: string;
  skills: Skill[];
  available_hours_per_week: number;
  role_preference: string;
  interests: string;
  constraints: string;
  collaboration_preference?: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertMemberProfileRequest = {
  skills: Skill[];
  available_hours_per_week: number;
  role_preference: string;
  interests: string;
  constraints: string;
  collaboration_preference?: string | null;
};

// --- Project ---
export type Project = {
  id: string;
  workspace_id: string;
  name: string;
  idea: string;
  deadline: string;
  deliverables: string;
  status: "draft" | "active" | "at_risk" | "completed";
  current_stage_id?: string | null;
  direction_card?: DirectionCard | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type CreateProjectRequest = {
  name: string;
  idea: string;
  deadline: string;
  deliverables: string;
  created_by: string;
};

// --- Direction Card ---
export type DirectionCard = {
  problem: string;
  users: string;
  value: string;
  deliverables: string[];
  boundaries: string[];
  risks: string[];
  suggested_questions: string[];
};

// --- Project Resource ---
export type ProjectResource = {
  id: string;
  project_id: string;
  type: "text_note" | "file_stub" | "link";
  title: string;
  content_text?: string | null;
  file_name?: string | null;
  url?: string | null;
  created_at: string;
};

export type AddResourceRequest = {
  type: "text_note" | "file_stub" | "link";
  title: string;
  content_text?: string | null;
  url?: string | null;
  file_name?: string | null;
};

// --- Stage ---
export type Stage = {
  id: string;
  project_id: string;
  name: string;
  goal: string;
  start_date: string;
  end_date: string;
  deliverable: string;
  done_criteria: string[];
  status: "pending" | "active" | "completed" | "at_risk";
  order_index: number;
};

// --- Task ---
export type Task = {
  id: string;
  project_id: string;
  stage_id: string;
  title: string;
  description: string;
  priority: "P0" | "P1" | "P2";
  status: "not_started" | "in_progress" | "done" | "blocked";
  owner_user_id?: string | null;
  backup_owner_user_id?: string | null;
  due_date: string;
  estimated_hours: number;
  dependency_ids: string[];
  acceptance_criteria: string[];
  can_cut: boolean;
  assignment_reason?: string | null;
  created_by_agent: boolean;
  updated_at: string;
};

// --- Assignment ---
export type AssignmentProposal = {
  id: string;
  project_id: string;
  stage_id: string;
  task_id: string;
  recommended_owner_user_id: string;
  backup_owner_user_id?: string | null;
  reason: string;
  skill_match?: string | null;
  availability_match?: string | null;
  preference_match?: string | null;
  constraint_respected?: string | null;
  risk_note?: string | null;
  status: "proposed" | "owner_confirmed" | "owner_rejected" | "negotiating" | "finalized";
  created_by_agent: boolean;
  created_at: string;
};

export type AssignmentResponse = {
  id: string;
  proposal_id: string;
  user_id: string;
  response: "accept" | "reject";
  preferred_task_id?: string | null;
  reason?: string | null;
  created_at: string;
};

export type AssignmentNegotiation = {
  id: string;
  project_id: string;
  stage_id: string;
  from_user_id: string;
  desired_task_id: string;
  current_owner_user_id?: string | null;
  status: "pending" | "accepted" | "declined" | "resolved";
  agent_message: string;
  created_at: string;
};

// --- Check-in ---
export type CheckInCycle = {
  id: string;
  project_id: string;
  stage_id: string;
  cadence_days: number;
  start_date: string;
  next_due_date: string;
  status: "active" | "paused" | "completed";
  created_by_user_id: string;
  created_at: string;
};

export type CheckInResponse = {
  id: string;
  cycle_id: string;
  project_id: string;
  stage_id: string;
  user_id: string;
  task_id?: string | null;
  what_done: string;
  blocker?: string | null;
  available_hours_next_cycle?: number | null;
  mood_or_confidence?: "low" | "medium" | "high" | null;
  created_at: string;
};

// --- Risk ---
export type RiskEvidence = string | Record<string, unknown>;

export type Risk = {
  id: string;
  project_id: string;
  stage_id?: string | null;
  task_id?: string | null;
  type: "deadline" | "dependency" | "workload" | "scope" | "review" | "assignment" | "checkin";
  severity: "low" | "medium" | "high";
  title: string;
  description: string;
  evidence: RiskEvidence[];
  recommendation: string;
  status: "open" | "accepted" | "ignored" | "resolved";
  created_by_agent: boolean;
  created_at: string;
};

// --- Action Card ---
export type ActionCard = {
  id: string;
  project_id: string;
  stage_id?: string | null;
  user_id?: string | null;
  task_id?: string | null;
  type: "personal_task" | "team_next_step" | "reminder" | "risk_action" | "kickoff_tip" | "checkin_prompt" | "assignment_request";
  title: string;
  content: string;
  reason: string;
  goal?: string | null;
  start_suggestion?: string | null;
  completion_standard?: string | null;
  due_date?: string | null;
  status: "active" | "done" | "dismissed";
  created_by_agent: boolean;
  created_at: string;
};

// --- Agent Event ---
export type AgentEvent = {
  id: string;
  project_id: string;
  workspace_id: string;
  event_type: "clarify" | "plan" | "breakdown" | "assign" | "negotiate" | "push" | "checkin" | "risk" | "replan" | "export";
  status: "success" | "repaired" | "fallback" | "failed";
  input_snapshot: Record<string, unknown>;
  output_snapshot: Record<string, unknown>;
  reasoning_summary: string;
  user_confirmed: boolean;
  created_at: string;
};

export type AgentFlowResult = {
  event_type: AgentEvent["event_type"];
  status: "success" | "repaired" | "fallback" | "failed";
  attempts: number;
  used_fallback: boolean;
  output: Record<string, unknown>;
  created_ids: string[];
  proposal_id?: string | null;
};

export type DemoResetResult = {
  workspace_id: string;
  project_id: string;
  user_ids: string[];
  stage_ids: string[];
  task_ids: string[];
};

// --- Workspace State (aggregated) ---
export type WorkspaceState = {
  workspace: Workspace;
  users: User[];
  memberships: WorkspaceMembership[];
  member_profiles: MemberProfile[];
  projects: Project[];
  members: User[];
};

export type AgentProposal = {
  id: string;
  project_id: string;
  workspace_id: string;
  proposal_type: "clarify" | "plan" | "breakdown" | "replan";
  status: "pending" | "confirmed" | "rejected";
  agent_event_id: string;
  payload: Record<string, unknown>;
  confirmed_by: string | null;
  confirmed_at: string | null;
  rejection_reason?: string | null;
  created_at: string;
};

// --- Project State (aggregated) ---
export type ProjectState = {
  workspace: Workspace;
  project: Project;
  resources: ProjectResource[];
  members: User[];
  memberships: WorkspaceMembership[];
  member_profiles: MemberProfile[];
  projects: Project[];
  stages: Stage[];
  tasks: Task[];
  agent_proposals: AgentProposal[];
  assignment_proposals: AssignmentProposal[];
  assignment_responses: AssignmentResponse[];
  assignment_negotiations: AssignmentNegotiation[];
  checkins: CheckInCycle[];
  risks: Risk[];
  action_cards: ActionCard[];
  timeline: AgentEvent[];
};

// --- UI State ---
export type AgentState = {
  label: "加载中" | "空状态" | "错误" | "成功";
  detail: string;
};

// --- Legacy compat (used by home screen constants) ---
export type ProjectActionCard = {
  owner: string;
  title: string;
  reason: string;
};

export type StageRow = {
  name: string;
  output: string;
  status: string;
  active: boolean;
};

export type TeamMember = {
  name: string;
  role: string;
  capacity: number;
  risk?: boolean;
};

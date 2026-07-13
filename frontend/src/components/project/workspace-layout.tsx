"use client";

import { useState, useCallback, useEffect } from "react";
import { motion } from "framer-motion";
import { ProjectSidebar, type ProjectView } from "./project-sidebar";
import { AgentSidebar } from "./agent-sidebar";
import { ProjectContent } from "./project-content";
import { WorkspaceContent } from "./workspace-content";
import type { AddResourceRequest, AgentArtifact, AgentConversation, AgentStreamPhase, AgentStreamTurn, ArchivedAgentStreamTurn, AgentSuggestion, ProjectState, WorkspaceState, ThinkingLevel } from "@/lib/types";
import type { AgentAction } from "./project-actions";

interface WorkspaceLayoutProps {
  workspaceId: string;
  selectedProjectId: string | null;
  workspaceState: WorkspaceState;
  projectState: ProjectState | null;
  showWorkspace: boolean;
  currentUserId?: string;
  pendingAction?: AgentAction | null;
  agentConversation?: AgentConversation | null;
  agentConversationSuggestions?: AgentSuggestion[];
  agentConversationArtifacts?: AgentArtifact[];
  pendingAgentInstruction?: string | null;
  agentConversationError?: string | null;
  pendingAgentConversation?: boolean;
  streamTurn?: AgentStreamTurn | null;
  archivedStreamTurns?: ArchivedAgentStreamTurn[];
  streamStatus?: { phase: AgentStreamPhase; module?: string; message: string } | null;
  activeRunId?: string | null;
  onStopStreaming?: () => void;
  onToggleThinking?: () => void;
  actionError?: string | null;
  actionSuccess?: string | null;
  viewParam?: ProjectView | null;
  onSelectProject: (projectId: string) => void;
  onClearSelectedProject: () => void;
  onShowWorkspace: (show: boolean) => void;
  onNavigateView: (view: ProjectView) => void;
  onRunAgent?: (action: AgentAction, thinkingLevel?: ThinkingLevel, model?: { provider: string; name: string }) => void;
  onSendAgentMessage?: (content: string, options?: { model?: string; thinkingLevel?: string }) => void | Promise<void>;
  onRespondToAssignment?: (
    proposalId: string,
    userId: string,
    response: "accept" | "reject",
    preferredTaskId?: string,
    reason?: string
  ) => void;
  onStartNegotiation?: (
    proposalId: string,
    fromUserId: string,
    desiredTaskId: string
  ) => void;
  onResolveNegotiation?: (
    negotiationId: string,
    resolution: "accepted" | "declined",
  ) => void | Promise<void>;
  onFinalizeAssignments?: (stageId: string) => void;
  onSubmitCheckin?: (data: {
    user_id: string;
    task_id?: string;
    what_done: string;
    blocker?: string;
    available_hours_next_cycle?: number;
    mood_or_confidence?: "low" | "medium" | "high";
  }) => void;
  onUpdateTaskStatus?: (data: {
    task_id: string;
    user_id: string;
    status: "not_started" | "in_progress" | "done" | "blocked";
    progress_note?: string;
    blocker?: string;
    available_hours_change?: number;
  }) => void;
  onResolveRisk?: (riskId: string) => void;
  onAcceptRisk?: (riskId: string) => void;
  onIgnoreRisk?: (riskId: string) => void;
  onDismissActionCard?: (cardId: string) => void;
  onCompleteActionCard?: (cardId: string) => void;
  onConfirmProposal?: (proposalId: string) => void;
  onRejectProposal?: (proposalId: string, reason: string) => void;
  onConfirmAgentArtifact?: (artifact: AgentArtifact) => void | Promise<void>;
  onAddResource?: (resource: AddResourceRequest) => void | Promise<void>;
  onDeleteResource?: (resourceId: string) => void | Promise<void>;
  onResetDemo?: () => void | Promise<void>;
  onRefresh?: () => void;
  completedAnnouncement?: string | null;
}

export function WorkspaceLayout({
  workspaceId,
  selectedProjectId,
  workspaceState,
  projectState,
  showWorkspace,
  currentUserId,
  pendingAction,
  agentConversation,
  agentConversationSuggestions,
  agentConversationArtifacts,
  pendingAgentInstruction,
  agentConversationError,
  pendingAgentConversation,
  streamTurn = null,
  archivedStreamTurns = [],
  streamStatus = null,
  activeRunId = null,
  onStopStreaming,
  onToggleThinking,
  actionError,
  actionSuccess,
  viewParam,
  onSelectProject,
  onClearSelectedProject,
  onShowWorkspace,
  onNavigateView,
  onRunAgent,
  onSendAgentMessage,
  onRespondToAssignment,
  onStartNegotiation,
  onResolveNegotiation,
  onFinalizeAssignments,
  onSubmitCheckin,
  onUpdateTaskStatus,
  onResolveRisk,
  onAcceptRisk,
  onIgnoreRisk,
  onDismissActionCard,
  onCompleteActionCard,
  onConfirmProposal,
  onRejectProposal,
  onConfirmAgentArtifact,
  onAddResource,
  onDeleteResource,
  onResetDemo,
  onRefresh,
  completedAnnouncement,
}: WorkspaceLayoutProps) {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const toggleLeft = useCallback(() => setLeftCollapsed((c) => !c), []);
  const toggleRight = useCallback(() => setRightCollapsed((c) => !c), []);

  const handleSelectProject = useCallback((projectId: string) => {
    onSelectProject(projectId);
  }, [onSelectProject]);

  const handleShowWorkspace = useCallback((show: boolean) => {
    if (show) {
      onClearSelectedProject();
    }
    onShowWorkspace(show);
  }, [onShowWorkspace, onClearSelectedProject]);

  // Build a merged state for sidebars: use ProjectState if available, otherwise WorkspaceState
  const sidebarState = projectState ?? (workspaceState as unknown as ProjectState);

  const hasProject = Boolean(projectState);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg-primary-token)]">
      {/* Left Sidebar */}
      <ProjectSidebar
        projectId={selectedProjectId ?? ""}
        state={sidebarState}
        currentUserId={currentUserId}
        collapsed={leftCollapsed}
        onToggle={toggleLeft}
        showWorkspace={showWorkspace}
        onShowWorkspace={handleShowWorkspace}
        onSelectProject={handleSelectProject}
        onNavigateView={onNavigateView}
        workspaceState={workspaceState}
        onRefresh={onRefresh}
      />

      {/* Main Content Area */}
      <motion.main
        className="flex-1 overflow-hidden"
        initial={false}
        animate={{
          marginLeft: leftCollapsed ? 0 : 0,
          marginRight: rightCollapsed ? 0 : 0,
        }}
        transition={{ duration: 0.2 }}
      >
        {showWorkspace || !projectState ? (
          <WorkspaceContent
            state={workspaceState}
            currentUserId={currentUserId}
            onNavigateToProject={handleSelectProject}
            onRefresh={onRefresh}
          />
        ) : (
          <ProjectContent
            state={projectState}
            currentUserId={currentUserId}
            pendingAction={pendingAction}
            showWorkspace={false}
            currentView={viewParam ?? "overview"}
            onShowWorkspace={handleShowWorkspace}
            onNavigateView={onNavigateView}
            onRunAgent={onRunAgent}
            onRespondToAssignment={onRespondToAssignment}
            onStartNegotiation={onStartNegotiation}
            onResolveNegotiation={onResolveNegotiation}
            onFinalizeAssignments={onFinalizeAssignments}
            onSubmitCheckin={onSubmitCheckin}
            onUpdateTaskStatus={onUpdateTaskStatus}
            onResolveRisk={onResolveRisk}
            onAcceptRisk={onAcceptRisk}
            onIgnoreRisk={onIgnoreRisk}
            onDismissActionCard={onDismissActionCard}
            onCompleteActionCard={onCompleteActionCard}
            onConfirmProposal={onConfirmProposal}
            onRejectProposal={onRejectProposal}
            onAddResource={onAddResource}
            onDeleteResource={onDeleteResource}
            onResetDemo={onResetDemo}
          />
        )}
      </motion.main>

      {/* Right Agent Sidebar */}
      <AgentSidebar
        state={sidebarState}
        selectedProjectId={selectedProjectId}
        hasProject={hasProject}
        conversation={agentConversation}
        conversationSuggestions={agentConversationSuggestions}
        conversationArtifacts={agentConversationArtifacts}
        pendingConversationInstruction={pendingAgentInstruction}
        conversationError={agentConversationError}
        pendingConversation={pendingAgentConversation}
        pendingAction={pendingAction}
        actionError={actionError}
        actionSuccess={actionSuccess}
        onRunAgent={onRunAgent ?? (() => {})}
        onSendMessage={onSendAgentMessage}
        streamTurn={streamTurn}
        archivedStreamTurns={archivedStreamTurns}
        streamStatus={streamStatus}
        activeRunId={activeRunId}
        onStopStreaming={onStopStreaming}
        onToggleThinking={onToggleThinking}
        onConfirmArtifact={onConfirmAgentArtifact}
        onResetDemo={onResetDemo}
        completedAnnouncement={completedAnnouncement}
      />
    </div>
  );
}

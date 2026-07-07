"use client";

import { useState, useCallback, useEffect } from "react";
import { motion } from "framer-motion";
import { ProjectSidebar } from "./project-sidebar";
import { AgentSidebar } from "./agent-sidebar";
import { ProjectContent } from "./project-content";
import type { AddResourceRequest, AgentArtifact, AgentConversation, AgentSuggestion, ProjectState, ThinkingLevel } from "@/lib/types";
import type { AgentAction } from "./project-actions";

interface ProjectLayoutProps {
  projectId: string;
  state: ProjectState;
  currentUserId?: string;
  pendingAction?: AgentAction | null;
  agentConversation?: AgentConversation | null;
  agentConversationSuggestions?: AgentSuggestion[];
  agentConversationArtifacts?: AgentArtifact[];
  pendingAgentInstruction?: string | null;
  agentConversationError?: string | null;
  pendingAgentConversation?: boolean;
  actionError?: string | null;
  actionSuccess?: string | null;
  onRunAgent?: (action: AgentAction, thinkingLevel?: ThinkingLevel, model?: { provider: string; name: string }) => void;
  onSendAgentMessage?: (content: string) => void | Promise<void>;
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
  onResetDemo?: () => void | Promise<void>;
}

export function ProjectLayout({
  projectId,
  state,
  currentUserId,
  pendingAction,
  agentConversation,
  agentConversationSuggestions,
  agentConversationArtifacts,
  pendingAgentInstruction,
  agentConversationError,
  pendingAgentConversation,
  actionError,
  actionSuccess,
  onRunAgent,
  onSendAgentMessage,
  onRespondToAssignment,
  onStartNegotiation,
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
  onResetDemo,
}: ProjectLayoutProps) {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);

  // Reset workspace view when navigating to a different project
  useEffect(() => {
    const timeout = setTimeout(() => setShowWorkspace(false), 0);
    return () => clearTimeout(timeout);
  }, [projectId]);

  const toggleLeft = useCallback(() => setLeftCollapsed((c) => !c), []);
  const toggleRight = useCallback(() => setRightCollapsed((c) => !c), []);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg-primary-token)]">
      {/* Left Sidebar */}
      <ProjectSidebar
        projectId={projectId}
        state={state}
        currentUserId={currentUserId}
        collapsed={leftCollapsed}
        onToggle={toggleLeft}
        showWorkspace={showWorkspace}
        onShowWorkspace={setShowWorkspace}
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
        <ProjectContent
          state={state}
          currentUserId={currentUserId}
          pendingAction={pendingAction}
          showWorkspace={showWorkspace}
          onShowWorkspace={setShowWorkspace}
          onRunAgent={onRunAgent}
          onRespondToAssignment={onRespondToAssignment}
          onStartNegotiation={onStartNegotiation}
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
          onResetDemo={onResetDemo}
        />
      </motion.main>

      {/* Right Agent Sidebar */}
      <AgentSidebar
        state={state}
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
        onConfirmArtifact={onConfirmAgentArtifact}
        onResetDemo={onResetDemo}
      />
    </div>
  );
}

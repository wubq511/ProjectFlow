"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";

import type { AgentAction } from "@/components/project/project-actions";
import { WorkspaceLayout } from "@/components/project/workspace-layout";
import { Button } from "@/components/ui/button";
import { setLastWorkspaceId, useCurrentUserId, setCurrentUserId, setWorkspaceMembers } from "@/components/app-shell";
import { resolveAgentActorId } from "@/lib/agent-identity";
import {
  addResource,
  createConversation,
  deleteResource,
  finalizeAssignments,
  confirmAgentProposal,
  createCheckinCycle,
  getProjectState,
  getWorkspaceState,
  rejectAgentProposal,
  resolveNegotiation,
  respondToAssignment,
  resetDemo,
  runActivePush,
  runAssignment,
  runBreakdown,
  runCheckinAnalysis,
  runClarification,
  runPlanning,
  runReplan,
  runRiskAnalysis,
  sendAgentConversationMessage,
  startNegotiation,
  submitCheckinResponse,
  updateActionCardStatus,
  updateRiskStatus,
  updateTaskStatus,
} from "@/lib/api";
import type {
  AddResourceRequest,
  AgentArtifact,
  AgentConversation,
  AgentFlowResult,
  AgentStreamPhase,
  AgentStreamTurn,
  AgentSuggestion,
  ProjectState,
  WorkspaceState,
  ThinkingLevel,
} from "@/lib/types";
import { useAgentConversationStream, useAgentStreamNavigationReset } from "@/lib/useAgentConversationStream";
import { useConversationHistory } from "@/lib/use-conversation-history";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";

	const AGENT_RUNNERS: Record<AgentAction, (projectId: string, state?: ProjectState, viewerUserId?: string, thinkingLevel?: ThinkingLevel, model?: { provider: string; name: string }) => Promise<unknown>> = {
	  clarify: (projectId, _state, vuid, tl, m) => runClarification(projectId, vuid!, tl, m),
	  plan: (projectId, _state, vuid, tl, m) => runPlanning(projectId, vuid!, tl, m),
	  breakdown: (projectId, _state, vuid, tl, m) => runBreakdown(projectId, vuid!, tl, m),
	  assign: (projectId, state, vuid, tl, m) => runAssignment(projectId, vuid!, resolveActiveStageId(state), tl, m),
	  push: (projectId, _state, vuid, tl, m) => runActivePush(projectId, vuid!, tl, m),
	  "analyze-checkins": (projectId, _state, vuid, tl, m) => runCheckinAnalysis(projectId, vuid!, tl, m),
	  "risk-analysis": (projectId, _state, vuid, tl, m) => runRiskAnalysis(projectId, vuid!, tl, m),
	  replan: (projectId, _state, vuid, tl, m) => runReplan(projectId, vuid!, tl, m),
	};

const AGENT_ACTION_LABELS: Record<AgentAction, string> = {
  clarify: "方向澄清",
  plan: "阶段计划",
  breakdown: "任务拆解",
  assign: "分工推荐",
  push: "主动推进",
  "analyze-checkins": "签到分析",
  "risk-analysis": "风险分析",
  replan: "计划调整",
};

function resolveActiveStageId(state?: ProjectState) {
  if (!state) return undefined;
  return state.project.current_stage_id
    ?? state.stages.find((stage) => stage.status === "active")?.id
    ?? state.stages[0]?.id;
}

function resolveValidCurrentUserId(nextState: ProjectState, storedUserId: string | null) {
  const memberIds = new Set(nextState.members.map((member) => member.user_id));
  if (storedUserId && memberIds.has(storedUserId)) return storedUserId;
  if (memberIds.has(nextState.project.created_by)) return nextState.project.created_by;
  return nextState.members[0]?.user_id ?? null;
}

function syncProjectShellState(nextState: ProjectState) {
  setLastWorkspaceId(nextState.workspace.workspace_id);
  setWorkspaceMembers(nextState.members.map((member) => ({
    user_id: member.user_id,
    display_name: member.display_name,
  })));
  if (typeof window === "undefined") return;
  const storedUserId = localStorage.getItem("projectflow:current-user-id");
  const validUserId = resolveValidCurrentUserId(nextState, storedUserId);
  if (validUserId && storedUserId !== validUserId) {
    setCurrentUserId(validUserId);
  }
}

export default function WorkspaceDashboardPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const workspaceId = params.workspaceId as string;
  const projectParam = searchParams.get("project");
  const conversationParam = searchParams.get("conversation");
  const viewParam = searchParams.get("view") as import("@/components/project/project-sidebar").ProjectView | null;

  const [workspaceState, setWorkspaceState] = useState<WorkspaceState | null>(null);
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const storedUserId = useCurrentUserId();
  const currentUserId = projectState
    ? resolveValidCurrentUserId(projectState, storedUserId) ?? undefined
    : undefined;
  const [agentConversationSuggestions, setAgentConversationSuggestions] = useState<AgentSuggestion[]>([]);
  const [agentConversationArtifacts, setAgentConversationArtifacts] = useState<AgentArtifact[]>([]);
  const [pendingAgentInstruction, setPendingAgentInstruction] = useState<string | null>(null);
  const [agentConversationError, setAgentConversationError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showWorkspace, setShowWorkspace] = useState(!projectParam);
  const showWorkspaceRef = useRef(showWorkspace);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // T45: Conversation history management
  const conversationHistory = useConversationHistory();
  const {
    loadHistory,
    switchToConversation,
    startNewDraft,
    reset: resetConversationHistory,
  } = conversationHistory;

  const replaceConversationParam = useCallback((conversationId: string | null) => {
    const nextParams = new URLSearchParams(searchParams.toString());
    if (conversationId) {
      nextParams.set("conversation", conversationId);
    } else {
      nextParams.delete("conversation");
    }
    const query = nextParams.toString();
    router.replace(`/workspaces/${workspaceId}${query ? `?${query}` : ""}`, { scroll: false });
  }, [router, searchParams, workspaceId]);

  useEffect(() => {
    showWorkspaceRef.current = showWorkspace;
  }, [showWorkspace]);

  const [pendingAction, setPendingAction] = useState<AgentAction | null>(null);
  const [pendingAgentConversation, setPendingAgentConversation] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Unified streaming hook (composes useAgentStreamTurn + transport + abort)
  const {
    streamTurn,
    streamStatus,
    send: sendStream,
    stop: stopStream,
    reset: resetStream,
    toggleThinking,
    streamThinkingContent,
    streamAnswerContent,
    streamHasThinking,
    archivedStreamTurns,
    completedAnnouncement,
    activeRunId,
    cleanup: streamCleanup,
  } = useAgentConversationStream({
    onPersistedTurn: (turn) => {
      // Update conversation history with the persisted turn
      conversationHistory.onPersistedTurn(turn.conversation);
      setAgentConversationSuggestions(turn.suggestions ?? []);
      setAgentConversationArtifacts(turn.artifacts ?? []);
      setPendingAgentInstruction(null);
      conversationHistory.setStreaming(false);
      reloadProject();
      // Refresh conversation list to update last message preview
      if (currentUserId && selectedProjectId) {
        conversationHistory.loadHistory(selectedProjectId, currentUserId);
      }
      const hasPendingArtifact = (turn.artifacts ?? []).some(
        (a) => a.status === "pending_confirmation",
      );
      if (!hasPendingArtifact && turn.run?.proposal_id) {
        setActionSuccess("Agent 已生成提案，等待你确认后应用");
      }
    },
    onError: (msg) => {
      setAgentConversationError(msg);
      conversationHistory.setStreaming(false);
    },
    onDisconnect: (reason) => {
      setAgentConversationError(reason ?? "连接意外中断，可重试");
      conversationHistory.setStreaming(false);
    },
  });

  // Abort streaming on unmount
  useEffect(() => {
    return streamCleanup;
  }, [streamCleanup]);

  // The URL identity is the single stream-cleanup boundary. Click navigation
  // updates the ref immediately; browser navigation is caught by the effect.
  const navigationIdentity = `${workspaceId}:${projectParam ?? "workspace"}`;
  const resetForNavigation = useAgentStreamNavigationReset(navigationIdentity, resetStream);

  // Load workspace and optionally project
  useEffect(() => {
    let ignore = false;

    getWorkspaceState(workspaceId)
      .then((ws) => {
        if (ignore) return;
        setWorkspaceState(ws);
        setLastWorkspaceId(workspaceId);

        const targetProjectId = projectParam ?? (ws.projects.length > 0 ? ws.projects[0].id : null);
        if (targetProjectId && !showWorkspaceRef.current) {
          setSelectedProjectId(targetProjectId);
          setShowWorkspace(false);
          return getProjectState(targetProjectId);
        }
        if (!targetProjectId) {
          setShowWorkspace(true);
        }
        return null;
      })
      .then((ps) => {
        if (ignore) return;
        if (ps) {
          setProjectState(ps);
          syncProjectShellState(ps);
          setAgentConversationSuggestions([]);
          setAgentConversationArtifacts([]);
          setPendingAgentInstruction(null);
          setAgentConversationError(null);
          resetConversationHistory();
        }
      })
      .catch(() => {
        if (!ignore) {
          setError("加载工作区数据失败");
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [workspaceId, projectParam, resetConversationHistory]);

  // Conversation identity is scoped by project and viewer. Changing either must
  // clear private transcript state before loading the new scope.
  const conversationScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const scope = selectedProjectId && currentUserId
      ? `${selectedProjectId}:${currentUserId}`
      : null;
    if (conversationScopeRef.current !== scope) {
      conversationScopeRef.current = scope;
      resetConversationHistory();
    }
  }, [currentUserId, resetConversationHistory, selectedProjectId]);

  // Load the lightweight list first, then resolve only the selected/latest
  // conversation. A local draft (no conversation param) intentionally wins over
  // automatic latest-selection until its first message is sent.
  useEffect(() => {
    if (!selectedProjectId || !currentUserId) return;
    if (conversationHistory.isStreaming) {
      const streamingConversationId = conversationHistory.activeConversation?.id ?? null;
      if (conversationParam !== streamingConversationId) {
        replaceConversationParam(streamingConversationId);
      }
      return;
    }
    if (!conversationParam && conversationHistory.isDraft) return;
    let ignore = false;

    void (async () => {
      const summaries = await loadHistory(selectedProjectId, currentUserId);
      if (ignore || summaries === null) return;

      if (conversationParam) {
        const outcome = await switchToConversation(
          conversationParam,
          selectedProjectId,
          currentUserId,
        );
        if (ignore || outcome === "loaded" || outcome === "error") return;
      }

      const fallback = summaries.find((item) => item.id !== conversationParam);
      if (!fallback) {
        startNewDraft();
        if (conversationParam) replaceConversationParam(null);
        return;
      }

      const outcome = await switchToConversation(
        fallback.id,
        selectedProjectId,
        currentUserId,
      );
      if (!ignore && outcome === "loaded") {
        replaceConversationParam(fallback.id);
      }
    })();

    return () => {
      ignore = true;
    };
  }, [
    conversationHistory.isDraft,
    conversationHistory.isStreaming,
    conversationHistory.activeConversation?.id,
    conversationParam,
    currentUserId,
    loadHistory,
    replaceConversationParam,
    selectedProjectId,
    startNewDraft,
    switchToConversation,
  ]);

  const handleSelectProject = useCallback(async (projectId: string) => {
    resetForNavigation(`${workspaceId}:${projectId}`);
    setSelectedProjectId(projectId);
    setShowWorkspace(false);
    setLoading(true);
    setActionError(null);
    setActionSuccess(null);
    resetConversationHistory();

    // Update URL without full navigation, clearing incompatible conversation
    const params = new URLSearchParams(searchParams.toString());
    params.set("project", projectId);
    params.delete("conversation"); // Clear cross-project conversation selection
    router.replace(`/workspaces/${workspaceId}?${params.toString()}`, { scroll: false });

    try {
      const ps = await getProjectState(projectId);
      setProjectState(ps);
      syncProjectShellState(ps);
      setAgentConversationSuggestions([]);
      setAgentConversationArtifacts([]);
      setPendingAgentInstruction(null);
      setAgentConversationError(null);

    } catch {
      setActionError("加载项目数据失败");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, searchParams, router, resetForNavigation, resetConversationHistory]);

  const handleShowWorkspace = useCallback((show: boolean) => {
    setShowWorkspace(show);
    if (show) {
      resetForNavigation(`${workspaceId}:workspace`);
      setSelectedProjectId(null);
      setProjectState(null);
      resetConversationHistory();
      setAgentConversationSuggestions([]);
      setAgentConversationArtifacts([]);
      setPendingAgentInstruction(null);
      setAgentConversationError(null);
      // Clear project and conversation params from URL
      const params = new URLSearchParams(searchParams.toString());
      params.delete("project");
      params.delete("view");
      params.delete("conversation");
      router.replace(`/workspaces/${workspaceId}?${params.toString()}`, { scroll: false });
    }
  }, [workspaceId, searchParams, router, resetForNavigation, resetConversationHistory]);

  // Debounce view navigation to avoid a storm of RSC flight requests (and
  // net::ERR_ABORTED console noise) when the user rapidly clicks sidebar items.
  const handleNavigateView = useDebouncedCallback((view: import("@/components/project/project-sidebar").ProjectView) => {
    const params = new URLSearchParams(searchParams.toString());
    if (view === "overview") {
      params.delete("view");
    } else {
      params.set("view", view);
    }
    router.replace(`/workspaces/${workspaceId}?${params.toString()}`, { scroll: false });
  }, 60);

  const reloadInProgressRef = useRef(false);

  const reloadProject = useCallback(async (projectId?: string) => {
    if (reloadInProgressRef.current) return;
    reloadInProgressRef.current = true;
    try {
      const pid = projectId || selectedProjectId;
      if (!pid) return;
      const ps = await getProjectState(pid);
      if (ps) {
        setProjectState(ps);
        syncProjectShellState(ps);
      }
      // Don't reload conversation here — the conversation history hook manages it
    } catch (err) {
      console.error("reloadProject failed:", err);
    } finally {
      reloadInProgressRef.current = false;
    }
  }, [selectedProjectId]);

  const runAgent = async (action: AgentAction, thinkingLevel?: ThinkingLevel, model?: { provider: string; name: string }) => {
    if (!selectedProjectId) return;
    setPendingAction(action);
    setActionError(null);
    setActionSuccess(null);
    try {
      const result = (await AGENT_RUNNERS[action](selectedProjectId, projectState ?? undefined, currentUserId, thinkingLevel, model)) as AgentFlowResult;
      await reloadProject();
      if (result?.status === "fallback") {
        setActionSuccess(`${AGENT_ACTION_LABELS[action]}已完成（已使用基础建议）`);
      } else if (result?.status === "repaired") {
        setActionSuccess(`${AGENT_ACTION_LABELS[action]}已完成（已修复格式后完成）`);
      } else if (result?.status === "failed") {
        setActionError(`${AGENT_ACTION_LABELS[action]}失败，请重试。`);
      } else {
        // Build a meaningful success message from tool results
        const toolResults = (result?.output as Record<string, unknown>)?.tool_results as Array<{
          tool_name: string;
          side_effect_status: string;
          observation: string;
          proposal_id?: string;
        }> | undefined;

        if (toolResults && toolResults.length > 0) {
          const hasProposal = toolResults.some((tr) => tr.side_effect_status === "proposal_persisted");
          const hasAdvisory = toolResults.some((tr) => tr.side_effect_status === "advisory_record_persisted");

          if (hasProposal) {
            // Proposal was created — tell user to check overview
            setActionSuccess(`${AGENT_ACTION_LABELS[action]}已完成：已生成提案，请在项目总览中确认或拒绝`);
          } else if (hasAdvisory) {
            // Advisory records created (risk/checkin) — tell user what happened
            const advisoryObs = toolResults.find((tr) => tr.side_effect_status === "advisory_record_persisted")?.observation;
            setActionSuccess(`${AGENT_ACTION_LABELS[action]}已完成：${advisoryObs || "已创建记录"}`);
          } else {
            // Tools were called but nothing was created — state didn't need changes
            setActionSuccess(`${AGENT_ACTION_LABELS[action]}已完成：项目状态已分析，暂无需更新`);
          }
        } else {
          // Fallback for push action cards
          const cards = (result?.output as Record<string, unknown>)?.action_cards;
          if (action === "push" && Array.isArray(cards) && cards.length > 0) {
            const title = (cards[0] as Record<string, unknown>)?.title;
            setActionSuccess(`已生成行动卡"${title}"，请在项目总览中查看`);
          } else {
            setActionSuccess(`${AGENT_ACTION_LABELS[action]}已完成`);
          }
        }
      }
    } catch (err: unknown) {
      console.error("[Agent action error]", err);
      let msg = "Agent 操作失败，请稍后重试。";
      if (err instanceof Error) {
        console.error("[Agent action error message]", err.message);
        try {
          const parsed = JSON.parse(err.message.replace(/^(?:Request failed:|请求失败：)\s*\d+\s*/, ""));
          if (parsed?.detail) msg = parsed.detail;
        } catch {
          if (err.message.includes("504") || err.message.includes("超时")) {
            msg = "AI 模型响应超时，请稍后重试。";
          } else if (err.message.includes("502") || err.message.includes("调用失败")) {
            msg = "AI 模型调用失败，请检查网络连接后重试。";
          }
        }
      }
      setActionError(msg);
    } finally {
      setPendingAction(null);
    }
  };

  const handleSendAgentMessage = async (content: string, options?: { model?: string; thinkingLevel?: string; skill?: string; slashCommand?: string }) => {
    const activeConv = conversationHistory.activeConversation;
    const isDraftConv = conversationHistory.isDraft;

    setPendingAgentConversation(true);
    setPendingAgentInstruction(content);
    setAgentConversationError(null);
    setActionError(null);
    setActionSuccess(null);
    conversationHistory.setStreaming(true);

    try {
      let conversationId: string;

      if (isDraftConv || !activeConv) {
        // T45: Create the conversation before the first streamed message
        if (!selectedProjectId || !currentUserId) {
          setAgentConversationError("无法创建对话：缺少项目或用户信息");
          conversationHistory.setStreaming(false);
          return;
        }
        const created = await createConversation(selectedProjectId, currentUserId);
        conversationId = created.id;

        // Update conversation history state with the created conversation
        const newConversation: AgentConversation = {
          id: created.id,
          workspace_id: created.workspace_id,
          project_id: created.project_id,
          status: created.status,
          summary: "",
          current_focus: created.current_focus,
          messages: [],
          created_at: created.created_at,
          updated_at: created.updated_at,
          visibility: created.visibility,
          creator_user_id: created.creator_user_id,
          title: created.title,
        };
        conversationHistory.onConversationCreated(newConversation);

        // Update URL with the new conversation ID
        replaceConversationParam(created.id);

        // Refresh history list to include the new conversation
        conversationHistory.loadHistory(selectedProjectId, currentUserId);
      } else {
        conversationId = activeConv.id;
      }

      await sendStream(conversationId, content, currentUserId ?? "", options);
    } catch (err) {
      // If conversation creation fails, show error and reset streaming state
      const msg = err instanceof Error ? err.message : "创建对话失败";
      setAgentConversationError(msg);
      conversationHistory.setStreaming(false);
    } finally {
      setPendingAgentConversation(false);
    }
  };

  const handleStopStreaming = () => {
    stopStream();
    conversationHistory.setStreaming(false);
  };

  const handleStartNewDraft = () => {
    if (conversationHistory.isStreaming) return;
    conversationHistory.startNewDraft();
    // Clear conversation from URL
    replaceConversationParam(null);
    // Reset stream state for clean draft
    resetStream();
    setAgentConversationSuggestions([]);
    setAgentConversationArtifacts([]);
    setPendingAgentInstruction(null);
    setAgentConversationError(null);
  };

  const handleSwitchConversation = async (conversationId: string) => {
    if (conversationHistory.isStreaming) return;
    if (!selectedProjectId || !currentUserId) return;

    // Reset stream state before switching
    resetStream();
    setAgentConversationSuggestions([]);
    setAgentConversationArtifacts([]);
    setPendingAgentInstruction(null);
    setAgentConversationError(null);

    const outcome = await switchToConversation(conversationId, selectedProjectId, currentUserId);
    if (outcome === "loaded") {
      replaceConversationParam(conversationId);
    }
  };

  const handleRetryHistory = () => {
    if (!selectedProjectId || !currentUserId) return;
    conversationHistory.loadHistory(selectedProjectId, currentUserId);
  };

  const handleLoadOlderMessages = () => {
    if (!currentUserId) return;
    conversationHistory.loadOlderMessages(currentUserId);
  };

  const handleAssignmentResponse = async (
    proposalId: string,
    userId: string,
    response: "accept" | "reject",
    preferredTaskId?: string,
    reason?: string,
  ) => {
    setActionError(null);
    try {
      await respondToAssignment(proposalId, userId, response, preferredTaskId, reason);
      await reloadProject();
    } catch {
      setActionError("分工响应路由暂不可用，UI 已就绪等待后端支持。");
    }
  };

  const handleStartNegotiation = async (
    proposalId: string,
    fromUserId: string,
    desiredTaskId: string,
  ) => {
    setActionError(null);
    try {
      if (!selectedProjectId) return;
      await startNegotiation(selectedProjectId, proposalId, fromUserId, desiredTaskId);
      await reloadProject();
    } catch {
      setActionError("协商路由暂不可用，拒绝状态将保留在本地直到后端支持。");
    }
  };

  const handleResolveNegotiation = async (
    negotiationId: string,
    resolution: "accepted" | "declined",
  ) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      await resolveNegotiation(negotiationId, resolution);
      await reloadProject();
      setActionSuccess(
        resolution === "accepted"
          ? "协商已接受，任务分配已更新。"
          : "协商已拒绝。"
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "未知错误";
      setActionError(`协商解决失败：${msg}`);
    }
  };

  const handleFinalizeAssignments = async (stageId: string) => {
    if (!projectState) return;
    setActionError(null);
    setActionSuccess(null);
    try {
      await finalizeAssignments(stageId, projectState.project.created_by);
      await reloadProject();
      setActionSuccess("分工已定稿，任务负责人已更新。");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "未知错误";
      setActionError(`定稿失败：${msg}`);
    }
  };

  const handleConfirmProposal = async (proposalId: string) => {
    if (!projectState) return;
    setActionError(null);
    setActionSuccess(null);
    const confirmedBy = resolveAgentActorId(currentUserId);
    if (!confirmedBy) {
      setActionError("当前工作区没有可用成员，暂时不能确认提案。请先选择有效成员。");
      return;
    }
    try {
      await confirmAgentProposal(proposalId, confirmedBy);
      await reloadProject();
      setActionSuccess("提案已确认，内容已应用到项目");
    } catch (err: unknown) {
      let msg = "确认提案失败，请稍后重试。";
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message.replace(/^(?:Request failed:|请求失败：)\s*\d+\s*/, ""));
          if (parsed?.detail) msg = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
        } catch { /* ignore */ }
      }
      setActionError(msg);
    }
  };

  const handleRejectProposal = async (proposalId: string, reason: string) => {
    if (!projectState) return;
    setActionError(null);
    setActionSuccess(null);
    try {
      await rejectAgentProposal(proposalId, reason);
      await reloadProject();
      setActionSuccess("提案已拒绝");
    } catch {
      setActionError("拒绝提案失败，请稍后重试。");
    }
  };

  const handleConfirmAgentArtifact = async (artifact: AgentArtifact) => {
    if (artifact.type === "proposal") {
      const proposalId = artifact.linked_entity_ids[0];
      if (!proposalId || !currentUserId) {
        setAgentConversationError("这条结果暂时不能直接确认，请在项目提案面板中查看。");
        return;
      }
      try {
        await confirmAgentProposal(proposalId, currentUserId);
        setAgentConversationArtifacts((prev) => {
          const found = prev.some((a) => a.id === artifact.id);
          if (found) return prev.map((a) => (a.id === artifact.id ? { ...a, status: "confirmed" as const } : a));
          return [...prev, { ...artifact, status: "confirmed" as const }];
        });
        await reloadProject();
        await handleSendAgentMessage(`已确认「${artifact.title}」，请确认结果并告诉我下一步。`);
      } catch {
        setAgentConversationError("确认应用失败，请重试。");
      }
    }
  };

  const handleDeleteResource = async (resourceId: string) => {
    setActionError(null);
    try {
      await deleteResource(resourceId);
      await reloadProject();
    } catch {
      setActionError("资源删除失败，请重试。");
    }
  };

  const handleAddResource = async (resource: AddResourceRequest) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      if (!selectedProjectId) return;
      await addResource(selectedProjectId, resource);
      await reloadProject();
      setActionSuccess("资源已添加");
    } catch {
      setActionError("资源添加失败，请检查标题和内容后重试。");
    }
  };

  const activeStage = projectState?.stages.find((stage) => stage.id === projectState.project.current_stage_id)
    ?? projectState?.stages.find((stage) => stage.status === "active")
    ?? projectState?.stages[0];
  const handleSubmitCheckin = async (data: {
    user_id: string;
    task_id?: string;
    what_done: string;
    blocker?: string;
    available_hours_next_cycle?: number;
    mood_or_confidence?: "low" | "medium" | "high";
  }) => {
    if (!projectState || !activeStage || !selectedProjectId) return;
    setActionError(null);
    try {
      const existingCycle = projectState.checkins.find(
        (cycle) => cycle.stage_id === activeStage.id && cycle.status === "active",
      );
      const cycle = existingCycle ?? await createCheckinCycle(
        selectedProjectId,
        activeStage.id,
        2,
        new Date().toISOString().slice(0, 10),
        projectState.project.created_by,
      );
      await submitCheckinResponse(cycle.id, {
        ...data,
        project_id: selectedProjectId,
        stage_id: activeStage.id,
      });
      await reloadProject();
    } catch {
      setActionError("签到提交失败，当前仪表盘状态已保留。");
    }
  };

  const handleUpdateTaskStatus = async (data: {
    task_id: string;
    user_id: string;
    status: "not_started" | "in_progress" | "done" | "blocked";
    progress_note?: string;
    blocker?: string;
    available_hours_change?: number;
  }) => {
    setActionError(null);
    try {
      await updateTaskStatus(data.task_id, data);
      await reloadProject();
    } catch {
      setActionError("任务状态更新失败，本地状态未变更。");
    }
  };

  const handleRiskStatus = async (
    riskId: string,
    status: "accepted" | "ignored" | "resolved",
  ) => {
    setActionError(null);
    try {
      await updateRiskStatus(riskId, status);
      await reloadProject();
    } catch {
      setActionError("风险状态更新失败。");
    }
  };

  const handleActionCardStatus = async (
    cardId: string,
    status: "done" | "dismissed",
  ) => {
    setActionError(null);
    try {
      await updateActionCardStatus(cardId, status);
      await reloadProject();
    } catch {
      setActionError("行动卡更新失败。");
    }
  };

  const handleResetDemo = useCallback(async () => {
    setActionError(null);
    try {
      const demo = await resetDemo();
      if (demo.project_id === selectedProjectId) {
        await reloadProject();
      } else {
        handleSelectProject(demo.project_id);
      }
    } catch {
      setActionError("演示重置失败，现有项目数据未被更改。");
    }
  }, [selectedProjectId, reloadProject, handleSelectProject]);

  // Listen for cross-component reset-demo requests (e.g., from Settings dialog)
  useEffect(() => {
    const onResetDemoEvent = () => {
      void handleResetDemo();
    };
    window.addEventListener("projectflow:reset-demo", onResetDemoEvent);
    return () => window.removeEventListener("projectflow:reset-demo", onResetDemoEvent);
  }, [handleResetDemo]);

  if (loading || !workspaceState) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-5 text-center">
        <AlertCircle className="h-8 w-8 text-coral" />
        <p className="text-sm text-coral">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <WorkspaceLayout
      workspaceId={workspaceId}
      selectedProjectId={selectedProjectId}
      workspaceState={workspaceState}
      projectState={projectState}
      showWorkspace={showWorkspace}
      currentUserId={currentUserId}
      pendingAction={pendingAction}
      agentConversation={conversationHistory.activeConversation}
      agentConversationSuggestions={agentConversationSuggestions}
      agentConversationArtifacts={agentConversationArtifacts}
      pendingAgentInstruction={pendingAgentInstruction}
      agentConversationError={agentConversationError}
      pendingAgentConversation={pendingAgentConversation}
      streamTurn={streamTurn.status !== "idle" && streamTurn.status !== "completed" ? streamTurn : null}
      archivedStreamTurns={archivedStreamTurns}
      streamStatus={streamStatus}
      activeRunId={activeRunId}
      onStopStreaming={handleStopStreaming}
      onToggleThinking={toggleThinking}
      completedAnnouncement={completedAnnouncement}
      actionError={actionError}
      actionSuccess={actionSuccess}
      viewParam={viewParam}
      onSelectProject={handleSelectProject}
      onClearSelectedProject={() => {
        setSelectedProjectId(null);
        setProjectState(null);
      }}
      onShowWorkspace={handleShowWorkspace}
      onNavigateView={handleNavigateView}
      onRunAgent={runAgent}
      onSendAgentMessage={handleSendAgentMessage}
      onRespondToAssignment={handleAssignmentResponse}
      onStartNegotiation={handleStartNegotiation}
      onResolveNegotiation={handleResolveNegotiation}
      onFinalizeAssignments={handleFinalizeAssignments}
      onSubmitCheckin={handleSubmitCheckin}
      onUpdateTaskStatus={handleUpdateTaskStatus}
      onResolveRisk={(riskId) => handleRiskStatus(riskId, "resolved")}
      onAcceptRisk={(riskId) => handleRiskStatus(riskId, "accepted")}
      onIgnoreRisk={(riskId) => handleRiskStatus(riskId, "ignored")}
      onCompleteActionCard={(cardId) => handleActionCardStatus(cardId, "done")}
      onDismissActionCard={(cardId) => handleActionCardStatus(cardId, "dismissed")}
      onConfirmProposal={handleConfirmProposal}
      onRejectProposal={handleRejectProposal}
      onConfirmAgentArtifact={handleConfirmAgentArtifact}
      onAddResource={handleAddResource}
      onDeleteResource={handleDeleteResource}
      onRefresh={() => reloadProject()}
      // T45: Conversation history props
      conversationSummaries={conversationHistory.summaries}
      isDraft={conversationHistory.isDraft}
      isStreamingConversation={conversationHistory.isStreaming}
      isLoadingHistory={conversationHistory.isLoadingHistory}
      isLoadingConversationDetail={conversationHistory.isLoadingDetail}
      historyError={conversationHistory.historyError ?? conversationHistory.detailError}
      hasOlderMessages={conversationHistory.hasOlderMessages}
      isLoadingOlder={conversationHistory.isLoadingOlder}
      onStartNewDraft={handleStartNewDraft}
      onSwitchConversation={handleSwitchConversation}
      onRetryHistory={handleRetryHistory}
      onLoadOlderMessages={handleLoadOlderMessages}
    />
  );
}

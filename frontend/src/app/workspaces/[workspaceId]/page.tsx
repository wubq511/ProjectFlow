"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";

import type { AgentAction } from "@/components/project/project-actions";
import { WorkspaceLayout } from "@/components/project/workspace-layout";
import { Button } from "@/components/ui/button";
import { setLastWorkspaceId, useCurrentUserId, setCurrentUserId, setWorkspaceMembers } from "@/components/app-shell";
import {
  addResource,
  deleteResource,
  finalizeAssignments,
  confirmAgentProposal,
  createCheckinCycle,
  getAgentConversation,
  getProjectState,
  getWorkspaceState,
  rejectAgentProposal,
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
  sendAgentConversationMessageStream,
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
  AgentSuggestion,
  ProjectState,
  WorkspaceState,
  ThinkingLevel,
} from "@/lib/types";

const AGENT_RUNNERS: Record<AgentAction, (projectId: string, state?: ProjectState, thinkingLevel?: ThinkingLevel, model?: { provider: string; name: string }) => Promise<unknown>> = {
  clarify: (projectId, _state, tl, m) => runClarification(projectId, tl, m),
  plan: (projectId, _state, tl, m) => runPlanning(projectId, tl, m),
  breakdown: (projectId, _state, tl, m) => runBreakdown(projectId, tl, m),
  assign: (projectId, state, tl, m) => runAssignment(projectId, resolveActiveStageId(state), tl, m),
  push: (projectId, _state, tl, m) => runActivePush(projectId, tl, m),
  "analyze-checkins": (projectId, _state, tl, m) => runCheckinAnalysis(projectId, tl, m),
  "risk-analysis": (projectId, _state, tl, m) => runRiskAnalysis(projectId, tl, m),
  replan: (projectId, _state, tl, m) => runReplan(projectId, tl, m),
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
  const viewParam = searchParams.get("view") as import("@/components/project/project-sidebar").ProjectView | null;

  const [workspaceState, setWorkspaceState] = useState<WorkspaceState | null>(null);
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [agentConversation, setAgentConversation] = useState<AgentConversation | null>(null);
  const [agentConversationSuggestions, setAgentConversationSuggestions] = useState<AgentSuggestion[]>([]);
  const [agentConversationArtifacts, setAgentConversationArtifacts] = useState<AgentArtifact[]>([]);
  const [pendingAgentInstruction, setPendingAgentInstruction] = useState<string | null>(null);
  const [agentConversationError, setAgentConversationError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showWorkspace, setShowWorkspace] = useState(!projectParam);
  const showWorkspaceRef = useRef(showWorkspace);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    showWorkspaceRef.current = showWorkspace;
  }, [showWorkspace]);

  // Abort streaming on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const [pendingAction, setPendingAction] = useState<AgentAction | null>(null);
  const [pendingAgentConversation, setPendingAgentConversation] = useState(false);
  const [streamingBuffer, setStreamingBuffer] = useState("");
  const [streamStatus, setStreamStatus] = useState<{ phase: AgentStreamPhase; module?: string; message: string } | null>(null);
  const [lastThinkingContent, setLastThinkingContent] = useState<string>("");
  const streamingBufferRef = useRef("");
  const turnCountRef = useRef(-1); // -1 = before first turn_start, 0 = first turn, 1 = second turn, etc.
  const turnTokensRef = useRef<string[]>([]); // one string per turn, indexed by turn number
  const abortRef = useRef<AbortController | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

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
          getAgentConversation(ps.project.id)
            .then((conversation) => {
              if (!ignore) setAgentConversation(conversation);
            })
            .catch(() => {
              if (!ignore) setActionError("加载 Agent 对话失败");
            });
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
  }, [workspaceId, projectParam]);

  const handleSelectProject = useCallback(async (projectId: string) => {
    setSelectedProjectId(projectId);
    setShowWorkspace(false);
    setLoading(true);
    setActionError(null);
    setActionSuccess(null);

    // Update URL without full navigation
    const params = new URLSearchParams(searchParams.toString());
    params.set("project", projectId);
    router.replace(`/workspaces/${workspaceId}?${params.toString()}`, { scroll: false });

    try {
      const ps = await getProjectState(projectId);
      setProjectState(ps);
      syncProjectShellState(ps);
      const conversation = await getAgentConversation(projectId);
      setAgentConversation(conversation);
      setAgentConversationSuggestions([]);
      setAgentConversationArtifacts([]);
      setPendingAgentInstruction(null);
      setAgentConversationError(null);
      setLastThinkingContent("");
    } catch {
      setActionError("加载项目数据失败");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, searchParams, router]);

  const handleShowWorkspace = useCallback((show: boolean) => {
    setShowWorkspace(show);
    if (show) {
      setSelectedProjectId(null);
      setProjectState(null);
      setAgentConversation(null);
      setAgentConversationSuggestions([]);
      setAgentConversationArtifacts([]);
      setPendingAgentInstruction(null);
      setAgentConversationError(null);
      setLastThinkingContent("");
      // Clear project param from URL
      const params = new URLSearchParams(searchParams.toString());
      params.delete("project");
      params.delete("view");
      router.replace(`/workspaces/${workspaceId}?${params.toString()}`, { scroll: false });
    }
  }, [workspaceId, searchParams, router]);

  const handleNavigateView = useCallback((view: import("@/components/project/project-sidebar").ProjectView) => {
    const params = new URLSearchParams(searchParams.toString());
    if (view === "overview") {
      params.delete("view");
    } else {
      params.set("view", view);
    }
    router.replace(`/workspaces/${workspaceId}?${params.toString()}`, { scroll: false });
  }, [workspaceId, searchParams, router]);

  const reloadInProgressRef = useRef(false);

  const reloadProject = useCallback(async (projectId?: string) => {
    if (reloadInProgressRef.current) return;
    reloadInProgressRef.current = true;
    try {
      const pid = projectId || selectedProjectId;
      if (!pid) return;
      const [ps, conv] = await Promise.all([
        getProjectState(pid),
        getAgentConversation(pid),
      ]);
      if (ps) {
        setProjectState(ps);
        syncProjectShellState(ps);
      }
      if (conv) setAgentConversation(conv);
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
      const result = (await AGENT_RUNNERS[action](selectedProjectId, projectState ?? undefined, thinkingLevel, model)) as AgentFlowResult;
      await reloadProject();
      if (result?.status === "fallback") {
        setActionSuccess(`${AGENT_ACTION_LABELS[action]}已完成（已使用基础建议）`);
      } else if (result?.status === "repaired") {
        setActionSuccess(`${AGENT_ACTION_LABELS[action]}已完成（已修复格式后完成）`);
      } else if (result?.status === "failed") {
        setActionError(`${AGENT_ACTION_LABELS[action]}失败，请重试。`);
      } else {
        // For push, mention what was created
        const cards = (result?.output as Record<string, unknown>)?.action_cards;
        if (action === "push" && Array.isArray(cards) && cards.length > 0) {
          const title = (cards[0] as Record<string, unknown>)?.title;
          setActionSuccess(`已生成行动卡"${title}"，请在项目总览中查看`);
        } else {
          setActionSuccess(`${AGENT_ACTION_LABELS[action]}已完成`);
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

  const handleSendAgentMessage = async (content: string) => {
    if (!agentConversation) return;
    // Reset streaming state from any previous request
    turnTokensRef.current = [];
    streamingBufferRef.current = "";
    turnCountRef.current = -1;
    setStreamingBuffer("");
    setStreamStatus(null);
    setPendingAgentConversation(true);
    setPendingAgentInstruction(content);
    setAgentConversationError(null);
    setActionError(null);
    setActionSuccess(null);

    // eslint-disable-next-line react-hooks/immutability -- abortRef assignment is a standard React pattern for managing abort controllers
    abortRef.current = new AbortController();

    try {
      await sendAgentConversationMessageStream(
        agentConversation.id,
        content,
        {
          onStatus: (status) => {
            setStreamStatus(status as { phase: AgentStreamPhase; module?: string; message: string });
            // Track turn boundaries for thinking/answer separation
            if ((status as { phase?: string }).phase === "turn_start") {
              turnCountRef.current += 1;
              // Ensure turnTokensRef has an entry for this turn
              turnTokensRef.current[turnCountRef.current] = turnTokensRef.current[turnCountRef.current] ?? "";
            }
          },
          onToken: (token) => {
            streamingBufferRef.current += token;
            // Record token into the current turn's buffer (if turn has started)
            const turnIdx = turnCountRef.current;
            if (turnIdx >= 0) {
              turnTokensRef.current[turnIdx] = (turnTokensRef.current[turnIdx] ?? "") + token;
            } else {
              // Token before first turn_start — append to turn 0 when it arrives
              turnTokensRef.current[0] = (turnTokensRef.current[0] ?? "") + token;
            }
            // Show all tokens in streaming UI (preserves typing effect)
            setStreamingBuffer((prev) => prev + token);
          },
          onDone: (turn) => {
            setAgentConversation(turn.conversation);
            setAgentConversationSuggestions(turn.suggestions ?? []);
            setAgentConversationArtifacts(turn.artifacts ?? []);
            setPendingAgentInstruction(null);
            // Separate thinking from answer using turn boundaries:
            // - Multiple turns (turnCount >= 1): turn 0 tokens = thinking, turn 1+ tokens = answer
            // - Single turn (turnCount === 0): no thinking (entire output is the answer)
            if (turnCountRef.current >= 1 && turnTokensRef.current[0]) {
              setLastThinkingContent(turnTokensRef.current[0].trim());
            } else {
              setLastThinkingContent("");
            }
            // Reset all streaming refs
            turnTokensRef.current = [];
            streamingBufferRef.current = "";
            turnCountRef.current = -1;
            setStreamingBuffer("");
            setStreamStatus(null);
            reloadProject();
            const hasPendingArtifact = (turn.artifacts ?? []).some(
              (a) => a.status === "pending_confirmation",
            );
            if (!hasPendingArtifact && turn.run?.proposal_id) {
              setActionSuccess("Agent 已生成提案，等待你确认后应用");
            }
          },
          onError: (msg) => {
            turnTokensRef.current = [];
            streamingBufferRef.current = "";
            turnCountRef.current = -1;
            setStreamingBuffer("");
            setStreamStatus(null);
            setAgentConversationError(msg || "这次没有生成可用结果，我保留了你的请求。");
          },
        },
        abortRef.current.signal,
        currentUserId,
      );
    } catch {
      if (!abortRef.current?.signal.aborted) {
        setAgentConversationError("这次没有生成可用结果，我保留了你的请求。你可以重新发送或换一种说法。");
      }
      setStreamingBuffer("");
      setStreamStatus(null);
    } finally {
      setPendingAgentConversation(false);
      abortRef.current = null;
    }
  };

  const handleStopStreaming = () => {
    abortRef.current?.abort();
    turnTokensRef.current = [];
    streamingBufferRef.current = "";
    turnCountRef.current = -1;
    setStreamingBuffer("");
    setStreamStatus(null);
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

  const handleFinalizeAssignments = async (stageId: string) => {
    if (!projectState) return;
    setActionError(null);
    try {
      await finalizeAssignments(stageId, projectState.project.created_by);
      await reloadProject();
    } catch {
      setActionError("确认分工路由暂不可用，任务负责人未被更改。");
    }
  };

  const handleConfirmProposal = async (proposalId: string) => {
    if (!projectState) return;
    setActionError(null);
    setActionSuccess(null);
    try {
      await confirmAgentProposal(proposalId, projectState.project.created_by);
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
  const storedUserId = useCurrentUserId();
  const currentUserId = projectState ? resolveValidCurrentUserId(projectState, storedUserId) ?? undefined : undefined;

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

  const handleResetDemo = async () => {
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
  };

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
      agentConversation={agentConversation}
      agentConversationSuggestions={agentConversationSuggestions}
      agentConversationArtifacts={agentConversationArtifacts}
      pendingAgentInstruction={pendingAgentInstruction}
      agentConversationError={agentConversationError}
      pendingAgentConversation={pendingAgentConversation}
      thinkingContent={lastThinkingContent}
      streamingBuffer={streamingBuffer}
      streamStatus={streamStatus}
      onStopStreaming={handleStopStreaming}
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
      onResetDemo={handleResetDemo}
      onRefresh={() => reloadProject()}
    />
  );
}

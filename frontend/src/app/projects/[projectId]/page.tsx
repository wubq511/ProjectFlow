"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";

import { ProjectDashboard, type AgentAction } from "@/components/project/project-dashboard";
import { Button } from "@/components/ui/button";
import { setLastWorkspaceId } from "@/components/app-shell";
import {
  finalizeAssignments,
  confirmAgentProposal,
  createCheckinCycle,
  getProjectState,
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
  startNegotiation,
  submitCheckinResponse,
  updateActionCardStatus,
  updateRiskStatus,
  updateTaskStatus,
} from "@/lib/api";
import type { ProjectState } from "@/lib/types";

const AGENT_RUNNERS: Record<AgentAction, (projectId: string) => Promise<unknown>> = {
  clarify: runClarification,
  plan: runPlanning,
  breakdown: runBreakdown,
  assign: runAssignment,
  push: runActivePush,
  "analyze-checkins": runCheckinAnalysis,
  "risk-analysis": runRiskAnalysis,
  replan: runReplan,
};

export default function ProjectDashboardPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;

  const [state, setState] = useState<ProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<AgentAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reloadProject = useCallback(async () => {
    setError(null);
    try {
      const nextState = await getProjectState(projectId);
      setState(nextState);
    } catch {
      setError("刷新项目数据失败，请重试");
    }
  }, [projectId]);

  useEffect(() => {
    let ignore = false;

    getProjectState(projectId)
      .then((nextState) => {
        if (!ignore) {
          setState(nextState);
          setLastWorkspaceId(nextState.workspace.workspace_id);
        }
      })
      .catch(() => {
        if (!ignore) setError("加载项目仪表盘失败");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [projectId]);

  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const runAgent = async (action: AgentAction) => {
    setPendingAction(action);
    setActionError(null);
    setActionSuccess(null);
    try {
      const result = await AGENT_RUNNERS[action](projectId);
      await reloadProject();
      const eventType = (result as { event_type?: string })?.event_type ?? action;
      setActionSuccess(`Agent "${eventType}" 操作成功`);
    } catch (err: unknown) {
      let msg = "Agent 操作失败，请稍后重试。";
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message.replace(/^Request failed: \d+ /, ""));
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
      await startNegotiation(projectId, proposalId, fromUserId, desiredTaskId);
      await reloadProject();
    } catch {
      setActionError("协商路由暂不可用，拒绝状态将保留在本地直到后端支持。");
    }
  };

  const handleFinalizeAssignments = async (stageId: string) => {
    if (!state) return;
    setActionError(null);
    try {
      await finalizeAssignments(stageId, state.project.created_by);
      await reloadProject();
    } catch {
      setActionError("确认分工路由暂不可用，任务负责人未被更改。");
    }
  };

  const handleConfirmProposal = async (proposalId: string) => {
    if (!state) return;
    setActionError(null);
    setActionSuccess(null);
    try {
      await confirmAgentProposal(proposalId, state.project.created_by);
      await reloadProject();
      setActionSuccess("提案已确认，内容已应用到项目");
    } catch (err: unknown) {
      let msg = "确认提案失败，请稍后重试。";
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message.replace(/^Request failed: \d+ /, ""));
          if (parsed?.detail) msg = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
        } catch { /* ignore */ }
      }
      setActionError(msg);
    }
  };

  const handleRejectProposal = async (proposalId: string) => {
    if (!state) return;
    setActionError(null);
    setActionSuccess(null);
    try {
      await rejectAgentProposal(proposalId);
      await reloadProject();
      setActionSuccess("提案已拒绝");
    } catch {
      setActionError("拒绝提案失败，请稍后重试。");
    }
  };

  const activeStage = state?.stages.find((stage) => stage.id === state.project.current_stage_id)
    ?? state?.stages.find((stage) => stage.status === "active")
    ?? state?.stages[0];
  const currentUserId = state?.project.created_by;

  const handleSubmitCheckin = async (data: {
    user_id: string;
    task_id?: string;
    what_done: string;
    blocker?: string;
    available_hours_next_cycle?: number;
    mood_or_confidence?: "low" | "medium" | "high";
  }) => {
    if (!state || !activeStage) return;
    setActionError(null);
    try {
      const existingCycle = state.checkins.find(
        (cycle) => cycle.stage_id === activeStage.id && cycle.status === "active",
      );
      const cycle = existingCycle ?? await createCheckinCycle(
        state.project.id,
        activeStage.id,
        2,
        new Date().toISOString().slice(0, 10),
        state.project.created_by,
      );
      await submitCheckinResponse(cycle.id, {
        ...data,
        project_id: state.project.id,
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
      if (demo.project_id === projectId) {
        await reloadProject();
      } else {
        router.push(`/projects/${demo.project_id}`);
      }
    } catch {
      setActionError("演示重置失败，现有项目数据未被更改。");
    }
  };

  if (loading) {
    return (
      <div className="mx-auto grid min-h-[70vh] max-w-4xl place-items-center px-5">
        <div className="w-full rounded-lg border border-ink/10 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-moss" />
            <p className="font-semibold text-ink">加载项目仪表盘</p>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <div className="h-24 animate-pulse rounded-lg bg-ink/5" />
            <div className="h-24 animate-pulse rounded-lg bg-ink/5" />
            <div className="h-24 animate-pulse rounded-lg bg-ink/5" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !state) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-5 text-center">
        <AlertCircle className="h-8 w-8 text-coral" />
        <p className="text-sm text-coral">{error ?? "项目未找到"}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <ProjectDashboard
      state={state}
      currentUserId={currentUserId}
      pendingAction={pendingAction}
      actionError={actionError}
      actionSuccess={actionSuccess}
      onRunAgent={runAgent}
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
      onResetDemo={handleResetDemo}
    />
  );
}

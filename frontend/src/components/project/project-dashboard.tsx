"use client";

import { AlertCircle, CheckCircle, ChevronRight, Loader2, PlayCircle, RotateCcw, Sparkles, ArrowLeft } from "lucide-react";
import Link from "next/link";

import { DirectionCardPanel } from "@/components/agent/direction-card-panel";
import { AgentProposalPanel } from "@/components/agent/agent-proposal-panel";
import { ActionCardsList } from "@/components/agent/action-card";
import { TeamActionsPanel } from "@/components/agent/team-actions-panel";
import { AgentTimeline } from "@/components/agent/timeline";
import { ExportPanel } from "@/components/agent/export-panel";
import { AssignmentFlowPanel } from "@/components/assignment/assignment-flow-panel";
import { CheckInForm } from "@/components/checkin/checkin-form";
import { RiskPanel } from "@/components/risk/risk-panel";
import { ReplanDiff } from "@/components/risk/replan-diff";
import { StagePlanBoard } from "@/components/stage/stage-plan-board";
import { TaskBreakdownBoard } from "@/components/task/task-breakdown-board";
import { TaskStatusUpdateList } from "@/components/task/task-status-update";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ProjectState } from "@/lib/types";

export type AgentAction = "clarify" | "plan" | "breakdown" | "assign" | "push" | "analyze-checkins" | "risk-analysis" | "replan";

type ProjectDashboardProps = {
  state: ProjectState;
  currentUserId?: string;
  pendingAction?: AgentAction | null;
  actionError?: string | null;
  actionSuccess?: string | null;
  onRunAgent?: (action: AgentAction) => void | Promise<void>;
  onRespondToAssignment?: (
    proposalId: string,
    userId: string,
    response: "accept" | "reject",
    preferredTaskId?: string,
    reason?: string,
  ) => void | Promise<void>;
  onStartNegotiation?: (
    proposalId: string,
    fromUserId: string,
    desiredTaskId: string,
  ) => void | Promise<void>;
  onFinalizeAssignments?: (stageId: string) => void | Promise<void>;
  onSubmitCheckin?: (data: {
    user_id: string;
    task_id?: string;
    what_done: string;
    blocker?: string;
    available_hours_next_cycle?: number;
    mood_or_confidence?: "low" | "medium" | "high";
  }) => void | Promise<void>;
  onUpdateTaskStatus?: (data: {
    task_id: string;
    user_id: string;
    status: "not_started" | "in_progress" | "done" | "blocked";
    progress_note?: string;
    blocker?: string;
    available_hours_change?: number;
  }) => void | Promise<void>;
  onResolveRisk?: (riskId: string) => void | Promise<void>;
  onAcceptRisk?: (riskId: string) => void | Promise<void>;
  onIgnoreRisk?: (riskId: string) => void | Promise<void>;
  onDismissActionCard?: (cardId: string) => void | Promise<void>;
  onCompleteActionCard?: (cardId: string) => void | Promise<void>;
  onConfirmProposal?: (proposalId: string) => void | Promise<void>;
  onRejectProposal?: (proposalId: string) => void | Promise<void>;
  onResetDemo?: () => void | Promise<void>;
};

type AgentPhase = "planning" | "assignment" | "execution" | "monitoring";

const PHASE_META: Record<AgentPhase, { label: string; description: string }> = {
  planning: { label: "规划", description: "澄清方向、拆解阶段、分解任务" },
  assignment: { label: "分工", description: "根据成员技能和可用时间推荐分工" },
  execution: { label: "执行", description: "主动推进、签到反馈、更新状态" },
  monitoring: { label: "监控", description: "风险识别、计划调整" },
};

const PHASE_ACTIONS: Record<AgentPhase, AgentAction[]> = {
  planning: ["clarify", "plan", "breakdown"],
  assignment: ["assign"],
  execution: ["push", "analyze-checkins"],
  monitoring: ["risk-analysis", "replan"],
};

const ACTION_LABELS: Record<AgentAction, string> = {
  clarify: "澄清方向",
  plan: "生成阶段计划",
  breakdown: "分解任务",
  assign: "推荐分工",
  push: "主动推进",
  "analyze-checkins": "分析签到",
  "risk-analysis": "风险分析",
  replan: "调整计划",
};

function projectStatusClass(status: ProjectState["project"]["status"]) {
  if (status === "active") return "bg-moss/15 text-moss";
  if (status === "at_risk") return "bg-coral/15 text-coral";
  if (status === "completed") return "bg-ink/10 text-ink/55";
  return "bg-white text-ink/60";
}

function projectStatusLabel(status: ProjectState["project"]["status"]) {
  if (status === "active") return "进行中";
  if (status === "at_risk") return "有风险";
  if (status === "completed") return "已完成";
  if (status === "draft") return "草稿";
  return status;
}

function inferCurrentPhase(state: ProjectState): AgentPhase {
  const { project, stages, tasks, assignment_proposals } = state;
  if (!project.direction_card) return "planning";
  if (stages.length === 0) return "planning";
  if (tasks.length === 0) return "planning";
  const hasFinalized = assignment_proposals.some((p) => p.status === "finalized");
  if (!hasFinalized && assignment_proposals.length === 0) return "assignment";
  return "execution";
}

function inferRecommendedAction(state: ProjectState): AgentAction | null {
  const { project, stages, tasks, assignment_proposals } = state;
  if (!project.direction_card) return "clarify";
  if (stages.length === 0) return "plan";
  if (tasks.length === 0) return "breakdown";
  if (assignment_proposals.length === 0) return "assign";
  const hasFinalized = assignment_proposals.some((p) => p.status === "finalized");
  if (!hasFinalized) return "assign";
  return "push";
}

export function ProjectDashboard({
  state,
  currentUserId,
  pendingAction,
  actionError,
  actionSuccess,
  onRunAgent,
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
  onResetDemo,
}: ProjectDashboardProps) {
  const { project, stages, tasks, action_cards, risks, timeline } = state;
  const currentStage = stages.find((stage) => stage.id === project.current_stage_id)
    ?? stages.find((stage) => stage.status === "active")
    ?? stages[0];
  const nextAction = action_cards.find((card) => card.status === "active");
  const p0OpenCount = tasks.filter((task) => task.priority === "P0" && task.status !== "done").length;
  const ownerCoverage = tasks.length === 0
    ? 0
    : Math.round((tasks.filter((task) => task.owner_user_id).length / tasks.length) * 100);

  const personalCards = action_cards.filter(
    (card) => card.user_id === currentUserId && card.status === "active"
  );

  const currentPhase = inferCurrentPhase(state);
  const recommendedAction = inferRecommendedAction(state);

  const phaseOrder: AgentPhase[] = ["planning", "assignment", "execution", "monitoring"];
  const currentPhaseIndex = phaseOrder.indexOf(currentPhase);

  const runButton = (action: AgentAction, isRecommended: boolean) => (
    <Button
      key={action}
      variant={isRecommended ? "default" : "outline"}
      disabled={Boolean(pendingAction)}
      onClick={() => onRunAgent?.(action)}
      className={isRecommended ? "bg-ink text-white hover:bg-ink/85" : ""}
    >
      {pendingAction === action ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
      {pendingAction === action ? "运行中..." : ACTION_LABELS[action]}
    </Button>
  );

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
      <nav className="mb-4 flex items-center gap-2 text-sm text-ink/55">
        <Link href={`/workspaces/${state.workspace.workspace_id}`} className="transition hover:text-ink">
          工作台
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-ink">{project.name}</span>
      </nav>

      <header className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={projectStatusClass(project.status)}>{projectStatusLabel(project.status)}</Badge>
              <span className="text-xs text-ink/45">截止 {project.deadline}</span>
            </div>
            <h1 className="font-display mt-3 text-3xl font-black leading-tight text-ink md:text-4xl">
              {project.name}
            </h1>
            <p className="mt-2 max-w-3xl text-sm text-ink/65">{project.idea}</p>
          </div>
          <div className="grid min-w-56 gap-2 rounded-lg bg-paper p-4 text-sm">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">当前阶段</p>
              <p className="mt-1 font-semibold text-ink">{currentStage?.name ?? "暂无阶段"}</p>
            </div>
            <div className="border-t border-ink/10 pt-2">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">推荐下一步</p>
              <p className="mt-1 font-semibold text-ink">
                {recommendedAction ? ACTION_LABELS[recommendedAction] : "查看行动卡"}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-3 border-t border-ink/10 pt-5 md:grid-cols-3">
          <div className="rounded-lg bg-paper px-4 py-3">
            <p className="text-xs text-ink/50">待处理 P0</p>
            <p className="mt-1 text-2xl font-black text-ink">{p0OpenCount}</p>
          </div>
          <div className="rounded-lg bg-paper px-4 py-3">
            <p className="text-xs text-ink/50">分工覆盖率</p>
            <p className="mt-1 text-2xl font-black text-ink">{ownerCoverage}%</p>
          </div>
          <div className="rounded-lg bg-paper px-4 py-3">
            <p className="text-xs text-ink/50">活跃行动卡</p>
            <p className="mt-1 text-2xl font-black text-ink">{action_cards.filter((card) => card.status === "active").length}</p>
          </div>
        </div>
      </header>

      {nextAction && (
        <section className="mt-5 rounded-lg border border-moss/20 bg-moss/10 p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-1 h-5 w-5 text-moss" />
            <div>
              <p className="font-semibold text-ink">{nextAction.title}</p>
              <p className="mt-1 text-sm text-ink/65">{nextAction.content}</p>
              <p className="mt-2 flex items-center gap-1 text-xs text-ink/50">
                原因 <ChevronRight className="h-3 w-3" /> {nextAction.reason}
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="mt-5 rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-ink">Agent 操作</h2>
          <p className="mt-1 text-sm text-ink/60">
            按项目阶段推进，当前阶段高亮显示
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          {phaseOrder.map((phase, phaseIndex) => {
            const isCurrent = phaseIndex === currentPhaseIndex;
            const isPast = phaseIndex < currentPhaseIndex;
            const actions = PHASE_ACTIONS[phase];
            const meta = PHASE_META[phase];

            return (
              <div
                key={phase}
                className={`rounded-lg border p-4 transition ${
                  isCurrent
                    ? "border-moss/30 bg-moss/5"
                    : isPast
                      ? "border-ink/8 bg-ink/3"
                      : "border-ink/8 bg-white"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      isCurrent ? "bg-moss" : isPast ? "bg-ink/30" : "bg-ink/15"
                    }`}
                  />
                  <h3 className={`text-sm font-bold ${isCurrent ? "text-moss" : "text-ink/70"}`}>
                    {meta.label}
                  </h3>
                  {isCurrent && (
                    <Badge className="bg-moss/15 text-moss text-[10px] px-1.5 py-0">当前</Badge>
                  )}
                  {isPast && (
                    <Badge className="bg-ink/10 text-ink/50 text-[10px] px-1.5 py-0">已完成</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink/50">{meta.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {actions.map((action) => {
                    const isRecommended = action === recommendedAction;
                    return (
                      <Button
                        key={action}
                        variant={isRecommended ? "default" : "outline"}
                        size="sm"
                        disabled={Boolean(pendingAction)}
                        onClick={() => onRunAgent?.(action)}
                        className={isRecommended ? "bg-ink text-white hover:bg-ink/85 text-xs" : "text-xs"}
                      >
                        {pendingAction === action ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <PlayCircle className="h-3.5 w-3.5" />
                        )}
                        {pendingAction === action ? "运行中" : ACTION_LABELS[action]}
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {actionSuccess && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-moss/20 bg-moss/10 p-3 text-sm text-moss">
            <CheckCircle className="mt-0.5 h-4 w-4" />
            <p>{actionSuccess}</p>
          </div>
        )}

        {actionError && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-coral/20 bg-coral/10 p-3 text-sm text-coral">
            <AlertCircle className="mt-0.5 h-4 w-4" />
            <p>{actionError}</p>
          </div>
        )}

        {onResetDemo && (
          <div className="mt-4 border-t border-ink/8 pt-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={onResetDemo}
              className="text-ink/50 hover:text-coral"
            >
              <RotateCcw className="h-4 w-4" />
              重置演示
            </Button>
          </div>
        )}
      </section>

      <div className="mt-5 grid gap-5">
        <AgentProposalPanel
          proposals={state.agent_proposals}
          pending={Boolean(pendingAction)}
          onConfirm={onConfirmProposal}
          onReject={onRejectProposal}
        />
        <DirectionCardPanel
          directionCard={project.direction_card}
          timeline={state.timeline}
          pending={pendingAction === "clarify"}
          onRunClarification={() => onRunAgent?.("clarify")}
        />
        <StagePlanBoard stages={stages} tasks={tasks} currentStageId={project.current_stage_id} />
        <TaskBreakdownBoard stages={stages} tasks={tasks} />
        <AssignmentFlowPanel
          proposals={state.assignment_proposals}
          negotiations={state.assignment_negotiations}
          stages={stages}
          tasks={tasks}
          members={state.members}
          pending={Boolean(pendingAction)}
          onRespondToAssignment={onRespondToAssignment}
          onStartNegotiation={onStartNegotiation}
          onFinalizeAssignments={onFinalizeAssignments}
        />

        <Tabs defaultValue="actions" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="actions">行动卡</TabsTrigger>
            <TabsTrigger value="checkin">签到与状态</TabsTrigger>
            <TabsTrigger value="risks">风险与调整</TabsTrigger>
            <TabsTrigger value="timeline">时间线与导出</TabsTrigger>
          </TabsList>

          <TabsContent value="actions" className="space-y-5">
            {personalCards.length > 0 && (
              <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
                <div>
                  <h2 className="text-lg font-bold text-ink">你的行动</h2>
                  <p className="mt-1 text-sm text-ink/60">
                    分配给你的任务和提醒
                  </p>
                </div>
                <div className="mt-5">
                  <ActionCardsList
                    cards={personalCards}
                    onDismiss={onDismissActionCard}
                    onComplete={onCompleteActionCard}
                    pending={Boolean(pendingAction)}
                  />
                </div>
              </section>
            )}
            <TeamActionsPanel
              cards={action_cards}
              onDismiss={onDismissActionCard}
              onComplete={onCompleteActionCard}
              pending={Boolean(pendingAction)}
            />
          </TabsContent>

          <TabsContent value="checkin" className="space-y-5">
            {currentUserId && onSubmitCheckin && (
              <CheckInForm
                tasks={tasks}
                userId={currentUserId}
                onSubmit={onSubmitCheckin}
                pending={Boolean(pendingAction)}
              />
            )}
            {currentUserId && onUpdateTaskStatus && (
              <section className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
                <div>
                  <h2 className="text-lg font-bold text-ink">更新任务状态</h2>
                  <p className="mt-1 text-sm text-ink/60">
                    手动更新进度、阻塞和完成情况
                  </p>
                </div>
                <div className="mt-5">
                  <TaskStatusUpdateList
                    tasks={tasks.filter((t) => t.owner_user_id === currentUserId)}
                    userId={currentUserId}
                    onUpdate={onUpdateTaskStatus}
                    pending={Boolean(pendingAction)}
                  />
                </div>
              </section>
            )}
          </TabsContent>

          <TabsContent value="risks" className="space-y-5">
            <RiskPanel
              risks={risks}
              onResolve={onResolveRisk}
              onAccept={onAcceptRisk}
              onIgnore={onIgnoreRisk}
              pending={Boolean(pendingAction)}
            />
            <ReplanDiff before={[]} after={[]} proposal={null} />
          </TabsContent>

          <TabsContent value="timeline" className="space-y-5">
            <AgentTimeline events={timeline} />
            <ExportPanel projectId={project.id} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

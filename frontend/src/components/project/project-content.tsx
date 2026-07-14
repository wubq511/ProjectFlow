"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  CalendarDays,
  CheckCircle2,
  Users,
  Sparkles,
  ChevronRight,
  LayoutDashboard,
  Compass,
  GitBranch,
  ListTodo,
  ClipboardCheck,
  AlertTriangle,
  BarChart3,
  Loader2,
  Lightbulb,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MultilineText } from "@/components/ui/multiline-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CompactStat } from "@/components/ui/compact-stat";
import { DirectionCardPanel } from "@/components/agent/direction-card-panel";
import { AgentProposalPanel } from "@/components/agent/agent-proposal-panel";
import { ActionCardsList } from "@/components/agent/action-card";
import { TeamActionsPanel } from "@/components/agent/team-actions-panel";
import { AgentTimeline } from "@/components/agent/timeline";
import { ExportPanel } from "@/components/agent/export-panel";
import { CheckInForm } from "@/components/checkin/checkin-form";
import { RiskPanel } from "@/components/risk/risk-panel";
import { ReplanDiff } from "@/components/risk/replan-diff";
import { ProjectResourcesPanel } from "@/components/project/project-resources-panel";
import { StagePlanBoard } from "@/components/stage/stage-plan-board";
import { TaskBreakdownBoard } from "@/components/task/task-breakdown-board";
import { TaskStatusUpdateList } from "@/components/task/task-status-update";
import { WorkspaceContent } from "./workspace-content";
import { MyTasksView, TeamTasksView } from "./project-task-views";
import { ProjectMemoryPanel } from "./project-memory-panel";
import type { AddResourceRequest, ProjectState, ThinkingLevel } from "@/lib/types";
import { ACTION_LABELS, inferRecommendedAction } from "./project-actions";
import type { AgentAction } from "./project-actions";
import type { ProjectView } from "./project-sidebar";

const VIEW_META: Record<
  ProjectView,
  { title: string; icon: React.ElementType; description: string }
> = {
  overview: {
    title: "项目总览",
    icon: LayoutDashboard,
    description: "项目整体进度和关键指标",
  },
  direction: {
    title: "方向卡",
    icon: Compass,
    description: "明确项目目标、边界和关键决策",
  },
  stages: {
    title: "阶段计划",
    icon: GitBranch,
    description: "阶段规划和任务看板",
  },
  "my-tasks": {
    title: "我的任务",
    icon: ListTodo,
    description: "个人任务和签到",
  },
  "team-tasks": {
    title: "团队任务",
    icon: ListTodo,
    description: "团队所有任务总览",
  },
  checkin: {
    title: "签到与状态",
    icon: ClipboardCheck,
    description: "签到和任务状态更新",
  },
  risks: {
    title: "风险预警",
    icon: AlertTriangle,
    description: "风险识别和应对措施",
  },
  memory: {
    title: "项目记忆",
    icon: BookOpen,
    description: "当前身份可见的项目决策记忆和 Markdown 导出",
  },
  retro: {
    title: "项目复盘",
    icon: BarChart3,
    description: "项目总结、Agent 时间线和评审导出",
  },
};

interface ProjectContentProps {
  state: ProjectState;
  currentUserId?: string;
  pendingAction?: AgentAction | null;
  showWorkspace?: boolean;
  currentView?: ProjectView;
  onShowWorkspace?: (show: boolean) => void;
  onNavigateView?: (view: ProjectView) => void;
  onRunAgent?: (action: AgentAction, thinkingLevel?: ThinkingLevel, model?: { provider: string; name: string }) => void;
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
  onAddResource?: (resource: AddResourceRequest) => void | Promise<void>;
  onDeleteResource?: (resourceId: string) => void | Promise<void>;
}

export function ProjectContent(props: ProjectContentProps) {
  const currentView = props.currentView ?? "overview";

  if (props.showWorkspace) {
    return (
      <WorkspaceContent
        state={props.state}
        currentUserId={props.currentUserId}
        onNavigateToProject={() => props.onShowWorkspace?.(false)}
      />
    );
  }

  return (
    <motion.div
      key={currentView}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
      className="h-full overflow-y-auto custom-scrollbar bg-bg-content p-6"
    >
      {/* View Header — redesigned: no uppercase eyebrow, cleaner hierarchy */}
      <div className="mb-8">
        <div className="flex items-center gap-2">
          <ViewHeaderIcon view={currentView} />
          <h1 className="text-xl font-semibold text-neutral-900">
            {VIEW_META[currentView].title}
          </h1>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          {VIEW_META[currentView].description}
        </p>
      </div>

      {/* View Content */}
      <ViewRenderer view={currentView} {...props} />
    </motion.div>
  );
}

/** Small banner shown in specialist views to guide users to overview for proposal confirmation. */
function PendingProposalBanner({
  count,
  label,
  onGoToOverview,
}: {
  count: number;
  label: string;
  onGoToOverview?: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-citron/40 bg-citron/10 px-4 py-3 text-sm">
      <Sparkles className="h-4 w-4 shrink-0 text-amber-600" />
      <span className="flex-1 text-ink/75">
        有 <strong>{count}</strong> 个待确认的 <strong>{label}</strong> 提案 —
        请到<strong>项目总览</strong>中确认应用
      </span>
      {onGoToOverview && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 border-amber-300 text-xs"
          onClick={onGoToOverview}
        >
          去确认
          <ChevronRight className="ml-1 h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

function ViewRenderer({
  view,
  state,
  currentUserId,
  pendingAction,
  onNavigateView,
  onRunAgent,
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
  onAddResource,
  onDeleteResource,
}: ProjectContentProps & { view: ProjectView }) {
  const { project, stages, tasks, action_cards, risks, timeline } = state;
  const currentStage =
    stages.find((stage) => stage.id === project.current_stage_id) ??
    stages.find((stage) => stage.status === "active") ??
    stages[0];

  const p0OpenCount = tasks.filter(
    (task) => task.priority === "P0" && task.status !== "done"
  ).length;
  const ownerCoverage =
    tasks.length === 0
      ? 0
      : Math.round(
          (tasks.filter((task) => task.owner_user_id).length / tasks.length) *
            100
        );

  const personalCards = action_cards.filter(
    (card) => card.user_id === currentUserId && card.status === "active"
  );
  const latestPendingReplan = state.agent_proposals
    .filter((proposal) => proposal.proposal_type === "replan" && proposal.status === "pending")
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null;

  switch (view) {
    case "overview":
      return (
        <div className="space-y-6">
          {/* Project Header Card */}
          <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="font-display text-3xl font-normal text-neutral-900">
                  {project.name}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Badge
                    className={cn(
                      "transition-colors",
                      project.status === "active"
                        ? "bg-moss/15 text-moss"
                        : project.status === "at_risk"
                          ? "bg-coral/15 text-coral"
                          : "bg-ink/10 text-ink/55"
                    )}
                  >
                    {project.status === "active"
                      ? "进行中"
                      : project.status === "at_risk"
                        ? "有风险"
                        : project.status === "completed"
                          ? "已完成"
                          : "草稿"}
                  </Badge>
                </div>
                <MultilineText text={project.idea} className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500 line-clamp-2" />
              </div>
              <div className="grid min-w-56 gap-2 rounded-lg border border-neutral-100 bg-neutral-50/50 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-neutral-400">当前阶段</span>
                  <span className="font-medium text-neutral-900">{currentStage?.name ?? "暂无阶段"}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-neutral-400">推荐下一步</span>
                  <span className="font-medium text-neutral-900">
                    {(() => {
                      const rec = inferRecommendedAction(state);
                      return rec ? ACTION_LABELS[rec] : "查看行动卡";
                    })()}
                  </span>
                </div>
                <div className="mt-1 border-t border-neutral-100 pt-2 flex items-center justify-between text-xs text-neutral-500">
                  <span className="flex items-center gap-1">
                    <CalendarDays className="h-3.5 w-3.5" />
                    截止 {project.deadline}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />
                    {state.members.length} 名成员
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* Next Action — promoted to top */}
          {(() => {
            const nextAction = action_cards.find(
              (card) => card.status === "active"
            );
            const completedCards = action_cards.filter(
              (card) => card.status === "done"
            );
            const latestDone = completedCards.length > 0
              ? completedCards.reduce((a, b) =>
                  new Date(a.created_at).getTime() > new Date(b.created_at).getTime() ? a : b
                )
              : null;

            if (nextAction) {
              return (
                <section className="rounded-xl border border-moss/20 bg-moss/[0.04] p-5 shadow-sm transition-colors hover:bg-moss/[0.06]">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-moss/10">
                      <Sparkles className="h-5 w-5 text-moss" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-neutral-900">
                        {nextAction.title}
                      </p>
                      <div className="mt-1 text-sm text-neutral-600">
                        <MultilineText text={nextAction.content} />
                      </div>
                      <div className="mt-2 flex items-center gap-1 text-xs text-ink/50">
                        原因 <ChevronRight className="h-3 w-3" />{" "}
                        <MultilineText text={nextAction.reason} />
                      </div>
                    </div>
                    <Button
                      size="sm"
                      className="shrink-0 bg-moss text-white hover:bg-moss/85"
                      disabled={Boolean(pendingAction)}
                      onClick={() => onCompleteActionCard?.(nextAction.id)}
                    >
                      完成
                    </Button>
                  </div>
                </section>
              );
            }

            if (completedCards.length > 0 && latestDone) {
              return (
                <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink/8">
                      <CheckCircle2 className="h-5 w-5 text-ink/50" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-neutral-900">
                        全部 {completedCards.length} 张行动卡已完成
                      </p>
                      <p className="mt-1 text-sm text-neutral-500">
                        最近完成：{latestDone.title}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={Boolean(pendingAction)}
                      onClick={() => onRunAgent?.("push")}
                    >
                      {pendingAction === "push" ? (
                        <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> 推进中…</>
                      ) : (
                        <><Sparkles className="mr-1 h-3 w-3" /> 继续推进</>
                      )}
                    </Button>
                  </div>
                </section>
              );
            }

            if (action_cards.length === 0) {
              return (
                <section className="rounded-xl border border-dashed border-ink/15 bg-paper/70 p-5">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-moss/10">
                      <Sparkles className="h-5 w-5 text-moss/60" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-neutral-900">
                        运行主动推进获取行动建议
                      </p>
                      <p className="mt-1 text-sm text-neutral-500">
                        Agent 会根据项目进展生成下一步行动卡
                      </p>
                    </div>
                    <Button
                      size="sm"
                      className="shrink-0 bg-ink text-white hover:bg-ink/85"
                      disabled={Boolean(pendingAction)}
                      onClick={() => onRunAgent?.("push")}
                    >
                      {pendingAction === "push" ? (
                        <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> 推进中…</>
                      ) : (
                        <><Sparkles className="mr-1 h-3 w-3" /> 主动推进</>
                      )}
                    </Button>
                  </div>
                </section>
              );
            }

            return null;
          })()}

          {/* Stats Row — compact, no fake progress */}
          <section className="grid gap-4 sm:grid-cols-3">
          <CompactStat
            label="待处理 P0"
            value={p0OpenCount}
            trend={p0OpenCount > 0 ? "需优先处理" : "全部完成"}
            tone={p0OpenCount > 0 ? "coral" : "moss"}
            helpText="P0 是最高优先级任务，需要立即处理"
          />
          <CompactStat
            label="分工覆盖率"
            value={`${ownerCoverage}%`}
            trend={ownerCoverage < 100 ? `${tasks.length - tasks.filter((t) => t.owner_user_id).length} 个未分配` : "全部分配"}
            tone={ownerCoverage < 100 ? "primary" : "moss"}
            helpText="已有负责人分配的任务占总任务的比例"
          />
          <CompactStat
            label="活跃行动卡"
            value={action_cards.filter((c) => c.status === "active").length}
            trend={action_cards.filter((c) => c.status === "active").length > 0 ? "有推荐行动" : "暂无"}
            tone={action_cards.filter((c) => c.status === "active").length > 0 ? "moss" : "ink"}
            helpText="Agent 为你推荐的当前需要执行的行动"
          />
          </section>

          {/* Agent Proposals — collapsed when none pending */}
          <AgentProposalPanel
            proposals={state.agent_proposals}
            timeline={state.timeline}
            pending={Boolean(pendingAction)}
            onConfirm={onConfirmProposal}
            onReject={onRejectProposal}
          />

          <ProjectResourcesPanel
            resources={state.resources}
            pending={Boolean(pendingAction)}
            onAddResource={onAddResource}
            onDeleteResource={onDeleteResource}
          />

          {/* Action Cards — personal first, then team */}
          {personalCards.length > 0 && (
            <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-bold text-ink">你的行动</h2>
              <div className="mt-4">
                <ActionCardsList
                  cards={personalCards.slice(0, 3)}
                  onDismiss={onDismissActionCard}
                  onComplete={onCompleteActionCard}
                  pending={Boolean(pendingAction)}
                />
                {personalCards.length > 3 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-3 h-7 text-xs text-ink/60"
                    onClick={() => {
                      const el = document.getElementById("personal-cards-all");
                      if (el) el.scrollIntoView({ behavior: "smooth" });
                    }}
                  >
                    查看全部 {personalCards.length} 个
                  </Button>
                )}
              </div>
            </section>
          )}
          <div id="personal-cards-all">
            <TeamActionsPanel
              cards={action_cards}
              onDismiss={onDismissActionCard}
              onComplete={onCompleteActionCard}
              pending={Boolean(pendingAction)}
              canOperate={currentUserId === project.created_by}
            />
          </div>
        </div>
      );

    case "direction":
      return (
        <div className="space-y-6">
          <PendingProposalBanner
            count={state.agent_proposals.filter((p) => p.proposal_type === "clarify" && p.status === "pending").length}
            label="方向卡"
            onGoToOverview={onNavigateView ? () => onNavigateView("overview") : undefined}
          />
          <DirectionCardPanel
            directionCard={project.direction_card}
            timeline={timeline}
            pending={pendingAction === "clarify"}
            onRunClarification={() => onRunAgent?.("clarify")}
            stagesCount={stages.length}
            tasksCount={tasks.length}
          />
        </div>
      );

    case "stages":
      return (
        <div className="space-y-6">
          <PendingProposalBanner
            count={state.agent_proposals.filter((p) => (p.proposal_type === "plan" || p.proposal_type === "breakdown") && p.status === "pending").length}
            label="阶段/任务"
            onGoToOverview={onNavigateView ? () => onNavigateView("overview") : undefined}
          />
          <StagePlanBoard
            stages={stages}
            tasks={tasks}
            currentStageId={project.current_stage_id}
            pendingPlanProposal={
              state.agent_proposals.find((p) => p.proposal_type === "plan" && p.status === "pending") ?? null
            }
          />
          <TaskBreakdownBoard
            stages={stages}
            tasks={tasks}
            pendingProposal={
              state.agent_proposals.find((p) => p.proposal_type === "breakdown" && p.status === "pending") ?? null
            }
          />
        </div>
      );

    case "my-tasks":
      return (
        <MyTasksView
          tasks={tasks}
          currentUserId={currentUserId}
          proposals={state.assignment_proposals}
          pendingAction={pendingAction}
          onRespondToAssignment={onRespondToAssignment}
          onSubmitCheckin={onSubmitCheckin}
          onUpdateTaskStatus={onUpdateTaskStatus}
        />
      );

    case "team-tasks":
      return (
        <TeamTasksView
          tasks={tasks}
          stages={stages}
          members={state.members}
          proposals={state.assignment_proposals}
          negotiations={state.assignment_negotiations}
          pendingAction={pendingAction}
          currentUserId={currentUserId}
          onRespondToAssignment={onRespondToAssignment}
          onStartNegotiation={onStartNegotiation}
          onResolveNegotiation={onResolveNegotiation}
          onFinalizeAssignments={onFinalizeAssignments}
        />
      );

    case "checkin":
      return (
        <div className="space-y-6">
          {currentUserId && onSubmitCheckin && (
            <CheckInForm
              tasks={tasks}
              userId={currentUserId}
              onSubmit={onSubmitCheckin}
              pending={Boolean(pendingAction)}
            />
          )}
          {currentUserId && onUpdateTaskStatus && (
            <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-bold text-ink">更新任务状态</h2>
              <div className="mt-4">
                <TaskStatusUpdateList
                  tasks={tasks.filter((t) => t.owner_user_id === currentUserId)}
                  userId={currentUserId}
                  onUpdate={onUpdateTaskStatus}
                  pending={Boolean(pendingAction)}
                />
              </div>
            </section>
          )}
        </div>
      );

   case "risks":
     return (
       <div className="space-y-6">
         <RiskPanel
           risks={risks}
           onResolve={onResolveRisk}
           onAccept={onAcceptRisk}
           onIgnore={onIgnoreRisk}
           pending={Boolean(pendingAction)}
         />
         <ReplanDiff
           before={[]}
           after={[]}
           proposal={null}
           pendingProposal={latestPendingReplan}
           onConfirmReplan={onConfirmProposal}
           onRejectReplan={onRejectProposal}
           pending={Boolean(pendingAction)}
         />
        </div>
      );

    case "memory":
      return (
        <div className="space-y-6">
          <ProjectMemoryPanel
            key={`${project.id}-${currentUserId ?? "none"}`}
            projectId={project.id}
            projectName={project.name}
            currentUserId={currentUserId}
          />
        </div>
      );

    case "retro":
      return (
        <div className="space-y-6">
          <RetroSummaryPanel
            project={project}
            stages={stages}
            tasks={tasks}
            risks={risks}
            pending={Boolean(pendingAction)}
            currentUserId={currentUserId}
            onRunAgent={onRunAgent}
          />
          <AgentTimeline events={timeline} />
          <ExportPanel projectId={project.id} />
        </div>
      );

    default:
      return null;
  }
}

function RetroSummaryPanel({
  project,
  stages,
  tasks,
  risks,
  pending,
  currentUserId,
  onRunAgent,
}: {
  project: ProjectState["project"];
  stages: ProjectState["stages"];
  tasks: ProjectState["tasks"];
  risks: ProjectState["risks"];
  pending: boolean;
  currentUserId?: string;
  onRunAgent?: (action: AgentAction, thinkingLevel?: ThinkingLevel, model?: { provider: string; name: string }) => void;
}) {
  const [summary, setSummary] = useState<{
    project_summary: string;
    key_achievements: string[];
    challenges: string[];
    lessons_learned: string[];
    overall_assessment: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const { runRetrospective } = await import("@/lib/api");
      const result = await runRetrospective(project.id, currentUserId ?? "");
      if (result.output) {
        setSummary(result.output as typeof summary);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      setLoading(false);
    }
  };

  const doneTasks = tasks.filter(t => t.status === "done").length;
  const totalTasks = tasks.length;
  const openRisks = risks.filter(r => r.status === "open");
  const completedStages = stages.filter(s => s.status === "completed").length;

  return (
    <>
      <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink">AI 项目复盘</h2>
          <Button
            size="sm"
            className="bg-moss text-white hover:bg-moss/85"
            disabled={loading || pending}
            onClick={handleGenerate}
          >
            {loading ? (
              <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> 生成中…</>
            ) : (
              <><Sparkles className="mr-1 h-3 w-3" /> 生成复盘</>
            )}
          </Button>
        </div>

        {error && (
          <p className="mt-2 text-sm text-coral">{error}</p>
        )}

        {summary ? (
          <div className="mt-4 space-y-4">
            <MultilineText text={summary.project_summary} className="text-sm leading-6 text-ink/75" />

            {summary.key_achievements.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-ink">关键成就</p>
                <ul className="mt-1 space-y-1">
                  {summary.key_achievements.map((item, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink/70">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-moss" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {summary.challenges.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-ink">挑战与应对</p>
                <ul className="mt-1 space-y-1">
                  {summary.challenges.map((item, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink/70">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-citron" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {summary.lessons_learned.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-ink">经验教训</p>
                <ul className="mt-1 space-y-1">
                  {summary.lessons_learned.map((item, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink/70">
                      <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-harbor" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-lg bg-ink/5 p-3">
              <p className="text-sm font-semibold text-ink">整体评价</p>
              <MultilineText text={summary.overall_assessment} className="mt-1 text-sm text-ink/70" />
            </div>
          </div>
        ) : !loading && !error ? (
          <p className="mt-3 text-sm text-ink/50">
            点击「生成复盘」让 Agent 基于项目数据生成深度复盘分析。
          </p>
        ) : null}
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <CompactStat
          label="任务完成"
          value={totalTasks > 0 ? `${doneTasks}/${totalTasks}` : "0/0"}
          trend={totalTasks > 0 ? `${Math.round(doneTasks / totalTasks * 100)}%` : "无任务"}
          tone={doneTasks === totalTasks ? "moss" : "primary"}
          helpText="已完成任务占总任务数的比例"
        />
        <CompactStat
          label="风险解决"
          value={risks.length > 0 ? `${risks.filter(r => r.status === "resolved").length}/${risks.length}` : "0/0"}
          trend={risks.length === 0 ? "无风险" : openRisks.length === 0 ? "全部解决" : `${openRisks.length} 待处理`}
          tone={openRisks.length === 0 ? "moss" : "coral"}
          helpText="已解决风险占总风险数的比例"
        />
        <CompactStat
          label="阶段完成"
          value={stages.length > 0 ? `${completedStages}/${stages.length}` : "0/0"}
          trend={stages.length === 0 ? "无阶段" : completedStages === stages.length ? "全部完成" : stages.find(s => s.status === "active")?.name ?? "进行中"}
          tone={completedStages === stages.length ? "moss" : "primary"}
          helpText="已完成阶段占总阶段数的比例"
        />
      </section>
    </>
  );
}

function ViewHeaderIcon({ view }: { view: ProjectView }) {
  const Icon = VIEW_META[view].icon;
  return <Icon className="h-5 w-5 text-primary" />;
}

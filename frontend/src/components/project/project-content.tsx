"use client";

import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import {
  CalendarDays,
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
} from "lucide-react";
import { cn } from "@/lib/utils";
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
import type { AddResourceRequest, ProjectState } from "@/lib/types";
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
  onShowWorkspace?: (show: boolean) => void;
  onRunAgent?: (action: AgentAction) => void;
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
  onRejectProposal?: (proposalId: string) => void;
  onAddResource?: (resource: AddResourceRequest) => void | Promise<void>;
  onDeleteResource?: (resourceId: string) => void | Promise<void>;
  onResetDemo?: () => void | Promise<void>;
}

export function ProjectContent(props: ProjectContentProps) {
  const searchParams = useSearchParams();
  const currentView =
    (searchParams.get("view") as ProjectView) || "overview";

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

function ViewRenderer({
  view,
  state,
  currentUserId,
  pendingAction,
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
          <section className="rounded-xl border border-neutral-200 bg-white p-5">
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
                <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500 line-clamp-2">
                  {project.idea}
                </p>
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
            return (
              nextAction && (
                <section className="rounded-xl border border-moss/20 bg-moss/[0.04] p-5 transition-colors hover:bg-moss/[0.06]">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-moss/10">
                      <Sparkles className="h-5 w-5 text-moss" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-neutral-900">
                        {nextAction.title}
                      </p>
                      <p className="mt-1 text-sm text-neutral-600">
                        {nextAction.content}
                      </p>
                      <p className="mt-2 flex items-center gap-1 text-xs text-ink/50">
                        原因 <ChevronRight className="h-3 w-3" />{" "}
                        {nextAction.reason}
                      </p>
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
              )
            );
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
            <section className="rounded-xl border border-neutral-200 bg-white p-5">
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
            />
          </div>
        </div>
      );

    case "direction":
      return (
        <div className="space-y-6">
          <DirectionCardPanel
            directionCard={project.direction_card}
            timeline={timeline}
            pending={pendingAction === "clarify"}
            onRunClarification={() => onRunAgent?.("clarify")}
          />
        </div>
      );

    case "stages":
      return (
        <div className="space-y-6">
          <StagePlanBoard
            stages={stages}
            tasks={tasks}
            currentStageId={project.current_stage_id}
          />
          <TaskBreakdownBoard stages={stages} tasks={tasks} />
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
            <section className="rounded-xl border border-neutral-200 bg-white p-5">
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

    case "retro":
      return (
        <div className="space-y-6">
          <section className="grid gap-4 sm:grid-cols-3">
            <CompactStat
              label="任务完成"
              value={tasks.length > 0 ? `${tasks.filter(t => t.status === "done").length}/${tasks.length}` : "0/0"}
              trend={tasks.length > 0 ? `${Math.round((tasks.filter(t => t.status === "done").length / tasks.length) * 100)}%` : "无任务"}
              tone={tasks.filter(t => t.status === "done").length === tasks.length ? "moss" : "primary"}
              helpText="已完成任务占总任务数的比例"
            />
            <CompactStat
              label="风险解决"
              value={risks.length > 0 ? `${risks.filter(r => r.status === "resolved").length}/${risks.length}` : "0/0"}
              trend={risks.length === 0 ? "无风险" : risks.filter(r => r.status === "open").length === 0 ? "全部解决" : `${risks.filter(r => r.status === "open").length} 待处理`}
              tone={risks.filter(r => r.status === "open").length === 0 ? "moss" : "coral"}
              helpText="已解决风险占总风险数的比例"
            />
            <CompactStat
              label="阶段完成"
              value={stages.length > 0 ? `${stages.filter(s => s.status === "completed").length}/${stages.length}` : "0/0"}
              trend={stages.length === 0 ? "无阶段" : stages.filter(s => s.status === "completed").length === stages.length ? "全部完成" : stages.find(s => s.status === "active")?.name ?? "进行中"}
              tone={stages.filter(s => s.status === "completed").length === stages.length ? "moss" : "primary"}
              helpText="已完成阶段占总阶段数的比例"
            />
          </section>
          <AgentTimeline events={timeline} />
          <ExportPanel projectId={project.id} />
        </div>
      );

    default:
      return null;
  }
}

function ViewHeaderIcon({ view }: { view: ProjectView }) {
  const Icon = VIEW_META[view].icon;
  return <Icon className="h-5 w-5 text-primary" />;
}

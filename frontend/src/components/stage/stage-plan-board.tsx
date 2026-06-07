"use client";

import { CalendarDays, CheckCircle2, Circle, Clock, Flag, AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { AgentProposal, Stage, Task } from "@/lib/types";

type StagePlanBoardProps = {
  stages: Stage[];
  tasks: Task[];
  currentStageId?: string | null;
  pendingPlanProposal?: AgentProposal | null;
};

function statusClass(status: Stage["status"]) {
  if (status === "active") return "bg-moss/15 text-moss";
  if (status === "at_risk") return "bg-coral/15 text-coral";
  if (status === "completed") return "bg-ink/10 text-ink/60";
  return "bg-white text-ink/55";
}

function statusLabel(status: Stage["status"]) {
  const labels: Record<Stage["status"], string> = {
    pending: "待开始",
    active: "进行中",
    completed: "已完成",
    at_risk: "有风险",
  };
  return labels[status];
}

function StageIcon({ status, isCurrent }: { status: Stage["status"]; isCurrent: boolean }) {
  if (status === "completed") return <CheckCircle2 className="h-5 w-5 text-moss" />;
  if (isCurrent || status === "active") return <Clock className="h-5 w-5 text-primary" />;
  if (status === "at_risk") return <AlertTriangle className="h-5 w-5 text-coral" />;
  return <Circle className="h-5 w-5 text-neutral-300" />;
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function relativeTimeLabel(start: string, end: string, status: Stage["status"]): string | null {
  if (status === "completed") return null;
  const remaining = daysUntil(end);
  if (remaining < 0) return `已延期 ${Math.abs(remaining)} 天`;
  if (remaining === 0) return "今天截止";
  if (remaining === 1) return "明天截止";
  if (remaining <= 7) return `还剩 ${remaining} 天`;
  return null;
}

interface PendingStage {
  name: string;
  goal: string;
  start_date: string;
  end_date: string;
  deliverable: string;
  order_index: number;
}

function parsePendingStages(proposal: AgentProposal): PendingStage[] {
  const payload = proposal.payload as Record<string, unknown>;
  const stages = payload?.stages;
  if (!Array.isArray(stages)) return [];
  return stages
    .filter(
      (s): s is PendingStage =>
        typeof s === "object" && s !== null && typeof (s as Record<string, unknown>).name === "string"
    )
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
}

export function StagePlanBoard({ stages, tasks, currentStageId, pendingPlanProposal }: StagePlanBoardProps) {
  const completed = stages.filter((stage) => stage.status === "completed").length;
  const progress = stages.length > 0 ? Math.round((completed / stages.length) * 100) : 0;

  const pendingStages =
    pendingPlanProposal && pendingPlanProposal.status === "pending"
      ? parsePendingStages(pendingPlanProposal)
      : [];
  const hasPending = pendingStages.length > 0;

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">阶段计划</h2>
          <p className="mt-1 text-sm text-ink/60">展示阶段、里程碑、交付物和完成标准。</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {hasPending && (
            <Badge className="bg-citron/35 text-ink">含 {pendingStages.length} 个待确认</Badge>
          )}
          <div className="w-44">
            <Progress value={progress} className="h-2" />
            <p className="mt-1 text-right text-xs text-ink/50">完成度 {progress}%</p>
          </div>
        </div>
      </div>

      {/* Pending plan preview */}
      {hasPending && (
        <div className="mt-4 rounded-lg border border-citron/30 bg-citron/5 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink/75">
            <Clock className="h-4 w-4 text-amber-500" />
            待确认的阶段提案
          </div>
          <p className="mt-1 text-xs text-ink/50">
            以下阶段尚未确认应用，请到项目总览中确认。确认后阶段将进入正式列表。
          </p>
          <div className="mt-3 space-y-2">
            {pendingStages.map((stage, i) => (
              <div
                key={i}
                className="rounded-lg border border-citron/25 bg-white/70 p-3 opacity-90"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="bg-ink/10 text-ink/50 text-[10px]">#{stage.order_index ?? i + 1}</Badge>
                  <span className="font-semibold text-ink">{stage.name}</span>
                </div>
                <p className="mt-1 text-sm text-ink/65">{stage.goal}</p>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-ink/50">
                  <span>
                    {stage.start_date} → {stage.end_date}
                  </span>
                  <span>交付: {stage.deliverable}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {stages.length === 0 && !hasPending ? (
        <div className="mt-5 rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
          暂无阶段。方向卡确认后运行阶段计划。
        </div>
      ) : stages.length === 0 && hasPending ? null : (
        <div className="mt-5 relative">
          {/* Timeline connector line */}
          <div className="absolute left-[18px] top-3 bottom-3 w-px bg-neutral-200" aria-hidden="true" />

          <div className="space-y-1">
            {stages.map((stage) => {
              const stageTasks = tasks.filter((task) => task.stage_id === stage.id);
              const isCurrent = stage.id === currentStageId || stage.status === "active";
              const timeLabel = relativeTimeLabel(stage.start_date, stage.end_date, stage.status);

              return (
                <article
                  key={stage.id}
                  className={cn(
                    "relative pl-10 py-3 rounded-lg transition-colors",
                    isCurrent ? "bg-primary/5" : "hover:bg-neutral-50/50"
                  )}
                  data-current={isCurrent ? "true" : "false"}
                >
                  {/* Timeline node */}
                  <div className="absolute left-2 top-4 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-white">
                    <StageIcon status={stage.status} isCurrent={isCurrent} />
                  </div>

                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className={cn("font-semibold text-ink", isCurrent && "text-primary")}>
                          {stage.name}
                        </h3>
                        {isCurrent && (
                          <Badge className="bg-primary/15 text-primary border-0">当前</Badge>
                        )}
                        <Badge className={cn(statusClass(stage.status), "border-0")}>
                          {statusLabel(stage.status)}
                        </Badge>
                        {timeLabel && (
                          <span className={cn(
                            "text-xs font-medium",
                            stage.status === "at_risk" || daysUntil(stage.end_date) < 0
                              ? "text-coral"
                              : "text-primary"
                          )}>
                            {timeLabel}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 max-w-2xl text-sm text-ink/65">{stage.goal}</p>
                    </div>
                    <div className="text-right text-xs text-ink/55 shrink-0">
                      <div className="flex items-center gap-1">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {stage.start_date} → {stage.end_date}
                      </div>
                    </div>
                  </div>

                  {/* Deliverable & Task count — inline, not cards */}
                  <div className="mt-2 flex flex-wrap gap-4 text-sm">
                    <span className="inline-flex items-center gap-1.5 text-ink/70">
                      <Flag className="h-3.5 w-3.5 text-ink/40" />
                      {stage.deliverable}
                    </span>
                    <span className="text-ink/50">
                      {stageTasks.length === 0 ? "暂无任务" : `${stageTasks.length} 个任务`}
                    </span>
                  </div>

                  {/* Done criteria */}
                  {stage.done_criteria && stage.done_criteria.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {stage.done_criteria.map((criteria, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 rounded-full bg-ink/5 px-2 py-0.5 text-xs text-ink/55"
                        >
                          <CheckCircle2 className="h-3 w-3 text-ink/30" />
                          {criteria}
                        </span>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

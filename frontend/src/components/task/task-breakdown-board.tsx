"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  GitBranch,
  Circle,
  Scissors,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { MultilineText } from "@/components/ui/multiline-text";
import { cn } from "@/lib/utils";
import type { AgentProposal, Stage, Task } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function priorityClass(priority: Task["priority"]) {
  if (priority === "P0") return "bg-coral/15 text-coral";
  if (priority === "P1") return "bg-harbor/15 text-harbor";
  return "bg-ink/8 text-ink/55";
}

function statusClass(status: Task["status"]) {
  if (status === "blocked") return "bg-coral/15 text-coral";
  if (status === "done") return "bg-moss/15 text-moss";
  if (status === "in_progress") return "bg-citron/40 text-ink";
  return "bg-white text-ink/55";
}

function statusLabel(status: Task["status"]) {
  const labels: Record<string, string> = {
    not_started: "未开始",
    in_progress: "进行中",
    done: "已完成",
    blocked: "受阻",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}

function stageStatusMeta(status: Stage["status"]) {
  switch (status) {
    case "active":
      return { label: "进行中", dot: "bg-emerald-400", border: "border-emerald-400/40", bg: "bg-emerald-50/60", text: "text-emerald-800" };
    case "completed":
      return { label: "已完成", dot: "bg-neutral-400", border: "border-neutral-300", bg: "bg-neutral-50/60", text: "text-neutral-500" };
    case "at_risk":
      return { label: "有风险", dot: "bg-red-400", border: "border-red-400/40", bg: "bg-red-50/50", text: "text-red-700" };
    default:
      return { label: "待开始", dot: "bg-amber-300", border: "border-amber-300/40", bg: "bg-amber-50/50", text: "text-amber-700" };
  }
}

interface PendingTask {
  title: string;
  description: string;
  priority: string;
  due_date: string;
  estimated_hours: number;
  stage_id?: string;
  dependency_ids?: string[];
  acceptance_criteria?: string[];
  can_cut?: boolean;
  reason?: string;
}

function parsePendingTasks(proposal: AgentProposal): PendingTask[] {
  const payload = proposal.payload as Record<string, unknown>;
  const tasks = payload?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.filter(
    (t): t is PendingTask =>
      typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).title === "string"
  );
}

function sortTasks(taskList: Task[]): Task[] {
  const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  return [...taskList].sort((a, b) => {
    if (a.stage_id !== b.stage_id) return a.stage_id.localeCompare(b.stage_id);
    if (a.order_index !== b.order_index) return a.order_index - b.order_index;
    const pa = PRIORITY_ORDER[a.priority] ?? 1;
    const pb = PRIORITY_ORDER[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return a.due_date.localeCompare(b.due_date);
  });
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function TaskMetaRow({ task }: { task: Task }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink/55">
      <span className="inline-flex items-center gap-1">
        <CalendarDays className="h-3.5 w-3.5 text-ink/35" />
        {task.due_date}
      </span>
      <span className="inline-flex items-center gap-1">
        <Clock className="h-3.5 w-3.5 text-ink/35" />
        {task.estimated_hours}h
      </span>
      {task.dependency_ids.length > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5">
          <GitBranch className="h-3 w-3" />
          {task.dependency_ids.length} 个依赖
        </span>
      )}
      {task.can_cut && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
          <Scissors className="h-3 w-3" />
          可砍
        </span>
      )}
      {task.status === "blocked" && (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-red-600">
          <AlertTriangle className="h-3 w-3" />
          受阻
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

type TaskBreakdownBoardProps = {
  stages: Stage[];
  tasks: Task[];
  pendingProposal?: AgentProposal | null;
};

export function TaskBreakdownBoard({ stages, tasks, pendingProposal }: TaskBreakdownBoardProps) {
  // Split stages: active/pending vs completed (old plans)
  const activeStages = stages.filter((s) => s.status !== "completed");
  const completedStages = stages.filter((s) => s.status === "completed");
  const [showCompleted, setShowCompleted] = useState(false);

  const stageById = new Map(stages.map((s) => [s.id, s]));
  const taskTitleById = new Map(tasks.map((t) => [t.id, t.title]));
  const sortedTasks = sortTasks(tasks);

  const pendingTasks = pendingProposal && pendingProposal.status === "pending"
    ? parsePendingTasks(pendingProposal)
    : [];
  const hasPending = pendingTasks.length > 0;

  // Group confirmed tasks by stage
  const tasksByStage = new Map<string, Task[]>();
  for (const task of sortedTasks) {
    const list = tasksByStage.get(task.stage_id) || [];
    list.push(task);
    tasksByStage.set(task.stage_id, list);
  }

  // Build ordered stage entries from active stages only
  const stageEntries: { stage: Stage | null; tasks: Task[] }[] = [];
  const seenStageIds = new Set<string>();

  for (const stage of activeStages) {
    const stageTasks = tasksByStage.get(stage.id) || [];
    stageEntries.push({ stage, tasks: stageTasks });
    seenStageIds.add(stage.id);
  }

  // Build completed stage entries (including tasks from those stages)
  const completedStageEntries: { stage: Stage; tasks: Task[] }[] = [];
  for (const stage of completedStages) {
    const stageTasks = tasksByStage.get(stage.id) || [];
    completedStageEntries.push({ stage, tasks: stageTasks });
  }

  // Tasks whose stage_id doesn't match any known stage — append as a generic completed group
  const orphanTasks: Task[] = [];
  for (const [stageId, tasks] of tasksByStage) {
    if (!seenStageIds.has(stageId) && !completedStages.some((s) => s.id === stageId)) {
      orphanTasks.push(...tasks);
    }
  }

  /* ---- empty state ---- */
  if (sortedTasks.length === 0 && !hasPending) {
    return (
      <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <div>
          <h2 className="text-lg font-bold text-ink">任务拆解</h2>
          <p className="mt-1 text-sm text-ink/60">持续展示优先级、依赖、截止时间和可砍/延期信号。</p>
        </div>
        <div className="mt-5 rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
          暂无任务。阶段计划确认后运行任务拆解。
        </div>
      </section>
    );
  }

  /* ---- main ---- */
  return (
    <section className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-6 py-4">
        <div>
          <h2 className="text-lg font-bold text-ink">任务拆解</h2>
          <p className="mt-0.5 text-sm text-ink/55">
            {sortedTasks.length} 个任务 · {stageEntries.filter((e) => e.tasks.length > 0).length} 个活跃阶段
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasPending && (
            <Badge className="bg-citron/35 text-ink">含 {pendingTasks.length} 个待确认</Badge>
          )}
        </div>
      </div>

      {/* Pending proposal preview */}
      {hasPending && (
        <div className="border-b border-citron/30 bg-citron/5 px-6 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink/75">
            <Clock className="h-4 w-4 text-amber-500" />
            待确认的任务提案
          </div>
          <p className="mt-0.5 text-xs text-ink/50">
            以下任务尚未确认应用，请到项目总览中确认
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {pendingTasks.map((task, i) => (
              <div key={i} className="rounded-lg border border-citron/25 bg-white/80 p-3 opacity-90">
                <div className="flex items-center gap-2">
                  <Badge className={priorityClass(task.priority as Task["priority"])}>
                    {task.priority}
                  </Badge>
                  <span className="text-sm font-semibold text-ink">{task.title}</span>
                </div>
                {task.description && (
                  <div className="mt-1 text-xs text-ink/55 line-clamp-2">
                    <MultilineText text={task.description} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stage groups */}
      <div className="divide-y divide-neutral-100">
        {stageEntries.map(({ stage, tasks: stageTasks }, groupIdx) => {
          const meta = stage ? stageStatusMeta(stage.status) : { label: "未知阶段", dot: "bg-neutral-300", border: "border-neutral-200", bg: "bg-neutral-50/30", text: "text-neutral-500" };
          const doneCount = stageTasks.filter((t) => t.status === "done").length;
          const p0Count = stageTasks.filter((t) => t.priority === "P0" && t.status !== "done").length;

          return (
            <div key={stage?.id ?? `orphan-${groupIdx}`} className={meta.bg}>
              {/* Stage header */}
              <div className="flex flex-wrap items-center gap-3 px-6 py-3">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {/* Dot indicator */}
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`} />
                  <h3 className={`text-base font-bold ${stage ? "text-ink" : meta.text}`}>
                    {stage?.name ?? "未分配阶段"}
                  </h3>
                  <Badge className={`border-0 text-[10px] ${stage ? meta.border + " " + meta.bg + " " + meta.text : ""}`}>
                    {meta.label}
                  </Badge>
                  {stageTasks.length > 0 && (
                    <>
                      <ChevronRight className="h-3.5 w-3.5 text-neutral-300" />
                      <span className="text-xs tabular-nums text-ink/50">
                        {stageTasks.length} 个任务
                        {doneCount > 0 && (
                          <span className="ml-1 text-emerald-600">· {doneCount} 完成</span>
                        )}
                        {p0Count > 0 && (
                          <span className="ml-1 text-coral">· {p0Count} P0</span>
                        )}
                      </span>
                    </>
                  )}
                </div>

                {/* Stage progress pill */}
                {stageTasks.length > 0 && (
                  <div className="flex items-center gap-1.5 rounded-full bg-white/80 px-3 py-1 text-xs text-ink/55 shadow-sm">
                    {doneCount === stageTasks.length ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <Circle className="h-3.5 w-3.5 text-ink/25" />
                    )}
                    <span className="tabular-nums font-medium text-ink/70">
                      {doneCount}/{stageTasks.length}
                    </span>
                  </div>
                )}
              </div>

              {/* Tasks */}
              {stageTasks.length > 0 && (
                <div className="px-6 pb-4">
                  <div className="grid gap-2">
                    {stageTasks.map((task) => {
                      const dependencies = task.dependency_ids
                        .map((id) => taskTitleById.get(id))
                        .filter(Boolean) as string[];

                      return (
                        <article
                          key={task.id}
                          className="group rounded-lg border border-ink/10 bg-white p-3.5 transition-shadow hover:shadow-sm"
                        >
                          <div className="flex flex-wrap items-start gap-3">
                            {/* Priority + status badges */}
                            <div className="flex items-center gap-1.5 shrink-0">
                              <Badge className={`text-[10px] ${priorityClass(task.priority)}`}>
                                {task.priority}
                              </Badge>
                              <Badge className={`text-[10px] ${statusClass(task.status)}`}>
                                {statusLabel(task.status)}
                              </Badge>
                            </div>

                            {/* Content */}
                            <div className="min-w-0 flex-1">
                              <h4 className="text-sm font-semibold text-ink leading-snug">{task.title}</h4>
                              {task.description && (
                                <div className="mt-0.5 text-xs text-ink/55 line-clamp-2 leading-relaxed">
                                  <MultilineText text={task.description} />
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Meta row */}
                          <TaskMetaRow task={task} />

                          {/* Dependencies detail (expandable feel — always collapsed) */}
                          {dependencies.length > 0 && (
                            <p className="mt-1.5 text-[11px] text-ink/40">
                              依赖任务：{dependencies.join("、")}
                            </p>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Empty stage — subtle hint */}
              {stageTasks.length === 0 && (
                <div className="px-6 pb-4">
                  <div className="rounded-md border border-dashed border-neutral-200 bg-white/60 px-4 py-3 text-xs text-neutral-400">
                    此阶段尚无任务。运行任务拆解或手动添加任务。
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Completed stages — historical record, collapsed by default */}
      {completedStageEntries.length > 0 && (
        <div className="border-t border-neutral-100 px-6 py-3">
          <button
            type="button"
            onClick={() => setShowCompleted(!showCompleted)}
            className="flex w-full items-center justify-between text-sm text-ink/50 hover:text-ink/70"
          >
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-moss/60" />
              已完成的阶段（{completedStageEntries.length} 个）— 已被新计划替换
            </span>
            {showCompleted ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showCompleted && (
            <div className="mt-2 space-y-3">
              {completedStageEntries.map((entry) => (
                <div key={entry.stage.id} className="rounded-md bg-white border border-neutral-100 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={cn("inline-block h-2 w-2 rounded-full", stageStatusMeta("completed").dot)} />
                    <span className="text-sm font-medium text-neutral-500">{entry.stage.name}</span>
                    <Badge className="bg-ink/10 text-ink/60 text-[10px]">已完成</Badge>
                    <span className="text-xs text-neutral-400">
                      {entry.stage.start_date} → {entry.stage.end_date} · {entry.tasks.length} 个任务
                    </span>
                  </div>
                  {entry.stage.goal && (
                    <MultilineText text={entry.stage.goal} className="mt-1 ml-4 text-xs text-neutral-400" />
                  )}
                  {entry.tasks.length > 0 && (
                    <div className="mt-2 ml-4 space-y-1 border-l-2 border-neutral-100 pl-3">
                      {entry.tasks.map((task) => (
                        <div key={task.id} className="flex items-center gap-2 text-xs">
                          <Badge className={cn("text-[10px] px-1.5 py-0", priorityClass(task.priority))}>
                            {task.priority}
                          </Badge>
                          <span className="text-neutral-500">{task.title}</span>
                          <span className="text-neutral-400">
                            {statusLabel(task.status)} · {task.estimated_hours}h
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Orphan tasks — tasks whose stage no longer exists */}
      {orphanTasks.length > 0 && (
        <div className="border-t border-amber-200 bg-amber-50/30 px-6 py-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-semibold text-amber-800">未关联阶段的任务（{orphanTasks.length} 个）</span>
          </div>
          <div className="grid gap-2">
            {orphanTasks.map((task) => {
              const dependencies = task.dependency_ids
                .map((id) => taskTitleById.get(id))
                .filter(Boolean) as string[];
              return (
                <article
                  key={task.id}
                  className="group rounded-lg border border-amber-200 bg-white p-3.5 transition-shadow hover:shadow-sm"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge className={`text-[10px] ${priorityClass(task.priority)}`}>
                        {task.priority}
                      </Badge>
                      <Badge className={`text-[10px] ${statusClass(task.status)}`}>
                        {statusLabel(task.status)}
                      </Badge>
                    </div>
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-semibold text-ink leading-snug">{task.title}</h4>
                      {task.description && (
                        <div className="mt-0.5 text-xs text-ink/55 line-clamp-2 leading-relaxed">
                          <MultilineText text={task.description} />
                        </div>
                      )}
                    </div>
                  </div>
                  <TaskMetaRow task={task} />
                  {dependencies.length > 0 && (
                    <p className="mt-1.5 text-[11px] text-ink/40">
                      依赖任务：{dependencies.join("、")}
                    </p>
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

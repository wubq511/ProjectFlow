"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpDown,
  CheckCircle2,
  ChevronRight,
  Filter,
  FolderKanban,
  ListTodo,
  MoreHorizontal,
  OctagonAlert,
  Play,
  UserCircle,
  XCircle,
} from "lucide-react";

import { AssignmentFlowPanel } from "@/components/assignment/assignment-flow-panel";
import { CheckInForm } from "@/components/checkin/checkin-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { TaskStatusUpdateList } from "@/components/task/task-status-update";
import { cn } from "@/lib/utils";
import type { ProjectState, Task } from "@/lib/types";
import type { AgentAction } from "./project-actions";

function cleanJsonString(text: string) {
  if (!text) return text;
  // Replace raw dictionary strings like {'name': '产品设计', 'level': 3} with just the name
  return text.replace(/\{['"]name['"]:\s*['"]([^'"]+)['"][^}]*\}/g, '$1');
}

function MatchText({ label, text }: { label: string; text: string }) {
  let cleanedText = cleanJsonString(text);
  
  // Strip duplicate label prefix if it exists
  const labelWithoutColon = label.replace(/[：:]$/, '');
  const prefixRegex = new RegExp(`^${labelWithoutColon}[：:]\s*`);
  if (prefixRegex.test(cleanedText)) {
    cleanedText = cleanedText.replace(prefixRegex, '');
  }

  return (
    <p>
      <span className="font-semibold text-ink/70">{label}</span> {cleanedText}
    </p>
  );
}

type AssignmentResponseHandler = (
  proposalId: string,
  userId: string,
  response: "accept" | "reject",
  preferredTaskId?: string,
  reason?: string
) => void;

type NegotiationHandler = (
  proposalId: string,
  fromUserId: string,
  desiredTaskId: string
) => void;

type CheckinHandler = (data: {
  user_id: string;
  task_id?: string;
  what_done: string;
  blocker?: string;
  available_hours_next_cycle?: number;
  mood_or_confidence?: "low" | "medium" | "high";
}) => void;

type TaskStatusHandler = (data: {
  task_id: string;
  user_id: string;
  status: "not_started" | "in_progress" | "done" | "blocked";
  progress_note?: string;
  blocker?: string;
  available_hours_change?: number;
}) => void;

export function MyTasksView({
  tasks,
  currentUserId,
  proposals,
  pendingAction,
  onRespondToAssignment,
  onSubmitCheckin,
  onUpdateTaskStatus,
}: {
  tasks: Task[];
  currentUserId?: string;
  proposals: ProjectState["assignment_proposals"];
  pendingAction?: AgentAction | null;
  onRespondToAssignment?: AssignmentResponseHandler;
  onSubmitCheckin?: CheckinHandler;
  onUpdateTaskStatus?: TaskStatusHandler;
}) {
  const myPending = tasks.filter(
    (t) => t.owner_user_id === currentUserId && t.status !== "done"
  );
  const myDone = tasks.filter(
    (t) => t.owner_user_id === currentUserId && t.status === "done"
  );
  const myProposals = proposals.filter(
    (p) => p.recommended_owner_user_id === currentUserId && p.status === "proposed"
  );

  const [showDone, setShowDone] = useState(false);
  const [showCheckinDialog, setShowCheckinDialog] = useState(false);
  const [showUpdateStatusDialog, setShowUpdateStatusDialog] = useState(false);
  const [selectedTaskIdForDialog, setSelectedTaskIdForDialog] = useState<string | null>(null);

  const handleCheckinClick = (taskId: string) => {
    setSelectedTaskIdForDialog(taskId);
    setShowCheckinDialog(true);
  };

  const handleUpdateStatusDetailsClick = (taskId: string) => {
    setSelectedTaskIdForDialog(taskId);
    setShowUpdateStatusDialog(true);
  };

  const selectedTaskForDialog = selectedTaskIdForDialog
    ? tasks.find((t) => t.id === selectedTaskIdForDialog)
    : undefined;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-neutral-100">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">
              待处理
              <span className="ml-2 text-sm font-normal text-neutral-400">
                {myPending.length}
              </span>
            </h2>
          </div>
        </div>

        {myPending.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-8 w-8 text-moss/60" />}
            title="暂无待处理任务"
            description="当前没有分配给你的未完成任务。"
          />
        ) : (
          <div className="divide-y divide-neutral-50">
            {myPending.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                showQuickActions
                onQuickUpdate={(status) =>
                  onUpdateTaskStatus?.({
                    task_id: task.id,
                    user_id: currentUserId!,
                    status,
                  })
                }
                onCheckinClick={handleCheckinClick}
                onUpdateStatusDetailsClick={handleUpdateStatusDetailsClick}
              />
            ))}
          </div>
        )}
      </section>

      <AnimatePresence>
        {myProposals.length > 0 && (
          <motion.section
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-xl border border-primary/20 bg-primary/5 p-5"
          >
            <h2 className="text-base font-semibold text-ink">待确认分工</h2>
            <div className="mt-3 space-y-3">
              {myProposals.map((proposal) => (
                <div
                  key={proposal.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-white p-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-900">
                      {tasks.find((t) => t.id === proposal.task_id)?.title}
                    </p>
                    <p className="text-xs text-neutral-500 mt-0.5">
                      {cleanJsonString(proposal.reason)}
                    </p>
                    {(proposal.skill_match || proposal.availability_match || proposal.preference_match || proposal.constraint_respected) && (
                      <div className="mt-2 grid gap-1 text-xs text-ink/55">
                        {proposal.skill_match && <MatchText label="技能匹配：" text={proposal.skill_match} />}
                        {proposal.availability_match && <MatchText label="时间匹配：" text={proposal.availability_match} />}
                        {proposal.preference_match && <MatchText label="偏好匹配：" text={proposal.preference_match} />}
                        {proposal.constraint_respected && <MatchText label="限制检查：" text={proposal.constraint_respected} />}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs rounded-full bg-ink text-white hover:bg-ink/85 transition-colors"
                      onClick={() =>
                        onRespondToAssignment?.(
                          proposal.id,
                          currentUserId!,
                          "accept"
                        )
                      }
                    >
                      <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                      接受
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-3 text-xs rounded-full text-ink/60 hover:text-ink/90 hover:bg-ink/5 transition-colors"
                      onClick={() =>
                        onRespondToAssignment?.(
                          proposal.id,
                          currentUserId!,
                          "reject"
                        )
                      }
                    >
                      <XCircle className="mr-1.5 h-3.5 w-3.5" />
                      拒绝
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {myDone.length > 0 && (
        <section>
          <button
            onClick={() => setShowDone(!showDone)}
            className="flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-700 transition-colors"
          >
            <CheckCircle2 className="h-4 w-4" />
            已完成 {myDone.length} 个任务
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                showDone && "rotate-90"
              )}
            />
          </button>
          <AnimatePresence initial={false}>
            {showDone && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="mt-2 rounded-xl border border-neutral-200 bg-white overflow-hidden"
              >
                <div className="divide-y divide-neutral-50">
                  {myDone.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onUpdateStatusDetailsClick={handleUpdateStatusDetailsClick}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}

      <Dialog open={showCheckinDialog} onOpenChange={setShowCheckinDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>签到</DialogTitle>
            <DialogDescription>
              记录你在任务上的进展和遇到的问题。
            </DialogDescription>
          </DialogHeader>
          {selectedTaskForDialog && currentUserId && onSubmitCheckin && (
            <CheckInForm
              key={selectedTaskForDialog.id}
              tasks={[selectedTaskForDialog]}
              userId={currentUserId}
              onSubmit={onSubmitCheckin}
              pending={Boolean(pendingAction)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showUpdateStatusDialog} onOpenChange={setShowUpdateStatusDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>更新任务状态</DialogTitle>
            <DialogDescription>
              详细更新任务的进度、阻塞情况等。
            </DialogDescription>
          </DialogHeader>
          {selectedTaskForDialog && currentUserId && onUpdateTaskStatus && (
            <TaskStatusUpdateList
              key={selectedTaskForDialog.id}
              tasks={[selectedTaskForDialog]}
              userId={currentUserId}
              onUpdate={onUpdateTaskStatus}
              pending={Boolean(pendingAction)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type TeamTasksViewProps = {
  tasks: Task[];
  stages: ProjectState["stages"];
  members: ProjectState["members"];
  proposals: ProjectState["assignment_proposals"];
  negotiations: ProjectState["assignment_negotiations"];
  pendingAction?: AgentAction | null;
  currentUserId?: string;
  onRespondToAssignment?: AssignmentResponseHandler;
  onStartNegotiation?: NegotiationHandler;
  onFinalizeAssignments?: (stageId: string) => void;
};

export function TeamTasksView({
  tasks,
  stages,
  members,
  proposals,
  negotiations,
  pendingAction,
  onRespondToAssignment,
  onStartNegotiation,
  onFinalizeAssignments,
}: TeamTasksViewProps) {
  const [filterStatus, setFilterStatus] = useState<Task["status"] | "all">("all");
  const [filterStage, setFilterStage] = useState<string>("all");
  const [groupBy, setGroupBy] = useState<"none" | "stage" | "owner">("stage");

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (filterStatus !== "all" && t.status !== filterStatus) return false;
      if (filterStage !== "all" && t.stage_id !== filterStage) return false;
      return true;
    });
  }, [tasks, filterStatus, filterStage]);

  const grouped = useMemo(() => {
    if (groupBy === "none") return [{ key: "全部任务", items: filtered }];
    if (groupBy === "stage") {
      const map = new Map<string, Task[]>();
      stages.forEach((s) => map.set(s.id, []));
      map.set("未分配", []);
      filtered.forEach((t) => {
        const key = stages.find((s) => s.id === t.stage_id)?.id ?? "未分配";
        const arr = map.get(key) ?? [];
        arr.push(t);
        map.set(key, arr);
      });
      return stages
        .map((s) => ({ key: s.name, items: map.get(s.id) ?? [] }))
        .filter((g) => g.items.length > 0);
    }

    const map = new Map<string, Task[]>();
    map.set("未分配", []);
    filtered.forEach((t) => {
      const owner = members.find((m) => m.user_id === t.owner_user_id);
      const key = owner?.display_name ?? "未分配";
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    });
    return Array.from(map.entries())
      .map(([key, items]) => ({ key, items }))
      .filter((g) => g.items.length > 0);
  }, [filtered, groupBy, stages, members]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 text-neutral-400" />
          <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as Task["status"] | "all")}>
            <SelectTrigger className="h-9 w-36 text-sm">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="not_started">待开始</SelectItem>
              <SelectItem value="in_progress">进行中</SelectItem>
              <SelectItem value="blocked">阻塞</SelectItem>
              <SelectItem value="done">已完成</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <FolderKanban className="h-3.5 w-3.5 text-neutral-400" />
          <Select value={filterStage} onValueChange={(v) => setFilterStage(v ?? "all")}>
            <SelectTrigger className="h-9 w-36 text-sm">
              <SelectValue placeholder="全部阶段" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部阶段</SelectItem>
              {stages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <ArrowUpDown className="h-3.5 w-3.5 text-neutral-400" />
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as "none" | "stage" | "owner")}>
            <SelectTrigger className="h-9 w-36 text-sm">
              <SelectValue placeholder="按阶段分组" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stage">按阶段分组</SelectItem>
              <SelectItem value="owner">按负责人分组</SelectItem>
              <SelectItem value="none">不分组</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {(filterStatus !== "all" || filterStage !== "all" || groupBy !== "stage") && (
          <button
            onClick={() => {
              setFilterStatus("all");
              setFilterStage("all");
              setGroupBy("stage");
            }}
            className="text-xs text-primary hover:text-primary/80 transition-colors"
          >
            清除筛选
          </button>
        )}

        <span className="ml-auto text-xs text-neutral-400">
          共 {filtered.length} 个任务
        </span>
      </div>

      {grouped.map((group) => (
        <section key={group.key} className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
          <div className="px-5 py-3 border-b border-neutral-100 bg-neutral-50/50">
            <h3 className="text-sm font-semibold text-neutral-700">{group.key}</h3>
          </div>
          <div className="divide-y divide-neutral-50">
            {group.items.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                members={members}
                showOwner
              />
            ))}
          </div>
        </section>
      ))}

      {filtered.length === 0 && (
        <EmptyState
          icon={<ListTodo className="h-8 w-8 text-neutral-300" />}
          title="没有匹配的任务"
          description="尝试调整筛选条件或等待任务分配。"
        />
      )}

      <AssignmentFlowPanel
        proposals={proposals}
        negotiations={negotiations}
        stages={stages}
        tasks={tasks}
        members={members}
        pending={Boolean(pendingAction)}
        onRespondToAssignment={onRespondToAssignment}
        onStartNegotiation={onStartNegotiation}
        onFinalizeAssignments={onFinalizeAssignments}
      />
    </div>
  );
}

function TaskRow({
  task,
  members,
  showOwner = false,
  showQuickActions = false,
  onQuickUpdate,
  onCheckinClick,
  onUpdateStatusDetailsClick,
}: {
  task: Task;
  members?: ProjectState["members"];
  showOwner?: boolean;
  showQuickActions?: boolean;
  onQuickUpdate?: (status: Task["status"]) => void;
  onCheckinClick?: (taskId: string) => void;
  onUpdateStatusDetailsClick?: (taskId: string) => void;
}) {
  const [updating, setUpdating] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<Task["status"] | null>(null);

  const displayStatus = optimisticStatus ?? task.status;

  const priorityConfig = {
    P0: { color: "bg-red-500", label: "P0" },
    P1: { color: "bg-orange-500", label: "P1" },
    P2: { color: "bg-gray-300", label: "P2" },
  };

  const statusConfig = {
    not_started: { label: "待开始", color: "text-neutral-500" },
    in_progress: { label: "进行中", color: "text-primary" },
    blocked: { label: "阻塞", color: "text-coral" },
    done: { label: "已完成", color: "text-moss" },
  };

  const ownerName = members?.find((m) => m.user_id === task.owner_user_id)?.display_name;

  const handleQuickUpdate = async (status: Task["status"]) => {
    if (updating) return;
    setUpdating(true);
    setOptimisticStatus(status);
    try {
      await onQuickUpdate?.(status);
    } catch {
      setOptimisticStatus(null);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div
      className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <span
        className={cn("h-2 w-2 rounded-full shrink-0", priorityConfig[task.priority].color)}
        aria-label={`优先级 ${priorityConfig[task.priority].label}`}
        title={`优先级 ${priorityConfig[task.priority].label}`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={cn("text-sm font-medium truncate", displayStatus === "done" && "line-through text-neutral-400")}>
            {task.title}
          </p>
          <Badge variant="outline" className={cn("text-xs shrink-0", statusConfig[displayStatus].color)}>
            {statusConfig[displayStatus].label}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
          <span className="text-xs text-neutral-400">
            预计 {task.estimated_hours}h · 截止 {task.due_date}
          </span>
          {showOwner && ownerName && (
            <span className="inline-flex items-center gap-1 text-xs text-neutral-500">
              <UserCircle className="h-3 w-3" />
              {ownerName}
            </span>
          )}
        </div>
      </div>

      {showQuickActions && displayStatus !== "done" && (
        <div
          className="flex items-center gap-1 shrink-0"
        >
          {displayStatus !== "in_progress" && (
            <button
              onClick={() => handleQuickUpdate("in_progress")}
              disabled={updating}
              className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
              title="标记进行中"
            >
              <Play className="h-3 w-3" />
              开始
            </button>
          )}
          <button
            onClick={() => handleQuickUpdate("done")}
            disabled={updating}
            className="flex items-center gap-1 rounded-md bg-moss/10 px-2 py-1 text-xs font-medium text-moss hover:bg-moss/20 transition-colors disabled:opacity-50"
            title="标记完成"
          >
            <CheckCircle2 className="h-3 w-3" />
            完成
          </button>
          {displayStatus !== "blocked" && (
            <button
              onClick={() => handleQuickUpdate("blocked")}
              disabled={updating}
              className="flex items-center gap-1 rounded-md bg-coral/10 px-2 py-1 text-xs font-medium text-coral hover:bg-coral/20 transition-colors disabled:opacity-50"
              title="标记阻塞"
            >
              <OctagonAlert className="h-3 w-3" />
              阻塞
            </button>
          )}
        </div>
      )}

      {(onCheckinClick || onUpdateStatusDetailsClick) && (
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-neutral-100 text-neutral-500 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20">
            <span className="sr-only">打开菜单</span>
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onCheckinClick && (
              <DropdownMenuItem onClick={() => onCheckinClick(task.id)}>
                签到
              </DropdownMenuItem>
            )}
            {onUpdateStatusDetailsClick && (
              <DropdownMenuItem onClick={() => onUpdateStatusDetailsClick(task.id)}>
                更新任务状态
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-5 text-center">
      <div className="mb-3">{icon}</div>
      <p className="text-sm font-medium text-neutral-700">{title}</p>
      <p className="mt-1 text-xs text-neutral-400 max-w-xs">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

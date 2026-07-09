"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Task } from "@/lib/types";

type TaskStatusUpdateProps = {
  task: Task;
  onUpdate: (data: {
    task_id: string;
    user_id: string;
    status: "not_started" | "in_progress" | "done" | "blocked";
    progress_note?: string;
    blocker?: string;
  }) => void | Promise<void>;
  userId: string;
  pending?: boolean;
};

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

export function TaskStatusUpdate({ task, onUpdate, userId, pending }: TaskStatusUpdateProps) {
  const [status, setStatus] = useState<Task["status"]>(task.status);
  const [progressNote, setProgressNote] = useState("");
  const [blocker, setBlocker] = useState("");
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUpdate = async () => {
    setError(null);
    setSuccess(false);

    try {
      await onUpdate({
        task_id: task.id,
        user_id: userId,
        status,
        progress_note: progressNote.trim() || undefined,
        blocker: status === "blocked" ? blocker.trim() || undefined : undefined,
      });
      setSuccess(true);
      setProgressNote("");
      setBlocker("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失败");
    }
  };

  return (
    <div className="rounded-lg border border-ink/10 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-ink">{task.title}</h3>
        <Badge className={statusClass(task.status)}>{statusLabel(task.status)}</Badge>
      </div>

      <div className="mt-4 grid gap-4">
        <div className="space-y-2">
          <Label htmlFor={`status-${task.id}`}>状态</Label>
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as Task["status"])}
          >
            <SelectTrigger id={`status-${task.id}`}>
              <span className="truncate text-sm">{statusLabel(status)}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="not_started">未开始</SelectItem>
              <SelectItem value="in_progress">进行中</SelectItem>
              <SelectItem value="done">已完成</SelectItem>
              <SelectItem value="blocked">受阻</SelectItem>
              <SelectItem value="cancelled">已取消</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`note-${task.id}`}>进展说明</Label>
          <Textarea
            id={`note-${task.id}`}
            value={progressNote}
            onChange={(e) => setProgressNote(e.target.value)}
            placeholder="本次有哪些进展？（可选）"
            rows={2}
          />
        </div>

        {status === "blocked" && (
          <div className="space-y-2">
            <Label htmlFor={`blocker-${task.id}`}>阻塞原因</Label>
            <Textarea
              id={`blocker-${task.id}`}
              value={blocker}
              onChange={(e) => setBlocker(e.target.value)}
              placeholder="当前卡在哪里？"
              rows={2}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-coral/20 bg-coral/10 p-3 text-sm text-coral">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <p>{error}</p>
        </div>
      )}

      {success && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-moss/20 bg-moss/10 p-3 text-sm text-moss">
          <CheckCircle2 className="mt-0.5 h-4 w-4" />
          <p>状态已更新。</p>
        </div>
      )}

      <div className="mt-4">
        <Button
          disabled={pending || status === task.status}
          onClick={handleUpdate}
          className="bg-ink text-white hover:bg-ink/85"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {pending ? "更新中..." : "更新状态"}
        </Button>
      </div>
    </div>
  );
}

type TaskStatusUpdateListProps = {
  tasks: Task[];
  userId: string;
  onUpdate: TaskStatusUpdateProps["onUpdate"];
  pending?: boolean;
};

export function TaskStatusUpdateList({ tasks, userId, onUpdate, pending }: TaskStatusUpdateListProps) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink/15 bg-paper/70 p-6 text-sm text-ink/55">
        暂无可更新的任务。
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {tasks.map((task) => (
        <TaskStatusUpdate
          key={task.id}
          task={task}
          userId={userId}
          onUpdate={onUpdate}
          pending={pending}
        />
      ))}
    </div>
  );
}

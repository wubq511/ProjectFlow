"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Task } from "@/lib/types";

type CheckInFormProps = {
  tasks: Task[];
  userId: string;
  onSubmit: (data: {
    user_id: string;
    task_id?: string;
    what_done: string;
    blocker?: string;
    available_hours_next_cycle?: number;
    mood_or_confidence?: "low" | "medium" | "high";
  }) => void | Promise<void>;
  pending?: boolean;
};

export function CheckInForm({ tasks, userId, onSubmit, pending }: CheckInFormProps) {
  const [whatDone, setWhatDone] = useState("");
  const [blocker, setBlocker] = useState("");
  const [availableHours, setAvailableHours] = useState("");
  const [mood, setMood] = useState<"low" | "medium" | "high" | "">("");
  const [taskId, setTaskId] = useState("");
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userTasks = tasks.filter(
    (task) => task.owner_user_id === userId && task.status !== "done"
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (!whatDone.trim()) {
      setError("请描述你完成了什么。");
      return;
    }

    try {
      await onSubmit({
        user_id: userId,
        task_id: taskId || undefined,
        what_done: whatDone.trim(),
        blocker: blocker.trim() || undefined,
        available_hours_next_cycle: availableHours ? Number(availableHours) : undefined,
        mood_or_confidence: mood || undefined,
      });
      setSuccess(true);
      setWhatDone("");
      setBlocker("");
      setAvailableHours("");
      setMood("");
      setTaskId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-ink/10 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-bold text-ink">签到</h2>
        <p className="mt-1 text-sm text-ink/60">
          汇报进度、阻塞和下一周期可用时间
        </p>
      </div>

      <div className="mt-5 grid gap-4">
        {userTasks.length > 0 && (
          <div className="space-y-2">
            <Label htmlFor="checkin-task">关联任务</Label>
            <Select value={taskId} onValueChange={(v) => setTaskId(v ?? "")}>
              <SelectTrigger id="checkin-task">
                <SelectValue placeholder="选择任务（可选）" />
              </SelectTrigger>
              <SelectContent>
                {userTasks.map((task) => (
                  <SelectItem key={task.id} value={task.id}>
                    {task.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="what-done">完成了什么？</Label>
          <Textarea
            id="what-done"
            value={whatDone}
            onChange={(e) => setWhatDone(e.target.value)}
            placeholder="描述你完成或正在做的工作..."
            rows={3}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="blocker">有阻塞吗？</Label>
          <Textarea
            id="blocker"
            value={blocker}
            onChange={(e) => setBlocker(e.target.value)}
            placeholder="什么在拖慢你的进度？（可选）"
            rows={2}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="available-hours">下一周期可用时间（小时）</Label>
            <Input
              id="available-hours"
              type="number"
              min={0}
              max={168}
              value={availableHours}
              onChange={(e) => setAvailableHours(e.target.value)}
              placeholder="如 10"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mood">信心水平</Label>
            <Select value={mood} onValueChange={(v) => setMood(v as "low" | "medium" | "high" | "")}>
              <SelectTrigger id="mood">
                <SelectValue placeholder="选择信心水平（可选）" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">低</SelectItem>
                <SelectItem value="medium">中</SelectItem>
                <SelectItem value="high">高</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
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
          <p>签到提交成功。</p>
        </div>
      )}

      <div className="mt-5">
        <Button
          type="submit"
          disabled={pending || !whatDone.trim()}
          className="bg-ink text-white hover:bg-ink/85"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {pending ? "提交中..." : "提交签到"}
        </Button>
      </div>
    </form>
  );
}

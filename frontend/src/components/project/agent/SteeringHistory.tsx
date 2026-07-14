"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, MessageSquareText } from "lucide-react";

export interface SteeringEvent {
  steering_seq: number;
  steering_type: string;
  content: string;
  created_at: string;
  consumed: boolean;
}

interface SteeringHistoryProps {
  events: SteeringEvent[];
}

const STEERING_LABELS: Record<string, string> = {
  constraint: "约束",
  correction: "纠正",
  plan_change: "调整计划",
  clarification_answer: "回答",
  approval_response: "审批",
  cancel: "取消",
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function SteeringHistory({ events }: SteeringHistoryProps) {
  if (events.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 p-3">
        <p className="flex items-center gap-1.5 text-xs text-neutral-500">
          <MessageSquareText className="h-3.5 w-3.5" />
          暂无追加约束或纠正
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-neutral-700">
        <MessageSquareText className="h-3.5 w-3.5" />
        追加约束 / 纠正
      </p>
      <ul className="space-y-2">
        {events.map((event) => {
          const label = STEERING_LABELS[event.steering_type] ?? event.steering_type;
          return (
            <li
              key={event.steering_seq}
              className={cn(
                "rounded-md border p-2 text-xs",
                event.consumed
                  ? "border-neutral-100 bg-neutral-50/60 text-neutral-600"
                  : "border-amber-200 bg-amber-50/40 text-amber-900",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <Badge
                  variant={event.consumed ? "secondary" : "outline"}
                  className={cn(
                    "h-5 px-1.5 text-[10px] font-normal",
                    !event.consumed && "border-amber-300 text-amber-800",
                  )}
                >
                  {label}
                </Badge>
                <span className="flex shrink-0 items-center gap-1 text-[10px] text-neutral-400">
                  {event.consumed ? (
                    <>
                      <CheckCircle2 className="h-3 w-3" />
                      已处理
                    </>
                  ) : (
                    <>
                      <Clock className="h-3 w-3" />
                      待处理
                    </>
                  )}
                </span>
              </div>
              <p className="mt-1.5 leading-relaxed">{event.content}</p>
              {formatTime(event.created_at) && (
                <p className="mt-1 text-[10px] text-neutral-400">{formatTime(event.created_at)}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

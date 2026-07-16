"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import type { RunActivityItem } from "@/lib/types";

interface RunActivityProps {
  activities: RunActivityItem[];
  durationMs?: number;
  isStreaming?: boolean;
}

export function RunActivity({ activities, durationMs, isStreaming = false }: RunActivityProps) {
  const [isOpen, setIsOpen] = useState(true);

  if (activities.length === 0) return null;

  const getActivityLabel = (item: RunActivityItem): string => {
    if (item.kind === "progress") {
      return item.content || "正在进行中";
    }
    if (item.kind === "steering") {
      return `用户插言: ${item.content}`;
    }
    return item.label;
  };

  const formatDuration = (ms?: number) => {
    if (ms === undefined || ms === null) return "";
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getEmojiIcon = (item: RunActivityItem): string => {
    switch (item.kind) {
      case "skill":
        return "🪄";
      case "tool":
        return "🔧";
      case "approval":
        return "🔒";
      case "steering":
        return "🧭";
      case "progress":
      default:
        return "⚙️";
    }
  };

  const getStatusIcon = (item: RunActivityItem) => {
    if (item.kind === "progress") {
      return <Loader2 className="h-3 w-3 animate-spin text-neutral-400" />;
    }
    switch (item.status) {
      case "running":
        return <Loader2 className="h-3 w-3 animate-spin text-neutral-400" />;
      case "completed":
        return <CheckCircle2 className="h-3.5 w-3.5 text-moss" />;
      case "failed":
        return <XCircle className="h-3.5 w-3.5 text-coral" />;
      case "blocked":
        return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
      default:
        return null;
    }
  };

  return (
    <div className="my-2.5">
      {/* Collapsible Trigger Header */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors py-1.5 focus:outline-none"
      >
        <span>{isStreaming ? "正在处理" : `已处理 ${formatDuration(durationMs) || "完成"}`}</span>
        {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
      </button>

      {/* Activities List (Transparent Flow) */}
      {isOpen && (
        <div className="pl-3 py-1 space-y-2 border-l border-neutral-100 dark:border-neutral-800 max-h-[300px] overflow-y-auto custom-scrollbar mt-1.5">
          {activities.map((item) => (
            <div
              key={item.id}
              className="flex items-start justify-between gap-3 text-xs"
            >
              <div className="flex items-start gap-2 min-w-0">
                <span className="mt-0.5 shrink-0 text-sm">{getEmojiIcon(item)}</span>
                <div className="min-w-0 text-neutral-600 dark:text-neutral-400">
                  <p className="text-xs leading-5">
                    {getActivityLabel(item)}
                  </p>
                  {item.kind === "progress" && item.content && (
                    <p className="mt-0.5 text-[10px] text-neutral-400 dark:text-neutral-500 font-mono break-all line-clamp-2">
                      {item.content}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 text-[10px] text-neutral-400">
                {("duration_ms" in item && (item as any).duration_ms) ? (
                  <span>{formatDuration((item as any).duration_ms)}</span>
                ) : null}
                <span className="shrink-0">{getStatusIcon(item)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

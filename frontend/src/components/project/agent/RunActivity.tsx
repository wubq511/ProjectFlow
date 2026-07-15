"use client";

import { useState } from "react";
import {
  Brain,
  Sparkles,
  Wrench,
  Lock,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Compass,
} from "lucide-react";
import { cn } from "@/lib/utils";
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

  const getIcon = (item: RunActivityItem) => {
    switch (item.kind) {
      case "skill":
        return <Sparkles className="h-3.5 w-3.5 text-indigo-500" />;
      case "tool":
        return <Wrench className="h-3.5 w-3.5 text-neutral-500" />;
      case "approval":
        return <Lock className="h-3.5 w-3.5 text-amber-500" />;
      case "steering":
        return <Compass className="h-3.5 w-3.5 text-emerald-500" />;
      case "progress":
      default:
        return <Brain className="h-3.5 w-3.5 text-blue-500 animate-pulse" />;
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
    <div className="my-2 overflow-hidden rounded-lg border border-neutral-100 bg-neutral-50/50 dark:border-neutral-800 dark:bg-neutral-900/50">
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100/50 dark:hover:bg-neutral-800/50 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Brain className="h-3.5 w-3.5 text-neutral-500" />
          <span>思考过程</span>
          {isStreaming ? (
            <span className="flex items-center gap-1">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neutral-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-neutral-500"></span>
              </span>
              <span className="text-[10px] text-neutral-400">运行中</span>
            </span>
          ) : (
            durationMs && <span className="text-[10px] text-neutral-400">({formatDuration(durationMs)})</span>
          )}
        </span>
        {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {/* Activities List */}
      {isOpen && (
        <div className="border-t border-neutral-100 dark:border-neutral-800 p-2.5 space-y-2 max-h-[250px] overflow-y-auto custom-scrollbar">
          {activities.map((item) => (
            <div
              key={item.id}
              className="flex items-start justify-between gap-3 text-xs"
            >
              <div className="flex items-start gap-2 min-w-0">
                <span className="mt-0.5 shrink-0">{getIcon(item)}</span>
                <div className="min-w-0">
                  <p className="font-medium text-neutral-700 dark:text-neutral-300 break-words leading-5">
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

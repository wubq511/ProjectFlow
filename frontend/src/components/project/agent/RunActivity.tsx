"use client";

import {
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Wrench,
  BookOpen,
  Shield,
} from "lucide-react";
import type { RunActivityItem } from "@/lib/types";

interface RunActivityProps {
  activities: RunActivityItem[];
  durationMs?: number;
  /** Whether the process phase is still streaming. */
  isStreaming?: boolean;
  /** Controlled expand state from reducer. */
  isExpanded?: boolean;
  /** Callback when user toggles expand/collapse. */
  onToggle?: () => void;
}

/**
 * Format duration in human-readable form.
 * Returns empty string for null/undefined or durations < 100ms
 * to avoid misleading "0.0s" display.
 */
function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || ms < 100) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Get the status icon for an activity item.
 * Uses Lucide linear icons — no emoji.
 * Progress items: only show spinner for the LAST progress item when actively
 * streaming (isStreaming). Historical progress items have no icon.
 */
function ActivityStatusIcon({ item, isStreaming, isCurrentProgress }: { item: RunActivityItem; isStreaming?: boolean; isCurrentProgress?: boolean }) {
  if (item.kind === "progress") {
    if (!isStreaming || !isCurrentProgress) return null;
    return <Loader2 className="h-3 w-3 animate-spin text-neutral-400" />;
  }

  const status = "status" in item ? item.status : undefined;

  switch (status) {
    case "running":
    case "loading":
      return <Loader2 className="h-3 w-3 animate-spin text-neutral-400" />;
    case "completed":
    case "loaded":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case "blocked":
      return <Shield className="h-3.5 w-3.5 text-amber-500" />;
    default:
      return null;
  }
}

/**
 * Get the kind icon for an activity item.
 */
function ActivityKindIcon({ kind }: { kind: RunActivityItem["kind"] }) {
  switch (kind) {
    case "skill":
      return <BookOpen className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" />;
    case "tool":
      return <Wrench className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" />;
    default:
      return null;
  }
}

/**
 * Check if the activity at index `i` is the last progress item AND
 * no tool/activity follows it. A tool after the last progress takes
 * over spinner responsibility, so the old progress should not spin.
 */
function isLastProgress(activities: RunActivityItem[], i: number): boolean {
  // Quick check: if any non-progress item exists after index i, this
  // progress is not the trailing one.
  for (let j = i + 1; j < activities.length; j++) {
    if (activities[j].kind !== "progress") return false;
  }
  // Also verify it's actually a progress item and the last one
  for (let j = activities.length - 1; j >= 0; j--) {
    if (activities[j].kind === "progress") return j === i;
  }
  return false;
}

export function RunActivity({
  activities,
  durationMs,
  isStreaming = false,
  isExpanded = true,
  onToggle,
}: RunActivityProps) {
  if (activities.length === 0) return null;

  const formattedDuration = formatDuration(durationMs);
  const summaryLabel = isStreaming
    ? "正在处理"
    : formattedDuration
      ? `已处理 ${formattedDuration}`
      : "已处理";

  const contentId = `run-activity-content-${activities[0]?.id ?? "empty"}`;

  return (
    <div className="my-2">
      {/* Collapsible Trigger Header */}
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors py-1 focus:outline-none"
        aria-expanded={isExpanded}
        aria-controls={contentId}
      >
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <span>{summaryLabel}</span>
      </button>

      {/* Activities List — normal document flow, no independent scroll */}
      {isExpanded && (
        <div id={contentId} className="pl-4 pt-1 space-y-1 border-l border-neutral-100 dark:border-neutral-800 mt-1">
          {activities.map((item, i) => (
            <ActivityRow
              key={item.id}
              item={item}
              isStreaming={isStreaming}
              isCurrentProgress={item.kind === "progress" && isLastProgress(activities, i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ item, isStreaming, isCurrentProgress }: { item: RunActivityItem; isStreaming?: boolean; isCurrentProgress?: boolean }) {
  const label = getActivityLabel(item);
  const duration = "duration_ms" in item ? (item as { duration_ms?: number }).duration_ms : undefined;
  const formattedDuration = formatDuration(duration);

  // Progress items: normal text style, with spinner only for the last progress when streaming
  if (item.kind === "progress") {
    return (
      <div className="flex items-start gap-1.5 py-0.5">
        {isStreaming && isCurrentProgress && (
          <Loader2 className="h-3 w-3 animate-spin text-neutral-400 mt-0.5 shrink-0" />
        )}
        <p className="text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-400">
          {label}
        </p>
      </div>
    );
  }

  // Skill/Tool items: smaller, muted, with kind icon
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-neutral-500 dark:text-neutral-400">
      <ActivityKindIcon kind={item.kind} />
      <span className="shrink-0">
        <ActivityStatusIcon item={item} isStreaming={isStreaming} isCurrentProgress={isCurrentProgress} />
      </span>
      <span className="truncate">{label}</span>
      {formattedDuration && (
        <span className="ml-auto shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
          {formattedDuration}
        </span>
      )}
    </div>
  );
}

function getActivityLabel(item: RunActivityItem): string {
  switch (item.kind) {
    case "progress":
      return item.content || "处理中";
    case "skill":
      return item.label;
    case "tool":
      return item.label;
    case "approval":
      return item.label;
    case "steering":
      return `用户插言: ${item.content}`;
    default:
      return "处理中";
  }
}

"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { ChevronDown, Loader2, CheckCircle2, XCircle, Shield, BookOpen } from "lucide-react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import type { RunActivityItem } from "@/lib/types";
import { ProcessMarkdown } from "./ProcessMarkdown";
import { StreamingProcessText } from "./StreamingProcessText";

interface RunActivityProps {
  activities: RunActivityItem[];
  durationMs?: number;
  /** Whether the process phase is still streaming. */
  isStreaming?: boolean;
  /** Controlled expand state from reducer. */
  isExpanded?: boolean;
  /** Callback when user toggles expand/collapse. */
  onToggle?: () => void;
  /** Timestamp when processing started (ISO string). Used for live elapsed. */
  processStartedAt?: string | null;
  /** Called when the collapse exit animation completes (for phase handoff). */
  onCollapseExitComplete?: () => void;
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
 * Live elapsed display — ticks every second while active.
 * Isolated component to avoid re-rendering the entire RunActivity tree.
 */
const LiveElapsed = React.memo(function LiveElapsed({ startedAt, className }: { startedAt: string; className?: string }) {
  const startMs = new Date(startedAt).getTime();
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startMs) / 1000));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startMs) / 1000));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startMs]);

  return <span className={className}>{elapsed}s</span>;
});

/**
 * Live tool elapsed — shows ticking seconds for a running tool.
 * Uses the tool's started_at timestamp.
 */
const ToolLiveElapsed = React.memo(function ToolLiveElapsed({ startedAt }: { startedAt: string }) {
  const startMs = new Date(startedAt).getTime();
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startMs) / 1000));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startMs) / 1000));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startMs]);

  if (elapsed < 1) return null;
  return (
    <span className="ml-auto shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500 tabular-nums">
      {elapsed}s
    </span>
  );
});

/**
 * Get the status icon for an activity item.
 * Uses Lucide linear icons — no emoji.
 * Running items: single Loader2 spinner (no wrench + tiny spinner dual noise).
 * Progress items: only show spinner for the LAST progress item when actively streaming.
 */
function ActivityStatusIcon({ item, isStreaming, isCurrentProgress }: { item: RunActivityItem; isStreaming?: boolean; isCurrentProgress?: boolean }) {
  if (item.kind === "progress") {
    if (!isStreaming || !isCurrentProgress) return null;
    return <Loader2 className="h-3 w-3 animate-spin text-neutral-400" />;
  }

  const status = "status" in item ? item.status : undefined;

  // Skill loaded/completed → BookOpen (semantic knowledge icon, not checkmark)
  if (item.kind === "skill" && (status === "loaded" || status === "completed")) {
    return <BookOpen className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" />;
  }

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
 * Check if the activity at index `i` is the last progress item AND
 * no tool/activity follows it.
 */
function isLastProgress(activities: RunActivityItem[], i: number): boolean {
  for (let j = i + 1; j < activities.length; j++) {
    if (activities[j].kind !== "progress") return false;
  }
  for (let j = activities.length - 1; j >= 0; j--) {
    if (activities[j].kind === "progress") return j === i;
  }
  return false;
}

/**
 * Animation variants for the collapse/expand container.
 *
 * Uses opacity + translate3d (composited properties) instead of clipPath
 * or height to avoid per-frame repaint on long content.
 *
 * Full transform strings are used instead of y/scale shorthand for
 * explicit composited-property control.
 *
 * Height change is handled by AnimatePresence mode="popLayout": the exiting
 * element is removed from layout flow immediately, so the answer surface
 * (with layout="position") can reposition without waiting for the exit
 * animation to complete.
 */
export const collapseVariants: Variants = {
  expanded: {
    opacity: 1,
    transform: "translate3d(0,0,0)",
  },
  collapsed: {
    opacity: 0,
    transform: "translate3d(0,-4px,0)",
  },
};

export function RunActivity({
  activities,
  durationMs,
  isStreaming = false,
  isExpanded = true,
  onToggle,
  processStartedAt,
  onCollapseExitComplete,
}: RunActivityProps) {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  if (activities.length === 0) return null;

  const formattedDuration = formatDuration(durationMs);

  // Header label: show live elapsed while streaming, frozen duration after completion
  const summaryLabel = isStreaming
    ? "正在处理"
    : formattedDuration
      ? `已处理 ${formattedDuration}`
      : "已处理";

  const contentId = `run-activity-content-${activities[0]?.id ?? "empty"}`;

  // Use faster auto-collapse variants, slower manual toggle
  const variants = prefersReducedMotion ? undefined : collapseVariants;

  // Reduced motion: ensure onExitComplete fires immediately
  const reducedMotionTransition = prefersReducedMotion ? { duration: 0 } : undefined;

  return (
    <div className="my-2">
      {/* Collapsible Trigger Header — single ChevronDown with CSS rotate */}
      <button
        type="button"
        onClick={onToggle}
        className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors py-1 focus:outline-none"
        aria-expanded={isExpanded}
        aria-controls={contentId}
      >
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 transition-transform duration-[170ms]"
          style={{
            transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)",
          }}
        />
        <span>{summaryLabel}</span>
        {isStreaming && processStartedAt && (
          <LiveElapsed startedAt={processStartedAt} className="text-neutral-400 dark:text-neutral-500 tabular-nums" />
        )}
      </button>

      {/* Activities List — animated collapse/expand.
          mode="popLayout" removes the exiting element from layout flow immediately,
          so downstream layout="position" surfaces can reposition without waiting.
          layoutDependency ties layout animation to expand state — answer only
          repositions when toggle changes, not on every content token.
          onExitComplete fires the phase handoff for answer reveal. */}
      <AnimatePresence
        initial={false}
        mode="popLayout"
        onExitComplete={onCollapseExitComplete}
      >
        {isExpanded && (
          <motion.div
            key="activity-content"
            id={contentId}
            variants={variants}
            initial="collapsed"
            animate="expanded"
            exit="collapsed"
            transition={reducedMotionTransition || {
              duration: 0.18,
              ease: [0.23, 1, 0.32, 1],
            }}
            layout
            layoutDependency={isExpanded}
            className="overflow-hidden"
          >
            <div className="pl-4 pt-1 space-y-1 border-l border-neutral-100 dark:border-neutral-800 mt-1">
              {activities.map((item, i) => (
                <ActivityRow
                  key={item.id}
                  item={item}
                  isStreaming={isStreaming}
                  isCurrentProgress={item.kind === "progress" && isLastProgress(activities, i)}
                  prefersReducedMotion={prefersReducedMotion}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const ActivityRow = React.memo(function ActivityRow({
  item,
  isStreaming,
  isCurrentProgress,
  prefersReducedMotion,
}: {
  item: RunActivityItem;
  isStreaming?: boolean;
  isCurrentProgress?: boolean;
  prefersReducedMotion?: boolean;
}) {
  const label = getActivityLabel(item);
  const duration = "duration_ms" in item ? (item as { duration_ms?: number }).duration_ms : undefined;
  const formattedDuration = formatDuration(duration);
  const startedAt = "started_at" in item ? (item as { started_at?: string }).started_at : undefined;

  // Progress items: render as Markdown, with spinner only for the last progress when streaming
  if (item.kind === "progress") {
    // Live last progress: use StreamingProcessText (scheduler-driven reveal)
    // Historical/non-streaming: render full content immediately via ProcessMarkdown
    const isLiveProgress = isStreaming && isCurrentProgress;

    return (
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0, transform: "translate3d(0,2px,0)" }}
        animate={{ opacity: 1, transform: "translate3d(0,0,0)" }}
        transition={{ duration: 0.12, ease: "easeOut" }}
        className="flex items-start gap-1.5 py-0.5"
      >
        {isLiveProgress && (
          <Loader2 className="h-3 w-3 animate-spin text-neutral-400 mt-0.5 shrink-0" />
        )}
        {isLiveProgress ? (
          <StreamingProcessText content={label} isStreaming={true} className="min-w-0 flex-1" />
        ) : (
          <ProcessMarkdown content={label} className="min-w-0 flex-1" />
        )}
      </motion.div>
    );
  }

  // Skill/Tool items: single spinner (no wrench + tiny spinner), elapsed while running
  const isRunning = "status" in item && (item.status === "running" || item.status === "loading");

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, transform: "translate3d(0,2px,0)" }}
      animate={{ opacity: 1, transform: "translate3d(0,0,0)" }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      className="flex items-center gap-2 py-0.5 text-xs text-neutral-500 dark:text-neutral-400"
    >
      <span className="shrink-0">
        <ActivityStatusIcon item={item} isStreaming={isStreaming} isCurrentProgress={isCurrentProgress} />
      </span>
      <span className="truncate">{label}</span>
      {isRunning && startedAt && isStreaming ? (
        <ToolLiveElapsed startedAt={startedAt} />
      ) : formattedDuration ? (
        <span className="ml-auto shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500 tabular-nums">
          {formattedDuration}
        </span>
      ) : null}
    </motion.div>
  );
});

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

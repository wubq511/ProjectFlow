"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentConversationMessage, AgentStreamTurn } from "@/lib/types";
import { SLASH_COMMANDS, type SlashCommandDef } from "@/components/project/project-actions";
import { SlashCommandChip } from "./SlashCommandChip";
import { MarkdownContent } from "./MarkdownContent";
import { StreamingText } from "./StreamingText";
import { MessageActions } from "./MessageActions";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { RunActivity } from "./RunActivity";
import { executionStepStatusIcon } from "./stream-display";
import type { RunActivityItem, ExecutionStep } from "@/lib/types";

interface ChatMessageProps {
  message: AgentConversationMessage;
  isLast?: boolean;
  onRetry?: () => void;
  onAction?: (instruction: string) => void;
  onToggleThinking?: () => void;
  /** Live streaming turn data — when present, render from turn state instead of persisted payload */
  streamTurn?: AgentStreamTurn | null;
  index?: number;
  /** Throttled callback fired when StreamingText reveals new text. */
  onRevealProgress?: () => void;
}

/**
 * Extract display text from quick reply instructions.
 * Pattern: "用户点击了快捷回复「<display text>」"
 * Falls back to original content if pattern doesn't match (truncated if too long).
 */
function displayContent(message: AgentConversationMessage): string {
  if (message.role !== "user") return message.content;
  const match = message.content.match(/「(.+?)」/);
  if (match?.[1]) return match[1];
  // Fallback: truncate long instructions to avoid showing raw prompt text
  return message.content.length > 50 ? message.content.slice(0, 50) + "…" : message.content;
}

function getSlashCommand(message: AgentConversationMessage): SlashCommandDef | null {
  const commandName = message.structured_payload?.slash_command;
  if (typeof commandName !== "string") return null;
  return SLASH_COMMANDS.find((c) => c.command === commandName) ?? null;
}

export const ChatMessage = React.memo(function ChatMessage({
  message,
  isLast,
  onRetry,
  onAction,
  onToggleThinking,
  streamTurn,
  index = 0,
  onRevealProgress,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const [persistedProcessOpen, setPersistedProcessOpen] = useState(false);
  const [persistedStepsOpen, setPersistedStepsOpen] = useState(false);

  // When streamTurn is present, use live data; otherwise use persisted payload
  const isLive = !!streamTurn && streamTurn.status !== "idle";
  const isActivelyStreaming = isLive && !["completed", "failed", "cancelled", "disconnected"].includes(streamTurn!.status);

  // Activities: live from turn, or persisted from structured_payload
  const activities: RunActivityItem[] = isLive
    ? (streamTurn!.activities || [])
    : Array.isArray(message.structured_payload?.activities)
      ? message.structured_payload.activities
      : [];
  const hasActivities = activities.length > 0;

  // Process expand state: live from reducer, or local state for persisted
  const processExpanded = isActivelyStreaming
    ? streamTurn!.processExpanded
    : isLive
      ? streamTurn!.processExpanded
      : persistedProcessOpen;
  const handleProcessToggle = isLive && onToggleThinking
    ? onToggleThinking
    : () => setPersistedProcessOpen(!persistedProcessOpen);

  // Duration: live from turn, or persisted from run_summary
  const durationMs = isLive
    ? streamTurn!.processDurationMs
    : (message.structured_payload?.run_summary as { processing_duration_ms?: number } | undefined)?.processing_duration_ms;

  // Is process still streaming? Derived from processCompletedAt — not status,
  // which may be thinking/executing during process phase and answering after.
  const isProcessStreaming = isActivelyStreaming && streamTurn!.processCompletedAt === null;

  // Answer content: live from answerBuffer (answer_delta) > finalContent,
  // or persisted from message.content.
  // Text blocks are NOT used as answer source during active streaming — the
  // projector sends answer exclusively via answer_delta after process_completed.
  // For terminal states (cancelled/failed/disconnected), text blocks serve as
  // last-resort fallback for interrupted turns that never reached process_completed.
  const isTerminalState = isLive && ["completed", "failed", "cancelled", "disconnected"].includes(streamTurn!.status);
  const streamedTextFromBlocks = isTerminalState
    ? Object.values(streamTurn!.blocks)
        .filter((b) => b.kind === "text")
        .sort((a, b) => a.order - b.order)
        .map((b) => b.content)
        .join("")
    : "";
  const answerContent = isLive
    ? (streamTurn!.answerBuffer || streamTurn!.finalContent || streamedTextFromBlocks || "")
    : message.content;

  // Is answer still streaming?
  const isAnswerStreaming = isLive && streamTurn!.status === "answering";

  // Execution steps: live from turn, or persisted from structured_payload
  const executionSteps: ExecutionStep[] = isLive
    ? streamTurn!.executionSteps
    : Array.isArray(message.structured_payload?.execution_steps)
      ? (message.structured_payload!.execution_steps as unknown[]).filter(
          (s): s is ExecutionStep =>
            s != null && typeof s === "object" && typeof (s as Record<string, unknown>).tool_name === "string" && typeof (s as Record<string, unknown>).status === "string" && typeof (s as Record<string, unknown>).label === "string",
        )
      : [];
  const hasExecutionSteps = executionSteps.length > 0;

  // Turn status label for error/cancel/disconnect
  const turnStatusLabel = isLive
    ? streamTurn!.status === "cancelled" ? "已停止生成"
      : streamTurn!.status === "disconnected" ? "连接中断"
      : streamTurn!.status === "failed" ? "生成失败"
      : null
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.15,
        delay: Math.min(index * 0.03, 0.2),
        ease: [0.25, 1, 0.5, 1],
      }}
      className={cn(
        "transition-all duration-200",
        isUser
          ? "ml-auto w-fit max-w-[85%] rounded-2xl bg-neutral-100/80 dark:bg-neutral-800/80 text-neutral-800 dark:text-neutral-200 px-4 py-2.5 shadow-none border-none"
          : "w-full bg-transparent border-none shadow-none px-0 py-4 text-neutral-800 dark:text-neutral-200",
      )}
    >
      {isUser ? (
        (() => {
          const slashCommand = getSlashCommand(message);
          if (slashCommand) {
            const hasBody = message.content !== slashCommand.defaultInstruction && message.content.trim().length > 0;
            return (
              <div className="flex flex-wrap items-center gap-1.5 text-sm leading-5">
                <SlashCommandChip command={slashCommand} />
                {hasBody ? <span>{message.content}</span> : null}
              </div>
            );
          }
          return <p className="text-xs leading-5">{displayContent(message)}</p>;
        })()
      ) : (
        <>
          {/* Single RunActivity surface — unified process timeline */}
          {hasActivities && (
            <RunActivity
              activities={activities}
              durationMs={durationMs}
              isStreaming={isProcessStreaming}
              isExpanded={processExpanded}
              onToggle={handleProcessToggle}
            />
          )}

          {/* Legacy: execution steps section when no activities (backward compat) */}
          {!hasActivities && hasExecutionSteps && (
            <Collapsible open={persistedStepsOpen} onOpenChange={setPersistedStepsOpen} className="mb-2">
              <CollapsibleTrigger
                className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors py-1.5 focus:outline-none"
                aria-expanded={persistedStepsOpen}
              >
                <span>执行过程</span>
                <span className="text-neutral-400">·</span>
                <span className="text-neutral-400">{executionSteps.length} 步</span>
                {persistedStepsOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
              </CollapsibleTrigger>
              <CollapsibleContent className="pl-3 py-1 border-l border-neutral-100 dark:border-neutral-800 mt-1.5">
                <ul className="space-y-1">
                  {executionSteps.map((step, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                      <span>{executionStepStatusIcon(step.status)}</span>
                      <span>{step.label}</span>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Answer content: streaming or persisted */}
          {isLive && streamTurn!.answerBuffer && answerContent.length > 0 ? (
            <StreamingText buffer={answerContent} isStreaming={isAnswerStreaming} onRevealProgress={onRevealProgress} />
          ) : answerContent ? (
            <div>
              <MarkdownContent content={answerContent} />
            </div>
          ) : isLive && !hasActivities && !answerContent ? (
            <div className="flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>正在生成回复...</span>
            </div>
          ) : null}

          {/* Turn status label (cancelled/disconnected/failed) */}
          {turnStatusLabel && (
            <p className="mt-1.5 text-[10px] text-neutral-500 dark:text-neutral-400">{turnStatusLabel}</p>
          )}
        </>
      )}
      {!isUser && isLast && !isLive && (
        <MessageActions
          message={message}
          onCopy={() => navigator.clipboard.writeText(message.content)}
          onRetry={onRetry}
          onAction={onAction}
        />
      )}
    </motion.div>
  );
});

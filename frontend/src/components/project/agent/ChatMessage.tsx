"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentConversationMessage, AgentStreamTurn, ExecutionStep } from "@/lib/types";
import { SLASH_COMMANDS, type SlashCommandDef } from "@/components/project/project-actions";
import { SlashCommandChip } from "./SlashCommandChip";
import { MarkdownContent } from "./MarkdownContent";
import { StreamingText } from "./StreamingText";
import { MessageActions } from "./MessageActions";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { executionStepStatusIcon } from "./stream-display";
import { RunActivity } from "./RunActivity";
import type { RunActivityItem } from "@/lib/types";

interface ChatMessageProps {
  message: AgentConversationMessage;
  isLast?: boolean;
  onRetry?: () => void;
  onAction?: (instruction: string) => void;
  onToggleThinking?: () => void;
  /** Live streaming turn data — when present, render from turn state instead of persisted payload */
  streamTurn?: AgentStreamTurn | null;
  index?: number;
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
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);

  // When streamTurn is present, use live data; otherwise use persisted payload
  const isLive = !!streamTurn && streamTurn.status !== "idle";
  const isActivelyStreaming = isLive && !["completed", "failed", "cancelled", "disconnected"].includes(streamTurn!.status);

  // Thinking content: live from turn blocks, or persisted from structured_payload
  const thinkingContent = isLive
    ? Object.values(streamTurn!.blocks)
        .filter((b) => b.kind === "thinking")
        .sort((a, b) => a.order - b.order)
        .map((b) => b.content)
        .join("")
    : typeof message.structured_payload?.thinking_content === "string"
      ? message.structured_payload.thinking_content
      : "";
  const hasThinking = thinkingContent.length > 0;

  // Answer content: live from turn blocks, or persisted from message.content
  const streamedAnswerContent = isLive
    ? Object.values(streamTurn!.blocks)
        .filter((b) => b.kind === "text")
        .sort((a, b) => a.order - b.order)
        .map((b) => b.content)
        .join("")
    : "";
  const answerContent = isLive
    ? streamTurn!.finalContent ?? (streamedAnswerContent || message.content)
    : message.content;

  // Activities: live from turn, or persisted from structured_payload
  const activities: RunActivityItem[] = isLive
    ? (streamTurn!.activities || [])
    : Array.isArray(message.structured_payload?.activities)
      ? message.structured_payload.activities
      : [];
  const hasActivities = activities.length > 0;

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

  // Thinking open state: live from turn (controlled by reducer), or local state for persisted
  const effectiveThinkingOpen = isActivelyStreaming ? streamTurn!.thinkingOpen : thinkingOpen;
  const handleThinkingToggle = isActivelyStreaming && onToggleThinking ? onToggleThinking : () => setThinkingOpen(!thinkingOpen);

  // Thinking section title: "正在思考" during streaming, "思考过程" after completion
  const thinkingTitle = isLive && streamTurn!.status !== "completed" && streamTurn!.status !== "failed" && streamTurn!.status !== "cancelled"
    ? "正在思考"
    : "思考过程";

  // Is answer still streaming?
  const isAnswerStreaming = isLive && streamTurn!.status === "answering";

  // Turn status label for error/cancel/disconnect
  const turnStatusLabel = isLive
    ? streamTurn!.status === "cancelled" ? "已停止生成"
      : streamTurn!.status === "disconnected" ? "连接中断"
      : streamTurn!.status === "failed" ? "生成失败"
      : null
    : null;

  // Unique ID for ARIA association
  const thinkingContentId = `thinking-content-${message.id}`;
  const stepsContentId = `steps-content-${message.id}`;

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
            // Show the chip + the actual typed body. When no extra text was
            // typed the persisted content equals the default instruction; in
            // that case render only the chip.
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
          {/* Two-stage Activity Timeline */}
          {hasActivities ? (
            <RunActivity
              activities={activities}
              durationMs={isLive ? streamTurn!.processDurationMs : (message.structured_payload?.run_summary as any)?.processing_duration_ms}
              isStreaming={isActivelyStreaming && streamTurn!.status === "thinking"}
            />
          ) : (
            <>
              {/* Collapsible thinking section */}
              {hasThinking && (
                <Collapsible open={effectiveThinkingOpen} onOpenChange={handleThinkingToggle} className="mb-2">
                  <CollapsibleTrigger
                    className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors py-1.5 focus:outline-none"
                    aria-expanded={effectiveThinkingOpen}
                    aria-controls={thinkingContentId}
                  >
                    <span>{thinkingTitle}</span>
                    {effectiveThinkingOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pl-3 py-1 border-l border-neutral-100 dark:border-neutral-800 mt-1.5" id={thinkingContentId}>
                    <p className="whitespace-pre-wrap text-[11px] leading-5 text-neutral-500 dark:text-neutral-400">{thinkingContent}</p>
                  </CollapsibleContent>
                </Collapsible>
              )}
              {/* Collapsible execution steps section */}
              {hasExecutionSteps && (
                <Collapsible open={stepsOpen} onOpenChange={setStepsOpen} className="mb-2">
                  <CollapsibleTrigger
                    className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors py-1.5 focus:outline-none"
                    aria-expanded={stepsOpen}
                    aria-controls={stepsContentId}
                  >
                    <span>执行过程</span>
                    <span className="text-neutral-400">·</span>
                    <span className="text-neutral-400">{executionSteps.length} 步</span>
                    {stepsOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pl-3 py-1 border-l border-neutral-100 dark:border-neutral-800 mt-1.5" id={stepsContentId}>
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
            </>
          )}
          {/* Answer content: streaming or persisted — NOT aria-live (announcement is separate) */}
          {isAnswerStreaming && answerContent.length > 0 ? (
            <StreamingText buffer={answerContent} isStreaming={true} />
          ) : answerContent ? (
            <div>
              <MarkdownContent content={answerContent} />
            </div>
          ) : isLive && !hasThinking ? (
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

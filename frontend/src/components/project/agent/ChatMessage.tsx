"use client";

import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from "react";
import { motion, LayoutGroup } from "framer-motion";
import { ChevronDown, Loader2 } from "lucide-react";
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

/**
 * Answer handoff surface — keyed by turnId so each turn gets independent
 * local state. Uses useLayoutEffect (synchronous, before paint) to activate
 * the gate when processAutoCollapsed arrives in the same batch as answer data.
 * This prevents a one-frame flash where the answer is visible before the gate
 * activates.
 *
 * The gate activates ONCE per shouldGate session: `lastGateRef` tracks which
 * shouldGate value already triggered activation. This prevents the fallback
 * timer (which sets gateActive=false) from immediately re-triggering the gate
 * via the useLayoutEffect (which would create an infinite loop).
 */
function AnswerHandoff({
  shouldGate,
  answerContent,
  isAnswerStreaming,
  isLive,
  hasActivities,
  processExpanded,
  onRevealProgress,
  streamTurn,
}: {
  shouldGate: boolean;
  answerContent: string;
  isAnswerStreaming: boolean;
  isLive: boolean;
  hasActivities: boolean;
  processExpanded: boolean;
  onRevealProgress?: () => void;
  streamTurn?: AgentStreamTurn | null;
}) {
  const [gateActive, setGateActive] = useState(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGateRef = useRef<boolean | null>(null);

  // Synchronous gate activation: useLayoutEffect runs after DOM mutation but
  // BEFORE the browser paints. When shouldGate transitions true (batched with
  // answer data), this sets gateActive synchronously and triggers an immediate
  // re-render — the browser never paints the intermediate frame where the
  // answer was visible.
  //
  // lastGateRef prevents re-activation: once the gate fires for a given
  // shouldGate=true session, it won't re-activate when the fallback timer
  // releases the gate (because shouldGate is still true but lastGateRef matches).
  // Intentional useLayoutEffect: synchronous gate activation before browser paint.
  // This prevents a one-frame flash when processAutoCollapsed + answer data arrive
  // in the same batch. setState in useLayoutEffect is the recommended pattern for
  // derived state that must be committed before the user sees the frame.
  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    if (shouldGate && !gateActive && lastGateRef.current !== shouldGate) {
      lastGateRef.current = shouldGate;
      setGateActive(true);
    } else if (!shouldGate && gateActive) {
      lastGateRef.current = shouldGate;
      setGateActive(false);
    } else if (!shouldGate) {
      // Reset tracking when shouldGate is false so a future true can re-activate
      lastGateRef.current = shouldGate;
    }
  }, [shouldGate, gateActive]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Start fallback timer when gate activates
  useEffect(() => {
    if (gateActive) {
      fallbackTimerRef.current = setTimeout(() => {
        setGateActive(false);
      }, 250);
    }
    return () => {
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, [gateActive]);

  const handleCollapseExitComplete = useCallback(() => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    setGateActive(false);
  }, []);

  const shouldRevealAnswer = !gateActive;

  return (
    <>
      {/* Wire onCollapseExitComplete from RunActivity */}
      {hasActivities && (
        <CollapseExitListener
          isExpanded={processExpanded}
          onExitComplete={handleCollapseExitComplete}
        />
      )}

      <motion.div
        layout="position"
        layoutDependency={processExpanded}
        transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
      >
        {isLive && streamTurn?.answerBuffer && answerContent.length > 0 && shouldRevealAnswer ? (
          <StreamingText buffer={answerContent} isStreaming={isAnswerStreaming} onRevealProgress={onRevealProgress} />
        ) : answerContent && shouldRevealAnswer ? (
          <div>
            <MarkdownContent content={answerContent} />
          </div>
        ) : isLive && !hasActivities && !answerContent ? (
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>正在生成回复...</span>
          </div>
        ) : null}
      </motion.div>
    </>
  );
}

/**
 * Invisible listener that detects when a RunActivity collapse exit animation
 * completes. Watches the isExpanded prop for true→false transitions and fires
 * onExitComplete after the animation duration (180ms).
 *
 * Also handles the "already collapsed" case: when isExpanded starts as false
 * on mount (e.g. batched events with processExpanded=false), there is no exit
 * animation to wait for, so onExitComplete fires immediately.
 */
const CollapseExitListener = React.memo(function CollapseExitListener({
  isExpanded,
  onExitComplete,
}: {
  isExpanded: boolean;
  onExitComplete: () => void;
}) {
  const prevExpandedRef = useRef(isExpanded);
  const initializedRef = useRef(false);

  useEffect(() => {
    // On first mount: if already collapsed, no exit animation — fire immediately
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (!isExpanded) {
        // Use setTimeout(0) to defer past the current render cycle
        const timer = setTimeout(onExitComplete, 0);
        prevExpandedRef.current = isExpanded;
        return () => clearTimeout(timer);
      }
      prevExpandedRef.current = isExpanded;
      return;
    }

    // Detect true→false transition (collapse started)
    if (prevExpandedRef.current && !isExpanded) {
      // Match RunActivity's collapse animation duration (180ms)
      const timer = setTimeout(onExitComplete, 180);
      prevExpandedRef.current = isExpanded;
      return () => clearTimeout(timer);
    }

    prevExpandedRef.current = isExpanded;
  }, [isExpanded, onExitComplete]);

  return null;
});

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
  // (computed early because gate logic depends on hasActivities)
  const activities: RunActivityItem[] = isLive
    ? (streamTurn!.activities || [])
    : Array.isArray(message.structured_payload?.activities)
      ? message.structured_payload.activities
      : [];
  const hasActivities = activities.length > 0;

  // Gate answer reveal — delegated to AnswerHandoff (keyed by turnId) so each
  // turn gets independent local state. The gate activates synchronously via
  // render-phase state adjustment when processAutoCollapsed arrives, preventing
  // the batched events from showing the answer for one frame.
  const turnId = streamTurn?.clientTurnId ?? null;
  const shouldGate = !!streamTurn?.processAutoCollapsed && hasActivities;

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
      initial={{ opacity: 0, transform: "translate3d(0,4px,0)" }}
      animate={{ opacity: 1, transform: "translate3d(0,0,0)" }}
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
        <LayoutGroup id={`turn-${turnId ?? message.id}`}>
          {/* Single RunActivity surface — unified process timeline.
              onCollapseExitComplete fires when the collapse exit animation ends,
              enabling the phase handoff to start the answer reveal. */}
          {hasActivities && (
            <RunActivity
              activities={activities}
              durationMs={durationMs}
              isStreaming={isProcessStreaming}
              isExpanded={processExpanded}
              onToggle={handleProcessToggle}
              processStartedAt={isLive ? streamTurn!.processStartedAt : undefined}
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
                <ChevronDown
                  className="h-3.5 w-3.5 shrink-0 transition-transform duration-[170ms]"
                  style={{
                    transform: persistedStepsOpen ? "rotate(0deg)" : "rotate(-90deg)",
                  }}
                />
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

          {/* Answer content — phase handoff via AnswerHandoff (keyed by turnId).
              Each turn gets independent local state so the gate activates
              synchronously when processAutoCollapsed arrives in the same batch
              as answer data. */}
          <AnswerHandoff
            key={turnId ?? `persisted-${message.id}`}
            shouldGate={shouldGate}
            answerContent={answerContent}
            isAnswerStreaming={isAnswerStreaming}
            isLive={isLive}
            hasActivities={hasActivities}
            processExpanded={processExpanded}
            onRevealProgress={onRevealProgress}
            streamTurn={streamTurn}
          />

          {/* Turn status label (cancelled/disconnected/failed) */}
          {turnStatusLabel && (
            <p className="mt-1.5 text-[10px] text-neutral-500 dark:text-neutral-400">{turnStatusLabel}</p>
          )}
        </LayoutGroup>
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

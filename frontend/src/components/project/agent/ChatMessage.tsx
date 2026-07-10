"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentConversationMessage } from "@/lib/types";
import { MarkdownContent } from "./MarkdownContent";
import { MessageActions } from "./MessageActions";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

interface ExecutionStep {
  tool_name: string;
  status: string;
  label: string;
}

interface ChatMessageProps {
  message: AgentConversationMessage;
  isLast?: boolean;
  onRetry?: () => void;
  onAction?: (instruction: string) => void;
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

/** Status icon for execution steps. */
function stepStatusIcon(status: string): string {
  switch (status) {
    case "completed": return "✅";
    case "failed": return "❌";
    case "blocked": return "🚫";
    default: return "⏳";
  }
}

export const ChatMessage = React.memo(function ChatMessage({ message, isLast, onRetry, onAction, index = 0 }: ChatMessageProps) {
  const isUser = message.role === "user";
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);

  // Extract thinking_content from structured_payload (persisted by backend)
  const thinkingContent = typeof message.structured_payload?.thinking_content === "string"
    ? message.structured_payload.thinking_content
    : "";
  const hasThinking = thinkingContent.length > 0;

  // Extract execution_steps from structured_payload (persisted by backend)
  // Runtime validation: gracefully degrade if shape is unexpected
  const rawSteps = message.structured_payload?.execution_steps;
  const executionSteps: ExecutionStep[] = Array.isArray(rawSteps)
    ? rawSteps.filter(
        (s): s is ExecutionStep =>
          s != null && typeof s === "object" && typeof s.tool_name === "string" && typeof s.status === "string" && typeof s.label === "string",
      )
    : [];
  const hasExecutionSteps = executionSteps.length > 0;

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
        "rounded-md border p-3",
        isUser
          ? "ml-6 border-neutral-200 bg-white text-neutral-700"
          : "mr-0 border-neutral-100 bg-neutral-50/80 text-neutral-700",
      )}
    >
      <div className="mb-1 text-[10px] font-semibold text-neutral-400">
        {isUser ? "你" : "Agent"}
      </div>
      {isUser ? (
        <p className="text-xs leading-5">{displayContent(message)}</p>
      ) : (
        <>
          {/* Collapsible thinking section */}
          {hasThinking && (
            <Collapsible open={thinkingOpen} onOpenChange={setThinkingOpen} className="mb-2">
              <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
                <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform duration-200", thinkingOpen && "rotate-90")} />
                <span>思考过程</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1 rounded-md border border-neutral-100 bg-white/60 p-2">
                <p className="whitespace-pre-wrap text-[11px] leading-5 text-neutral-500">{thinkingContent}</p>
              </CollapsibleContent>
            </Collapsible>
          )}
          {/* Collapsible execution steps section */}
          {hasExecutionSteps && (
            <Collapsible open={stepsOpen} onOpenChange={setStepsOpen} className="mb-2">
              <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600">
                <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform duration-200", stepsOpen && "rotate-90")} />
                <span>执行过程</span>
                <span className="text-neutral-300">·</span>
                <span className="text-neutral-300">{executionSteps.length} 步</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1 rounded-md border border-neutral-100 bg-white/60 p-2">
                <ul className="space-y-1">
                  {executionSteps.map((step, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                      <span>{stepStatusIcon(step.status)}</span>
                      <span>{step.label}</span>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
          {/* Final answer */}
          <MarkdownContent content={message.content} />
        </>
      )}
      {!isUser && isLast && (
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

"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentConversationMessage } from "@/lib/types";
import { MarkdownContent } from "./MarkdownContent";
import { MessageActions } from "./MessageActions";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";

interface ChatMessageProps {
  message: AgentConversationMessage;
  isLast?: boolean;
  onRetry?: () => void;
  onAction?: (instruction: string) => void;
  index?: number;
  /** Thinking/reasoning content to show in a collapsible section. */
  thinkingContent?: string;
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

const TOOL_CALL_MARKER = "🔧 _工具调用_";
/** Render-friendly version: blockquote style for better visibility and accessibility. */
const TOOL_CALL_DISPLAY = "> 🔧 **工具调用**";

/** Clean tool observation noise from thinking content. */
function cleanThinkingContent(raw: string): string {
  const lines = raw.split("\n");
  let inCodeBlock = false;
  const cleaned = lines.map((line) => {
    // Track markdown code block boundaries
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (inCodeBlock) return line;
    const trimmed = line.trim();
    // Replace short standalone JSON objects/arrays (tool observations like {}, {"limit": 10})
    if (/^\{[^{}]{0,80}\}$/.test(trimmed) || /^\[[^\[\]]{0,80}\]$/.test(trimmed)) {
      return TOOL_CALL_MARKER;
    }
    return line;
  });
  return cleaned
    .join("\n")
    // Collapse consecutive tool-call lines into one
    .replace(new RegExp(`(${TOOL_CALL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?){2,}`, "g"), TOOL_CALL_MARKER + "\n");
}

/** Count approximate "steps" in thinking content (tool calls + reasoning paragraphs). */
function countThinkingSteps(content: string): number {
  const cleaned = cleanThinkingContent(content);
  // Count tool call markers
  const escaped = TOOL_CALL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const toolCalls = (cleaned.match(new RegExp(escaped, "g")) ?? []).length;
  // Count paragraph breaks as reasoning steps
  const paragraphs = cleaned.split(/\n\n+/).filter((p) => p.trim().length > 20).length;
  return Math.max(toolCalls + paragraphs, 1);
}

export const ChatMessage = React.memo(function ChatMessage({ message, isLast, onRetry, onAction, index = 0, thinkingContent }: ChatMessageProps) {
  const isUser = message.role === "user";
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const hasThinking = Boolean(thinkingContent && thinkingContent.trim());

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
                <span className="text-neutral-300">·</span>
                <span className="text-neutral-300">{countThinkingSteps(thinkingContent!)} 步</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1 rounded-md border border-neutral-100 bg-white/60 p-2 text-neutral-500">
                  <MarkdownContent content={cleanThinkingContent(thinkingContent!).split(TOOL_CALL_MARKER).join(TOOL_CALL_DISPLAY)} />
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

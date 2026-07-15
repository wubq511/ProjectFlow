"use client";

import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Clock,
  Loader2,
  Pencil,
  Sparkles,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MultilineText } from "@/components/ui/multiline-text";
import { cn } from "@/lib/utils";
import type { AgentArtifact, AgentSuggestion } from "@/lib/types";
import { forwardRef } from "react";

// ---------------------------------------------------------------------------
// Focus reason helper
// ---------------------------------------------------------------------------

const FOCUS_REASONS: Record<string, string> = {
  方向澄清: "先把目标、边界和取舍确认下来，后续计划才不会建立在模糊假设上。",
  阶段计划: "方向已经具备基础，可以按截止时间和交付物倒排阶段。",
  任务拆解: "阶段计划确认后，需要把阶段目标拆成可分配、可检查的任务。",
  分工确认: "任务明确后，需要结合成员技能、时间和偏好生成并确认分工。",
  执行推进: "分工确认后，Agent 可以持续生成行动卡、分析风险并建议重排。",
};

export function focusReason(focus: string): string {
  return FOCUS_REASONS[focus] ?? "Agent 会根据当前项目状态判断下一步。";
}

// ---------------------------------------------------------------------------
// AgentContextCard
// ---------------------------------------------------------------------------

interface AgentContextCardProps {
  focus: string;
  pendingCount?: number;
}

export function AgentContextCard({ focus, pendingCount = 0 }: AgentContextCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="mb-4 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
          <Sparkles className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" />
          当前阶段
        </div>
        {pendingCount > 0 && (
          <Badge className="bg-moss/15 px-2 py-0 text-[10px] text-moss dark:text-blue-400">
            {pendingCount} 待确认
          </Badge>
        )}
      </div>
      <p className="mt-1.5 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{focus}</p>
      <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">{focusReason(focus)}</p>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// AgentRunStatusCard
// ---------------------------------------------------------------------------

const RUN_STEPS = ["读取项目状态", "判断下一步影响", "整理可确认结果"] as const;

export function AgentRunStatusCard() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="mb-3 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900"
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-600 dark:text-neutral-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-500 dark:text-neutral-400" />
        Agent 正在处理
      </div>
      <ul className="mt-2 space-y-1">
        {RUN_STEPS.map((step, index) => (
          <motion.li
            key={step}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.1, duration: 0.2 }}
            className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400"
          >
            <Clock className="h-3 w-3 shrink-0 text-neutral-500 dark:text-neutral-400" />
            {step}
          </motion.li>
        ))}
      </ul>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// AgentErrorCard
// ---------------------------------------------------------------------------

interface AgentErrorCardProps {
  message: string;
  onRetry?: () => void | Promise<void>;
  disabled?: boolean;
}

export function AgentErrorCard({ message, onRetry, disabled }: AgentErrorCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="mb-3 rounded-md border border-coral/30 bg-white p-3 dark:bg-neutral-900"
    >
      <div className="flex items-start gap-2 text-xs">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-coral" />
        <div>
          <p className="font-semibold text-coral">Agent 暂时没有完成这次处理</p>
          <p className="mt-1 text-neutral-600 dark:text-neutral-400">{message}</p>
          <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">可能是网络波动或服务暂时不可用，重试通常能解决。</p>
        </div>
      </div>
      {onRetry && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 gap-1 text-xs text-coral hover:bg-coral/10 hover:text-coral"
          disabled={disabled}
          onClick={() => void onRetry()}
        >
          重新发送
        </Button>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// AgentArtifactCard
// ---------------------------------------------------------------------------

const ARTIFACT_STATUS_LABELS: Record<AgentArtifact["status"], string> = {
  draft: "草稿",
  pending_confirmation: "待确认",
  confirmed: "已确认",
  dismissed: "已忽略",
  expired: "已过期",
};

interface AgentArtifactCardProps {
  artifact: AgentArtifact;
  onConfirm?: (artifact: AgentArtifact) => void | Promise<void>;
  onRevise?: (artifact: AgentArtifact) => void | Promise<void>;
  onInspect?: (artifact: AgentArtifact) => void | Promise<void>;
  onDismiss?: (artifact: AgentArtifact) => void | Promise<void>;
  disabled?: boolean;
}

export const AgentArtifactCard = forwardRef<HTMLDivElement, AgentArtifactCardProps>(
  function AgentArtifactCard(
    { artifact, onConfirm, onRevise, onInspect, onDismiss, disabled },
    ref,
  ) {
    const isPending = artifact.status === "pending_confirmation";

    return (
      <motion.div
        ref={ref}
        layout
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
        transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
        className={cn(
        "mb-3 rounded-md border p-3",
        isPending
          ? "border-moss/25 bg-moss/[0.04] dark:border-blue-500/25 dark:bg-blue-500/[0.06]"
          : "border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{artifact.title}</h4>
        <Badge
          className={
            artifact.status === "confirmed"
              ? "bg-moss/25 px-2 py-0 text-[10px] text-moss/70"
              : artifact.status === "dismissed"
                ? "bg-neutral-200 px-2 py-0 text-[10px] text-neutral-500"
                : isPending
                  ? "bg-moss/15 px-2 py-0 text-[10px] text-moss"
                  : "bg-neutral-100 px-2 py-0 text-[10px] text-neutral-500"
          }
        >
          {ARTIFACT_STATUS_LABELS[artifact.status]}
        </Badge>
      </div>
      <div className="mt-1.5 text-xs leading-5 text-neutral-600 dark:text-neutral-400">
        <MultilineText text={artifact.summary} />
      </div>
      {artifact.rationale && (
        <div className="mt-1.5 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
          <MultilineText text={artifact.rationale} />
        </div>
      )}
      {artifact.impact.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {artifact.impact.map((item) => (
            <li key={item} className="flex items-start gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              <ArrowRight className="h-3 w-3 shrink-0 text-neutral-400 mt-0.5 dark:text-neutral-500" />
              <MultilineText text={item} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {artifact.type === "proposal" && isPending && onConfirm && (
          <Button
            size="sm"
            className="h-8 gap-1.5 rounded-md bg-moss px-3 text-xs font-medium text-white shadow-sm shadow-moss/20 hover:bg-moss/90 active:shadow-none"
            disabled={disabled}
            title="确认后将应用到项目，可在对话中撤销"
            onClick={() => void onConfirm(artifact)}
          >
            <BadgeCheck className="h-3.5 w-3.5" />
            确认应用
          </Button>
        )}
        {(artifact.status === "draft" || isPending) && onRevise && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-md border-neutral-200 px-2.5 text-xs text-neutral-600 hover:bg-neutral-50 hover:text-neutral-800 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            disabled={disabled}
            onClick={() => void onRevise(artifact)}
          >
            <Pencil className="h-3 w-3" />
            继续修改
          </Button>
        )}
        {(artifact.status === "draft" || isPending) && onInspect && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 rounded-md px-2.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            disabled={disabled}
            onClick={() => void onInspect(artifact)}
          >
            <ArrowRight className="h-3 w-3" />
            查看影响
          </Button>
        )}
        {artifact.type !== "proposal" && artifact.status === "draft" && onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 rounded-md px-2.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            disabled={disabled}
            onClick={() => void onDismiss(artifact)}
          >
            <XCircle className="h-3 w-3" />
            知道了
          </Button>
        )}
      </div>
    </motion.div>
  );
});

// ---------------------------------------------------------------------------
// AgentSuggestionRow
// ---------------------------------------------------------------------------

interface AgentSuggestionRowProps {
  suggestions: AgentSuggestion[];
  disabled?: boolean;
  onPick: (instruction: string) => void;
}

export function AgentSuggestionRow({ suggestions, disabled = false, onPick }: AgentSuggestionRowProps) {
  const visible = suggestions.slice(0, 3);
  if (visible.length === 0) return null;

  return (
    <motion.div
      className="mt-3 flex flex-wrap gap-1.5"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      {visible.map((suggestion, index) => (
        <motion.button
          key={suggestion.id}
          type="button"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: 0.2,
            delay: index * 0.06,
            ease: [0.25, 1, 0.5, 1],
          }}
          onClick={() => onPick(suggestion.user_instruction)}
          disabled={disabled}
          className={cn(
            "rounded-full border px-2.5 py-1 text-[11px] transition-all disabled:cursor-not-allowed disabled:opacity-50",
            suggestion.priority === "primary"
              ? "border-moss/30 bg-white text-moss hover:border-moss/40 hover:bg-moss/5 dark:border-blue-500/30 dark:bg-neutral-900 dark:text-blue-400 dark:hover:border-blue-500/40 dark:hover:bg-blue-500/5"
              : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 hover:text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200"
          )}
        >
          {suggestion.label}
        </motion.button>
      ))}
    </motion.div>
  );
}

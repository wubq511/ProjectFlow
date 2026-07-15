"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, Loader2, CheckCircle2, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import { MultilineText } from "@/components/ui/multiline-text";

interface ModuleRunCardProps {
  module: string;
  status: "running" | "completed" | "failed";
  message?: string;
  elapsed?: number;
}

const MODULE_LABELS: Record<string, string> = {
  clarify: "方向澄清",
  plan: "阶段计划",
  breakdown: "任务拆解",
  assign: "分工推荐",
  push: "主动推进",
  checkin: "签到分析",
  risk: "风险分析",
  replan: "计划调整",
};

export const ModuleRunCard = React.memo(function ModuleRunCard({ module, status, message, elapsed }: ModuleRunCardProps) {
  const [expanded, setExpanded] = useState(status === "running");
  const label = MODULE_LABELS[module] ?? module;

  return (
    <div className="mb-2 rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs"
      >
        <div className="flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5 text-neutral-500" />
          <span className="font-medium text-neutral-700">{label}</span>
          {status === "running" && <Loader2 className="h-3 w-3 animate-spin text-moss" />}
          {status === "completed" && <CheckCircle2 className="h-3 w-3 text-moss" />}
          {status === "failed" && <span className="text-coral text-[10px]">失败</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {elapsed != null && (
            <span className="text-[10px] text-neutral-500">{elapsed}s</span>
          )}
          <ChevronRight className={cn("h-3 w-3 text-neutral-500 transition-transform", expanded && "rotate-90")} />
        </div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && message && (
          <motion.div
            initial={{ maxHeight: 0, opacity: 0 }}
            animate={{ maxHeight: 200, opacity: 1 }}
            exit={{ maxHeight: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className="border-t border-neutral-100 px-3 py-2 text-xs text-neutral-500 overflow-hidden"
          >
            <MultilineText text={message} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, ChevronRight } from "lucide-react";
import type { AgentStreamPhase, ExecutionStep } from "@/lib/types";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { executionStepStatusIcon } from "./stream-display";

export type AgentStreamStatus = {
  phase: AgentStreamPhase;
  module?: string;
  message: string;
  runId?: string;
  requestMode?: "answer" | "action";
  selectedSkills?: string[];
};

interface AgentStepIndicatorProps {
  status: AgentStreamStatus | null;
  /** Live execution steps from the streaming turn */
  executionSteps?: ExecutionStep[];
}

const PHASE_LABELS: Record<string, string> = {
  planning: "理解你的需求",
  executing: "执行任务模块",
  generating: "整理执行结果",
  streaming: "生成回复",
  answering: "整理回复",
};

export const AgentStepIndicator = React.memo(function AgentStepIndicator({ status, executionSteps = [] }: AgentStepIndicatorProps) {
  const [stepsOpen, setStepsOpen] = useState(false);

  if (!status) return null;

  const currentLabel = PHASE_LABELS[status.phase] ?? "处理中";
  const hasSteps = executionSteps.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className="mb-3 rounded-md border border-neutral-200 bg-neutral-50 p-3"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-700">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-500" />
        <span>{status.message || currentLabel}</span>
      </div>
      {/* Collapsible execution timeline */}
      {hasSteps && (
        <Collapsible open={stepsOpen} onOpenChange={setStepsOpen} className="mt-2">
          <CollapsibleTrigger className="flex min-h-[44px] w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700">
            <ChevronRight className={`h-3 w-3 shrink-0 transition-transform duration-200 ${stepsOpen ? "rotate-90" : ""}`} />
            <span>执行过程</span>
            <span className="text-neutral-400">·</span>
            <span className="text-neutral-400">{executionSteps.length} 步</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 rounded-md border border-neutral-100 bg-white/60 p-2">
            <ul className="space-y-1">
              <AnimatePresence>
                {executionSteps.map((step, i) => (
                  <motion.li
                    key={`${step.tool_name}-${i}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center gap-1.5 text-[11px] text-neutral-500"
                  >
                    <span>{executionStepStatusIcon(step.status)}</span>
                    <span>{step.label}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </motion.div>
  );
});

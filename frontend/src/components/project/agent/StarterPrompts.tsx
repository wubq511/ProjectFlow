"use client";

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface StarterPromptsProps {
  focus: string;
  onSelect: (instruction: string) => void;
  disabled?: boolean;
}

const FOCUS_PROMPTS: Record<string, { label: string; hint: string; instruction: string }[]> = {
  方向澄清: [
    { label: "帮我澄清项目方向", hint: "分析项目描述，生成目标、边界和取舍建议", instruction: "请执行 clarify 模块：澄清项目方向。" },
    { label: "根据已有资料生成方向卡", hint: "读取已有信息，整理成结构化的方向卡", instruction: "请执行 clarify 模块：根据已有资料生成方向卡。" },
    { label: "这个项目的核心价值是什么？", hint: "和 Agent 对话，理清项目的核心定位", instruction: "这个项目的核心价值是什么？帮我和团队理清楚。" },
  ],
  阶段计划: [
    { label: "按三周节奏生成阶段计划", hint: "按三周一个阶段的标准节奏倒排", instruction: "请执行 plan 模块：按三周节奏生成阶段计划。" },
    { label: "按截止日期倒排阶段", hint: "根据项目截止日期自动计算每个阶段", instruction: "请执行 plan 模块：按截止日期倒排阶段。" },
    { label: "解释阶段划分的依据", hint: "了解 Agent 为什么这样划分阶段", instruction: "解释阶段划分的依据，帮我和团队理解规划逻辑。" },
  ],
  任务拆解: [
    { label: "把当前阶段拆成任务", hint: "将阶段目标拆成可分配、可检查的任务", instruction: "请执行 breakdown 模块：把当前阶段拆成可执行任务。" },
    { label: "任务拆得更细一点", hint: "把已有任务进一步细分，适合更小的分工", instruction: "请执行 breakdown 模块：把当前阶段拆成更细的任务。" },
    { label: "优先保留 MVP 任务", hint: "只保留最小可交付的核心任务", instruction: "请执行 breakdown 模块：优先保留 MVP 核心任务。" },
  ],
  分工确认: [
    { label: "根据成员情况推荐分工", hint: "结合技能、时间和偏好生成分工建议", instruction: "请执行 assign 模块：根据成员情况推荐分工。" },
    { label: "解释分工依据", hint: "了解 Agent 为什么这样分配任务", instruction: "解释当前分工推荐的依据，帮我和团队理解。" },
    { label: "查看未确认分工", hint: "检查还有哪些分工没有被确认", instruction: "查看当前还有哪些分工没有确认。" },
  ],
  执行推进: [
    { label: "生成下一步行动卡", hint: "为每个成员生成具体可执行的下一步", instruction: "请执行 push 模块：生成下一步行动卡。" },
    { label: "分析当前风险", hint: "检查截止日期、依赖、工作量等潜在风险", instruction: "请执行 risk 模块：分析当前风险。" },
    { label: "查看项目整体进度", hint: "汇总完成情况和风险项", instruction: "帮我看一下项目整体进度，哪些任务完成了，哪些有风险。" },
  ],
};

const FOCUS_DESCRIPTIONS: Record<string, string> = {
  方向澄清: "先确认项目目标和边界，后续计划才不会建立在模糊假设上。",
  阶段计划: "方向已具备基础，可以按截止时间和交付物倒排阶段。",
  任务拆解: "阶段计划确认后，需要把阶段目标拆成可分配、可检查的任务。",
  分工确认: "任务明确后，需要结合成员技能、时间和偏好生成并确认分工。",
  执行推进: "分工已确认，Agent 可以持续生成行动卡、分析风险并建议重排。",
};

export function StarterPrompts({ focus, onSelect, disabled }: StarterPromptsProps) {
  const prompts = FOCUS_PROMPTS[focus] ?? FOCUS_PROMPTS["执行推进"];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="mb-4"
    >
      <div className="mb-3 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900">
        <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">Agent 可以帮你做什么</p>
        <p className="mt-1 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
          通过对话推进项目。Agent 会分析当前状态，生成建议（方向、计划、任务、分工），你确认后才会应用到项目。
        </p>
      </div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
        <Sparkles className="h-3 w-3 text-neutral-500 dark:text-neutral-400" />
        快速开始
      </div>
      <p className="mb-2.5 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">
        {FOCUS_DESCRIPTIONS[focus] ?? "Agent 会根据当前项目状态判断下一步。"}
      </p>
      <div className="space-y-1.5">
        {prompts.map((prompt, index) => (
          <motion.button
            key={prompt.label}
            type="button"
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.15,
              delay: index * 0.04,
              ease: [0.25, 1, 0.5, 1],
            }}
            disabled={disabled}
            onClick={() => onSelect(prompt.instruction)}
            className={cn(
              "w-full rounded-md border border-neutral-200 bg-white px-3 py-2.5 text-left transition-all",
              "hover:border-neutral-300 hover:bg-neutral-50",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-neutral-600 dark:hover:bg-neutral-800",
            )}
          >
            <span className="text-xs text-neutral-700 dark:text-neutral-300">{prompt.label}</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-neutral-500 dark:text-neutral-400">{prompt.hint}</span>
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}

import type { ElementType } from "react";
import { Compass, GitBranch, ListTodo, Users, Rocket, ClipboardCheck, AlertTriangle, RefreshCw } from "lucide-react";
import type { ProjectState } from "@/lib/types";

export type AgentAction = "clarify" | "plan" | "breakdown" | "assign" | "push" | "analyze-checkins" | "risk-analysis" | "replan";

export const ACTION_LABELS: Record<AgentAction, string> = {
  clarify: "澄清方向",
  plan: "生成阶段计划",
  breakdown: "分解任务",
  assign: "推荐分工",
  push: "主动推进",
  "analyze-checkins": "分析签到",
  "risk-analysis": "风险分析",
  replan: "调整计划",
};

export interface SlashCommandDef {
  command: string;
  action: AgentAction;
  label: string;
  description: string;
  skill: string;
  category: "规划" | "分工" | "执行";
  icon: ElementType;
  defaultInstruction: string;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { command: "clarify", action: "clarify", label: "方向澄清", description: "明确项目目标和边界", skill: "project-intake", category: "规划", icon: Compass, defaultInstruction: "请执行 clarify 模块" },
  { command: "plan", action: "plan", label: "阶段计划", description: "生成阶段计划和时间线", skill: "project-planning", category: "规划", icon: GitBranch, defaultInstruction: "请执行 plan 模块" },
  { command: "breakdown", action: "breakdown", label: "任务拆解", description: "将阶段拆解为具体任务", skill: "task-breakdown", category: "规划", icon: ListTodo, defaultInstruction: "请执行 breakdown 模块" },
  { command: "assign", action: "assign", label: "分工推荐", description: "根据技能推荐分工", skill: "assignment-planning", category: "分工", icon: Users, defaultInstruction: "请执行 assign 模块" },
  { command: "push", action: "push", label: "主动推进", description: "分析进度并推进项目", skill: "project-status", category: "执行", icon: Rocket, defaultInstruction: "请执行 push 模块" },
  { command: "checkin", action: "analyze-checkins", label: "签到分析", description: "分析团队签到状态", skill: "risk-analysis", category: "执行", icon: ClipboardCheck, defaultInstruction: "请执行 checkin 模块" },
  { command: "risk", action: "risk-analysis", label: "风险分析", description: "识别潜在风险", skill: "risk-analysis", category: "执行", icon: AlertTriangle, defaultInstruction: "请执行 risk 模块" },
  { command: "replan", action: "replan", label: "计划调整", description: "根据现状调整计划", skill: "risk-replan", category: "执行", icon: RefreshCw, defaultInstruction: "请执行 replan 模块" },
];

/**
 * 解析 /command args 格式，返回 skill 和 content。
 *
 * - 无附加文本时 content = defaultInstruction（如 "请执行 plan 模块"），
 *   与后端 _EXPANDED_QUICK_REPLIES 一致，即使 skill 参数丢失也能正确路由。
 * - 有附加文本时 content = 纯用户附加上下文（如 "按三周节奏"），
 *   不做前缀拼接，避免冗余——skill 已确定模块路由。
 */
export function parseSlashCommand(input: string): { skill: string; command: string; content: string } | null {
  const match = input.match(/^\/(\w+)\s*([\s\S]*)/);
  if (!match) return null;
  const [, cmdName, rest] = match;
  const cmd = SLASH_COMMANDS.find((c) => c.command === cmdName);
  if (!cmd) return null;
  const additionalText = rest.trim();
  const content = additionalText || cmd.defaultInstruction;
  return { skill: cmd.skill, command: cmd.command, content };
}

/**
 * Detect a valid slash command at the very beginning of the input,
 * followed by a whitespace separator. Returns the matching command
 * definition, or null if no valid leading command is present.
 */
export function getLeadingSlashCommand(value: string): SlashCommandDef | null {
  const match = value.match(/^\/(\w+)\s/);
  if (!match) return null;
  return SLASH_COMMANDS.find((c) => c.command === match[1].toLowerCase()) ?? null;
}

export function inferRecommendedAction(state: ProjectState): AgentAction | null {
  const { project, stages, tasks, assignment_proposals } = state;
  if (!project.direction_card) return "clarify";
  if (stages.length === 0) return "plan";
  if (tasks.length === 0) return "breakdown";
  if (assignment_proposals.length === 0) return "assign";
  const hasFinalized = assignment_proposals.some((p) => p.status === "finalized");
  if (!hasFinalized) return "assign";
  return "push";
}

"use client";

import type { ElementType } from "react";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Compass,
  GitBranch,
  ListTodo,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Rocket,
  Sparkles,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentArtifact, AgentConversation, AgentEvent, AgentSuggestion, ProjectState } from "@/lib/types";
import {
  ChatMessage,
  StreamingText,
  AgentStepIndicator,
  ChatComposer,
  StarterPrompts,
} from "./agent";
import type { AgentStreamStatus } from "./agent/AgentStepIndicator";
import type { AgentAction } from "./project-actions";
import {
  AgentArtifactCard,
  AgentContextCard,
  AgentErrorCard,
  AgentRunStatusCard,
  AgentSuggestionRow,
  focusReason,
} from "./agent-conversation-cards";

const ALL_AGENT_ACTIONS: {
  id: AgentAction;
  label: string;
  icon: ElementType;
  description: string;
}[] = [
  { id: "clarify", label: "方向澄清", icon: Compass, description: "明确项目目标和边界" },
  { id: "plan", label: "阶段计划", icon: GitBranch, description: "生成阶段计划和时间线" },
  { id: "breakdown", label: "任务拆解", icon: ListTodo, description: "将阶段拆解为具体任务" },
  { id: "assign", label: "分工推荐", icon: Users, description: "根据技能推荐分工" },
  { id: "push", label: "主动推进", icon: Rocket, description: "分析进度并推进项目" },
  { id: "analyze-checkins", label: "签到分析", icon: ClipboardCheck, description: "分析团队签到状态" },
  { id: "risk-analysis", label: "风险分析", icon: AlertTriangle, description: "识别潜在风险" },
  { id: "replan", label: "计划调整", icon: RefreshCw, description: "根据现状调整计划" },
];

const EVENT_STATUS_LABELS: Record<AgentEvent["status"], string> = {
  success: "成功",
  repaired: "已修复",
  fallback: "基础建议",
  failed: "失败",
};

const EVENT_STATUS_CLASSES: Record<AgentEvent["status"], string> = {
  success: "bg-moss/15 text-moss",
  repaired: "bg-citron/40 text-ink",
  fallback: "bg-harbor/15 text-harbor",
  failed: "bg-coral/15 text-coral",
};

const VALID_ARTIFACT_TYPES = new Set(["proposal", "risk_analysis", "action_card", "assignment", "direction", "plan"]);
const VALID_ARTIFACT_STATUSES = new Set(["draft", "pending_confirmation", "confirmed", "dismissed", "expired"]);

function isValidArtifact(value: unknown): value is AgentArtifact {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    VALID_ARTIFACT_TYPES.has(record.type as string) &&
    VALID_ARTIFACT_STATUSES.has(record.status as string) &&
    typeof record.title === "string" &&
    typeof record.summary === "string" &&
    typeof record.rationale === "string" &&
    Array.isArray(record.impact) &&
    Array.isArray(record.linked_entity_ids)
  );
}

interface AgentSidebarProps {
  state: ProjectState;
  selectedProjectId?: string | null;
  hasProject?: boolean;
  conversation?: AgentConversation | null;
  conversationSuggestions?: AgentSuggestion[] | string[];
  conversationArtifacts?: AgentArtifact[];
  pendingConversation?: boolean;
  pendingConversationInstruction?: string | null;
  pendingAction?: AgentAction | null;
  actionSuccess?: string | null;
  actionError?: string | null;
  conversationError?: string | null;
  onRunAgent: (action: AgentAction) => void;
  onSendMessage?: (content: string) => void | Promise<void>;
  streamingBuffer?: string;
  streamStatus?: AgentStreamStatus | null;
  onStopStreaming?: () => void;
  onConfirmArtifact?: (artifact: AgentArtifact) => void | Promise<void>;
  onResetDemo?: () => void | Promise<void>;
}

export function AgentSidebar({
  state,
  hasProject = true,
  conversation,
  conversationSuggestions = [],
  conversationArtifacts = [],
  pendingConversation,
  pendingConversationInstruction = null,
  pendingAction,
  actionSuccess,
  actionError,
  conversationError = null,
  onRunAgent,
  onSendMessage,
  streamingBuffer = "",
  streamStatus = null,
  onStopStreaming,
  onConfirmArtifact,
  onResetDemo,
}: AgentSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.ctrlKey && event.key === "j") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);

  const isExpanded = !collapsed || hovered;
  const recentEvents = (state.timeline ?? []).slice(0, 5);
  const pendingProposalCount = state.agent_proposals?.filter((proposal) => proposal.status === "pending").length ?? 0;
  const focus = conversation?.current_focus || inferFocus(state);
  const messages = conversation?.messages ?? [];
  const normalizedSuggestions = normalizeSuggestions(conversationSuggestions);
  const suggestions = normalizedSuggestions.length > 0 ? normalizedSuggestions : inferStructuredSuggestions(focus);

  const payloadArtifacts = messages.flatMap((message) => {
    const artifacts = message.structured_payload?.artifacts;
    return Array.isArray(artifacts) ? artifacts.filter(isValidArtifact) : [];
  });
  const mergedArtifacts = Array.from(
    new Map([...payloadArtifacts, ...conversationArtifacts].map((artifact) => [artifact.id, artifact])).values()
  );

  const proposalStatusLookup = new Map(
    (state.agent_proposals ?? []).map((p) => [p.id, p.status]),
  );

  const PROPOSAL_STATUS_TO_ARTIFACT: Record<string, AgentArtifact["status"] | undefined> = {
    pending: "pending_confirmation",
    confirmed: "confirmed",
    rejected: "dismissed",
  };

  const visibleArtifacts = mergedArtifacts.map((artifact) => {
    if (artifact.type !== "proposal") return artifact;
    const proposalId = artifact.linked_entity_ids[0];
    if (!proposalId) return artifact;
    const proposalStatus = proposalStatusLookup.get(proposalId);
    if (!proposalStatus) return artifact;
    const mapped = PROPOSAL_STATUS_TO_ARTIFACT[proposalStatus];
    if (!mapped || mapped === artifact.status) return artifact;
    return { ...artifact, status: mapped };
  });

  const submitMessage = async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || !onSendMessage || pendingConversation) return;
    setDraft("");
    await onSendMessage(trimmed);
  };

  return (
    <motion.aside
      className={cn(
        "relative flex h-screen flex-col border-l border-neutral-200/70 bg-bg-sidebar transition-all duration-200 ease-out",
        isExpanded ? "w-80" : "w-12"
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      initial={false}
    >
      <button
        type="button"
        onClick={toggle}
        className="absolute -left-3 top-4 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-400 shadow-sm transition hover:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-moss/30"
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
      >
        {collapsed ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>

      <div className="flex h-14 items-center gap-2 border-b border-neutral-100 px-3">
        <Bot className="h-5 w-5 shrink-0 text-moss" />
        <AnimatePresence>
          {isExpanded && (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden whitespace-nowrap text-sm font-semibold text-neutral-900"
            >
              Agent
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="p-3"
            >
              {!hasProject && (
                <div className="mb-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-center">
                  <Bot className="mx-auto mb-2 h-6 w-6 text-neutral-300" />
                  <p className="text-sm text-neutral-500">选择一个项目以查看 Agent 建议</p>
                </div>
              )}

              {hasProject && (
                <div className="mb-4">
                  <AgentContextCard focus={focus} pendingCount={pendingProposalCount} />

                  <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-neutral-500">
                    <MessageSquare className="h-3.5 w-3.5" />
                    Agent 对话
                  </div>
                  <div className="space-y-2">
                    {messages.length === 0 && !pendingConversationInstruction && (
                      <StarterPrompts
                        focus={focus}
                        onSelect={(instruction) => void submitMessage(instruction)}
                        disabled={Boolean(pendingConversation)}
                      />
                    )}
                    {messages.map((message, index) => (
                      <ChatMessage
                        key={message.id}
                        message={message}
                        isLast={index === messages.length - 1}
                        onRetry={pendingConversationInstruction ? () => void submitMessage(pendingConversationInstruction) : undefined}
                        onAction={(instruction) => void submitMessage(instruction)}
                      />
                    ))}

                    {pendingConversationInstruction && !streamingBuffer && (
                      <ChatMessage
                        message={{
                          id: "pending",
                          conversation_id: "",
                          role: "user",
                          content: pendingConversationInstruction,
                          structured_payload: {},
                          created_at: new Date().toISOString(),
                        }}
                      />
                    )}

                    {streamingBuffer && (
                      <div className="mr-0 rounded-lg border border-moss/20 bg-moss/5 p-3">
                        <div className="mb-1 text-[10px] font-semibold text-neutral-400">Agent</div>
                        <StreamingText buffer={streamingBuffer} />
                      </div>
                    )}
                  </div>

                  {streamStatus && <AgentStepIndicator status={streamStatus} />}
                  {pendingConversation && !streamStatus && <AgentRunStatusCard />}

                  {visibleArtifacts.map((artifact) => (
                    <AgentArtifactCard
                      key={artifact.id}
                      artifact={artifact}
                      disabled={Boolean(pendingConversation)}
                      onConfirm={onConfirmArtifact}
                      onRevise={(item) => void submitMessage(`继续修改：${item.title}`)}
                      onInspect={(item) => void submitMessage(`解释这条建议的影响：${item.title}`)}
                    />
                  ))}

                  {conversationError && (
                    <AgentErrorCard
                      message={conversationError}
                      disabled={Boolean(pendingConversation)}
                      onRetry={pendingConversationInstruction ? () => void submitMessage(pendingConversationInstruction) : undefined}
                    />
                  )}

                  <AgentSuggestionRow
                    suggestions={suggestions}
                    disabled={Boolean(pendingConversation)}
                    onPick={(instruction) => void submitMessage(instruction)}
                  />

                  <ChatComposer
                    value={draft}
                    onChange={setDraft}
                    onSubmit={(text) => void submitMessage(text)}
                    onStop={onStopStreaming}
                    disabled={Boolean(pendingConversation)}
                    isStreaming={Boolean(streamingBuffer)}
                  />
                </div>
              )}

              {actionSuccess && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-3 flex items-start gap-2 rounded-lg border border-moss/20 bg-moss/10 p-2.5 text-xs text-moss"
                >
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{actionSuccess}</span>
                </motion.div>
              )}
              {actionError && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-3 flex items-start gap-2 rounded-lg border border-coral/20 bg-coral/10 p-2.5 text-xs text-coral"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{actionError}</span>
                </motion.div>
              )}

              {recentEvents.length > 0 && (
                <div className="mb-4 border-t border-neutral-100 pt-3">
                  <button
                    type="button"
                    onClick={() => setActivityOpen((open) => !open)}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-xs font-semibold text-neutral-500 transition hover:bg-neutral-50 hover:text-neutral-700"
                    aria-expanded={activityOpen}
                  >
                    <span className="flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" />
                      最近活动
                    </span>
                    <ChevronRight className={cn("h-3 w-3 transition-transform", activityOpen && "rotate-90")} />
                  </button>
                  <AnimatePresence>
                    {activityOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-2 space-y-2">
                          {recentEvents.map((event) => {
                            const Icon = getEventIcon(event.event_type);
                            return (
                              <div key={event.id} className="flex items-start gap-2 text-xs">
                                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" />
                                <div className="min-w-0">
                                  <p className="text-neutral-700">
                                    <span>{getEventLabel(event.event_type)}</span>
                                    <Badge
                                      className={cn(
                                        "ml-1 px-1.5 py-0 text-[10px]",
                                        EVENT_STATUS_CLASSES[event.status]
                                      )}
                                    >
                                      {EVENT_STATUS_LABELS[event.status]}
                                    </Badge>
                                    {event.user_confirmed && <span className="ml-1 text-moss">已确认</span>}
                                  </p>
                                  <p className="mt-0.5 flex items-center gap-1 text-neutral-400">
                                    <Clock className="h-3 w-3" />
                                    {formatTimeAgo(event.created_at)}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {hasProject && (
                <div className="mt-4 border-t border-neutral-100 pt-3">
                  <button
                    type="button"
                    onClick={() => setAdvancedOpen((open) => !open)}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-xs font-semibold text-neutral-500 transition hover:bg-neutral-50 hover:text-neutral-700"
                    aria-expanded={advancedOpen}
                  >
                    <span className="flex items-center gap-1.5">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                      高级操作
                    </span>
                    <ChevronRight className={cn("h-3 w-3 transition-transform", advancedOpen && "rotate-90")} />
                  </button>
                  <AnimatePresence>
                    {advancedOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-1 grid grid-cols-2 gap-1">
                          {ALL_AGENT_ACTIONS.map((action) => {
                            const isPending = pendingAction === action.id;
                            return (
                              <Button
                                key={action.id}
                                variant="ghost"
                                size="sm"
                                className="h-8 justify-start gap-1.5 px-2 text-xs text-neutral-600"
                                disabled={Boolean(pendingAction)}
                                onClick={() => onRunAgent(action.id)}
                              >
                                {isPending ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <action.icon className="h-3.5 w-3.5" />
                                )}
                                {action.label}
                              </Button>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {onResetDemo && (
                <div className="mt-4 border-t border-neutral-100 pt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-full justify-start gap-2 text-xs text-neutral-500 hover:bg-coral/10 hover:text-coral"
                    disabled={Boolean(pendingAction)}
                    onClick={() => onResetDemo()}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    重置演示数据
                  </Button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {!isExpanded && hasProject && (
          <div className="flex flex-col items-center gap-2 py-3">
            <button
              type="button"
              onClick={toggle}
              className="relative flex h-8 w-8 items-center justify-center rounded-lg text-moss transition hover:bg-moss/10 focus:outline-none focus:ring-2 focus:ring-moss/30"
              title="打开 Agent 对话"
            >
              <MessageSquare className="h-4 w-4" />
              {pendingProposalCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-moss px-1 text-[9px] font-semibold text-white">
                  {pendingProposalCount}
                </span>
              )}
            </button>
          </div>
        )}
      </div>
    </motion.aside>
  );
}

const QUICK_REPLY_INSTRUCTION_MAP: Record<string, string> = {
  "生成下一步行动卡": "请执行 push 模块：生成下一步行动卡。用户点击了快捷回复「生成下一步行动卡」，请直接运行 push 模块生成行动卡。",
  "分析当前风险": "请执行 risk 模块：分析当前风险。用户点击了快捷回复「分析当前风险」，请直接运行 risk 模块进行风险分析。",
  "根据签到调整计划": "请执行 replan 模块：根据签到结果调整项目计划。用户点击了快捷回复「根据签到调整计划」，请直接运行 replan 模块生成计划调整草案。",
  "根据成员情况推荐分工": "请执行 assign 模块：根据成员情况推荐分工。用户点击了快捷回复「根据成员情况推荐分工」，请直接运行 assign 模块。",
  "把当前阶段拆成任务": "请执行 breakdown 模块：把当前阶段拆成可执行任务。用户点击了快捷回复「把当前阶段拆成任务」，请直接运行 breakdown 模块。",
  "按三周节奏生成阶段计划": "请执行 plan 模块：按三周节奏生成阶段计划。用户点击了快捷回复「按三周节奏生成阶段计划」，请直接运行 plan 模块。",
  "先帮我澄清方向": "请执行 clarify 模块：澄清项目方向。用户点击了快捷回复「先帮我澄清方向」，请直接运行 clarify 模块。",
};

function mapQuickReplyInstruction(label: string): string {
  return QUICK_REPLY_INSTRUCTION_MAP[label] ?? label;
}

function normalizeSuggestions(items: AgentSuggestion[] | string[]): AgentSuggestion[] {
  return items.map((item, index) =>
    typeof item === "string"
      ? { id: `suggestion-${index + 1}`, label: item, user_instruction: mapQuickReplyInstruction(item), priority: index === 0 ? "primary" : "secondary" }
      : item
  );
}

function inferFocus(state: ProjectState): string {
  if (!state.project?.direction_card) return "方向澄清";
  if (!state.stages || state.stages.length === 0) return "阶段计划";
  if (!state.tasks || state.tasks.length === 0) return "任务拆解";
  const hasFinalized = state.assignment_proposals?.some((proposal) => proposal.status === "finalized");
  if (!hasFinalized) return "分工确认";
  return "执行推进";
}

function inferSuggestions(focus: string): string[] {
  const suggestions: Record<string, string[]> = {
    方向澄清: ["先帮我澄清方向", "根据资料生成方向卡", "为什么要先澄清方向？"],
    阶段计划: ["按三周节奏生成阶段计划", "按答辩倒排阶段", "解释阶段规划依据"],
    任务拆解: ["把当前阶段拆成任务", "任务拆得更细一点", "优先保留 MVP 任务"],
    分工确认: ["根据成员情况推荐分工", "解释分工依据", "查看未确认分工"],
    执行推进: ["生成下一步行动卡", "分析当前风险", "根据签到调整计划"],
  };
  return suggestions[focus] ?? ["下一步做什么？"];
}

function inferStructuredSuggestions(focus: string): AgentSuggestion[] {
  return inferSuggestions(focus).slice(0, 3).map((label, index) => ({
    id: `fallback-suggestion-${index + 1}`,
    label,
    user_instruction: mapQuickReplyInstruction(label),
    priority: index === 0 ? "primary" : "secondary",
  }));
}

function getEventIcon(eventType: AgentEvent["event_type"]) {
  switch (eventType) {
    case "clarify":
      return Compass;
    case "plan":
      return GitBranch;
    case "breakdown":
      return ListTodo;
    case "assign":
      return Users;
    case "push":
      return Rocket;
    case "checkin":
      return ClipboardCheck;
    case "risk":
      return AlertTriangle;
    case "replan":
      return RefreshCw;
    default:
      return Sparkles;
  }
}

function getEventLabel(eventType: AgentEvent["event_type"]) {
  const action = ALL_AGENT_ACTIONS.find((candidate) => candidate.id === eventType);
  return action?.label || eventType;
}

function formatTimeAgo(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  return `${diffDays}天前`;
}

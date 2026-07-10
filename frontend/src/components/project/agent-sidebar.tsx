"use client";

import type { ElementType } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AgentArtifact, AgentConversation, AgentEvent, AgentSuggestion, ProjectState, ThinkingLevel, ModelConfigEntry } from "@/lib/types";
import {
  ChatMessage,
  StreamingText,
  AgentStepIndicator,
  ChatComposer,
  StarterPrompts,
  AgentGuidedTour,
  useGuidedTour,
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

// 拖动调整宽度相关常量
const SIDEBAR_MIN_WIDTH = 280; // 最小宽度 280px (17.5rem)
const SIDEBAR_MAX_WIDTH = 600; // 最大宽度 600px (37.5rem)
const SIDEBAR_DEFAULT_WIDTH = 352; // 默认宽度 22rem
const SIDEBAR_WIDTH_STORAGE_KEY = "agent-sidebar-width";

const ALL_AGENT_ACTIONS: {
  id: AgentAction;
  label: string;
  icon: ElementType;
  description: string;
  category: string;
}[] = [
  { id: "clarify", label: "方向澄清", icon: Compass, description: "明确项目目标和边界", category: "规划" },
  { id: "plan", label: "阶段计划", icon: GitBranch, description: "生成阶段计划和时间线", category: "规划" },
  { id: "breakdown", label: "任务拆解", icon: ListTodo, description: "将阶段拆解为具体任务", category: "规划" },
  { id: "assign", label: "分工推荐", icon: Users, description: "根据技能推荐分工", category: "分工" },
  { id: "push", label: "主动推进", icon: Rocket, description: "分析进度并推进项目", category: "执行" },
  { id: "analyze-checkins", label: "签到分析", icon: ClipboardCheck, description: "分析团队签到状态", category: "执行" },
  { id: "risk-analysis", label: "风险分析", icon: AlertTriangle, description: "识别潜在风险", category: "执行" },
  { id: "replan", label: "计划调整", icon: RefreshCw, description: "根据现状调整计划", category: "执行" },
];

const ACTION_CATEGORIES = ["规划", "分工", "执行"] as const;

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
  onRunAgent: (action: AgentAction, thinkingLevel?: ThinkingLevel, model?: { provider: string; name: string }) => void;
  onSendMessage?: (content: string) => void | Promise<void>;
  streamingBuffer?: string;
  streamStatus?: AgentStreamStatus | null;
  onStopStreaming?: () => void;
  onConfirmArtifact?: (artifact: AgentArtifact) => void | Promise<void>;
  onResetDemo?: () => void | Promise<void>;
}

export function AgentSidebar({
  state,
  selectedProjectId,
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [modelConfigs, setModelConfigs] = useState<ModelConfigEntry[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  // Load model configs from sidecar on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getModelConfigs } = await import("@/lib/api");
        const configs = await getModelConfigs();
        if (cancelled) return;
        setModelConfigs(configs);
        // Restore from localStorage or use default
        const saved = localStorage.getItem("pf:selected-model-id");
        if (saved && configs.some((c) => c.id === saved && c.valid)) {
          setSelectedModelId(saved);
        } else {
          const def = configs.find((c) => c.isDefault && c.valid);
          setSelectedModelId(def?.id ?? null);
        }
        setModelsLoaded(true);
      } catch {
        // Sidecar not available — models will remain empty
        setModelsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [activityOpen, setActivityOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [actionLog, setActionLog] = useState<Array<{ id: string; artifactId: string; type: "confirmed" | "dismissed"; text: string }>>([]);
  const { active: tourActive, complete: tourComplete } = useGuidedTour();

  // 拖动调整宽度状态
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) {
        return parsed;
      }
    }
    return SIDEBAR_DEFAULT_WIDTH;
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // 拖动开始
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
  }, [sidebarWidth]);

  // 拖动中（使用 useEffect 绑定全局事件）
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = dragStartX.current - e.clientX; // 向左拖动为正
      const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, dragStartWidth.current + delta));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      // 保存到 localStorage
      setSidebarWidth((current) => {
        localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(current));
        return current;
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    // 拖动时禁用文本选择
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isDragging]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDismissedIds(new Set());
      setConfirmedIds(new Set());
      setActionLog([]);
    }, 0);
    return () => clearTimeout(timeout);
  }, [selectedProjectId]);

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

  const isExpanded = !collapsed;
  const recentEvents = (state.timeline ?? []).slice(0, 5);
  const pendingProposalCount = state.agent_proposals?.filter((proposal) => proposal.status === "pending").length ?? 0;
  const focus = conversation?.current_focus || inferFocus(state);
  const messages = useMemo(() => conversation?.messages ?? [], [conversation]);
  const normalizedSuggestions = normalizeSuggestions(conversationSuggestions);
  const suggestions = normalizedSuggestions.length > 0 ? normalizedSuggestions : inferStructuredSuggestions(focus);

  const payloadArtifacts = useMemo(
    () => messages.flatMap((message) => {
      const artifacts = message.structured_payload?.artifacts;
      return Array.isArray(artifacts) ? artifacts.filter(isValidArtifact) : [];
    }),
    [messages],
  );
  const mergedArtifacts = useMemo(
    () => Array.from(
      new Map([...payloadArtifacts, ...conversationArtifacts].map((artifact) => [artifact.id, artifact])).values(),
    ),
    [payloadArtifacts, conversationArtifacts],
  );

  const proposalStatusLookup = useMemo(
    () => new Map((state.agent_proposals ?? []).map((p) => [p.id, p.status])),
    [state.agent_proposals],
  );

  const visibleArtifacts = useMemo(
    () => {
      const PROPOSAL_STATUS_TO_ARTIFACT: Record<string, AgentArtifact["status"] | undefined> = {
        pending: "pending_confirmation",
        confirmed: "confirmed",
        rejected: "dismissed",
      };
      return mergedArtifacts
        .map((artifact) => {
          if (artifact.type !== "proposal") return artifact;
          const proposalId = artifact.linked_entity_ids[0];
          if (!proposalId) return artifact;
          const proposalStatus = proposalStatusLookup.get(proposalId);
          if (!proposalStatus) return artifact;
          const mapped = PROPOSAL_STATUS_TO_ARTIFACT[proposalStatus];
          if (!mapped || mapped === artifact.status) return artifact;
          return { ...artifact, status: mapped };
        })
        .filter((artifact) => !dismissedIds.has(artifact.id) && artifact.status !== "confirmed" && artifact.status !== "dismissed");
    },
    [mergedArtifacts, proposalStatusLookup, dismissedIds],
  );

  const handleDismissArtifact = useCallback((artifact: AgentArtifact) => {
    setDismissedIds((prev) => new Set(prev).add(artifact.id));
    setActionLog((prev) => [...prev, { id: `dismiss-${artifact.id}`, artifactId: artifact.id, type: "dismissed", text: `已忽略「${artifact.title}」` }]);
  }, []);

  const handleConfirmArtifact = useCallback(async (artifact: AgentArtifact) => {
    if (onConfirmArtifact) {
      await onConfirmArtifact(artifact);
    }
    setConfirmedIds((prev) => new Set(prev).add(artifact.id));
    setActionLog((prev) => [...prev, { id: `confirm-${artifact.id}`, artifactId: artifact.id, type: "confirmed", text: `已确认「${artifact.title}」` }]);
  }, [onConfirmArtifact]);

  const handleUndoDismiss = useCallback((entry: { id: string; artifactId: string }) => {
    setActionLog((prev) => prev.filter((e) => e.id !== entry.id));
    setDismissedIds((prev) => { const next = new Set(prev); next.delete(entry.artifactId); return next; });
  }, []);

  useEffect(() => {
    if (confirmedIds.size === 0) return;
    const timer = setTimeout(() => {
      setDismissedIds((prev) => {
        const next = new Set(prev);
        confirmedIds.forEach((id) => next.add(id));
        return next;
      });
      setConfirmedIds(new Set());
    }, 3000);
    return () => clearTimeout(timer);
  }, [confirmedIds]);

  const submitMessage = async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || !onSendMessage || pendingConversation) return;
    setDraft("");
    await onSendMessage(trimmed);
  };

  return (
    <motion.aside
      data-tour-sidebar
      className={cn(
        "relative flex h-screen flex-col border-l border-neutral-200/70 bg-bg-sidebar",
        collapsed ? "w-12" : "",
        isDragging && "select-none"
      )}
      style={!collapsed ? { width: `${sidebarWidth}px`, transition: isDragging ? "none" : "width 200ms ease-out" } : undefined}
      initial={false}
    >
      <AgentGuidedTour active={tourActive && isExpanded && hasProject} onComplete={tourComplete} />
      <button
        type="button"
        onClick={toggle}
        className="absolute -left-3 top-4 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-400 shadow-sm transition hover:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-neutral-300"
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
      >
        {collapsed ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>

      {/* 拖动调整宽度的手柄 */}
      {isExpanded && (
        <div
          className="absolute left-0 top-0 z-20 h-full w-1.5 cursor-col-resize group"
          onMouseDown={handleDragStart}
        >
          <div className={cn(
            "absolute left-0 top-1/2 -translate-y-1/2 h-12 w-1 rounded-r-full transition-all",
            isDragging ? "bg-moss" : "bg-neutral-300 group-hover:bg-moss"
          )} />
        </div>
      )}

      <div className="flex h-14 items-center gap-2 border-b border-neutral-100 px-3" data-tour="header">
        <Bot className="h-5 w-5 shrink-0 text-neutral-600" />
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
        <div
          className="transition-all duration-200 overflow-hidden p-3"
          style={{
            width: isExpanded ? "100%" : 0,
            opacity: isExpanded ? 1 : 0,
            maxHeight: isExpanded ? "none" : 0,
          }}
        >
              {!hasProject && (
                <div className="mb-4 space-y-4">
                  <div className="rounded-md border border-neutral-200 bg-white p-4 text-center">
                    <Bot className="mx-auto mb-3 h-8 w-8 text-neutral-600" />
                    <p className="text-sm font-semibold text-neutral-800">Agent 助手</p>
                    <p className="mt-1 text-xs leading-5 text-neutral-500">
                      选择或创建一个项目开始。Agent 会通过对话帮你推进，所有建议你确认后才会生效。
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        const event = new CustomEvent("projectflow:create-project");
                        window.dispatchEvent(event);
                      }}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-moss px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-moss/20 transition hover:bg-moss/90 active:shadow-none"
                    >
                      <Rocket className="h-3.5 w-3.5" />
                      创建项目
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-start gap-2.5 rounded-md bg-neutral-50 p-2.5">
                      <Compass className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" />
                      <div>
                        <p className="text-xs font-medium text-neutral-700">方向澄清</p>
                        <p className="text-[11px] text-neutral-500">明确项目目标和边界</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5 rounded-md bg-neutral-50 p-2.5">
                      <ListTodo className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" />
                      <div>
                        <p className="text-xs font-medium text-neutral-700">任务拆解</p>
                        <p className="text-[11px] text-neutral-500">把阶段目标拆成可执行任务</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5 rounded-md bg-neutral-50 p-2.5">
                      <Rocket className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" />
                      <div>
                        <p className="text-xs font-medium text-neutral-700">主动推进</p>
                        <p className="text-[11px] text-neutral-500">分析进度并建议下一步行动</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {hasProject && (
                <div className="mb-4">
                  {/* Layer 1: Context & Priority Alerts */}
                  <div data-tour="context">
                    <AgentContextCard focus={focus} pendingCount={pendingProposalCount} />
                  </div>

                  {/* Layer 2: Pending Artifacts (highest priority) */}
                  <AnimatePresence mode="popLayout">
                    {visibleArtifacts.map((artifact) => (
                      <AgentArtifactCard
                        key={artifact.id}
                        artifact={artifact}
                        disabled={Boolean(pendingConversation)}
                        onConfirm={handleConfirmArtifact}
                        onDismiss={handleDismissArtifact}
                        onRevise={(item) => void submitMessage(`继续修改：${item.title}`)}
                        onInspect={(item) => void submitMessage(`解释这条建议的影响：${item.title}`)}
                      />
                    ))}
                  </AnimatePresence>

                  {/* Layer 3: Conversation Stream */}
                  <div className="mt-6 border-t border-neutral-100 pt-4">
                    <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-neutral-400">
                      <MessageSquare className="h-3.5 w-3.5" />
                      对话
                    </div>
                    <div className="space-y-2">
                      {messages.length === 0 && !pendingConversationInstruction && (
                        <div data-tour="prompts">
                          <StarterPrompts
                            focus={focus}
                            onSelect={(instruction) => void submitMessage(instruction)}
                            disabled={Boolean(pendingConversation)}
                          />
                        </div>
                      )}
                      {messages.map((message, index) => (
                        <ChatMessage
                          key={message.id}
                          message={message}
                          isLast={index === messages.length - 1}
                          index={index}
                          onRetry={pendingConversationInstruction ? () => void submitMessage(pendingConversationInstruction) : undefined}
                          onAction={(instruction) => void submitMessage(instruction)}
                        />
                      ))}

                      {/* Action log: inline confirm/dismiss records */}
                      {actionLog.length > 0 && (
                        <div className="space-y-1 rounded-md border border-neutral-100 bg-neutral-50/50 p-2">
                          {actionLog.map((entry) => (
                            <motion.div
                              key={entry.id}
                              initial={{ opacity: 0, y: 2 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.12 }}
                              className="flex items-center gap-1.5 text-[11px]"
                            >
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 shrink-0 rounded-full",
                                  entry.type === "confirmed" ? "bg-moss" : "bg-neutral-400",
                                )}
                              />
                              <span className={entry.type === "confirmed" ? "text-moss" : "text-neutral-500"}>
                                {entry.text}
                              </span>
                              {entry.type === "dismissed" && (
                                <button
                                  type="button"
                                  onClick={() => handleUndoDismiss(entry)}
                                  className="ml-auto text-[10px] text-neutral-400 underline decoration-dotted underline-offset-2 hover:text-neutral-600"
                                  title="恢复此建议"
                                >
                                  撤销
                                </button>
                              )}
                            </motion.div>
                          ))}
                        </div>
                      )}

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
                        <div className="mr-0 rounded-md border border-neutral-200 bg-neutral-50 p-3">
                          <div className="mb-1 text-[10px] font-semibold text-neutral-400">Agent</div>
                          <StreamingText buffer={streamingBuffer} />
                        </div>
                      )}
                    </div>

                    {streamStatus && <AgentStepIndicator status={streamStatus} />}
                    {pendingConversation && !streamStatus && <AgentRunStatusCard />}

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

                    <div className="mt-3" data-tour="composer">
                      <ChatComposer
                        value={draft}
                        onChange={setDraft}
                        onSubmit={(text) => void submitMessage(text)}
                        onStop={onStopStreaming}
                        disabled={Boolean(pendingConversation)}
                        isStreaming={Boolean(streamingBuffer)}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Action Feedback */}
              {actionSuccess && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-3 flex items-start gap-2 rounded-md border border-moss/20 bg-moss/10 p-2.5 text-xs text-moss"
                >
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{actionSuccess}</span>
                </motion.div>
              )}
              {actionError && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-3 flex items-start gap-2 rounded-md border border-coral/20 bg-coral/10 p-2.5 text-xs text-coral"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{actionError}</span>
                </motion.div>
              )}

              {/* Layer 4: Recent Activity (collapsed by default) */}
              {recentEvents.length > 0 && (
                <div className="mb-4 border-t border-neutral-100 pt-3">
                  <button
                    type="button"
                    onClick={() => setActivityOpen((open) => !open)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-xs font-semibold text-neutral-500 transition hover:bg-neutral-50 hover:text-neutral-700"
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
                        initial={{ maxHeight: 0, opacity: 0 }}
                        animate={{ maxHeight: 500, opacity: 1 }}
                        exit={{ maxHeight: 0, opacity: 0 }}
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

              {/* Layer 5: Advanced Actions (collapsed by default) */}
              {hasProject && (
                <div className="mt-4 border-t border-neutral-100 pt-3">
                  <button
                    type="button"
                    onClick={() => setAdvancedOpen((open) => !open)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-xs font-semibold text-neutral-500 transition hover:bg-neutral-50 hover:text-neutral-700"
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
                        initial={{ maxHeight: 0, opacity: 0 }}
                        animate={{ maxHeight: 500, opacity: 1 }}
                        exit={{ maxHeight: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-1 space-y-2">
                          {/* Model selector */}
                          {modelsLoaded && modelConfigs.length > 0 && (
                            <div className="flex items-center gap-2 px-2">
                              <span className="text-[10px] font-medium text-neutral-400">模型</span>
                              <Select
                                value={selectedModelId ?? undefined}
                                onValueChange={(v) => {
                                  if (v) {
                                    setSelectedModelId(v);
                                    localStorage.setItem("pf:selected-model-id", v);
                                  }
                                }}
                              >
                                <SelectTrigger size="sm" className="h-6 w-auto min-w-28 text-[11px]">
                                  <SelectValue placeholder="选择模型" />
                                </SelectTrigger>
                                <SelectContent>
                                  {modelConfigs
                                    .filter((c) => c.valid)
                                    .map((model) => (
                                      <SelectItem key={model.id} value={model.id}>
                                        {model.displayName}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                          <div className="flex items-center gap-2 px-2">
                            <span className="text-[10px] font-medium text-neutral-400">思考强度</span>
                            <Select value={thinkingLevel} onValueChange={(v) => setThinkingLevel(v as ThinkingLevel)}>
                              <SelectTrigger size="sm" className="h-6 w-auto min-w-20 text-[11px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="low">low</SelectItem>
                                <SelectItem value="medium">medium</SelectItem>
                                <SelectItem value="high">high</SelectItem>
                                <SelectItem value="xhigh">xhigh</SelectItem>
                                <SelectItem value="max">max</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {ACTION_CATEGORIES.map((category) => {
                            const actions = ALL_AGENT_ACTIONS.filter((a) => a.category === category);
                            return (
                              <div key={category}>
                                <p className="mb-1 px-2 text-[10px] font-medium text-neutral-400">{category}</p>
                                <div className="grid grid-cols-2 gap-1">
                                  {actions.map((action) => {
                                    const isPending = pendingAction === action.id;
                                    return (
                                      <Button
                                        key={action.id}
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 justify-start gap-1.5 px-2 text-xs text-neutral-600"
                                        disabled={Boolean(pendingAction)}
                                        title={action.description}
                                        onClick={() => {
                                          const selectedModel = selectedModelId ? modelConfigs.find((c) => c.id === selectedModelId) : undefined;
                                          const modelRef = selectedModel ? { provider: selectedModel.provider, name: selectedModel.name } : undefined;
                                          onRunAgent(action.id, thinkingLevel, modelRef);
                                        }}
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
                              </div>
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
        </div>

        {!isExpanded && hasProject && (
          <CollapsedSidebarIcons focus={focus} pendingCount={pendingProposalCount} isStreaming={Boolean(streamingBuffer)} onToggle={toggle} />
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

const FOCUS_ICON_MAP: Record<string, ElementType> = {
  方向澄清: Compass,
  阶段计划: GitBranch,
  任务拆解: ListTodo,
  分工确认: Users,
  执行推进: Rocket,
};

function CollapsedSidebarIcons({
  focus,
  pendingCount,
  isStreaming,
  onToggle,
}: {
  focus: string;
  pendingCount: number;
  isStreaming: boolean;
  onToggle: () => void;
}) {
  const Icon = FOCUS_ICON_MAP[focus] ?? Compass;

  return (
    <div className="flex flex-col items-center gap-1.5 py-3">
      {/* Current stage indicator */}
      <div className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500" title={`当前阶段：${focus}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>

      {/* Main toggle button */}
      <button
        type="button"
        onClick={onToggle}
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-300"
        title="打开 Agent 对话"
        aria-label="打开 Agent 对话"
      >
        <MessageSquare className="h-4 w-4" />
        {pendingCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-moss px-1 text-[9px] font-semibold text-white">
            {pendingCount}
          </span>
        )}
        {isStreaming && (
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-coral animate-pulse" aria-hidden="true" />
        )}
      </button>
    </div>
  );
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

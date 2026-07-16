"use client";

import type { ElementType } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Compass,
  GitBranch,
  History,
  ListTodo,
  Loader2,
  Lock,
  MessageSquare,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  Users,
  XCircle,
  ArrowDown,
  LockKeyhole,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type {
  AgentArtifact,
  AgentConversation,
  AgentConversationMessage,
  AgentConversationSummary,
  AgentSuggestion,
  AgentStreamTurn,
  ArchivedAgentStreamTurn,
  ProjectState,
  ThinkingLevel,
  ModelConfigEntry,
} from "@/lib/types";
import { sendSteering, cancelRun } from "@/lib/api";
import {
  ChatMessage,
  StreamingText,
  AgentStepIndicator,
  ChatComposer,
  StarterPrompts,
} from "../agent";
import type { AgentStreamStatus } from "../agent/AgentStepIndicator";
import type { AgentAction } from "../project-actions";
import {
  AgentArtifactCard,
  AgentContextCard,
  AgentErrorCard,
  AgentRunStatusCard,
  AgentSuggestionRow,
  focusReason,
} from "../agent-conversation-cards";

const OPTIMISTIC_MESSAGE_MATCH_WINDOW_MS = 2 * 60 * 1000;

function getDismissedStorageKey(projectId: string | null | undefined) {
  return projectId ? `agent-artifacts-dismissed:${projectId}` : "";
}

function createLocalStorageSetStore(key: string) {
  return {
    getSnapshot: () => {
      if (typeof window === "undefined") return "";
      try {
        return window.localStorage.getItem(key) ?? "";
      } catch {
        return "";
      }
    },
    subscribe: (callback: () => void) => {
      const handler = (e: StorageEvent) => {
        if (e.key === key) callback();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
  };
}

function useLocalStorageSet(key: string | null): [Set<string>, (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void] {
  const store = useMemo(() => (key ? createLocalStorageSetStore(key) : null), [key]);
  const raw = useSyncExternalStore(
    store ? store.subscribe : () => () => {},
    store ? store.getSnapshot : () => "",
    () => "",
  );
  const value = useMemo(() => {
    if (!raw) return new Set<string>();
    try {
      return new Set<string>(JSON.parse(raw));
    } catch {
      return new Set<string>();
    }
  }, [raw]);
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);
  const set = useCallback(
    (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      if (!key || typeof window === "undefined") return;
      try {
        const resolved = typeof next === "function" ? next(valueRef.current) : next;
        window.localStorage.setItem(key, JSON.stringify(Array.from(resolved)));
        window.dispatchEvent(new StorageEvent("storage", { key }));
      } catch {
        // ignore storage errors
      }
    },
    [key],
  );
  return [value, set];
}

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

interface ConversationTimelineEntry {
  key: string;
  sortAt: number;
  message: AgentConversationMessage;
  turn?: AgentStreamTurn;
}

function archivedAssistantMessage(turn: AgentStreamTurn): AgentConversationMessage {
  const answer = turn.finalContent ?? Object.values(turn.blocks)
    .filter((block) => block.kind === "text")
    .sort((a, b) => a.order - b.order)
    .map((block) => block.content)
    .join("");
  return {
    id: `${turn.clientTurnId}-assistant`,
    conversation_id: turn.userMessage?.conversation_id ?? "",
    role: "assistant",
    content: answer,
    structured_payload: {
      activities: turn.activities,
      run_summary: turn.runSummary,
    },
    created_at: turn.userMessage?.created_at ?? new Date().toISOString(),
  };
}

interface AgentConversationPageProps {
  state: ProjectState;
  currentUserId?: string;
  conversation?: AgentConversation | null;
  conversationSuggestions?: AgentSuggestion[] | string[];
  conversationArtifacts?: AgentArtifact[];
  pendingConversationInstruction?: string | null;
  conversationError?: string | null;
  pendingConversation?: boolean;
  pendingAction?: AgentAction | null;
  actionError?: string | null;
  actionSuccess?: string | null;
  onSendMessage?: (content: string, options?: { model?: string; thinkingLevel?: string; skill?: string; slashCommand?: string }) => void | Promise<void>;
  streamTurn?: AgentStreamTurn | null;
  archivedStreamTurns?: ArchivedAgentStreamTurn[];
  streamStatus?: AgentStreamStatus | null;
  activeRunId?: string | null;
  onStopStreaming?: () => void;
  onToggleThinking?: () => void;
  onConfirmArtifact?: (artifact: AgentArtifact) => void | Promise<void>;
  completedAnnouncement?: string | null;
  // T45 conversation history
  conversationSummaries?: AgentConversationSummary[];
  isDraft?: boolean;
  isStreamingConversation?: boolean;
  isLoadingHistory?: boolean;
  isLoadingConversationDetail?: boolean;
  historyError?: string | null;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  onStartNewDraft?: () => void;
  onSwitchConversation?: (conversationId: string) => void;
  onRetryHistory?: () => void;
  onLoadOlderMessages?: () => void;
  // Shared state props
  draft?: string;
  onDraftChange?: (val: string) => void;
  thinkingLevelProp?: ThinkingLevel | null;
  onThinkingLevelChange?: (val: ThinkingLevel | null) => void;
  selectedModelIdProp?: string | null;
  onSelectedModelIdChange?: (val: string | null) => void;
  onRunAgent?: (action: AgentAction, thinkingLevel?: ThinkingLevel, model?: { provider: string; name: string }) => void;
}

export function AgentConversationPage({
  state,
  currentUserId,
  conversation,
  conversationSuggestions = [],
  conversationArtifacts = [],
  pendingConversationInstruction = null,
  conversationError = null,
  pendingConversation,
  pendingAction,
  actionError,
  actionSuccess,
  onSendMessage,
  streamTurn = null,
  archivedStreamTurns = [],
  streamStatus = null,
  activeRunId = null,
  onStopStreaming,
  onToggleThinking,
  onConfirmArtifact,
  completedAnnouncement,
  // T45 conversation history
  conversationSummaries = [],
  isDraft = false,
  isStreamingConversation = false,
  isLoadingHistory = false,
  isLoadingConversationDetail = false,
  historyError = null,
  hasOlderMessages = false,
  isLoadingOlder = false,
  onStartNewDraft,
  onSwitchConversation,
  onRetryHistory,
  onLoadOlderMessages,
  // Shared props
  draft: draftProp,
  onDraftChange,
  thinkingLevelProp,
  onThinkingLevelChange,
  selectedModelIdProp,
  onSelectedModelIdChange,
  onRunAgent,
}: AgentConversationPageProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [localThinkingLevel, setLocalThinkingLevel] = useState<ThinkingLevel | null>(null);
  const thinkingLevel = thinkingLevelProp !== undefined ? thinkingLevelProp : localThinkingLevel;
  const setThinkingLevel = onThinkingLevelChange !== undefined ? onThinkingLevelChange : setLocalThinkingLevel;

  const [modelConfigs, setModelConfigs] = useState<ModelConfigEntry[]>([]);
  const [localSelectedModelId, setLocalSelectedModelId] = useState<string | null>(null);
  const selectedModelId = selectedModelIdProp !== undefined ? selectedModelIdProp : localSelectedModelId;
  const setSelectedModelId = onSelectedModelIdChange !== undefined ? onSelectedModelIdChange : setLocalSelectedModelId;
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const isNearBottomRef = useRef(true);

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
        setModelsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [setSelectedModelId]);

  const [localDraft, setLocalDraft] = useState("");
  const draft = draftProp !== undefined ? draftProp : localDraft;
  const setDraft = onDraftChange !== undefined ? onDraftChange : setLocalDraft;

  const selectedProjectId = state.project?.id;
  const [dismissedIds, setDismissedIds] = useLocalStorageSet(getDismissedStorageKey(selectedProjectId));
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [actionLog, setActionLog] = useState<Array<{ id: string; artifactId: string; type: "confirmed" | "dismissed"; text: string }>>([]);
  const [steeringError, setSteeringError] = useState<string | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDismissedIds(new Set());
      setConfirmedIds(new Set());
      setActionLog([]);
    }, 0);
    return () => clearTimeout(timeout);
  }, [selectedProjectId, setDismissedIds]);

  const isRunning = !!activeRunId;
  const pendingProposalCount = state.agent_proposals?.filter((proposal) => proposal.status === "pending").length ?? 0;

  const inferFocus = (state: ProjectState): string => {
    if (!state.project?.direction_card) return "方向澄清";
    if (!state.stages || state.stages.length === 0) return "阶段计划";
    if (!state.tasks || state.tasks.length === 0) return "任务拆解";
    const hasFinalized = state.assignment_proposals?.some((proposal) => proposal.status === "finalized");
    if (!hasFinalized) return "分工确认";
    return "执行推进";
  };

  const focus = conversation?.current_focus || inferFocus(state);
  const messages = useMemo(() => conversation?.messages ?? [], [conversation]);

  const timelineEntries = useMemo<ConversationTimelineEntry[]>(() => {
    const entries: ConversationTimelineEntry[] = messages.map((message, index) => ({
      key: message.id,
      sortAt: Date.parse(message.created_at) + index / 1000,
      message,
    }));

    for (const archived of archivedStreamTurns) {
      const userMessage = archived.turn.userMessage;
      if (!userMessage) continue;
      const optimisticTime = Date.parse(userMessage.created_at);
      const matchingPersistedUser = messages
        .filter((message) => message.role === "user" && message.content === userMessage.content)
        .map((message) => ({ message, distance: Math.abs(Date.parse(message.created_at) - optimisticTime) }))
        .filter(({ distance }) => distance <= OPTIMISTIC_MESSAGE_MATCH_WINDOW_MS)
        .sort((a, b) => a.distance - b.distance)[0]?.message;
      const userSortAt = matchingPersistedUser ? Date.parse(matchingPersistedUser.created_at) : optimisticTime;

      if (!matchingPersistedUser) {
        entries.push({ key: `${archived.turn.clientTurnId}-user`, sortAt: userSortAt, message: userMessage });
      }
      entries.push({
        key: `${archived.turn.clientTurnId}-assistant`,
        sortAt: userSortAt + 0.5,
        message: archivedAssistantMessage(archived.turn),
        turn: archived.turn,
      });
    }

    return entries.sort((a, b) => a.sortAt - b.sortAt);
  }, [archivedStreamTurns, messages]);

  const QUICK_REPLY_INSTRUCTION_MAP: Record<string, string> = {
    "生成下一步行动卡": "请执行 push 模块：生成下一步行动卡。用户点击了快捷回复「生成下一步行动卡」，请直接运行 push 模块生成行动卡。",
    "分析当前风险": "请执行 risk 模块：分析当前风险。用户点击了快捷回复「分析当前风险」，请直接运行 risk 模块进行风险分析。",
    "根据签到调整计划": "请执行 replan 模块：根据签到结果调整项目计划。用户点击了快捷回复「根据签到调整计划」，请直接运行 replan 模块生成计划调整草案。",
    "根据成员情况推荐分工": "请执行 assign 模块：根据成员情况推荐分工。用户点击了快捷回复「根据成员情况推荐分工」，请直接运行 assign 模块。",
    "把当前阶段拆成任务": "请执行 breakdown 模块：把当前阶段拆成可执行任务。用户点击了快捷回复「把当前阶段拆成任务」，请直接运行 breakdown 模块。",
    "按三周节奏生成阶段计划": "请执行 plan 模块：按三周节奏生成阶段计划。用户点击了快捷回复「按三周节奏生成阶段计划」，请直接运行 plan 模块。",
    "先帮我澄清方向": "请执行 clarify 模块：澄清项目方向。用户点击了快捷回复「先帮我澄清方向」，请直接运行 clarify 模块。",
  };

  const mapQuickReplyInstruction = (label: string): string => {
    return QUICK_REPLY_INSTRUCTION_MAP[label] ?? label;
  };

  const normalizeSuggestions = (items: AgentSuggestion[] | string[]): AgentSuggestion[] => {
    return items.map((item, index) =>
      typeof item === "string"
        ? { id: `suggestion-${index + 1}`, label: item, user_instruction: mapQuickReplyInstruction(item), priority: index === 0 ? "primary" : "secondary" }
        : item
    );
  };

  const inferSuggestions = (focus: string): string[] => {
    const suggestions: Record<string, string[]> = {
      方向澄清: ["先帮我澄清方向", "根据资料生成方向卡", "为什么要先澄清方向？"],
      阶段计划: ["按三周节奏生成阶段计划", "按答辩倒排阶段", "解释阶段规划依据"],
      任务拆解: ["把当前阶段拆成任务", "任务拆得更细一点", "优先保留 MVP 任务"],
      分工确认: ["根据成员情况推荐分工", "解释分工依据", "查看未确认分工"],
      执行推进: ["生成下一步行动卡", "分析当前风险", "根据签到调整计划"],
    };
    return suggestions[focus] ?? ["下一步做什么？"];
  };

  const inferStructuredSuggestions = (focus: string): AgentSuggestion[] => {
    return inferSuggestions(focus).slice(0, 3).map((label, index) => ({
      id: `fallback-suggestion-${index + 1}`,
      label,
      user_instruction: mapQuickReplyInstruction(label),
      priority: index === 0 ? "primary" : "secondary",
    }));
  };

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
    const next = new Set(dismissedIds);
    next.add(artifact.id);
    setDismissedIds(next);
    setActionLog((prev) => [...prev, { id: `dismiss-${artifact.id}`, artifactId: artifact.id, type: "dismissed", text: `已忽略「${artifact.title}」` }]);
  }, [dismissedIds, setDismissedIds, setActionLog]);

  const handleConfirmArtifact = useCallback(async (artifact: AgentArtifact) => {
    try {
      if (onConfirmArtifact) {
        await onConfirmArtifact(artifact);
      }
      setConfirmedIds((prev) => new Set(prev).add(artifact.id));
      setActionLog((prev) => [...prev, { id: `confirm-${artifact.id}`, artifactId: artifact.id, type: "confirmed", text: `已确认「${artifact.title}」` }]);
    } catch {
      setSteeringError("确认建议失败，请重试");
    }
  }, [onConfirmArtifact, setConfirmedIds, setActionLog, setSteeringError]);

  const handleUndoDismiss = useCallback((entry: { id: string; artifactId: string }) => {
    setActionLog((prev) => prev.filter((e) => e.id !== entry.id));
    const next = new Set(dismissedIds);
    next.delete(entry.artifactId);
    setDismissedIds(next);
  }, [dismissedIds, setDismissedIds, setActionLog]);

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
  }, [confirmedIds, setDismissedIds]);

  const submitMessage = async (content: string, options?: { skill?: string; slashCommand?: string }) => {
    const trimmed = content.trim();
    if (!trimmed || !onSendMessage || pendingConversation) return;
    setDraft("");
    const selectedModel = selectedModelId ? modelConfigs.find((c) => c.id === selectedModelId) : undefined;
    const modelKey = selectedModel ? `${selectedModel.provider}:${selectedModel.name}` : undefined;
    const supportsThinking = selectedModel?.capabilities?.thinking ?? false;
    const supportedLevels = selectedModel?.capabilities?.supportedThinkingLevels;
    const levelIsSupported = thinkingLevel !== null && (!supportedLevels || supportedLevels.length === 0 || supportedLevels.includes(thinkingLevel));
    const explicitThinking = thinkingLevel !== null && supportsThinking && levelIsSupported ? thinkingLevel : undefined;
    await onSendMessage(trimmed, {
      ...(modelKey ? { model: modelKey } : {}),
      ...(explicitThinking ? { thinkingLevel: explicitThinking } : {}),
      ...(options?.skill ? { skill: options.skill } : {}),
      ...(options?.slashCommand ? { slashCommand: options.slashCommand } : {}),
    });
  };

  const handleSlashSubmit = async (content: string, skill: string, slashCommand: string) => {
    await submitMessage(content, { skill, slashCommand });
  };

  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModelId(modelId);
    localStorage.setItem("pf:selected-model-id", modelId);
    const newModel = modelConfigs.find((c) => c.id === modelId);
    const supportedLevels = newModel?.capabilities?.supportedThinkingLevels;
    if (thinkingLevel !== null && supportedLevels && !supportedLevels.includes(thinkingLevel)) {
      setThinkingLevel(null);
    }
  }, [modelConfigs, thinkingLevel, setSelectedModelId, setThinkingLevel]);

  const handleSendSteering = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || !activeRunId) return;
    setSteeringError(null);
    try {
      await sendSteering(activeRunId, "constraint", trimmed, crypto.randomUUID());
    } catch {
      setSteeringError("发送插言失败，请重试");
    }
  }, [activeRunId, setSteeringError]);

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return;
    setSteeringError(null);
    try {
      await cancelRun(activeRunId);
      if (onStopStreaming) onStopStreaming();
    } catch {
      setSteeringError("取消运行失败，请重试");
    }
  }, [activeRunId, onStopStreaming, setSteeringError]);

  // Clear draft when a run starts so old text isn't accidentally sent as steering.
  const [clearedForRunId, setClearedForRunId] = useState<string | null>(null);
  if (activeRunId && activeRunId !== clearedForRunId && draft.trim()) {
    setDraft("");
    setClearedForRunId(activeRunId);
  }

  // Scroll to bottom handling
  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Show button if user scrolls up by more than 150px
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    isNearBottomRef.current = nearBottom;
    setShowScrollBottom(!nearBottom);
  };

  /** Auto-scroll during StreamingText RAF reveal when user is near bottom. */
  const handleRevealProgress = useCallback(() => {
    if (!isNearBottomRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior,
    });
  };

  useEffect(() => {
    if (isStreamingConversation && !showScrollBottom) {
      scrollToBottom("auto");
    }
  }, [streamTurn, isStreamingConversation, showScrollBottom]);

  useEffect(() => {
    scrollToBottom("smooth");
  }, [conversation?.id, messages.length]);

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary-token)]">
      {/* Top Header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-100 px-6 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-neutral-600 dark:text-neutral-400" />
          <h1 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">Agent 交互对话</h1>
          {conversation?.visibility === "private" && !isDraft && (
            <Badge variant="secondary" className="flex items-center gap-1 text-[10px] text-neutral-500 bg-neutral-100 hover:bg-neutral-100 dark:bg-neutral-800">
              <LockKeyhole className="h-2.5 w-2.5" />
              <span>私人会话</span>
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* New Conversation Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={onStartNewDraft}
            disabled={isStreamingConversation || isDraft}
            className="h-8 gap-1 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>新对话</span>
          </Button>

          {/* History Button */}
          <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800"
                  title="历史会话"
                />
              }
            >
              <History className="h-4 w-4" />
              <span>历史会话</span>
            </SheetTrigger>
            <SheetContent side="right" className="w-[320px] sm:w-[380px] p-6 bg-white dark:bg-neutral-950 flex flex-col h-full border-l border-neutral-100 dark:border-neutral-800 shadow-xl">
              <SheetHeader className="mb-4">
                <SheetTitle className="text-sm font-bold text-neutral-800 dark:text-neutral-200">历史会话</SheetTitle>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2">
                {isLoadingHistory ? (
                  <div className="flex h-40 items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
                  </div>
                ) : historyError ? (
                  <div className="rounded-md bg-coral/10 p-3 text-xs text-coral text-center">
                    <p>{historyError}</p>
                    <Button variant="link" size="sm" onClick={onRetryHistory} className="text-coral underline mt-1">重试</Button>
                  </div>
                ) : conversationSummaries.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <div className="rounded-full bg-neutral-50 p-3 dark:bg-neutral-900/50 mb-3 border border-neutral-100/50 dark:border-neutral-800/50">
                      <MessageSquare className="h-5 w-5 text-neutral-400 dark:text-neutral-500" />
                    </div>
                    <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">
                      {isDraft ? "当前为新对话草稿" : "暂无历史会话"}
                    </p>
                    <p className="text-[11px] text-neutral-400 dark:text-neutral-500 mt-1.5 max-w-[200px] leading-relaxed">
                      {isDraft ? "发送首条消息后，将自动保存至历史会话" : "与 Agent 开启对话，持续推进您的项目吧"}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {conversationSummaries.map((summary) => {
                      const isActive = summary.id === conversation?.id;
                      return (
                        <button
                          key={summary.id}
                          type="button"
                          onClick={() => {
                            if (onSwitchConversation) onSwitchConversation(summary.id);
                            setHistoryOpen(false);
                          }}
                          disabled={isStreamingConversation}
                          className={cn(
                            "flex w-full flex-col gap-1 rounded-lg p-2.5 text-left text-xs transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900 disabled:opacity-50",
                            isActive ? "bg-neutral-50 font-medium text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100" : "text-neutral-600 dark:text-neutral-400"
                          )}
                        >
                          <div className="flex items-center gap-1.5">
                            {summary.visibility === "private" && <Lock className="h-3 w-3 shrink-0 text-neutral-400" />}
                            <span className="truncate">{summary.title || "无标题会话"}</span>
                          </div>
                          {summary.last_message_preview && (
                            <span className="line-clamp-1 text-[10px] text-neutral-400">{summary.last_message_preview}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>

      {/* Message and scroll container */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-6 py-6 custom-scrollbar"
        >
          <div className="mx-auto max-w-3xl space-y-6 pb-40">
            {/* Suggestions/Context Panel if empty */}
            {timelineEntries.length === 0 && !pendingConversationInstruction && (
              <div className="my-8 space-y-6">
                <div className="rounded-xl border border-neutral-100 bg-neutral-50/50 p-6 text-center dark:border-neutral-800 dark:bg-neutral-900/50">
                  <Bot className="mx-auto mb-3 h-10 w-10 text-neutral-400" />
                  <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">欢迎使用 Agent 推进台</h2>
                  <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                    我是你的主动推进型 AI 助手。我会分析项目状态、阶段计划、执行进度和团队风险，帮助你的小队主动推进项目。所有操作在您确认后才会应用。
                  </p>
                </div>
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">你可以尝试这样开始：</p>
                  <StarterPrompts
                    focus={focus}
                    onSelect={(instruction) => void submitMessage(instruction)}
                    disabled={Boolean(pendingConversation)}
                  />
                </div>
              </div>
            )}

            {/* Context/Proposal Cards */}
            {visibleArtifacts.length > 0 && (
              <div className="space-y-3 my-4">
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
              </div>
            )}

            {/* Conversation Messages Timeline */}
            <div className="space-y-4">
              {hasOlderMessages && (
                <button
                  type="button"
                  onClick={onLoadOlderMessages}
                  disabled={isLoadingOlder}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs text-neutral-500 transition hover:bg-neutral-50 disabled:opacity-50"
                >
                  {isLoadingOlder ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />
                  ) : (
                    <ChevronLeft className="h-3.5 w-3.5 rotate-[-90deg]" />
                  )}
                  <span>{isLoadingOlder ? "正在加载更早消息..." : "加载更早消息"}</span>
                </button>
              )}

              {timelineEntries.map((entry, index) => (
                <ChatMessage
                  key={entry.key}
                  message={entry.message}
                  isLast={index === timelineEntries.length - 1}
                  index={index}
                  streamTurn={entry.turn}
                  onRetry={pendingConversationInstruction ? () => void submitMessage(pendingConversationInstruction) : undefined}
                  onAction={(instruction) => void submitMessage(instruction)}
                  onRevealProgress={handleRevealProgress}
                />
              ))}

              {/* Action Log inline feedback */}
              {actionLog.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-neutral-100 bg-neutral-50/30 p-3 dark:border-neutral-800 dark:bg-neutral-900/30">
                  {actionLog.map((entry) => (
                    <motion.div
                      key={entry.id}
                      initial={{ opacity: 0, y: 2 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", entry.type === "confirmed" ? "bg-moss" : "bg-neutral-400")} />
                      <span className={entry.type === "confirmed" ? "text-moss font-medium" : "text-neutral-500"}>
                        {entry.text}
                      </span>
                      {entry.type === "dismissed" && (
                        <button
                          type="button"
                          onClick={() => handleUndoDismiss(entry)}
                          className="ml-auto text-[10px] text-neutral-400 hover:text-neutral-600 underline underline-offset-2"
                        >
                          撤销
                        </button>
                      )}
                    </motion.div>
                  ))}
                </div>
              )}

              {/* Optimistic User message */}
              {streamTurn?.userMessage && streamTurn.status !== "idle" && (
                <ChatMessage message={streamTurn.userMessage} onRevealProgress={handleRevealProgress} />
              )}
              {pendingConversationInstruction && !streamTurn?.userMessage && (
                <ChatMessage
                  message={{
                    id: "pending",
                    conversation_id: "",
                    role: "user",
                    content: pendingConversationInstruction,
                    structured_payload: {},
                    created_at: new Date().toISOString(),
                  }}
                  onRevealProgress={handleRevealProgress}
                />
              )}

              {/* Streaming Assistant message */}
              {streamTurn && streamTurn.status !== "idle" && (
                <ChatMessage
                  message={{
                    id: streamTurn.clientTurnId,
                    conversation_id: "",
                    role: "assistant",
                    content: streamTurn.finalContent ?? Object.values(streamTurn.blocks).filter(b => b.kind === "text").sort((a, b) => a.order - b.order).map(b => b.content).join(""),
                    structured_payload: {
                      thinking_content: Object.values(streamTurn.blocks).filter(b => b.kind === "thinking").sort((a, b) => a.order - b.order).map(b => b.content).join(""),
                      execution_steps: streamTurn.executionSteps,
                      activities: streamTurn.activities,
                      run_summary: streamTurn.runSummary,
                    },
                    created_at: new Date().toISOString(),
                  }}
                  isLast={true}
                  streamTurn={streamTurn}
                  onToggleThinking={onToggleThinking}
                  onRevealProgress={handleRevealProgress}
                />
              )}
            </div>

            {/* AgentStepIndicator removed — process timeline is now inside RunActivity in ChatMessage */}
            {pendingConversation && !streamStatus && <AgentRunStatusCard />}

            {/* ARIA Live status announcements */}
            {completedAnnouncement && (
              <div role="status" aria-live="polite" className="sr-only">
                回答已完成
              </div>
            )}

            {/* Errors */}
            {(conversationError || steeringError) && (
              <AgentErrorCard
                message={steeringError ?? conversationError ?? ""}
                disabled={Boolean(pendingConversation)}
                onRetry={pendingConversationInstruction ? () => void submitMessage(pendingConversationInstruction) : undefined}
              />
            )}

            {/* Action Feedback alerts */}
            {actionSuccess && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-2.5 rounded-lg border border-moss/20 bg-moss/5 p-3 text-xs text-moss"
              >
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{actionSuccess}</span>
              </motion.div>
            )}
            {actionError && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-2.5 rounded-lg border border-coral/20 bg-coral/5 p-3 text-xs text-coral"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{actionError}</span>
              </motion.div>
            )}

            {/* Next Step Recommendations removed */}
          </div>
        </div>

        {/* Floating "Jump to bottom" Button */}
        {showScrollBottom && (
          <Button
            size="icon"
            onClick={() => scrollToBottom("smooth")}
            className="absolute bottom-32 right-8 h-9 w-9 rounded-full bg-white text-neutral-600 shadow-md hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 border border-neutral-200 dark:border-neutral-800"
            title="回到最新"
            aria-label="回到最新"
          >
            <ArrowDown className="h-4 w-4 animate-bounce" />
          </Button>
        )}

        {/* Floating Bottom Composer Container */}
        <div className="absolute bottom-0 left-0 right-0 p-6 pt-12 bg-gradient-to-t from-white via-white/95 to-transparent dark:from-neutral-950 dark:via-neutral-950/95 pointer-events-none">
          <div className="mx-auto max-w-3xl pointer-events-auto" data-tour="composer">
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSubmit={(text) => void submitMessage(text)}
              onSlashSubmit={handleSlashSubmit}
              disabled={Boolean(pendingConversation)}
              isStreaming={Boolean(streamTurn && streamTurn.status !== "idle" && streamTurn.status !== "completed" && streamTurn.status !== "failed" && streamTurn.status !== "cancelled" && streamTurn.status !== "disconnected")}
              isRunning={isRunning}
              onSendSteering={handleSendSteering}
              onCancelRun={handleCancelRun}
              modelConfigs={modelConfigs}
              selectedModelId={selectedModelId}
              onModelChange={handleModelChange}
              thinkingLevel={thinkingLevel}
              onThinkingLevelChange={setThinkingLevel}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

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
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { AgentArtifact, AgentConversation, AgentConversationMessage, AgentConversationSummary, AgentSuggestion, AgentStreamTurn, ArchivedAgentStreamTurn, ProjectState, ThinkingLevel, ModelConfigEntry } from "@/lib/types";
import { sendSteering, cancelRun } from "@/lib/api";
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

type ConversationTimelineEntry =
  | { key: string; sortAt: number; message: AgentConversationMessage; turn?: undefined }
  | { key: string; sortAt: number; message: AgentConversationMessage; turn: AgentStreamTurn };

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
    structured_payload: {},
    created_at: turn.userMessage?.created_at ?? new Date().toISOString(),
  };
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
  onSendMessage?: (content: string, options?: { model?: string; thinkingLevel?: string; skill?: string; slashCommand?: string }) => void | Promise<void>;
  streamTurn?: AgentStreamTurn | null;
  archivedStreamTurns?: ArchivedAgentStreamTurn[];
  streamStatus?: AgentStreamStatus | null;
  activeRunId?: string | null;
  onStopStreaming?: () => void;
  onToggleThinking?: () => void;
  onConfirmArtifact?: (artifact: AgentArtifact) => void | Promise<void>;
  /** Explicit completion announcement token — renders one-time aria-live "回答已完成". */
  completedAnnouncement?: string | null;
  // --- T45: Conversation history props ---
  /** Conversation summaries for the history list. */
  conversationSummaries?: AgentConversationSummary[];
  /** Whether the active conversation is a local unsaved draft. */
  isDraft?: boolean;
  /** Whether a streamed response is currently active (locks switching). */
  isStreamingConversation?: boolean;
  /** Whether conversation history is loading. */
  isLoadingHistory?: boolean;
  /** Whether a conversation detail is loading (during switch). */
  isLoadingConversationDetail?: boolean;
  /** Error message for history load failure. */
  historyError?: string | null;
  /** Callback to start a new blank draft. */
  onStartNewDraft?: () => void;
  /** Callback to switch to an existing conversation. */
  onSwitchConversation?: (conversationId: string) => void;
  /** Callback to retry loading history. */
  onRetryHistory?: () => void;
  /** Whether there are older messages that can be loaded. */
  hasOlderMessages?: boolean;
  /** Whether older messages are currently loading. */
  isLoadingOlder?: boolean;
  /** Callback to load older messages. */
  onLoadOlderMessages?: () => void;
  draft?: string;
  onDraftChange?: (val: string) => void;
  thinkingLevelProp?: ThinkingLevel | null;
  onThinkingLevelChange?: (val: ThinkingLevel | null) => void;
  selectedModelIdProp?: string | null;
  onSelectedModelIdChange?: (val: string | null) => void;
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
  onStartNewDraft,
  onSwitchConversation,
  onRetryHistory,
  hasOlderMessages = false,
  isLoadingOlder = false,
  onLoadOlderMessages,
  draft: draftProp,
  onDraftChange,
  thinkingLevelProp,
  onThinkingLevelChange,
  selectedModelIdProp,
  onSelectedModelIdChange,
}: AgentSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  
  const [localThinkingLevel, setLocalThinkingLevel] = useState<ThinkingLevel | null>(null);
  const thinkingLevel = thinkingLevelProp !== undefined ? thinkingLevelProp : localThinkingLevel;
  const setThinkingLevel = onThinkingLevelChange !== undefined ? onThinkingLevelChange : setLocalThinkingLevel;
  
  const [modelConfigs, setModelConfigs] = useState<ModelConfigEntry[]>([]);
  
  const [localSelectedModelId, setLocalSelectedModelId] = useState<string | null>(null);
  const selectedModelId = selectedModelIdProp !== undefined ? selectedModelIdProp : localSelectedModelId;
  const setSelectedModelId = onSelectedModelIdChange !== undefined ? onSelectedModelIdChange : setLocalSelectedModelId;

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
  }, [setSelectedModelId]);

  const [localDraft, setLocalDraft] = useState("");
  const draft = draftProp !== undefined ? draftProp : localDraft;
  const setDraft = onDraftChange !== undefined ? onDraftChange : setLocalDraft;

  const [dismissedIds, setDismissedIds] = useLocalStorageSet(getDismissedStorageKey(selectedProjectId));
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [actionLog, setActionLog] = useState<Array<{ id: string; artifactId: string; type: "confirmed" | "dismissed"; text: string }>>([]);
  const [steeringError, setSteeringError] = useState<string | null>(null);
  const { active: tourActive, complete: tourComplete } = useGuidedTour();

  // 拖动调整宽度状态
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return SIDEBAR_DEFAULT_WIDTH;
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
  const [clearedForRunId, setClearedForRunId] = useState<string | null>(null);

  // Clear draft when a run starts so old text isn't accidentally sent as steering.
  // Using render-phase state adjustment to avoid setState-in-effect.
  if (activeRunId && activeRunId !== clearedForRunId && draft.trim()) {
    setDraft("");
    setClearedForRunId(activeRunId);
  }

  // 拖动开始
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
  }, [sidebarWidth]);

  const updateWidth = useCallback((nextWidth: number) => {
    const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, nextWidth));
    setSidebarWidth(clamped);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped));
    } catch {
      // ignore storage errors
    }
  }, []);

  const handleResizeKeyboard = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 50 : 20;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        updateWidth(sidebarWidth - step);
        break;
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        updateWidth(sidebarWidth + step);
        break;
      case "Home":
        e.preventDefault();
        updateWidth(SIDEBAR_MIN_WIDTH);
        break;
      case "End":
        e.preventDefault();
        updateWidth(SIDEBAR_MAX_WIDTH);
        break;
    }
  }, [sidebarWidth, updateWidth]);

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
  }, [selectedProjectId, setDismissedIds]);

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
  const isRunning = !!activeRunId;
  const pendingProposalCount = state.agent_proposals?.filter((proposal) => proposal.status === "pending").length ?? 0;
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
  }, [dismissedIds, setDismissedIds]);

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
  }, [onConfirmArtifact]);

  const handleUndoDismiss = useCallback((entry: { id: string; artifactId: string }) => {
    setActionLog((prev) => prev.filter((e) => e.id !== entry.id));
    const next = new Set(dismissedIds);
    next.delete(entry.artifactId);
    setDismissedIds(next);
  }, [dismissedIds, setDismissedIds]);

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
    // Build model composite key from selectedModelId
    const selectedModel = selectedModelId ? modelConfigs.find((c) => c.id === selectedModelId) : undefined;
    const modelKey = selectedModel ? `${selectedModel.provider}:${selectedModel.name}` : undefined;
    // Only send thinkingLevel when explicitly chosen by the user AND the model supports it
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

  /** Handle slash command submission — delegates to submitMessage with skill and slash command name. */
  const handleSlashSubmit = async (content: string, skill: string, slashCommand: string) => {
    await submitMessage(content, { skill, slashCommand });
  };

  /** Handle model change with localStorage persistence and thinking level reset. */
  const handleModelChange = useCallback((modelId: string) => {
    setSelectedModelId(modelId);
    localStorage.setItem("pf:selected-model-id", modelId);
    // Reset thinkingLevel if the new model doesn't support it
    const newModel = modelConfigs.find((c) => c.id === modelId);
    const supportedLevels = newModel?.capabilities?.supportedThinkingLevels;
    if (thinkingLevel !== null && supportedLevels && !supportedLevels.includes(thinkingLevel)) {
      setThinkingLevel(null);
    }
  }, [modelConfigs, thinkingLevel, setSelectedModelId, setThinkingLevel]);

  const handleSendSteering = useCallback(
    async (content: string) => {
      if (!activeRunId) return;
      try {
        await sendSteering(activeRunId, "constraint", content, crypto.randomUUID());
      } catch (err) {
        setSteeringError(err instanceof Error ? err.message : "发送约束失败");
      }
    },
    [activeRunId],
  );

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await cancelRun(activeRunId, "用户取消");
      onStopStreaming?.();
    } catch (err) {
      setSteeringError(err instanceof Error ? err.message : "取消运行失败");
      // Do NOT call onStopStreaming — the run is still active in the backend.
    }
  }, [activeRunId, onStopStreaming]);

  return (
    <motion.aside
      data-tour-sidebar
      className={cn(
        "relative flex h-screen flex-col border-l border-neutral-200/70 bg-bg-sidebar dark:border-neutral-700/70 dark:bg-sidebar",
        collapsed ? "w-12" : "",
        isDragging && "select-none"
      )}
      style={!collapsed ? { width: `${sidebarWidth}px`, transition: isDragging ? "none" : "width 220ms cubic-bezier(0.23, 1, 0.32, 1)" } : undefined}
      initial={false}
    >
      <AgentGuidedTour active={tourActive && isExpanded && hasProject} onComplete={tourComplete} />
      <button
        type="button"
        onClick={toggle}
        className="absolute -left-3 top-4 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-500 shadow-sm transition hover:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
        aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
      >
        {collapsed ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>

      {/* 拖动调整宽度的手柄 */}
      {isExpanded && (
        <div
          role="separator"
          aria-label="调整侧边栏宽度"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          aria-controls="agent-sidebar-content"
          tabIndex={0}
          className="absolute left-0 top-0 z-20 h-full w-1.5 cursor-col-resize outline-none transition-colors focus-visible:bg-moss/20 group"
          onMouseDown={handleDragStart}
          onKeyDown={handleResizeKeyboard}
        >
          <div className={cn(
            "absolute left-0 top-1/2 -translate-y-1/2 h-12 w-1 rounded-r-full transition-all",
            isDragging ? "bg-moss" : "bg-neutral-300 group-hover:bg-moss group-focus-visible:bg-moss"
          )} />
        </div>
      )}

      <div className="flex h-14 items-center gap-1.5 border-b border-neutral-100 px-3 dark:border-neutral-800" data-tour="header">
        <Bot className="h-5 w-5 shrink-0 text-neutral-600 dark:text-neutral-300" />
        <AnimatePresence>
          {isExpanded && (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden whitespace-nowrap text-sm font-semibold text-neutral-900 dark:text-neutral-100"
            >
              Agent
            </motion.span>
          )}
        </AnimatePresence>
        {/* T45: Conversation history controls */}
        {isExpanded && hasProject && (
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-8 w-8 shrink-0 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
              onClick={onStartNewDraft}
              disabled={isStreamingConversation || isLoadingConversationDetail}
              title="新对话"
              aria-label="新对话"
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
              <SheetTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-8 w-8 shrink-0 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                    disabled={isStreamingConversation || isLoadingConversationDetail}
                    title="历史会话"
                    aria-label="历史会话"
                  />
                }
              >
                <History className="h-4 w-4" />
              </SheetTrigger>
              <SheetContent side="right" className="w-72 sm:max-w-72">
                <SheetHeader>
                  <SheetTitle>历史会话</SheetTitle>
                </SheetHeader>
                <div className="flex-1 overflow-y-auto px-4 pb-4">
                  {isLoadingHistory && (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
                    </div>
                  )}
                  {historyError && (
                    <div className="rounded-md border border-coral/20 bg-coral/5 p-3 text-center">
                      <p className="text-xs text-coral">{historyError}</p>
                      {onRetryHistory && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 h-7 text-xs"
                          onClick={onRetryHistory}
                        >
                          重试
                        </Button>
                      )}
                    </div>
                  )}
                  {!isLoadingHistory && !historyError && conversationSummaries.length === 0 && (
                    <p className="py-8 text-center text-xs text-neutral-500">
                      {isDraft ? "当前为新对话（未保存）" : "暂无历史会话"}
                    </p>
                  )}
                  {!isLoadingHistory && !historyError && conversationSummaries.length > 0 && (
                    <ul className="space-y-1" role="listbox" aria-label="会话列表">
                      {conversationSummaries.map((summary) => {
                        const isActive = conversation?.id === summary.id && !isDraft;
                        return (
                          <li key={summary.id} role="option" aria-selected={isActive}>
                            <button
                              type="button"
                              onClick={() => {
                                onSwitchConversation?.(summary.id);
                                setHistoryOpen(false);
                              }}
                              disabled={isStreamingConversation || isActive}
                              className={cn(
                                "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/40",
                                isActive
                                  ? "bg-moss/10 text-moss"
                                  : "hover:bg-neutral-50 text-neutral-700",
                              )}
                            >
                              <span className="flex items-center gap-1.5 font-medium">
                                <span className="truncate">{summary.title || "未命名会话"}</span>
                                {summary.visibility === "private" ? (
                                  <Lock className="h-3 w-3 shrink-0 text-neutral-500" aria-label="私人会话" />
                                ) : (
                                  <Users className="h-3 w-3 shrink-0 text-neutral-500" aria-label="团队会话" />
                                )}
                              </span>
                              <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                                <span>{summary.message_count} 条消息</span>
                                <span>·</span>
                                <span>{formatTimeAgo(summary.updated_at)}</span>
                              </span>
                              {summary.last_message_preview && (
                                <span className="truncate text-[11px] text-neutral-500">
                                  {summary.last_message_preview}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        )}
      </div>

      <div id="agent-sidebar-content" className="flex-1 overflow-y-auto custom-scrollbar">
        {isExpanded && (
        <div className="transition-all duration-200 overflow-hidden p-3">
              {!hasProject && (
                <div className="mb-4 space-y-4">
                  <div className="rounded-md border border-neutral-200 bg-white p-4 text-center dark:border-neutral-700 dark:bg-neutral-900">
                    <Bot className="mx-auto mb-3 h-8 w-8 text-neutral-600 dark:text-neutral-400" />
                    <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">未选择项目</p>
                    <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
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
                    <div className="flex items-start gap-2.5 rounded-md bg-neutral-50 p-2.5 dark:bg-neutral-900">
                      <Compass className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
                      <div>
                        <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">方向澄清</p>
                        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">明确项目目标和边界</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5 rounded-md bg-neutral-50 p-2.5 dark:bg-neutral-900">
                      <ListTodo className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
                      <div>
                        <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">任务拆解</p>
                        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">把阶段目标拆成可执行任务</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5 rounded-md bg-neutral-50 p-2.5 dark:bg-neutral-900">
                      <Rocket className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" />
                      <div>
                        <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">主动推进</p>
                        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">分析进度并建议下一步行动</p>
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
                    <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-neutral-500">
                      <MessageSquare className="h-3.5 w-3.5" />
                      对话
                      {isDraft && (
                        <Badge variant="secondary" className="ml-auto px-1.5 py-0 text-[10px]">
                          新对话
                        </Badge>
                      )}
                      {conversation?.visibility === "private" && !isDraft && (
                        <Lock className="ml-auto h-3 w-3 text-neutral-500" aria-label="私人会话" />
                      )}
                    </div>
                    <div className="space-y-2">
                      {hasOlderMessages && (
                        <button
                          type="button"
                          onClick={onLoadOlderMessages}
                          disabled={isLoadingOlder}
                          aria-label="加载更早消息"
                          className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] text-neutral-500 transition hover:bg-neutral-50 hover:text-neutral-700 disabled:opacity-50"
                        >
                          {isLoadingOlder ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ChevronLeft className="h-3 w-3 rotate-[-90deg]" />
                          )}
                          {isLoadingOlder ? "加载中..." : "加载更早消息"}
                        </button>
                      )}
                      {messages.length === 0 && !pendingConversationInstruction && (
                        <div data-tour="prompts">
                          <StarterPrompts
                            focus={focus}
                            onSelect={(instruction) => void submitMessage(instruction)}
                            disabled={Boolean(pendingConversation)}
                          />
                        </div>
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
                        />
                      ))}

                      {/* Action log: inline confirm/dismiss records */}
                      {actionLog.length > 0 && (
                        <div className="space-y-1 rounded-md border border-neutral-100 bg-neutral-50/50 p-2 dark:border-neutral-800 dark:bg-neutral-900/50">
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
                                  className="ml-auto text-[10px] text-neutral-500 underline decoration-dotted underline-offset-2 hover:text-neutral-700"
                                  title="恢复此建议"
                                >
                                  撤销
                                </button>
                              )}
                            </motion.div>
                          ))}
                        </div>
                      )}

                      {/* Optimistic user message from turn (stable, never disappears) */}
                      {streamTurn?.userMessage && streamTurn.status !== "idle" && (
                        <ChatMessage
                          message={streamTurn.userMessage}
                        />
                      )}
                      {/* Fallback: pending user message when turn not yet created */}
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
                        />
                      )}

                      {/* Live streaming assistant turn */}
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
                            },
                            created_at: new Date().toISOString(),
                          }}
                          isLast={true}
                          streamTurn={streamTurn}
                          onToggleThinking={onToggleThinking}
                        />
                      )}
                    </div>

                    {streamStatus && <AgentStepIndicator status={streamStatus} executionSteps={streamTurn?.executionSteps} />}
                    {pendingConversation && !streamStatus && <AgentRunStatusCard />}

                    {/* ARIA completion announcement — visual:hidden, one-time per turn */}
                    {completedAnnouncement && (
                      <div role="status" aria-live="polite" className="sr-only">
                        回答已完成
                      </div>
                    )}

                    {(conversationError || steeringError) && (
                      <AgentErrorCard
                        message={steeringError ?? conversationError ?? ""}
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

        </div>
        )}

        {!isExpanded && hasProject && (
          <CollapsedSidebarIcons focus={focus} pendingCount={pendingProposalCount} isStreaming={Boolean(streamTurn && streamTurn.status !== "idle" && streamTurn.status !== "completed" && streamTurn.status !== "failed" && streamTurn.status !== "cancelled" && streamTurn.status !== "disconnected")} onToggle={toggle} />
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
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:text-neutral-400 dark:hover:bg-neutral-800"
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

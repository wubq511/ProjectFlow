/**
 * Stream presentation projector — manages activity lifecycle, progress text,
 * tool transitions, and answer projection for the SSE stream.
 *
 * Extracted from start-run-stream.ts for testability. The projector owns all
 * activity/progress/answer emission; the stream route owns transport (tool
 * events, status, content:thinking, error, done).
 *
 * Event contract:
 * - Activities are emitted with EMPTY content on creation; content arrives via
 *   process_delta so the frontend reducer can append exactly once.
 * - Text deltas accumulate in `pendingVisibleText`; they are NEVER emitted as
 *   `content:text` events. The answer comes exclusively from `final_content`.
 * - process_completed → answer_started → answer_delta[] → (run_completed, done)
 *   is strictly ordered. process_completed fires exactly once.
 */

// ---------------------------------------------------------------------------
// Tool display metadata
// ---------------------------------------------------------------------------

const TOOL_BASE_LABELS: Record<string, string> = {
  get_project_state: "获取项目状态",
  get_workspace_state: "获取工作区状态",
  get_agent_conversation: "获取对话记录",
  list_pending_proposals: "查看待处理提案",
  get_timeline_slice: "查看最近进展",
  read_tool_resource: "读取工具资源",
  generate_stage_plan_proposal: "生成阶段规划",
  generate_task_breakdown_proposal: "生成任务分解",
  recommend_assignment: "推荐分工方案",
  generate_replan_proposal: "生成调整方案",
  generate_direction_card_proposal: "生成方向卡",
  analyze_checkins_and_risks: "分析进展与风险",
  create_risk: "创建风险记录",
  create_checkin: "创建进展记录",
};

/** Tool name → category for transition progress dedup. */
const TOOL_CATEGORIES: Record<string, string> = {
  get_project_state: "read",
  get_workspace_state: "read",
  get_agent_conversation: "read",
  list_pending_proposals: "read",
  get_timeline_slice: "timeline",
  read_tool_resource: "read",
  generate_stage_plan_proposal: "proposal",
  generate_replan_proposal: "proposal",
  generate_direction_card_proposal: "proposal",
  generate_task_breakdown_proposal: "proposal",
  recommend_assignment: "proposal",
  analyze_checkins_and_risks: "analysis",
  create_risk: "create",
  create_checkin: "create",
};

/** Category transition messages — emitted only when model has no commentary. */
const TRANSITION_MESSAGES: Record<string, string> = {
  "read→timeline": "项目状态已读取，接下来核对近期进展。",
  "read→proposal": "项目状态已读取，接下来生成提案。",
  "read→create": "数据已确认，接下来创建记录。",
  "read→analysis": "项目状态已读取，接下来分析进展与风险。",
  "timeline→proposal": "近期进展已核对，接下来生成提案。",
  "timeline→create": "近期进展已核对，接下来创建记录。",
  "timeline→analysis": "近期进展已核对，接下来分析风险。",
  "analysis→create": "分析已完成，接下来创建记录。",
  "analysis→proposal": "分析已完成，接下来生成提案。",
  "proposal→read": "提案已生成，接下来核对最新状态。",
  "proposal→create": "提案已生成，接下来创建记录。",
  "create→read": "记录已创建，接下来核对最新状态。",
  "create→proposal": "记录已创建，接下来生成提案。",
  "create→analysis": "记录已创建，接下来分析整体进展。",
};

export const INITIAL_PROGRESS_TEXT = "我先理解你的请求，并核对当前项目状态。";

// ---------------------------------------------------------------------------
// Exported label helpers (also used by stream-route for execution steps)
// ---------------------------------------------------------------------------

export function getToolBaseLabel(toolName: string): string | null {
  return TOOL_BASE_LABELS[toolName] ?? null;
}

export function formatToolStartLabel(toolName: string): string {
  const base = TOOL_BASE_LABELS[toolName];
  return base ? `正在${base}` : "正在执行工具";
}

export function formatToolCompleteLabel(toolName: string): string {
  const base = TOOL_BASE_LABELS[toolName];
  return base ? `已${base}` : "已完成工具";
}

export function formatToolFailedLabel(toolName: string): string {
  const base = TOOL_BASE_LABELS[toolName];
  return base ? `${base}失败` : "执行工具失败";
}

export function formatToolBlockedLabel(toolName: string): string {
  const base = TOOL_BASE_LABELS[toolName];
  return base ? `${base}已被阻止` : "执行工具已被阻止";
}

/**
 * Legacy compatibility — returns a label suitable for "正在..." prefixing.
 * Prefer the specific format* functions above for new code.
 */
export function toolLabel(toolName: string): string {
  return TOOL_BASE_LABELS[toolName] ?? "执行工具";
}

// ---------------------------------------------------------------------------
// Projector types
// ---------------------------------------------------------------------------

export type ProjectorPhase = "initial" | "processing" | "answering" | "done";

export interface ProjectorActivity {
  id: string;
  sequence: number;
  created_at: string;
  kind: "progress" | "skill" | "tool";
  content?: string;
  tool_call_id?: string;
  tool_name?: string;
  skill_name?: string;
  status?: string;
  label?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

export type SSEWriter = (event: string, data: unknown) => void;

export interface StreamProjector {
  /** Emit process_started event and transition to processing phase. */
  emitProcessStarted(): void;
  /** Emit deterministic initial progress activity. */
  emitInitialProgress(): void;
  /** Emit a preflight skill activity. */
  emitSkillActivity(skillName: string, label: string): void;
  /** Accumulate sanitized text from model text_delta. */
  accumulateText(safeText: string): void;
  /**
   * Handle tool.started: flush pending text as progress, emit category
   * transition if applicable, close progress block, insert tool activity.
   */
  handleToolStarted(toolName: string, toolCallId: string): void;
  /** Handle tool.completed: update tool activity in place. */
  handleToolCompleted(toolCallId: string, toolName: string): void;
  /** Handle tool.failed: update tool activity in place. */
  handleToolFailed(toolCallId: string, toolName: string): void;
  /** Handle tool.blocked: update or create blocked tool activity. */
  handleToolBlocked(
    toolCallId: string | undefined,
    toolName: string,
    eventId: string,
  ): void;
  /**
   * Emit the answer boundary: process_completed → answer_started → answer_delta
   * chunks whose concatenation exactly equals finalContent.
   */
  emitAnswerBoundaryAndContent(finalContent: string): void;
  /** Get accumulated activities for the done payload. */
  getActivities(): ProjectorActivity[];
  /** Derive execution steps from tool activities. */
  getExecutionSteps(): Array<{
    tool_name: string;
    tool_call_id?: string;
    status: string;
    label: string;
  }>;
  /** Whether process_completed has been emitted. */
  hasCompletedProcess(): boolean;
  /** Current projector phase. */
  getPhase(): ProjectorPhase;
  /** Current stream sequence number (for metrics/debugging). */
  getStreamSequence(): number;
  /** Get pending visible text (for final_content fallback). */
  getPendingText(): string;
  /** Drain pending text and flush sanitizer tail. Returns accumulated text. */
  drainPendingText(sanitizerFlush?: () => string): string;
  /** Get process completion summary for run_summary enrichment. */
  getProcessSummary(): { process_completed_at: string | null; processing_duration_ms: number };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStreamProjector(
  writer: SSEWriter,
  streamStartedAt: number,
): StreamProjector {
  let streamSequence = 0;
  let activitySeq = 0;
  const activities: ProjectorActivity[] = [];
  let currentProgressId: string | null = null;
  let pendingVisibleText = "";
  let phase: ProjectorPhase = "initial";
  let lastToolCategory: string | null = null;
  let hasSentProcessCompleted = false;
  let hasSentAnswerStarted = false;
  let processCompletedAt: string | null = null;
  let processingDurationMs = 0;

  // --- Internal helpers ---

  function nextSeq(): number {
    return ++streamSequence;
  }

  function emitSSE(event: string, data: unknown): void {
    writer(event, data);
  }

  function pushActivity(activity: ProjectorActivity): void {
    activities.push(activity);
    emitSSE("activity", {
      stream_sequence: nextSeq(),
      data: activity,
    });
  }

  function emitProcessDelta(activityId: string, content: string): void {
    emitSSE("process_delta", {
      stream_sequence: nextSeq(),
      activity_id: activityId,
      content,
    });
  }

  /**
   * Create a new progress activity. Per spec: the activity event carries
   * EMPTY content; the actual text arrives via process_delta so the frontend
   * reducer appends it exactly once.
   */
  function createProgressActivity(content: string): string {
    const progressId = `progress-${++activitySeq}`;
    currentProgressId = progressId;
    const activity: ProjectorActivity = {
      id: progressId,
      sequence: activitySeq,
      created_at: new Date().toISOString(),
      kind: "progress",
      content: "",
    };
    pushActivity(activity);
    if (content) {
      emitProcessDelta(progressId, content);
      // Update local record so getActivities() returns complete content
      activity.content = content;
    }
    return progressId;
  }

  /**
   * Append content to the current progress activity, or create a new one
   * if no progress block is open.
   */
  function appendOrCreateProgress(content: string): void {
    if (!content) return;
    if (currentProgressId) {
      const existing = activities.find(
        (a) => a.id === currentProgressId && a.kind === "progress",
      );
      if (existing) {
        existing.content = (existing.content ?? "") + content;
        emitProcessDelta(currentProgressId, content);
        return;
      }
    }
    createProgressActivity(content);
  }

  // --- Public API ---

  function emitProcessStarted(): void {
    phase = "processing";
    emitSSE("process_started", {
      stream_sequence: nextSeq(),
      started_at: new Date(streamStartedAt).toISOString(),
    });
  }

  function emitInitialProgress(): void {
    // Standalone progress — do NOT keep currentProgressId open.
    // Subsequent model commentary creates its own progress block.
    const progressId = `progress-${++activitySeq}`;
    const activity: ProjectorActivity = {
      id: progressId,
      sequence: activitySeq,
      created_at: new Date().toISOString(),
      kind: "progress",
      content: "",
    };
    pushActivity(activity);
    emitProcessDelta(progressId, INITIAL_PROGRESS_TEXT);
    activity.content = INITIAL_PROGRESS_TEXT;
  }

  function emitSkillActivity(skillName: string, label: string): void {
    const activity: ProjectorActivity = {
      id: `skill-${skillName}`,
      sequence: ++activitySeq,
      created_at: new Date(streamStartedAt).toISOString(),
      kind: "skill",
      skill_name: skillName,
      status: "loaded",
      label,
      started_at: new Date(streamStartedAt).toISOString(),
      completed_at: new Date(streamStartedAt).toISOString(),
      duration_ms: 0,
    };
    pushActivity(activity);
  }

  function accumulateText(safeText: string): void {
    if (safeText) {
      pendingVisibleText += safeText;
    }
  }

  function handleToolStarted(toolName: string, toolCallId: string): void {
    const category = TOOL_CATEGORIES[toolName];
    let flushedCommentary = false;

    // 1. Flush pending text as progress (if any)
    if (pendingVisibleText) {
      appendOrCreateProgress(pendingVisibleText);
      pendingVisibleText = "";
      flushedCommentary = true;
    }

    // 2. Category transition progress (only if no commentary was flushed
    //    and category actually changed)
    if (
      !flushedCommentary &&
      lastToolCategory &&
      category &&
      category !== lastToolCategory
    ) {
      const key = `${lastToolCategory}→${category}`;
      const msg = TRANSITION_MESSAGES[key];
      if (msg) {
        appendOrCreateProgress(msg);
      }
    }

    // 3. Close current progress block
    currentProgressId = null;

    // 4. Insert tool activity
    const label = formatToolStartLabel(toolName);
    const toolActivity: ProjectorActivity = {
      id: toolCallId || `tool-${toolName}-${Date.now()}`,
      sequence: ++activitySeq,
      created_at: new Date().toISOString(),
      kind: "tool",
      tool_call_id: toolCallId,
      tool_name: toolName,
      status: "running",
      label,
      started_at: new Date().toISOString(),
    };
    pushActivity(toolActivity);

    // 5. Update category
    if (category) lastToolCategory = category;
  }

  function handleToolCompleted(toolCallId: string, toolName: string): void {
    const act = activities.find(
      (a) => a.kind === "tool" && a.tool_call_id === toolCallId,
    );
    if (act) {
      act.status = "completed";
      act.completed_at = new Date().toISOString();
      act.label = formatToolCompleteLabel(toolName);
      if (act.started_at) {
        act.duration_ms =
          new Date(act.completed_at).getTime() -
          new Date(act.started_at).getTime();
      }
      emitSSE("activity", {
        stream_sequence: nextSeq(),
        data: act,
      });
    }
  }

  function handleToolFailed(toolCallId: string, toolName: string): void {
    const act = activities.find(
      (a) => a.kind === "tool" && a.tool_call_id === toolCallId,
    );
    if (act) {
      act.status = "failed";
      act.completed_at = new Date().toISOString();
      act.label = formatToolFailedLabel(toolName);
      if (act.started_at) {
        act.duration_ms =
          new Date(act.completed_at).getTime() -
          new Date(act.started_at).getTime();
      }
      emitSSE("activity", {
        stream_sequence: nextSeq(),
        data: act,
      });
    }
  }

  function handleToolBlocked(
    toolCallId: string | undefined,
    toolName: string,
    eventId: string,
  ): void {
    const key = toolCallId ?? toolName;
    const act = activities.find(
      (a) => a.kind === "tool" && a.tool_call_id === key,
    );
    if (act) {
      act.status = "blocked";
      act.completed_at = new Date().toISOString();
      act.label = formatToolBlockedLabel(toolName);
      emitSSE("activity", {
        stream_sequence: nextSeq(),
        data: act,
      });
    } else {
      const blockedActivity: ProjectorActivity = {
        id: eventId,
        sequence: ++activitySeq,
        created_at: new Date().toISOString(),
        kind: "tool",
        tool_call_id: toolCallId,
        tool_name: toolName,
        status: "blocked",
        label: formatToolBlockedLabel(toolName),
        completed_at: new Date().toISOString(),
      };
      pushActivity(blockedActivity);
    }
  }

  function emitAnswerBoundaryAndContent(finalContent: string): void {
    phase = "answering";

    // process_completed (exactly once)
    if (!hasSentProcessCompleted) {
      processCompletedAt = new Date().toISOString();
      processingDurationMs = Date.now() - streamStartedAt;
      emitSSE("process_completed", {
        stream_sequence: nextSeq(),
        completed_at: processCompletedAt,
        processing_duration_ms: processingDurationMs,
      });
      hasSentProcessCompleted = true;
    }

    // answer_started (exactly once)
    if (!hasSentAnswerStarted) {
      emitSSE("answer_started", {
        stream_sequence: nextSeq(),
        started_at: new Date().toISOString(),
      });
      hasSentAnswerStarted = true;
    }

    // answer_delta chunks — concatenation must exactly equal finalContent
    if (finalContent) {
      const chunkSize = 100;
      for (let i = 0; i < finalContent.length; i += chunkSize) {
        const chunk = finalContent.slice(i, i + chunkSize);
        emitSSE("answer_delta", {
          stream_sequence: nextSeq(),
          content: chunk,
        });
      }
    }

    phase = "done";
  }

  function getActivities(): ProjectorActivity[] {
    return activities;
  }

  function getExecutionSteps() {
    return activities
      .filter((a) => a.kind === "tool")
      .map((a) => ({
        tool_name: a.tool_name ?? "",
        tool_call_id: a.tool_call_id,
        status: a.status ?? "started",
        label: a.label ?? "",
      }));
  }

  function hasCompletedProcess(): boolean {
    return hasSentProcessCompleted;
  }

  function getPhase(): ProjectorPhase {
    return phase;
  }

  function getStreamSequence(): number {
    return streamSequence;
  }

  function getPendingText(): string {
    return pendingVisibleText;
  }

  function drainPendingText(sanitizerFlush?: () => string): string {
    if (sanitizerFlush) {
      const tail = sanitizerFlush();
      if (tail) pendingVisibleText += tail;
    }
    const text = pendingVisibleText;
    pendingVisibleText = "";
    return text;
  }

  function getProcessSummary() {
    return {
      process_completed_at: processCompletedAt,
      processing_duration_ms: processingDurationMs,
    };
  }

  return {
    emitProcessStarted,
    emitInitialProgress,
    emitSkillActivity,
    accumulateText,
    handleToolStarted,
    handleToolCompleted,
    handleToolFailed,
    handleToolBlocked,
    emitAnswerBoundaryAndContent,
    getActivities,
    getExecutionSteps,
    hasCompletedProcess,
    getPhase,
    getStreamSequence,
    getPendingText,
    drainPendingText,
    getProcessSummary,
  };
}

/**
 * Production projector tests — event sequence, phase transitions,
 * activity ordering, answer isolation, and edge cases.
 *
 * Tests import the PRODUCTION createStreamProjector (not a copy).
 */
import { describe, it, expect } from "vitest";
import {
  createStreamProjector,
  formatToolStartLabel,
  formatToolCompleteLabel,
  formatToolFailedLabel,
  formatToolBlockedLabel,
  getToolBaseLabel,
  toolLabel,
  INITIAL_PROGRESS_TEXT,
  type SSEWriter,
  type StreamProjector,
} from "../../src/server/routes/run-stream-presentation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedEvent {
  event: string;
  data: Record<string, unknown>;
}

function createTestProjector(streamStartedAt?: number) {
  const events: CapturedEvent[] = [];
  const writer: SSEWriter = (event, data) => {
    // Deep copy to snapshot at emit time (matches production JSON.stringify behavior)
    events.push({ event, data: JSON.parse(JSON.stringify(data)) });
  };
  const projector = createStreamProjector(writer, streamStartedAt ?? Date.now());
  return { projector, events };
}

/** Extract activity events from captured events. */
function activityEvents(events: CapturedEvent[]) {
  return events.filter((e) => e.event === "activity");
}

/** Extract process_delta events from captured events. */
function processDeltaEvents(events: CapturedEvent[]) {
  return events.filter((e) => e.event === "process_delta");
}

/** Extract answer_delta events and concatenate content. */
function answerContent(events: CapturedEvent[]): string {
  return events
    .filter((e) => e.event === "answer_delta")
    .map((e) => (e.data as Record<string, unknown>).content as string)
    .join("");
}

/** Get stream_sequence values from all events that have one. */
function sequences(events: CapturedEvent[]): number[] {
  return events
    .map((e) => (e.data as Record<string, unknown>).stream_sequence as number | undefined)
    .filter((s): s is number => typeof s === "number");
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

describe("tool label helpers", () => {
  it("getToolBaseLabel returns Chinese label for known tools", () => {
    expect(getToolBaseLabel("get_project_state")).toBe("获取项目状态");
    expect(getToolBaseLabel("create_risk")).toBe("创建风险记录");
    expect(getToolBaseLabel("get_timeline_slice")).toBe("查看最近进展");
  });

  it("getToolBaseLabel returns null for unknown tools", () => {
    expect(getToolBaseLabel("unknown_tool")).toBeNull();
  });

  it("formatToolStartLabel wraps base label with 正在", () => {
    expect(formatToolStartLabel("get_project_state")).toBe("正在获取项目状态");
    expect(formatToolStartLabel("unknown_tool")).toBe("正在执行工具");
  });

  it("formatToolCompleteLabel wraps base label with 已", () => {
    expect(formatToolCompleteLabel("get_project_state")).toBe("已获取项目状态");
    expect(formatToolCompleteLabel("unknown_tool")).toBe("已完成工具");
  });

  it("formatToolFailedLabel appends 失败", () => {
    expect(formatToolFailedLabel("get_project_state")).toBe("获取项目状态失败");
    expect(formatToolFailedLabel("unknown_tool")).toBe("执行工具失败");
  });

  it("formatToolBlockedLabel appends 已被阻止", () => {
    expect(formatToolBlockedLabel("get_project_state")).toBe("获取项目状态已被阻止");
    expect(formatToolBlockedLabel("unknown_tool")).toBe("执行工具已被阻止");
  });

  it("toolLabel returns base label for known, generic fallback for unknown", () => {
    expect(toolLabel("get_project_state")).toBe("获取项目状态");
    expect(toolLabel("unknown_tool")).toBe("执行工具");
    expect(toolLabel("")).toBe("执行工具");
  });

  it("no raw snake_case in any label output", () => {
    const allLabels = [
      formatToolStartLabel("some_unknown_tool"),
      formatToolCompleteLabel("some_unknown_tool"),
      formatToolFailedLabel("some_unknown_tool"),
      formatToolBlockedLabel("some_unknown_tool"),
      toolLabel("some_unknown_tool"),
    ];
    for (const label of allLabels) {
      expect(label).not.toContain("some_unknown_tool");
      expect(label).not.toContain("some unknown tool");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 18: Full event sequence
// ---------------------------------------------------------------------------

describe("projector: full event sequence (test 18)", () => {
  it("text A → tool1 → text B → tool2 → final C → correct timeline and answer isolation", () => {
    const { projector, events } = createTestProjector();

    // 1. Process started
    projector.emitProcessStarted();

    // 2. Initial progress
    projector.emitInitialProgress();

    // 3. Skill
    projector.emitSkillActivity("project-intake", "已读取项目澄清技能");

    // 4. Model commentary text A
    projector.accumulateText("让我先看看项目状态。");

    // 5. Tool1 started (flushes text A as progress)
    projector.handleToolStarted("get_project_state", "tc-1");
    projector.handleToolCompleted("tc-1", "get_project_state");

    // 6. Model commentary text B
    projector.accumulateText("状态已确认，接下来创建风险记录。");

    // 7. Tool2 started (flushes text B as progress)
    projector.handleToolStarted("create_risk", "tc-2");
    projector.handleToolCompleted("tc-2", "create_risk");

    // 8. Final answer C
    projector.emitAnswerBoundaryAndContent("这是最终回答内容。");

    // --- Assertions ---

    // Activities order: initial progress, skill, progress A, tool1, progress B, tool2
    const activities = projector.getActivities();
    const kinds = activities.map((a) => a.kind);
    expect(kinds).toEqual(["progress", "skill", "progress", "tool", "progress", "tool"]);

    // Progress contents
    const progressItems = activities.filter((a) => a.kind === "progress");
    expect(progressItems[0].content).toBe(INITIAL_PROGRESS_TEXT);
    expect(progressItems[1].content).toBe("让我先看看项目状态。");
    expect(progressItems[2].content).toBe("状态已确认，接下来创建风险记录。");

    // Tool labels (completed → formatToolCompleteLabel)
    const toolItems = activities.filter((a) => a.kind === "tool");
    expect(toolItems[0].label).toBe("已获取项目状态");
    expect(toolItems[0].status).toBe("completed");
    expect(toolItems[0].tool_call_id).toBe("tc-1");
    expect(toolItems[1].label).toBe("已创建风险记录");
    expect(toolItems[1].status).toBe("completed");
    expect(toolItems[1].tool_call_id).toBe("tc-2");

    // answer_delta concatenation = C (not A or B)
    const answer = answerContent(events);
    expect(answer).toBe("这是最终回答内容。");
    expect(answer).not.toContain("让我先看看");
    expect(answer).not.toContain("状态已确认");

    // process_completed exactly once, before answer_started
    const processCompletedSeqs = events
      .filter((e) => e.event === "process_completed")
      .map((e) => e.data.stream_sequence as number);
    expect(processCompletedSeqs).toHaveLength(1);

    const answerStartedSeqs = events
      .filter((e) => e.event === "answer_started")
      .map((e) => e.data.stream_sequence as number);
    expect(answerStartedSeqs).toHaveLength(1);
    expect(processCompletedSeqs[0]).toBeLessThan(answerStartedSeqs[0]);

    // First answer_delta after answer_started
    const firstAnswerDeltaSeq = events
      .find((e) => e.event === "answer_delta")?.data.stream_sequence as number;
    expect(firstAnswerDeltaSeq).toBeGreaterThan(answerStartedSeqs[0]);

    // Stream sequence strictly increasing
    const seqs = sequences(events);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    // First progress activity has empty content (process_delta carries the text)
    const firstProgressAct = activityEvents(events).find(
      (e) => (e.data.data as Record<string, unknown>)?.kind === "progress",
    );
    expect((firstProgressAct!.data.data as Record<string, unknown>).content).toBe("");

    // The actual content comes via process_delta
    const firstProgressDelta = processDeltaEvents(events).find(
      (e) => (e.data as Record<string, unknown>).activity_id ===
        (firstProgressAct!.data.data as Record<string, unknown>).id,
    );
    expect((firstProgressDelta!.data as Record<string, unknown>).content).toBe(INITIAL_PROGRESS_TEXT);

    // Execution steps derived from tool activities
    const steps = projector.getExecutionSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ tool_name: "get_project_state", tool_call_id: "tc-1", status: "completed" });
    expect(steps[1]).toMatchObject({ tool_name: "create_risk", tool_call_id: "tc-2", status: "completed" });
  });
});

// ---------------------------------------------------------------------------
// Test 19: No commentary multi-tool with category transitions
// ---------------------------------------------------------------------------

describe("projector: no commentary multi-tool (test 19)", () => {
  it("initial progress + category transition progress + dedup for same category", () => {
    const { projector, events } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    // Tool 1: read (no previous category → no transition)
    projector.handleToolStarted("get_project_state", "tc-1");
    projector.handleToolCompleted("tc-1", "get_project_state");

    // Tool 2: timeline (read→timeline transition)
    projector.handleToolStarted("get_timeline_slice", "tc-2");
    projector.handleToolCompleted("tc-2", "get_timeline_slice");

    // Tool 3: same category (timeline→timeline → NO transition)
    projector.handleToolStarted("get_timeline_slice", "tc-3");
    projector.handleToolCompleted("tc-3", "get_timeline_slice");

    // Tool 4: create (timeline→create transition)
    projector.handleToolStarted("create_risk", "tc-4");
    projector.handleToolCompleted("tc-4", "create_risk");

    // Tool 5: same category (create→create → NO transition)
    projector.handleToolStarted("create_checkin", "tc-5");
    projector.handleToolCompleted("tc-5", "create_checkin");

    projector.emitAnswerBoundaryAndContent("回答");

    const activities = projector.getActivities();
    const progressItems = activities.filter((a) => a.kind === "progress");
    const toolItems = activities.filter((a) => a.kind === "tool");

    // Should have: initial + read→timeline + timeline→create = 3 progress items
    expect(progressItems).toHaveLength(3);
    expect(progressItems[0].content).toBe(INITIAL_PROGRESS_TEXT);
    expect(progressItems[1].content).toBe("项目状态已读取，接下来核对近期进展。");
    expect(progressItems[2].content).toBe("近期进展已核对，接下来创建记录。");

    // 5 tools in order
    expect(toolItems).toHaveLength(5);
    expect(toolItems[0].tool_name).toBe("get_project_state");
    expect(toolItems[1].tool_name).toBe("get_timeline_slice");
    expect(toolItems[2].tool_name).toBe("get_timeline_slice");
    expect(toolItems[3].tool_name).toBe("create_risk");
    expect(toolItems[4].tool_name).toBe("create_checkin");

    // Activities interleaved: progress, tool, progress, tool, tool, progress, tool, tool
    const kinds = activities.map((a) => a.kind);
    expect(kinds).toEqual([
      "progress", // initial
      "tool",     // get_project_state
      "progress", // read→timeline
      "tool",     // get_timeline_slice
      "tool",     // get_timeline_slice (same category, no transition)
      "progress", // timeline→create
      "tool",     // create_risk
      "tool",     // create_checkin (same category, no transition)
    ]);
  });

  it("model commentary overrides deterministic transition", () => {
    const { projector } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    // Tool 1: read
    projector.handleToolStarted("get_project_state", "tc-1");
    projector.handleToolCompleted("tc-1", "get_project_state");

    // Model produces commentary before next tool
    projector.accumulateText("项目进展良好，接下来查看时间线。");

    // Tool 2: timeline (read→timeline, but model commentary takes priority)
    projector.handleToolStarted("get_timeline_slice", "tc-2");
    projector.handleToolCompleted("tc-2", "get_timeline_slice");

    projector.emitAnswerBoundaryAndContent("回答");

    const progressItems = projector.getActivities().filter((a) => a.kind === "progress");
    // Should have: initial + model commentary = 2 progress (no deterministic transition)
    expect(progressItems).toHaveLength(2);
    expect(progressItems[0].content).toBe(INITIAL_PROGRESS_TEXT);
    expect(progressItems[1].content).toBe("项目进展良好，接下来查看时间线。");
  });
});

// ---------------------------------------------------------------------------
// Test 20: Edge cases
// ---------------------------------------------------------------------------

describe("projector: edge cases (test 20)", () => {
  it("same-name different tool_call_id creates separate activities", () => {
    const { projector } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    projector.handleToolStarted("create_risk", "tc-a");
    projector.handleToolCompleted("tc-a", "create_risk");

    projector.handleToolStarted("create_risk", "tc-b");
    projector.handleToolCompleted("tc-b", "create_risk");

    projector.emitAnswerBoundaryAndContent("回答");

    const toolItems = projector.getActivities().filter((a) => a.kind === "tool");
    expect(toolItems).toHaveLength(2);
    expect(toolItems[0].tool_call_id).toBe("tc-a");
    expect(toolItems[1].tool_call_id).toBe("tc-b");
    expect(toolItems[0].id).not.toBe(toolItems[1].id);
  });

  it("failed tool updates activity status", () => {
    const { projector } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    projector.handleToolStarted("get_project_state", "tc-fail");
    projector.handleToolFailed("tc-fail", "get_project_state");

    projector.emitAnswerBoundaryAndContent("回答");

    const toolItems = projector.getActivities().filter((a) => a.kind === "tool");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0].status).toBe("failed");
    expect(toolItems[0].label).toBe("获取项目状态失败");
    expect(toolItems[0].duration_ms).toBeDefined();
  });

  it("blocked tool with existing activity updates status", () => {
    const { projector } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    projector.handleToolStarted("create_risk", "tc-block");
    projector.handleToolBlocked("tc-block", "create_risk", "ev-1");

    projector.emitAnswerBoundaryAndContent("回答");

    const toolItems = projector.getActivities().filter((a) => a.kind === "tool");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0].status).toBe("blocked");
    expect(toolItems[0].label).toBe("创建风险记录已被阻止");
  });

  it("blocked tool without existing activity creates new blocked entry", () => {
    const { projector } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    // Blocked without prior started (policy_block)
    projector.handleToolBlocked(undefined, "shell_exec", "ev-blocked");

    projector.emitAnswerBoundaryAndContent("回答");

    const toolItems = projector.getActivities().filter((a) => a.kind === "tool");
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0].status).toBe("blocked");
    expect(toolItems[0].label).toBe("执行工具已被阻止");
  });

  it("no-tool direct answer: only initial progress + answer", () => {
    const { projector, events } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();
    projector.emitAnswerBoundaryAndContent("直接回答内容");

    const activities = projector.getActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0].kind).toBe("progress");
    expect(activities[0].content).toBe(INITIAL_PROGRESS_TEXT);

    expect(answerContent(events)).toBe("直接回答内容");
  });

  it("final_content missing fallback: uses pendingVisibleText", () => {
    const { projector, events } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    // Model produces text but no final_content
    projector.accumulateText("这是模型的最后输出。");

    // Simulate: drainPendingText would be called by stream route
    // Here we test the projector's getPendingText
    expect(projector.getPendingText()).toBe("这是模型的最后输出。");

    // emitAnswerBoundaryAndContent with empty final_content
    projector.emitAnswerBoundaryAndContent("");

    // Answer should be empty (the stream route would use getPendingText as fallback)
    expect(answerContent(events)).toBe("");
  });

  it("drainPendingText flushes accumulated text", () => {
    const { projector } = createTestProjector();

    projector.accumulateText("部分文本");
    projector.accumulateText("更多文本");

    const drained = projector.drainPendingText();
    expect(drained).toBe("部分文本更多文本");
    expect(projector.getPendingText()).toBe("");
  });

  it("drainPendingText with sanitizer flush", () => {
    const { projector } = createTestProjector();

    projector.accumulateText("已累积");

    const drained = projector.drainPendingText(() => "尾部文本");
    expect(drained).toBe("已累积尾部文本");
    expect(projector.getPendingText()).toBe("");
  });

  it("emitAnswerBoundaryAndContent is idempotent for process_completed", () => {
    const { projector, events } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    // Call twice — should only emit process_completed once
    projector.emitAnswerBoundaryAndContent("回答1");
    projector.emitAnswerBoundaryAndContent("回答2");

    const processCompleted = events.filter((e) => e.event === "process_completed");
    expect(processCompleted).toHaveLength(1);

    const answerStarted = events.filter((e) => e.event === "answer_started");
    expect(answerStarted).toHaveLength(1);
  });

  it("phase transitions correctly", () => {
    const { projector } = createTestProjector();

    expect(projector.getPhase()).toBe("initial");

    projector.emitProcessStarted();
    expect(projector.getPhase()).toBe("processing");

    projector.emitInitialProgress();
    expect(projector.getPhase()).toBe("processing");

    projector.emitAnswerBoundaryAndContent("回答");
    expect(projector.getPhase()).toBe("done");
  });

  it("stream_sequence is strictly monotonically increasing", () => {
    const { projector, events } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();
    projector.emitSkillActivity("test-skill", "测试技能");
    projector.accumulateText("文本");
    projector.handleToolStarted("get_project_state", "tc-1");
    projector.handleToolCompleted("tc-1", "get_project_state");
    projector.emitAnswerBoundaryAndContent("回答");

    const seqs = sequences(events);
    expect(seqs.length).toBeGreaterThan(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3: process summary (completed_at, processing_duration_ms)
// ---------------------------------------------------------------------------

describe("projector: process summary (fix 3)", () => {
  it("getProcessSummary returns null/0 before process_completed", () => {
    const { projector } = createTestProjector();
    const summary = projector.getProcessSummary();
    expect(summary.process_completed_at).toBeNull();
    expect(summary.processing_duration_ms).toBe(0);
  });

  it("getProcessSummary returns timestamps after emitAnswerBoundaryAndContent", () => {
    const startedAt = Date.now();
    const { projector } = createTestProjector(startedAt);

    projector.emitProcessStarted();
    projector.emitInitialProgress();
    projector.emitAnswerBoundaryAndContent("回答");

    const summary = projector.getProcessSummary();
    expect(summary.process_completed_at).toBeTruthy();
    expect(typeof summary.process_completed_at).toBe("string");
    expect(summary.processing_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("process_completed event carries completed_at and processing_duration_ms", () => {
    const startedAt = Date.now();
    const { projector, events } = createTestProjector(startedAt);

    projector.emitProcessStarted();
    projector.emitInitialProgress();
    projector.emitAnswerBoundaryAndContent("回答");

    const processCompleted = events.find((e) => e.event === "process_completed");
    expect(processCompleted).toBeTruthy();
    expect(processCompleted!.data.completed_at).toBeTruthy();
    expect(typeof processCompleted!.data.processing_duration_ms).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Additional projector tests
// ---------------------------------------------------------------------------

describe("projector: activity lifecycle", () => {
  it("tool completed updates duration_ms", () => {
    const { projector } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    projector.handleToolStarted("get_project_state", "tc-1");
    // Small delay to ensure duration > 0
    projector.handleToolCompleted("tc-1", "get_project_state");

    const tool = projector.getActivities().find((a) => a.kind === "tool");
    expect(tool!.status).toBe("completed");
    expect(tool!.completed_at).toBeDefined();
    // duration_ms may be 0 if instant, but should be defined
    expect(tool!.duration_ms).toBeDefined();
  });

  it("skill activity has correct structure", () => {
    const { projector } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();
    projector.emitSkillActivity("risk-analysis", "已读取风险分析技能");

    const skill = projector.getActivities().find((a) => a.kind === "skill");
    expect(skill).toMatchObject({
      kind: "skill",
      skill_name: "risk-analysis",
      status: "loaded",
      label: "已读取风险分析技能",
      duration_ms: 0,
    });
  });

  it("unknown tool uses generic labels", () => {
    const { projector } = createTestProjector();

    projector.emitProcessStarted();
    projector.emitInitialProgress();

    projector.handleToolStarted("mcp_server_tool", "tc-unknown");
    projector.handleToolCompleted("tc-unknown", "mcp_server_tool");

    const tool = projector.getActivities().find((a) => a.kind === "tool");
    expect(tool!.label).toBe("已完成工具"); // Not "已工具 mcp server tool"
    expect(tool!.status).toBe("completed");
  });
});

/**
 * POST /runs/:runId/resume — Resume a previously interrupted run.
 *
 * Fetches durable state from FastAPI, rehydrates run state,
 * checks compatibility/recovery policy, and resumes execution
 * on the SAME run (does not create a new run).
 *
 * Resume semantics:
 * - Restores original governed goal, Outcome Contract, WorkState/version,
 *   RunPlan/current step, ledger/recovery decisions, viewer identity,
 *   model/Skill/prompt versions, and unconsumed steering
 * - Uses checkpoint recovery decisions to determine tool handling
 * - completed tools: skipped (no replay)
 * - safe_to_retry tools: re-executed with same idempotency key
 * - blocked_unknown tools: run is blocked, cannot resume
 * - Never uses a placeholder message as the resumed goal
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunContext } from "./utils.js";
import { sendJson } from "./utils.js";
import { rehydrateFromEvents } from "@/runtime/rehydrate.js";
import { createRunState } from "@/types/run-state.js";
import { executeRun } from "@/runtime/pi-runtime.js";
import type { RunInput, PendingSteeringEvent, ResumeExecutionContext } from "@/runtime/pi-runtime.js";
import type { StreamEventType } from "@/events/stream.js";
import type { RuntimeEvent } from "@/types/runtime-event.js";
import type { SkillContext } from "@/runtime/context-builder.js";
import { resolveSkillContext } from "@/skills/skill-resolver.js";
import type { OutcomeContract } from "@/runtime/outcome-contract.js";
import type { RunCheckpoint } from "@/runtime/checkpoint.js";

/** Maximum number of event pages to fetch during resume pagination. */
const MAX_RESUME_PAGES = 10;

export async function handleResumeRun(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RunContext,
): Promise<void> {
  const runId = params.runId;
  if (!runId) {
    sendJson(res, 400, { error: "missing_run_id", message: "缺少 run ID" });
    return;
  }

  try {
    // Step 1: Fetch durable snapshot from FastAPI (paginated)
    const snapshot = await fetchCompleteSnapshot(ctx, runId);

    // Step 2: Rehydrate from events
    const events = (snapshot.recent_events as Array<Record<string, unknown>>) ?? [];
    const rehydrateResult = rehydrateFromEvents(
      events.map((e) => ({
        id: e.id as string ?? "",
        run_id: runId,
        type: e.type as string ?? "",
        event_seq: e.event_seq as number ?? 0,
        payload: (e.payload as Record<string, unknown>) ?? {},
        created_at: e.created_at as string ?? "",
      })),
      runId,
      snapshot.conversation_id as string ?? "",
      snapshot.workspace_id as string ?? "",
      snapshot.project_id as string ?? "",
    );

    if (!rehydrateResult.success) {
      sendJson(res, 400, {
        error: "rehydrate_failed",
        message: rehydrateResult.error ?? "无法恢复运行状态",
      });
      return;
    }

    // Step 3: Check resume eligibility
    if (!rehydrateResult.canResume) {
      sendJson(res, 409, {
        error: "cannot_resume",
        message: rehydrateResult.resumeReason,
      });
      return;
    }

    // Step 4: Validate required durable context
    const checkpoint = rehydrateResult.checkpoint;
    if (!checkpoint) {
      sendJson(res, 409, {
        error: "no_checkpoint",
        message: "无检查点数据，无法安全恢复运行",
      });
      return;
    }

    // Step 5: Restore original user content from checkpoint (never synthetic)
    const originalUserContent = checkpoint.originalUserContent
      ?? restoreOriginalUserContentFromEvents(events);
    if (!originalUserContent) {
      sendJson(res, 409, {
        error: "missing_goal",
        message: "无法恢复原始目标内容，需人工审查",
      });
      return;
    }

    // Step 6: Restore Outcome Contract from checkpoint (full contract, not synthetic)
    const outcomeContract = checkpoint.fullOutcomeContract
      ?? restoreOutcomeContractFromCheckpoint(checkpoint);
    if (!outcomeContract) {
      sendJson(res, 409, {
        error: "missing_contract",
        message: "无法恢复 Outcome Contract，需人工审查",
      });
      return;
    }

    // Step 7: Restore viewer identity — use snapshot first, then authenticated endpoint
    let viewerUserId = (snapshot.viewer_user_id as string) || undefined;

    // Step 8: Fetch authenticated resume context (blocking failure)
    let workspaceState: unknown;
    let pendingProposals: unknown[] = [];
    let memoryContext: unknown = null;
    try {
      if (viewerUserId) {
        const resumeCtx = await ctx.fastapiClient.getResumeContext(runId, viewerUserId);
        viewerUserId = resumeCtx.viewer_user_id as string ?? viewerUserId;
        // Extract actual fields from resume context (not the wrapper)
        workspaceState = resumeCtx.workspace_state ?? resumeCtx;
        pendingProposals = (resumeCtx.pending_proposals as unknown[]) ?? [];
        memoryContext = resumeCtx.memory_context ?? null;
      } else {
        // No viewer in snapshot — cannot fetch authenticated context
        sendJson(res, 409, {
          error: "missing_viewer",
          message: "无法恢复 viewer 身份，需人工审查",
        });
        return;
      }
    } catch (err) {
      // Workspace state fetch failure on resume is BLOCKING — do not proceed
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 409, {
        error: "resume_context_failed",
        message: `无法获取恢复上下文: ${message}`,
      });
      return;
    }

    // Step 9: Resolve skill context if the original run had one
    const skillName = checkpoint?.contextSummary?.skillName;
    let skillContext: SkillContext | undefined;
    if (skillName) {
      const resolved = await resolveSkillContext({ skillName }, ctx.skillLoader, ctx.skillIndex);
      skillContext = resolved;
    }

    // Step 10: Restore unconsumed steering from snapshot
    const unconsumedSteering = (snapshot.unconsumed_steering as Array<Record<string, unknown>>) ?? [];
    const pendingSteering: PendingSteeringEvent[] = unconsumedSteering.map((s) => ({
      steeringSeq: s.steering_seq as number,
      steeringType: s.steering_type as PendingSteeringEvent["steeringType"],
      content: s.content as string ?? "",
      clientMessageId: s.client_message_id as string ?? "",
      metadata: s.metadata as Record<string, unknown> | undefined,
    }));

    // Step 11: Build ResumeExecutionContext from rehydrated data
    const resumeContext: ResumeExecutionContext = {
      workState: rehydrateResult.workState!,
      runPlan: rehydrateResult.runPlan,
      toolLedger: rehydrateResult.toolLedger,
      recoveryDecisions: checkpoint.recoveryDecisions ?? [],
      completedLogicalCallIds: new Set(
        (checkpoint.recoveryDecisions ?? [])
          .filter((d) => d.action === "completed")
          .map((d) => d.logicalCallId),
      ),
      safeToRetryLogicalCallIds: new Set(
        (checkpoint.recoveryDecisions ?? [])
          .filter((d) => d.action === "safe_to_retry")
          .map((d) => d.logicalCallId),
      ),
      stateVersion: (snapshot.state_version as number) ?? 0,
      lastEventSeq: rehydrateResult.runState!.lastEventSeq,
      checkpointVersion: checkpoint.version,
    };

    // Step 12: Create local run state from rehydrated data
    const runState = createRunState({
      runId,
      conversationId: rehydrateResult.runState!.conversationId,
      workspaceId: rehydrateResult.runState!.workspaceId,
      projectId: rehydrateResult.runState!.projectId,
      model: rehydrateResult.runState!.model,
      maxSteps: rehydrateResult.runState!.budgetLimits.maxSteps,
      maxToolCalls: rehydrateResult.runState!.budgetLimits.maxToolCalls,
      timeoutMs: rehydrateResult.runState!.budgetLimits.timeoutMs,
    });
    // Restore sequence counter and state version from durable baseline
    runState.lastEventSeq = resumeContext.lastEventSeq;
    runState.stateVersion = resumeContext.stateVersion;

    ctx.sessionStore.set(runId, runState);
    const abortController = new AbortController();
    ctx.sessionStore.setAbortController(runId, abortController);

    // Step 13: Return success immediately
    sendJson(res, 200, {
      run_id: runId,
      status: "resumed",
      work_state: rehydrateResult.workState?.status,
      recovery_decisions: resumeContext.recoveryDecisions.length,
      completed_calls_skipped: resumeContext.completedLogicalCallIds.size,
      message: "运行已恢复",
    });

    // Step 14: Resume execution with full ResumeExecutionContext
    const runInput: RunInput = {
      conversationId: runState.conversationId,
      workspaceId: runState.workspaceId,
      projectId: runState.projectId,
      userContent: originalUserContent,  // Restored from checkpoint, NOT synthetic
      workspaceState,
      recentMessages: [],
      pendingProposals,                  // Fresh from FastAPI, not empty
      skillContext,
      viewerUserId,
      outcomeContract,                   // Restored from checkpoint, NOT synthetic
      pendingSteering,
      memoryContext: memoryContext as RunInput["memoryContext"],
    };

    executeRun(
      runState,
      runInput,
      ctx.toolRegistry,
      ctx.modelRouter,
      ctx.fastapiClient,
      ctx.stream,
      {
        traceIncludeSensitiveData: false,
        signal: abortController.signal,
        resumeContext,                   // Pass rehydrated context
      },
      {
        onEvent: (type, payload) => {
          ctx.stream.emit(type as StreamEventType, { type, ...payload } as RuntimeEvent);
        },
        onComplete: (state) => {
          ctx.sessionStore.clearAbortController(state.runId);
          console.log(`[agent-bridge] resumed run ${state.runId} completed`);
        },
        onError: (error, state) => {
          ctx.sessionStore.clearAbortController(state.runId);
          console.error(`[agent-bridge] resumed run ${state.runId} failed:`, error.message);
        },
      },
    ).catch((err) => {
      ctx.sessionStore.clearAbortController(runId);
      console.error(`[agent-bridge] resumed run ${runId} uncaught error:`, err);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: "resume_failed", message: `恢复失败: ${message}` });
  }
}

/**
 * Fetch complete snapshot with cursor-based pagination.
 * Loops until all post-checkpoint events are fetched (has_more=false).
 * Returns 409 if pagination exceeds safety bounds.
 */
async function fetchCompleteSnapshot(
  ctx: RunContext,
  runId: string,
): Promise<Record<string, unknown>> {
  const firstPage = await ctx.fastapiClient.getRunSnapshot(runId);
  let allEvents = (firstPage.recent_events as Array<Record<string, unknown>>) ?? [];
  let hasMore = firstPage.has_more as boolean ?? false;
  let nextCursor = firstPage.next_cursor as number | null ?? null;
  let pageCount = 1;

  while (hasMore && nextCursor != null && pageCount < MAX_RESUME_PAGES) {
    // Fetch next page using cursor — advances past already-fetched events
    const nextPage = await ctx.fastapiClient.getRunSnapshot(runId, nextCursor);
    const newEvents = (nextPage.recent_events as Array<Record<string, unknown>>) ?? [];

    // Deduplicate by event_seq (safety net, should not overlap with cursor)
    const existingSeqs = new Set(allEvents.map((e) => e.event_seq));
    const freshEvents = newEvents.filter((e) => !existingSeqs.has(e.event_seq));
    allEvents = [...allEvents, ...freshEvents];

    hasMore = nextPage.has_more as boolean ?? false;
    nextCursor = nextPage.next_cursor as number | null ?? null;
    pageCount++;
  }

  if (hasMore) {
    throw new Error(
      `恢复失败: 事件数量超过安全上限 (${MAX_RESUME_PAGES} 页), 需人工审查`,
    );
  }

  // Return merged snapshot
  return {
    ...firstPage,
    recent_events: allEvents,
    has_more: false,
    next_cursor: null,
  };
}

/**
 * Restore original user content from events.
 * Looks for agent.started event with user_content. No synthetic fallback.
 */
function restoreOriginalUserContentFromEvents(
  events: Array<Record<string, unknown>>,
): string | undefined {
  for (const event of events) {
    if (event.type === "agent.started") {
      const payload = event.payload as Record<string, unknown> | undefined;
      const userContent = payload?.user_content as string | undefined;
      if (userContent && userContent.length > 0) {
        return userContent;
      }
    }
  }
  return undefined;
}

/**
 * Restore Outcome Contract from checkpoint summary fields.
 * Only used when fullOutcomeContract is not in the checkpoint (old format).
 * Returns undefined if insufficient data — caller must block.
 */
function restoreOutcomeContractFromCheckpoint(
  checkpoint: RunCheckpoint,
): OutcomeContract | undefined {
  const summary = checkpoint.outcomeContractSummary;
  if (!summary) return undefined;

  // Old checkpoint format — reconstruct minimal contract from summary
  // This is a degraded fallback; new checkpoints store the full contract.
  if (!checkpoint.hardConstraints || !checkpoint.successCriteria) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    requestType: (summary.requestType ?? "act") as OutcomeContract["requestType"],
    normalizedGoal: checkpoint.originalUserContent?.slice(0, 200) ?? "",
    constraints: checkpoint.hardConstraints,
    successCriteria: checkpoint.successCriteria,
    requiredEvidence: ["tool_observations", "tool_results"],
    effectCeiling: (summary.effectCeiling ?? "full") as OutcomeContract["effectCeiling"],
    clarificationPolicy: "never" as OutcomeContract["clarificationPolicy"],
    verificationLevel: (summary.verificationLevel ?? "deterministic") as OutcomeContract["verificationLevel"],
    completionMode: (summary.completionMode ?? "complete") as OutcomeContract["completionMode"],
  };
}

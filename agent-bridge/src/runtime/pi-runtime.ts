/**
 * Pi runtime adapter — wraps @earendil-works/pi-agent-core's runAgentLoop.
 *
 * This is the core orchestration module that:
 * 1. Receives a run request from FastAPI
 * 2. Builds model context via context-builder
 * 3. Runs the agent loop using Pi's runAgentLoop
 * 4. On each tool call: beforeToolCall → policy gate → execute → afterToolCall
 * 5. Persists events/results via FastAPI append API
 * 6. Loops until model produces final answer or budget exhausted
 *
 * Key invariants:
 * - Every tool call produces exactly one result
 * - Parameters validated before execution
 * - Policy decision recorded before every side effect
 * - Every result has a bounded payload
 * - Tool success observation only returned to model after FastAPI confirms persistence
 */

import type { AgentRunState, RunStatus } from "@/types/run-state.js";
import type { ContextBuildInput, MemoryContext, SkillContext } from "./context-builder.js";
import { buildContext, filterModelCallableManifests, transformForLLM } from "./context-builder.js";
import type { OutcomeContract } from "./outcome-contract.js";
import { PROMPT_KERNEL_VERSION, hashPromptKernel } from "./request-preparation.js";
import { DEFAULT_CONTEXT_TOKENS } from "@/types/model-config.js";
import { createInitialWorkState, transitionWorkState, type WorkStateStatus } from "./work-state.js";
import { shouldCreatePlan, createSimplePlan, type RunPlan } from "./run-plan.js";
import { verify, type VerifierReport } from "./verifier.js";
import { createMemoryGuardedStreamFn, shouldGuardMemoryOutput } from "./memory-output-guard.js";
import type { ModelRouter } from "./model-router.js";
import type { FastapiClient } from "@/tools/fastapi-client.js";
import type { ToolRegistry, ToolExecutionContext } from "@/tools/registry.js";
import { ToolExecutor, type ToolLedgerEntry } from "@/tools/tool-executor.js";
import { persistLedgerEntry, persistCheckpoint } from "@/tools/tool-ledger.js";
import { createCheckpoint } from "./checkpoint.js";
import { hashValue } from "@/utils/hash.js";
// normalizeResult is used internally by ToolExecutor
import { canExecuteInParallel, evaluatePolicy } from "@/policy/policy-engine.js";
import { BudgetManager } from "@/policy/budget.js";
// createToolTrace is used internally by ToolExecutor
import {
  buildRuntimeEvent,
  buildRuntimeEventFromPiEvent,
  buildRuntimeProductEvent,
  shouldPersistPiEvent,
} from "@/events/event-mapper.js";
import { getDebugPayloadStore, type DebugPayloadStore } from "@/events/debug-payload-store.js";
import type { EventStream, StreamEventType } from "@/events/stream.js";
import type { RuntimeEvent, RuntimeEventType } from "@/types/runtime-event.js";
import type { ProjectFlowToolResult, ToolTrace } from "@/types/tool-result.js";
import { snakifyKeys } from "@/types/wire.js";
import type {
  WireAppendResponse,
  WireEventAppendItem,
  WireProjectFlowToolResult,
} from "@/types/wire.js";

// Pi imports
import {
  runAgentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentTool,
  type AgentToolResult,
  type AgentMessage,
  type AgentLoopConfig,
  type BeforeToolCallContext,
  type AfterToolCallContext,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Model, Api, Provider, AssistantMessage, Message, ToolCall, Usage, TSchema } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

/** A queued steering event from FastAPI. */
export interface PendingSteeringEvent {
  steeringSeq: number;
  steeringType: "constraint" | "correction" | "plan_change" | "clarification_answer" | "approval_response" | "cancel";
  content: string;
  clientMessageId: string;
  metadata?: Record<string, unknown>;
}

export interface RunInput {
  conversationId: string;
  workspaceId: string;
  projectId: string;
  userContent: string;
  workspaceState?: unknown;
  recentMessages?: unknown[];
  pendingProposals?: unknown[];
  skillContext?: SkillContext;
  /** All resolved skill contexts for multi-skill composition. */
  allSkillContexts?: SkillContext[];
  /** Viewer identity for visibility/auth enforcement in tool execution. */
  viewerUserId?: string;
  /** ProjectMemory context built by FastAPI (already visibility-filtered and budget-truncated). */
  memoryContext?: MemoryContext | null;
  /** Draft Outcome Contract from request preparation. */
  outcomeContract?: OutcomeContract;
  /** Queued steering events to consume at the next loop boundary. */
  pendingSteering?: PendingSteeringEvent[];
}

export interface RunCallbacks {
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  onComplete?: (state: AgentRunState) => void;
  onError?: (error: Error, state: AgentRunState) => void;
}

/**
 * Context for resuming an interrupted run from a durable checkpoint.
 * When provided, executeRun restores state from this context instead of
 * creating fresh WorkState/RunPlan/ledger.
 */
export interface ResumeExecutionContext {
  /** Restored WorkState from checkpoint/events */
  workState: import("./work-state.js").WorkState;
  /** Restored RunPlan from events (if any) */
  runPlan?: import("./run-plan.js").RunPlan;
  /** Restored tool ledger from events */
  toolLedger: import("@/tools/tool-executor.js").ToolLedgerEntry[];
  /** Recovery decisions from checkpoint — determines skip/retry/block per tool */
  recoveryDecisions: import("./checkpoint.js").ToolRecoveryDecision[];
  /** Logical call IDs that are already completed — skip these on resume */
  completedLogicalCallIds: Set<string>;
  /** Logical call IDs that are safe to retry with same idempotency key */
  safeToRetryLogicalCallIds: Set<string>;
  /** Durable state version from FastAPI snapshot */
  stateVersion: number;
  /** Last event seq from snapshot */
  lastEventSeq: number;
  /** Latest durable checkpoint version; new checkpoints continue from it. */
  checkpointVersion: number;
}

/**
 * Convert a ProjectFlow ToolRegistry tool to a Pi AgentTool.
 * Uses ToolExecutor for all enforcement (validation, policy, timeout, retry, ledger).
 * Throws on tool execution failure (Pi convention).
 */
function toPiTool(
  toolName: string,
  registry: ToolRegistry,
  executor: ToolExecutor,
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  stream: EventStream,
  budget: BudgetManager,
  traceIncludeSensitiveData: boolean,
  viewerUserId?: string,
  resumeContext?: ResumeExecutionContext,
): AgentTool<any> | null {
  const registered = registry.get(toolName);
  if (!registered) return null;

  const manifest = registered.manifest;

  return {
    name: manifest.name,
    description: manifest.description,
    label: manifest.name,
    parameters: toToolParameters(manifest.inputSchema),
    executionMode: manifest.execution.mode === "parallel" ? "parallel" : "sequential",
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<any>> => {
      const idempotencyKey = `${runState.runId}_${toolCallId}`;
      const context: ToolExecutionContext = {
        runId: runState.runId,
        toolCallId,
        conversationId: runState.conversationId,
        workspaceId: runState.workspaceId,
        projectId: runState.projectId,
        toolName,
        toolVersion: manifest.version,
        manifestVersion: manifest.resume.manifestVersion,
        idempotencyKey,
        viewerUserId,
      };

      try {
        // Defense-in-depth: on resume, check if this exact (tool, manifest, input)
        // operation already completed in the recovered ledger. Different inputs
        // for the same tool remain allowed.
        if (resumeContext) {
          const inputHash = hashValue(params);
          const matchingCompleted = resumeContext.toolLedger.find(
            (e) =>
              e.toolName === toolName &&
              e.manifestVersion === manifest.resume.manifestVersion &&
              e.inputHash === inputHash &&
              e.resultStatus === "success",
          );
          if (matchingCompleted) {
            return {
              content: [{
                type: "text" as const,
                text: `此操作已在先前运行中完成（幂等跳过）。工具: ${toolName}`,
              }],
              details: { _resumed: true, _originalLogicalCallId: matchingCompleted.logicalCallId },
            };
          }
        }

        // Budget check before execution
        const budgetCheck = budget.checkAll();
        if (!budgetCheck.allowed) {
          const observation = budgetCheck.message ?? "运行预算已超限";
          throw new Error(`BUDGET_EXCEEDED: ${observation}`);
        }

        budget.useToolCall();

        // Execute through ToolExecutor (handles validation, policy, timeout, retry, ledger)
        // Each attempt is persisted immediately via onLedgerEntry callback.
        const normalized = await executor.execute(toolName, params, context, manifest, signal);

        // Persist tool result and product events
        const productEvents = buildToolResultProductEvents(
          normalized,
          context,
          runState,
          traceIncludeSensitiveData,
        );

        const appendResponse = await fastapiClient.appendEvents(runState.runId, {
          idempotency_key: idempotencyKey,
          expected_state_version: runState.stateVersion,
          events: productEvents.map(toWireEvent),
          tool_results: [{
            tool_call_id: toolCallId,
            tool_name: toolName,
            tool_version: manifest.version,
            result: toWireToolResult(normalized),
          }],
        });
        assignPersistedEventSeqs(productEvents, appendResponse);
        updateLastEventSeq(runState, appendResponse.state_version, appendResponse.events.map((event) => event.event_seq));
        emitPersistedEvents(stream, productEvents);

        // Update run state
        runState.sideEffects.push({ toolCallId, status: normalized.sideEffectStatus });
        runState.toolResults.push({
          toolCallId,
          toolName,
          sideEffectStatus: normalized.sideEffectStatus,
          observation: normalized.observation,
          ...(normalized.links?.proposalId ? { proposalId: normalized.links.proposalId } : {}),
          ...(normalized.links?.createdIds?.length ? { createdIds: normalized.links.createdIds } : {}),
        });

        if (normalized.status !== "success") {
          const errorText = `工具调用失败: ${normalized.observation}`;
          return {
            content: [{ type: "text" as const, text: errorText }],
            details: { error: normalized.observation },
          };
        }

        // Format result for model consumption
        const MAX_CONTENT_DATA_BYTES = 32_768;
        let textContent = normalized.observation;
        if (normalized.data !== undefined) {
          let dataJson = JSON.stringify(normalized.data, null, 2);
          dataJson = transformForLLM(dataJson);
          if (Buffer.byteLength(dataJson, "utf-8") > MAX_CONTENT_DATA_BYTES) {
            dataJson = dataJson.slice(0, MAX_CONTENT_DATA_BYTES) + "\n...[截断]";
          }
          textContent = `${normalized.observation}\n\n${dataJson}`;
        }
        return {
          content: [{ type: "text" as const, text: textContent }],
          details: normalized.data,
        };
      } catch (err) {
        throw err; // Pi convention: throw on failure
      }
    },
  };
}

/**
 * Map a Pi AgentEvent to a ProjectFlow event, persist it, then emit to stream.
 */
async function handlePiEvent(
  event: AgentEvent,
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  stream: EventStream,
  callbacks: RunCallbacks,
  traceIncludeSensitiveData: boolean,
  memoryMetadata?: Record<string, unknown>,
): Promise<void> {
  applyPiEventToRunState(event, runState);
  const pfEvent = buildRuntimeEventFromPiEvent(
    event as Parameters<typeof buildRuntimeEventFromPiEvent>[0],
    runState,
    {
      orderingHint: runState.lastEventSeq + 1,
      includeSensitiveData: traceIncludeSensitiveData,
      // Persist final memory evidence with the terminal output event, after the
      // output guard has had a chance to record its result.
      payload: (event.type === "agent_start" || event.type === "agent_end") && memoryMetadata
        ? memoryMetadata
        : undefined,
    },
  );
  if (!shouldPersistPiEvent(event as Parameters<typeof shouldPersistPiEvent>[0])) {
    // Token/progress deltas stay live-only. The final model/tool output and the
    // latest state are persisted at their durable boundary, avoiding thousands
    // of redundant event + run.state_changed rows for one response.
    stream.emit(pfEvent.type as StreamEventType, pfEvent);
    callbacks.onEvent?.(pfEvent.type, pfEvent.payload);
    return;
  }
  const appendResponse = await fastapiClient.appendEvents(runState.runId, {
    idempotency_key: `${pfEvent.clientEventId}:append:v1`,
    expected_state_version: runState.stateVersion,
    state_patch: buildStatePatch(runState),
    events: [toWireEvent(pfEvent)],
  });
  assignPersistedEventSeqs([pfEvent], appendResponse);
  updateLastEventSeq(runState, appendResponse.state_version, appendResponse.events.map((item) => item.event_seq));
  stream.emit(pfEvent.type as StreamEventType, pfEvent);
  callbacks.onEvent?.(pfEvent.type, pfEvent.payload);
}

function applyPiEventToRunState(event: AgentEvent, runState: AgentRunState): void {
  switch (event.type) {
    case "agent_start": {
      runState.status = "context_building";
      break;
    }
    case "turn_start": {
      // Guard: don't mutate state if run already reached terminal status
      if (runState.status !== "completed" && runState.status !== "failed" && runState.status !== "cancelled") {
        runState.currentTurn++;
        runState.status = "model_streaming";
        runState.updatedAt = new Date().toISOString();
      }
      break;
    }
    case "message_start":
    case "message_update": {
      if (runState.status !== "completed" && runState.status !== "failed" && runState.status !== "cancelled") {
        runState.status = "model_streaming";
        runState.updatedAt = new Date().toISOString();
      }
      break;
    }
    case "message_end": {
      if (runState.status !== "completed" && runState.status !== "failed" && runState.status !== "cancelled") {
        runState.status = "model_streaming";
        runState.updatedAt = new Date().toISOString();
      }
      break;
    }
    case "tool_execution_start": {
      if (runState.status !== "completed" && runState.status !== "failed" && runState.status !== "cancelled") {
        runState.status = "tool_preparing";
        runState.currentStep++;
        runState.pendingToolCall = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolVersion: 1,
          idempotencyKey: `${runState.runId}_${event.toolCallId}`,
        };
      }
      break;
    }
    case "tool_execution_update": {
      if (runState.status !== "completed" && runState.status !== "failed" && runState.status !== "cancelled") {
        runState.status = "tool_running";
        runState.updatedAt = new Date().toISOString();
      }
      break;
    }
    case "tool_execution_end": {
      if (runState.status !== "completed" && runState.status !== "failed" && runState.status !== "cancelled") {
        runState.status = "persisting_tool_result";
        runState.pendingToolCall = undefined;
        runState.updatedAt = new Date().toISOString();
      }
      break;
    }
    case "turn_end": {
      if (runState.status !== "completed" && runState.status !== "failed" && runState.status !== "cancelled") {
        runState.status = "model_streaming";
        runState.updatedAt = new Date().toISOString();
      }
      break;
    }
    case "agent_end": {
      // DEFERRED: Do NOT set terminal status here.
      // Capture the stop reason and final content; the post-loop verifier
      // will determine the actual terminal status.
      const lastMsg = event.messages?.[event.messages.length - 1] as Record<string, unknown> | undefined;
      const stopReason = (lastMsg?.stopReason as string) ?? "unknown";
      const modelError = !!(event as any).error || !!(event as any).isError || stopReason === "error";
      const modelAborted = stopReason === "aborted";

      // Extract final content from the last assistant message
      let finalContent = "";
      const msgContent = lastMsg?.content;
      if (msgContent && Array.isArray(msgContent)) {
        const textParts: string[] = [];
        for (const part of msgContent) {
          if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            if (p.type === "text" && typeof p.text === "string") {
              textParts.push(p.text);
            }
          }
        }
        finalContent = textParts.join("");
      }

      runState.pendingTerminal = {
        stopReason,
        finalContent,
        modelError,
        modelAborted,
      };

      // Set non-terminal status — terminal status determined after verifier
      runState.status = "persisting_tool_result";
      runState.updatedAt = new Date().toISOString();
      break;
    }
  }
}

/**
 * Merge multiple skill contexts for composition.
 * Combines bodies and allowed tools (union), with primary skill's metadata.
 */
function mergeSkillContexts(contexts: SkillContext[]): SkillContext {
  if (contexts.length === 0) throw new Error("Cannot merge empty skill contexts");
  if (contexts.length === 1) return contexts[0]!;

  const primary = contexts[0]!;
  const allTools = [...new Set(contexts.flatMap((c) => c.allowedTools))];
  const combinedBody = contexts
    .map((c) => `### ${c.name}\n${c.body}`)
    .join("\n\n---\n\n");

  return {
    name: primary.name,
    description: `组合技能: ${contexts.map((c) => c.name).join(" + ")}`,
    body: combinedBody,
    allowedTools: allTools,
  };
}

/**
 * Execute a complete agent run using Pi's runAgentLoop.
 */
export async function executeRun(
  runState: AgentRunState,
  input: RunInput,
  toolRegistry: ToolRegistry,
  modelRouter: ModelRouter,
  fastapiClient: FastapiClient,
  stream: EventStream,
  options: {
    traceIncludeSensitiveData?: boolean;
    signal?: AbortSignal;
    debugPayloadStore?: DebugPayloadStore;
    model?: Model<Api>;
    streamFn?: StreamFn;
    /** Resume context — when provided, restores state from checkpoint instead of creating fresh. */
    resumeContext?: ResumeExecutionContext;
  } = {},
  callbacks: RunCallbacks = {},
): Promise<AgentRunState> {
  const budget = new BudgetManager({
    maxSteps: runState.budgetLimits.maxSteps,
    maxToolCalls: runState.budgetLimits.maxToolCalls,
    timeoutMs: runState.budgetLimits.timeoutMs,
    maxOutputTokens: 4096,
    maxToolResultBytes: 32768,
  });

  const traceIncludeSensitiveData = options.traceIncludeSensitiveData ?? false;
  const debugPayloadStore = options.debugPayloadStore ?? getDebugPayloadStore();

  // Checkpoint counter for versioned snapshots
  let checkpointVersion = options.resumeContext?.checkpointVersion ?? 0;

  try {
    // Step 1: Context building
    runState.status = "context_building";
    runState.updatedAt = new Date().toISOString();
    callbacks.onEvent?.("state.changed", { run_id: runState.runId, status: runState.status });

    // Restore or create WorkState (cognitive work state, separate from transport state)
    // On resume: use rehydrated state from checkpoint/events
    // On fresh run: create initial state
    let workState = options.resumeContext?.workState ?? createInitialWorkState();
    let runPlan: RunPlan | undefined = options.resumeContext?.runPlan;
    let verifierReport: VerifierReport | undefined;

    // Restore durable version counters from resume context
    if (options.resumeContext) {
      runState.stateVersion = options.resumeContext.stateVersion;
      runState.lastEventSeq = options.resumeContext.lastEventSeq;
    }

    // ── Steering consumption helper ─────────────────────────────────
    // Consumes pending steering events at loop boundaries.
    const consumeSteering = async (
      steeringEvents: PendingSteeringEvent[],
    ): Promise<{ shouldAbort: boolean }> => {
      for (const event of steeringEvents) {
        if (event.steeringType === "cancel") {
          return { shouldAbort: true };
        }

        // Persist steering consumed event — failure is NOT swallowed because
        // undurable consumption would allow duplicate processing on resume.
        await persistControlPlaneEvent(
          "steering.consumed",
          runState,
          fastapiClient,
          stream,
          {
            steering_seq: event.steeringSeq,
            steering_type: event.steeringType,
            content: event.content.slice(0, 500), // bounded
          },
          traceIncludeSensitiveData,
        );

        // Handle clarification answers
        if (event.steeringType === "clarification_answer" && workState.status === "awaiting_user") {
          try {
            workState = transitionWorkState(workState, "understanding", workState.version, "收到用户回答");
          } catch {
            // Already transitioned — ok
          }
        }
        if (event.steeringType === "approval_response" && workState.status === "awaiting_approval") {
          const approved = event.metadata?.approved === true || event.content === "approved";
          if (!approved) return { shouldAbort: true };
          workState = transitionWorkState(workState, "planning", workState.version, "用户已批准工具执行");
          await persistControlPlaneEvent(
            "work_state.changed",
            runState,
            fastapiClient,
            stream,
            { status: workState.status, version: workState.version, reason: workState.reason },
            traceIncludeSensitiveData,
          );
        }
      }
      return { shouldAbort: false };
    };

    // Answer mode: no skill → no tools exposed, model answers directly.
    // Action mode: skill active → only skill's allowed tools exposed.
    const isAnswerMode = !input.skillContext;

    // Resolve model config early to get context budget.
    const earlyResolveResult = modelRouter.resolveWithMeta(
      `${runState.model.provider}:${runState.model.name}`,
    );
    // Explicit invalid model selection must fail, not silently fall back
    if (earlyResolveResult.resolutionFailed) {
      throw new Error(earlyResolveResult.fallbackReason ?? `模型 "${runState.model.provider}:${runState.model.name}" 无效或不存在`);
    }
    if (earlyResolveResult.fallbackReason) {
      console.warn(`[agent-bridge] 模型回退: ${earlyResolveResult.fallbackReason}`);
    }
    const earlyModelConfig = earlyResolveResult.entry;
    const contextBudget = earlyModelConfig?.capabilities?.contextTokens ?? DEFAULT_CONTEXT_TOKENS;

    // Merge multi-skill contexts if composition is active.
    // allSkillContexts[0] is the primary; additional entries are secondary.
    const allContexts = input.allSkillContexts ?? (input.skillContext ? [input.skillContext] : []);
    const mergedSkillContext = allContexts.length > 1
      ? mergeSkillContexts(allContexts)
      : input.skillContext;

    const contextInput: ContextBuildInput = {
      userContent: input.userContent,
      workspaceState: input.workspaceState,
      recentMessages: input.recentMessages,
      pendingProposals: input.pendingProposals,
      toolManifests: isAnswerMode ? [] : toolRegistry.getManifests(),
      skillContext: mergedSkillContext,
      currentTime: new Date().toISOString(),
      memoryContext: input.memoryContext,
      isAnswerMode,
      promptKernelVersion: PROMPT_KERNEL_VERSION,
      maxContextTokens: contextBudget,
    };
    const builtContext = buildContext(contextInput);
    const kernelHash = hashPromptKernel();

    // R2: Build run evidence metadata for the agent.started event.
    // Includes memory, outcome contract, and prompt kernel version.
    const memoryMetadata: Record<string, unknown> = input.memoryContext
      ? {
          _memory: {
            used: !!input.memoryContext.text,
            backend: input.memoryContext.memoryBackend,
            used_memory_ids: input.memoryContext.usedMemoryIds,
            used_memory_types: input.memoryContext.usedMemoryTypes ?? [],
            retrieval_count: input.memoryContext.retrievalCount,
            injected_count: input.memoryContext.injectedCount,
            latency_ms: input.memoryContext.latencyMs,
          },
        }
      : {
          _memory: {
            used: false,
            backend: "none",
            used_memory_ids: [],
            retrieval_count: 0,
            injected_count: 0,
            latency_ms: 0,
          },
        };

    // Add outcome contract metadata (subset — full contract is in-memory only).
    // Records classification and policy fields; normalizedGoal/constraints/
    // successCriteria/requiredEvidence are NOT persisted to avoid bloating events.
    if (input.outcomeContract) {
      memoryMetadata._outcome_contract = {
        request_type: input.outcomeContract.requestType,
        effect_ceiling: input.outcomeContract.effectCeiling,
        completion_mode: input.outcomeContract.completionMode,
        verification_level: input.outcomeContract.verificationLevel,
        clarification_policy: input.outcomeContract.clarificationPolicy,
      };
    }
    memoryMetadata._prompt_kernel = {
      version: PROMPT_KERNEL_VERSION,
      hash: kernelHash,
    };

    // Record compaction metadata if context was budget-aware
    if (builtContext.compaction) {
      memoryMetadata._context_compaction = {
        compacted: builtContext.compaction.compacted,
        total_tokens_before: builtContext.compaction.totalTokensBefore,
        total_tokens_after: builtContext.compaction.totalTokensAfter,
        dropped_count: builtContext.compaction.droppedBlocks.length,
        retained_count: builtContext.compaction.retainedBlocks.length,
        pinned_preserved: builtContext.compaction.pinnedPreserved,
        // Block type summary (no sensitive content)
        dropped_types: [...new Set(builtContext.compaction.droppedBlocks.map((b) => b.source))],
        retained_types: [...new Set(builtContext.compaction.retainedBlocks.map((b) => b.source))],
      };
    }

    // Store full memory text in debug payload (only accessible with sensitive data enabled)
    if (input.memoryContext?.text) {
      debugPayloadStore.store(
        { runId: runState.runId, toolName: "_memory" },
        { input: { memory_text_length: input.memoryContext.text.length }, output: traceIncludeSensitiveData ? { memory_text: input.memoryContext.text } : { memory_text: "[redacted]" } },
      );
    }

    // Step 2: Build Pi tools from registry
    // Use merged skill context for tool filtering (supports multi-skill composition)
    // On resume: do NOT filter by tool name — a run may legitimately call the same
    // tool multiple times with different inputs. Instead, ToolExecutor dedupes by
    // (tool name, manifest version, input hash) for defense in depth.
    let exposedManifests = isAnswerMode
      ? []
      : filterModelCallableManifests(toolRegistry.getManifests(), mergedSkillContext);

    // On resume: reconcile recovered ledger into RunPlan steps.
    // If every required step is already complete, skip the model loop entirely
    // and jump to verifier/terminalization from recovered evidence.
    let allPlanStepsComplete = false;
    if (options.resumeContext && runPlan) {
      const { toolLedger } = options.resumeContext;
      for (const step of runPlan.steps) {
        if (step.status === "completed") continue;
        const stepTools = new Set(step.allowedTools);
        const hasMatchingSuccess = toolLedger.some(
          (e) => stepTools.has(e.toolName) && e.resultStatus === "success",
        );
        if (hasMatchingSuccess) {
          step.status = "completed";
          step.progressMessage = "从恢复证据中标记完成";
        }
      }
      allPlanStepsComplete = runPlan.steps.every(
        (s) => s.status === "completed" || s.status === "skipped",
      );
    }

    const toolNames = exposedManifests.map((m) => m.name);

    // Create ToolExecutor — all tool execution goes through this.
    // onLedgerEntry callback persists each attempt immediately via FastAPI.
    const recoveredLedger = options.resumeContext?.toolLedger ?? [];
    const toolExecutor = new ToolExecutor(toolRegistry, {
      maxResultBytes: 32768,
      traceIncludeSensitiveData,
      debugPayloadStore,
      onLedgerEntry: async (entry) => {
        await persistLedgerEntry(entry, runState, fastapiClient, stream, traceIncludeSensitiveData);
      },
      onLargeResult: async (ref, content, context) => {
        await fastapiClient.storeToolResource(runState.runId, {
          resource_id: ref.resourceId,
          tool_call_id: context.toolCallId,
          tool_name: context.toolName,
          content,
          content_type: "application/json",
        });
      },
    });
    const getCombinedLedger = (): ToolLedgerEntry[] => [
      ...recoveredLedger,
      ...toolExecutor.getRunLedger(runState.runId),
    ];

    // Create RunPlan if this is a non-trivial request
    // Skip if resuming with an existing plan from checkpoint
    if (!runPlan && input.outcomeContract && shouldCreatePlan(input.outcomeContract, input.userContent)) {
      workState = transitionWorkState(workState, "planning", workState.version, "creating plan");
      const planId = `plan_${runState.runId}_${Date.now()}`;
      runPlan = createSimplePlan(planId, input.outcomeContract, toolNames);
      // Emit plan created event
      callbacks.onEvent?.("workstate.plan_created", {
        run_id: runState.runId,
        plan_id: runPlan.id,
        step_count: runPlan.steps.length,
        rationale: runPlan.rationale,
      });
    }
    const piTools: AgentTool<any>[] = [];
    for (const name of toolNames) {
      const piTool = toPiTool(
        name, toolRegistry, toolExecutor, runState, fastapiClient, stream, budget, traceIncludeSensitiveData, input.viewerUserId, options.resumeContext,
      );
      if (piTool) piTools.push(piTool);
    }

    // On resume with all plan steps complete: skip the model loop entirely
    // and jump to post-loop verifier/terminalization from recovered evidence.
    if (allPlanStepsComplete && options.resumeContext) {
      // Transition WorkState to verifying
      try {
        workState = transitionWorkState(workState, "verifying", workState.version, "all plan steps completed from recovery evidence");
        await persistControlPlaneEvent(
          "work_state.changed",
          runState,
          fastapiClient,
          stream,
          { status: workState.status, version: workState.version, reason: workState.reason },
          traceIncludeSensitiveData,
        );
      } catch (err) {
        console.warn(`[agent-bridge] WorkState transition to verifying failed: ${err}`);
      }

      // Run verifier from recovered evidence
      if (input.outcomeContract) {
        const finalContent = "已根据持久化工具证据恢复运行，既定计划步骤均已完成。";
        verifierReport = verify({
          runId: runState.runId,
          outcomeContract: input.outcomeContract,
          runPlan,
          toolResults: runState.toolResults,
          ledgerEntries: getCombinedLedger(),
          finalContent,
          hasTools: !isAnswerMode,
        });

        await persistControlPlaneEvent(
          "verifier.completed",
          runState,
          fastapiClient,
          stream,
          {
            report_id: verifierReport.id,
            passed: verifierReport.passed,
            completion: verifierReport.completion,
            has_fixable_failures: verifierReport.hasFixableFailures,
            summary: verifierReport.summary,
            dimensions: verifierReport.dimensions.map((d) => ({
              name: d.name, passed: d.passed, description: d.description,
              evidence: d.evidence.slice(0, 200), fixable: d.fixable,
            })),
          },
          traceIncludeSensitiveData,
        );
      }

      // Determine terminal status
      const terminalStatus: RunStatus = verifierReport?.passed ? "completed" : "failed";
      const terminalType = terminalStatus === "completed" ? "agent.completed" : "agent.failed";

      try {
        workState = transitionWorkState(
          workState,
          terminalStatus === "completed" ? "completed" : "failed",
          workState.version,
          `resume terminal: ${terminalType}`,
        );
      } catch {
        // A durable terminal WorkState is preferable, but an already-terminal
        // compatible state does not need another transition.
      }

      checkpointVersion++;
      const resumeTerminalCheckpoint = createCheckpoint(
        runState,
        workState,
        runPlan,
        input.outcomeContract,
        getCombinedLedger(),
        "pre_terminal",
        checkpointVersion,
        undefined,
        input.userContent,
      );
      await persistCheckpoint(
        resumeTerminalCheckpoint,
        runState,
        fastapiClient,
        traceIncludeSensitiveData,
      );

      runState.status = terminalStatus;
      runState.completedAt = new Date().toISOString();
      runState.updatedAt = new Date().toISOString();

      await persistAndEmitMappedEvent(
        {
          type: terminalType,
          payload: {
            reason: "all_plan_steps_completed_from_recovery",
            _work_state: { status: workState.status, version: workState.version },
            ...(verifierReport ? {
              _verifier: {
                passed: verifierReport.passed,
                completion: verifierReport.completion,
                summary: verifierReport.summary,
              },
            } : {}),
          },
          newStatus: terminalStatus,
        },
        runState,
        fastapiClient,
        stream,
        traceIncludeSensitiveData,
      );

      callbacks.onComplete?.(runState);
      return runState;
    }

    // Step 3: Build Pi AgentContext
    // The current user message is passed as the prompt argument to runAgentLoop
    // (step 7 below), so agentContext.messages must be empty to avoid duplicating
    // the same full user payload in the model request.
    const agentContext: AgentContext = {
      systemPrompt: builtContext.systemPrompt,
      messages: [],
      tools: piTools,
    };

    // Step 4: Resolve model from registry
    // The runState.model.provider/name come from the frontend's model selection.
    // We look up the corresponding ModelConfigEntryRuntime to get the full config
    // (including apiKeyEnvVar, baseUrl, capabilities, etc.).
    const modelResolveResult = modelRouter.resolveWithMeta(
      // Use provider:name as a composite id lookup, or fall back to default
      `${runState.model.provider}:${runState.model.name}`,
    );
    // Explicit invalid model selection must fail, not silently fall back
    if (modelResolveResult.resolutionFailed) {
      throw new Error(modelResolveResult.fallbackReason ?? `模型 "${runState.model.provider}:${runState.model.name}" 无效或不存在`);
    }
    const modelConfigEntry = modelResolveResult.entry;

    // Record fallback reason from config resolution
    if (modelResolveResult.fallbackReason) {
      runState.modelFallbackReason = modelResolveResult.fallbackReason;
      console.warn(`[agent-bridge] 模型回退: ${modelResolveResult.fallbackReason}`);
    }

    // Step 5: Create model instance — real provider when configured, mock fallback
    const resolved = await resolveRealModel(
      modelConfigEntry
        ? { provider: modelConfigEntry.provider, name: modelConfigEntry.name, baseUrl: modelConfigEntry.resolvedBaseUrl }
        : { provider: runState.model.provider, name: runState.model.name },
    );
    const model = options.model ?? resolved.model;

    // Record actual resolved model from the real Pi Model object (not config entry)
    // This captures the true provider:name after catalog lookup or custom construction
    runState.resolvedModel = { provider: String(resolved.model.provider), name: resolved.model.name };
    const configuredStreamFn = options.streamFn ?? ((modelConfigEntry?.provider ?? runState.model.provider) === "mock" ? createMockStreamFn() : undefined);
    const streamFn = shouldGuardMemoryOutput(input.memoryContext, input.userContent)
      ? createMemoryGuardedStreamFn(configuredStreamFn ?? (streamSimple as StreamFn), {
          userContent: input.userContent,
          workspaceState: input.workspaceState,
          memoryContext: input.memoryContext!,
          onResult: (result) => {
            input.memoryContext!.outputGuardStatus = result.status;
            input.memoryContext!.outputGuardModelCalls = result.modelCalls;
            const evidence = memoryMetadata._memory as Record<string, unknown>;
            evidence.output_guard_status = result.status;
            evidence.output_guard_model_calls = result.modelCalls;
          },
        })
      : configuredStreamFn;

    // Step 6: Build AgentLoopConfig with hooks
    // Map our ThinkingLevel to Pi SDK's ThinkingLevel.
    // Pi SDK has: minimal | low | medium | high | xhigh (no "max").
    // Our "max" maps to Pi SDK "xhigh" (DeepSeek thinkingLevelMap: xhigh → "max" budget).
    const reasoningLevel = runState.thinkingLevel === "max" ? "xhigh" as const : runState.thinkingLevel;
    const config: AgentLoopConfig = {
      model,
      reasoning: reasoningLevel,
      convertToLlm: (messages: AgentMessage[]): Message[] => messages as Message[],
      toolExecution: canExecuteInParallel(exposedManifests) ? "parallel" : "sequential",
      beforeToolCall: async (_ctx: BeforeToolCallContext) => {
        if (options.signal?.aborted) {
          return { block: true, reason: "运行已取消" };
        }
        // Policy gate — check if tool is allowed
        const toolName = _ctx.toolCall.name;
        const tool = toolRegistry.get(toolName);
        if (tool) {
          const policy = evaluatePolicy(tool.manifest);
          if (policy.decision === "block" || policy.decision === "deny") {
            return { block: true, reason: policy.reason };
          }
        }
        return undefined;
      },
      afterToolCall: async (_ctx: AfterToolCallContext) => {
        // Result normalization is handled in the tool's execute function
        return undefined;
      },
    };

    // Step 7: Run the agent loop
    runState.status = "model_streaming";
    runState.updatedAt = new Date().toISOString();

    // Transition WorkState to executing
    if (workState.status === "planning" || workState.status === "understanding") {
      workState = transitionWorkState(workState, "executing", workState.version, "starting agent loop");
    }

    const piEventSink = async (event: AgentEvent) => {
      await handlePiEvent(event, runState, fastapiClient, stream, callbacks, traceIncludeSensitiveData, memoryMetadata);
    };

    const promptMessage = {
      role: "user" as const,
      content: builtContext.userMessage,
      timestamp: Date.now(),
    } as AgentMessage;

    await runAgentLoop(
      [promptMessage],
      agentContext,
      config,
      piEventSink,
      options.signal,
      streamFn,
    );

    // Post-loop checkpoint: snapshot state after all tool observations collected.
    // This is a correctness boundary — failure must propagate, not be swallowed.
    checkpointVersion++;
    const postLoopCheckpoint = createCheckpoint(
      runState, workState, runPlan, input.outcomeContract,
      getCombinedLedger(), "tool_result", checkpointVersion,
      undefined, input.userContent,
    );
    await persistCheckpoint(postLoopCheckpoint, runState, fastapiClient, traceIncludeSensitiveData);

    // ── Consume pending steering at loop boundary ─────────────────────
    if (input.pendingSteering && input.pendingSteering.length > 0) {
      const steeringResult = await consumeSteering(input.pendingSteering);
      if (steeringResult.shouldAbort) {
        runState.status = "cancelled";
        runState.completedAt = new Date().toISOString();
        runState.updatedAt = new Date().toISOString();
        await persistAndEmitMappedEvent(
          { type: "run.cancelled", payload: { reason: "用户取消" }, newStatus: "cancelled" },
          runState, fastapiClient, stream, traceIncludeSensitiveData,
        );
        callbacks.onComplete?.(runState);
        return runState;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Step 8: Post-loop control plane — verifier, plan reconciliation,
    //         WorkState transitions, and SINGLE terminal event.
    //
    // IMPORTANT: agent_end from Pi did NOT set terminal status.
    // runState.pendingTerminal captures the model's stop reason.
    // We now determine the REAL terminal status here.
    // ═══════════════════════════════════════════════════════════════════

    // 8a. Reconcile RunPlan steps based on tool results
    if (runPlan) {
      for (const step of runPlan.steps) {
        if (step.status === "pending" || step.status === "in_progress") {
          // Check if any tool result matches this step's allowed tools
          const stepTools = new Set(step.allowedTools);
          const matchingResults = runState.toolResults.filter(
            (tr) => stepTools.has(tr.toolName),
          );
          if (matchingResults.length > 0) {
            step.status = "completed";
            step.progressMessage = `工具执行完成: ${matchingResults.map((t) => t.toolName).join(", ")}`;
          }
        }
      }
      // Persist run_plan.created event
      await persistControlPlaneEvent(
        "run_plan.created",
        runState,
        fastapiClient,
        stream,
        {
          plan_id: runPlan.id,
          rationale: runPlan.rationale,
          steps: runPlan.steps.map((s) => ({
            id: s.id, goal: s.goal, status: s.status,
            dependencies: s.dependencies, allowed_tools: s.allowedTools,
          })),
        },
        traceIncludeSensitiveData,
      );
    }

    // 8b. Transition WorkState to verifying and persist event
    try {
      workState = transitionWorkState(workState, "verifying", workState.version, "running verifier");
      await persistControlPlaneEvent(
        "work_state.changed",
        runState,
        fastapiClient,
        stream,
        { status: workState.status, version: workState.version, reason: workState.reason },
        traceIncludeSensitiveData,
      );
    } catch (err) {
      // If transition fails, log but continue — verifier still runs
      console.warn(`[agent-bridge] WorkState transition to verifying failed: ${err}`);
    }

    // 8c. Run deterministic verifier
    if (input.outcomeContract) {
      const finalContent = runState.pendingTerminal?.finalContent
        ?? runState.toolResults[runState.toolResults.length - 1]?.observation
        ?? "";

      verifierReport = verify({
        runId: runState.runId,
        outcomeContract: input.outcomeContract,
        runPlan,
        toolResults: runState.toolResults,
        ledgerEntries: getCombinedLedger(),
        finalContent,
        hasTools: !isAnswerMode,
      });

      // Persist verifier.completed event
      await persistControlPlaneEvent(
        "verifier.completed",
        runState,
        fastapiClient,
        stream,
        {
          report_id: verifierReport.id,
          passed: verifierReport.passed,
          completion: verifierReport.completion,
          has_fixable_failures: verifierReport.hasFixableFailures,
          summary: verifierReport.summary,
          dimensions: verifierReport.dimensions.map((d) => ({
            name: d.name, passed: d.passed, description: d.description,
            evidence: d.evidence.slice(0, 200), fixable: d.fixable,
          })),
        },
        traceIncludeSensitiveData,
      );
    }

    // 8d. Determine SINGLE terminal status from:
    //     - cancellation signal
    //     - model error/abort from pendingTerminal
    //     - verifier completion classification
    const pending = runState.pendingTerminal;
    let terminalType: "agent.completed" | "agent.failed" | "run.cancelled";
    let terminalStatus: RunStatus;

    if (options.signal?.aborted) {
      // Explicit cancellation
      terminalType = "run.cancelled";
      terminalStatus = "cancelled";
    } else if (pending?.modelAborted) {
      terminalType = "run.cancelled";
      terminalStatus = "cancelled";
    } else if (pending?.modelError) {
      // Model reported error — check if side effects exist
      const hasSideEffects = runState.toolResults.some(
        (tr) => tr.sideEffectStatus !== "no_side_effect" && tr.sideEffectStatus !== "unknown",
      );
      if (hasSideEffects) {
        // Side effects exist — verifier decides completion
        if (verifierReport) {
          terminalType = verifierReport.passed ? "agent.completed" : "agent.failed";
          terminalStatus = verifierReport.passed ? "completed" : "failed";
        } else {
          terminalType = "agent.completed";
          terminalStatus = "completed";
        }
      } else {
        terminalType = "agent.failed";
        terminalStatus = "failed";
      }
    } else if (verifierReport) {
      // Verifier determines completion
      switch (verifierReport.completion) {
        case "complete":
        case "answer_only":
          terminalType = "agent.completed";
          terminalStatus = "completed";
          break;
        case "partial":
          terminalType = "agent.completed";
          terminalStatus = "completed"; // partial is still a successful completion
          break;
        case "blocked":
          terminalType = "agent.failed";
          terminalStatus = "failed";
          break;
        case "failed":
          terminalType = "agent.failed";
          terminalStatus = "failed";
          break;
        default:
          terminalType = "agent.completed";
          terminalStatus = "completed";
      }
    } else {
      // No verifier (answer mode without contract) — default to completed
      terminalType = "agent.completed";
      terminalStatus = "completed";
    }

    // 8e. Transition WorkState to terminal
    const workStateMap: Record<string, WorkStateStatus> = {
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
    };
    try {
      workState = transitionWorkState(
        workState,
        workStateMap[terminalStatus] ?? "completed",
        workState.version,
        `terminal: ${terminalType}`,
      );
    } catch {
      // Already terminal — ok
    }

    // 8f. Persist pre-terminal checkpoint (safe snapshot before terminal event).
    // This is a correctness boundary — failure must not be swallowed.
    // If the checkpoint fails, persist a failure terminal instead of a misleading success.
    checkpointVersion++;
    const preTerminalCheckpoint = createCheckpoint(
      runState, workState, runPlan, input.outcomeContract,
      getCombinedLedger(), "pre_terminal", checkpointVersion,
      undefined, input.userContent,
    );
    try {
      await persistCheckpoint(preTerminalCheckpoint, runState, fastapiClient, traceIncludeSensitiveData);
    } catch (ckptErr) {
      // Checkpoint persistence failed — emit a failure terminal instead of misleading success
      const ckptErrorMessage = ckptErr instanceof Error ? ckptErr.message : String(ckptErr);
      console.error(`[agent-bridge] pre-terminal checkpoint persist failed: ${ckptErrorMessage}`);
      runState.status = "failed";
      runState.completedAt = new Date().toISOString();
      runState.updatedAt = new Date().toISOString();
      await persistAndEmitMappedEvent(
        {
          type: "run.failed",
          payload: {
            error: `检查点持久化失败: ${ckptErrorMessage}`,
            _checkpoint_failed: true,
          },
          newStatus: "failed",
        },
        runState, fastapiClient, stream, traceIncludeSensitiveData,
      );
      callbacks.onError?.(new Error(`Checkpoint failed: ${ckptErrorMessage}`), runState);
      return runState;
    }

    // 8g. Persist the SINGLE terminal event with WorkState/RunPlan/VerifierReport
    runState.status = terminalStatus;
    runState.completedAt = new Date().toISOString();
    runState.updatedAt = new Date().toISOString();

    const terminalPayload: Record<string, unknown> = {
      reason: pending?.stopReason ?? "completed",
      ...(pending?.finalContent ? { final_content: pending.finalContent } : {}),
      _work_state: { status: workState.status, version: workState.version },
      ...(runPlan ? {
        _run_plan: {
          plan_id: runPlan.id,
          steps_completed: runPlan.steps.filter((s) => s.status === "completed").length,
          steps_total: runPlan.steps.length,
        },
      } : {}),
      ...(verifierReport ? {
        _verifier: {
          passed: verifierReport.passed,
          completion: verifierReport.completion,
          summary: verifierReport.summary,
        },
      } : {}),
    };

    await persistAndEmitMappedEvent(
      {
        type: terminalType,
        payload: terminalPayload,
        newStatus: terminalStatus,
      },
      runState,
      fastapiClient,
      stream,
      traceIncludeSensitiveData,
    );

    callbacks.onComplete?.(runState);

    return runState;
  } catch (err) {
    const wasCancelled = options.signal?.aborted || runState.status === "cancelling" || runState.status === "cancelled";
    runState.status = wasCancelled ? "cancelled" : "failed";
    runState.completedAt = new Date().toISOString();
    runState.updatedAt = new Date().toISOString();
    const error = err instanceof Error ? err : new Error(String(err));

    if (wasCancelled) {
      await persistAndEmitMappedEvent(
        {
          type: "run.cancelled",
          payload: { reason: "运行已取消" },
          newStatus: runState.status,
        },
        runState,
        fastapiClient,
        stream,
        traceIncludeSensitiveData,
      );
      callbacks.onComplete?.(runState);
    } else {
      await persistAndEmitMappedEvent(
        {
          type: "run.failed",
          payload: {
            error: error.message,
            ...(error.message.startsWith("BUDGET_EXCEEDED") ? { code: "BUDGET_EXCEEDED" } : {}),
          },
          newStatus: runState.status,
        },
        runState,
        fastapiClient,
        stream,
        traceIncludeSensitiveData,
      );
      callbacks.onError?.(error, runState);
    }

    return runState;
  }
}

async function persistAndEmitMappedEvent(
  mapped: Parameters<typeof buildRuntimeEvent>[0],
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  stream: EventStream,
  traceIncludeSensitiveData: boolean,
): Promise<RuntimeEvent> {
  const event = buildRuntimeEvent(mapped, runState, {
    orderingHint: runState.lastEventSeq + 1,
    includeSensitiveData: traceIncludeSensitiveData,
  });
  const appendResponse = await fastapiClient.appendEvents(runState.runId, {
    idempotency_key: `${event.clientEventId}:append:v1`,
    expected_state_version: runState.stateVersion,
    state_patch: buildStatePatch(runState),
    events: [toWireEvent(event)],
  });
  assignPersistedEventSeqs([event], appendResponse);
  updateLastEventSeq(runState, appendResponse.state_version, appendResponse.events.map((item) => item.event_seq));
  stream.emit(event.type as StreamEventType, event);
  return event;
}

/**
 * Persist a control-plane event (work_state.changed, run_plan.created, etc.)
 * through the FastAPI append API. These events are durable and replayable.
 */
async function persistControlPlaneEvent(
  type: RuntimeEventType,
  runState: AgentRunState,
  fastapiClient: FastapiClient,
  stream: EventStream,
  payload: Record<string, unknown>,
  traceIncludeSensitiveData: boolean,
): Promise<void> {
  const event = buildRuntimeEvent(
    {
      type,
      payload: { run_id: runState.runId, ...payload },
    },
    runState,
    {
      orderingHint: runState.lastEventSeq + 1,
      includeSensitiveData: traceIncludeSensitiveData,
    },
  );
  const appendResponse = await fastapiClient.appendEvents(runState.runId, {
    idempotency_key: `${event.clientEventId}:append:v1`,
    expected_state_version: runState.stateVersion,
    events: [toWireEvent(event)],
  });
  assignPersistedEventSeqs([event], appendResponse);
  updateLastEventSeq(runState, appendResponse.state_version, appendResponse.events.map((item) => item.event_seq));
  stream.emit(event.type as StreamEventType, event);
}

function buildStatePatch(runState: AgentRunState): Record<string, unknown> {
  return {
    schema_version: 1,
    status: runState.status,
    current_turn: runState.currentTurn,
    current_step: runState.currentStep,
    model_provider: runState.model.provider,
    model_name: runState.model.name,
    resolved_model_provider: runState.resolvedModel?.provider ?? runState.model.provider,
    resolved_model_name: runState.resolvedModel?.name ?? runState.model.name,
    ...(runState.modelFallbackReason ? { model_fallback_reason: runState.modelFallbackReason } : {}),
    pending_tool_call_id: runState.pendingToolCall?.toolCallId ?? null,
    pending_tool_name: runState.pendingToolCall?.toolName ?? null,
    pending_tool_version: runState.pendingToolCall?.toolVersion ?? null,
    pending_idempotency_key: runState.pendingToolCall?.idempotencyKey ?? null,
  };
}

function buildToolResultProductEvents(
  result: ProjectFlowToolResult,
  context: ToolExecutionContext,
  runState: AgentRunState,
  traceIncludeSensitiveData: boolean,
): RuntimeEvent[] {
  const commonPayload = {
    tool_call_id: context.toolCallId,
    tool_name: context.toolName,
    tool_version: context.toolVersion,
    side_effect_status: result.sideEffectStatus,
    ...(result.links?.agentEventId ? { agent_event_id: result.links.agentEventId } : {}),
    ...(result.links?.createdIds ? { created_ids: result.links.createdIds } : {}),
  };
  const orderingHint = runState.lastEventSeq + 1;

  if (result.sideEffectStatus === "proposal_persisted" && result.links?.proposalId) {
    return [
      buildRuntimeProductEvent(
        "proposal.created",
        runState,
        {
          ...commonPayload,
          proposal_id: result.links.proposalId,
        },
        {
          orderingHint,
          includeSensitiveData: traceIncludeSensitiveData,
          proposalId: result.links.proposalId,
        },
      ),
    ];
  }

  if (result.sideEffectStatus === "advisory_record_persisted" && result.links?.createdIds?.length) {
    return [
      buildRuntimeProductEvent(
        "advisory_record.created",
        runState,
        commonPayload,
        {
          orderingHint,
          includeSensitiveData: traceIncludeSensitiveData,
        },
      ),
    ];
  }

  return [];
}

function toWireEvent(event: RuntimeEvent): WireEventAppendItem {
  return {
    client_event_id: event.clientEventId ?? `${event.runId}:${event.type}:${event.orderingHint ?? 0}`,
    type: event.type,
    ordering_hint: event.orderingHint,
    payload: event.payload,
    ...(event.trace ? { trace: snakifyKeys(event.trace) as Record<string, unknown> } : {}),
  };
}

function assignPersistedEventSeqs(events: RuntimeEvent[], response: WireAppendResponse): void {
  const byClientId = new Map(response.events.map((event) => [event.client_event_id, event.event_seq]));
  for (const event of events) {
    const eventSeq = event.clientEventId ? byClientId.get(event.clientEventId) : undefined;
    if (eventSeq !== undefined) {
      event.eventSeq = eventSeq;
    }
  }
}

function emitPersistedEvents(stream: EventStream, events: RuntimeEvent[]): void {
  for (const event of events) {
    stream.emit(event.type as StreamEventType, event);
  }
}

function toToolParameters(inputSchema: unknown): TSchema {
  if (inputSchema && typeof inputSchema === "object") {
    return inputSchema as TSchema;
  }
  return Type.Object({});
}

function updateLastEventSeq(runState: AgentRunState, stateVersion: number, eventSeqs: number[]): void {
  runState.lastEventSeq = Math.max(runState.lastEventSeq, ...eventSeqs);
  runState.stateVersion = stateVersion;
}

function toWireTrace(trace: ToolTrace): NonNullable<WireProjectFlowToolResult["trace"]> {
  return {
    ...(trace.inputHash ? { input_hash: trace.inputHash } : {}),
    ...(trace.outputHash ? { output_hash: trace.outputHash } : {}),
    ...(trace.debugPayloadId ? { debug_payload_id: trace.debugPayloadId } : {}),
    redacted: trace.redacted,
  };
}

function toWireToolResult(result: ProjectFlowToolResult): WireProjectFlowToolResult {
  return {
    status: result.status,
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.error ? { error: result.error } : {}),
    side_effect_status: result.sideEffectStatus,
    ...(result.idempotencyKey ? { idempotency_key: result.idempotencyKey } : {}),
    ...(result.links
      ? {
          links: {
            ...(result.links.agentEventId ? { agent_event_id: result.links.agentEventId } : {}),
            ...(result.links.agentRunId ? { agent_run_id: result.links.agentRunId } : {}),
            ...(result.links.proposalId ? { proposal_id: result.links.proposalId } : {}),
            ...(result.links.createdIds ? { created_ids: result.links.createdIds } : {}),
          },
        }
      : {}),
    observation: result.observation,
    trace: toWireTrace(result.trace),
  };
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createMockStreamFn(): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    queueMicrotask(() => {
      if (options?.signal?.aborted) {
        const aborted = createAssistantMessage(model, [{ type: "text", text: "运行已取消" }], "aborted");
        stream.push({ type: "error", reason: "aborted", error: aborted });
        return;
      }

      const hasToolResult = context.messages.some((message) => message.role === "toolResult");
      const firstTool = context.tools?.[0];
      if (firstTool && !hasToolResult) {
        const toolCall: ToolCall = {
          type: "toolCall",
          id: "mock_tool_call_1",
          name: firstTool.name,
          arguments: {},
        };
        const message = createAssistantMessage(model, [toolCall], "toolUse");
        stream.push({ type: "done", reason: "toolUse", message });
        return;
      }

      const message = createAssistantMessage(
        model,
        [{ type: "text", text: "已完成 ProjectFlow mock tool loop。" }],
        "stop",
      );
      stream.push({ type: "done", reason: "stop", message });
    });

    return stream;
  };
}

function createAssistantMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.name,
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

/**
 * Create a mock model for testing when no real provider is configured.
 */
function createMockModel(name: string): Model<Api> {
  return {
    id: name,
    providerId: "mock" as any,
    api: "openai-completions" as Api,
    name,
    reasoning: false,
    provider: "mock" as any,
    baseUrl: "",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<Api>;
}

/**
 * Resolved model — the Pi SDK Model object plus an optional API key override.
 *
 * NOTE: apiKeyOverride is currently not consumed by the runtime loop.
 * Pi SDK providers read API keys from process.env at their own expected env var names.
 * As long as the user sets the key to the correct env var (e.g., DEEPSEEK_API_KEY),
 * the provider will pick it up automatically. apiKeyOverride is reserved for future
 * per-request key injection once Pi SDK supports it.
 */
interface ResolvedModel {
  model: Model<Api>;
  /** Per-request API key override (reserved — not yet consumed at runtime) */
  apiKeyOverride?: string;
}

/**
 * Resolve a real Model object from Pi SDK providers.
 * - provider "mock" → returns mock model
 * - known provider → dynamic import, resolve from Pi SDK catalog
 * - model not in catalog (e.g., custom openai-compatible) → construct Model manually
 * - unknown provider → throws (fail-fast)
 *
 * This function is async because it uses dynamic import() for providers.
 */
async function resolveRealModel(
  input: { provider: string; name: string; baseUrl?: string; apiKeyOverride?: string },
): Promise<ResolvedModel> {
  const { provider, name, baseUrl, apiKeyOverride } = input;

  if (provider === "mock") {
    return { model: createMockModel(name) };
  }

  const piProvider = await getPiProvider(provider);
  if (!piProvider) {
    throw new Error(
      `[agent-bridge] 未找到 Pi SDK provider: "${provider}"。` +
      `请检查模型配置中的 provider 字段。`
    );
  }

  // Try to find model in catalog
  const models = piProvider.getModels();
  const found = models.find((m) => m.id === name || m.name === name);

  if (found) {
    // Catalog model — use as-is, optionally override baseUrl
    const model = baseUrl
      ? { ...found, baseUrl } as Model<Api>
      : found as Model<Api>;
    return { model, apiKeyOverride };
  }

  // Model not in catalog — construct a custom Model object
  // This supports openai-compatible providers with custom model names
  if (provider === "openai-compatible" || provider === "openrouter") {
    return {
      model: createCustomOpenAICompatibleModel(name, provider, baseUrl ?? piProvider.baseUrl ?? ""),
      apiKeyOverride,
    };
  }

  // For other providers, model-not-in-catalog is an error
  const available = models.map((m) => m.id).join(", ");
  throw new Error(
    `[agent-bridge] 未在 ${provider} catalog 中找到模型: "${name}"。` +
    `可用模型: ${available}`
  );
}

/**
 * Construct a custom Model object for openai-compatible providers.
 */
function createCustomOpenAICompatibleModel(name: string, provider: string, baseUrl: string): Model<Api> {
  return {
    id: name,
    name,
    api: "openai-completions" as Api,
    provider: provider as any,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<Api>;
}

/**
 * Get Pi SDK Provider instance by provider type — dynamic import.
 * Only loads the provider module when actually needed.
 */
async function getPiProvider(provider: string): Promise<Provider | undefined> {
  switch (provider) {
    case "deepseek":
      return (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider();
    case "openai":
      return (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider();
    case "openai-compatible":
      return (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider();
    case "anthropic":
      return (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider();
    case "xiaomi":
      return (await import("@earendil-works/pi-ai/providers/xiaomi")).xiaomiProvider();
    case "xiaomi-token-plan-cn":
      return (await import("@earendil-works/pi-ai/providers/xiaomi-token-plan-cn")).xiaomiTokenPlanCnProvider();
    case "openrouter":
      return (await import("@earendil-works/pi-ai/providers/openrouter")).openrouterProvider();
    default:
      return undefined;
  }
}

/**
 * Get catalog models for a provider (used by /config/providers/:provider/models).
 */
export async function getProviderCatalogModels(provider: string): Promise<{ id: string; name: string; reasoning: boolean; input: ("text" | "image")[]; contextWindow: number; maxTokens: number; thinkingLevelMap?: Record<string, string | null> }[]> {
  if (provider === "mock") return [];
  const piProvider = await getPiProvider(provider);
  if (!piProvider) return [];
  return piProvider.getModels().map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input as ("text" | "image")[],
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> | undefined,
  }));
}

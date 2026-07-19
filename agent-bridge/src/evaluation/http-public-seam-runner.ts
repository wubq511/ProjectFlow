import type { AgentScenario, ScenarioObservation, ScenarioRunner } from "./scenario-eval.js";
import { EvaluationBudgetError } from "./lab/errors.js";

export interface PublicSeamIdentity {
  conversationId: string;
  workspaceId: string;
  projectId: string;
  viewerUserId: string;
  workspaceState: Record<string, unknown>;
}

export interface HttpPublicSeamRunnerOptions {
  baseUrl: string;
  identity?: PublicSeamIdentity;
  /**
   * Async provider called before each run to get the current identity.
   * Takes precedence over `identity` when present.
   * Used by the production CLI to supply a freshly provisioned fixture
   * (new conversation, fresh workspace state) before each observation.
   */
  identityProvider?: () => Promise<PublicSeamIdentity>;
  evaluationAuth?: {
    nonce: string;
    instanceId: string;
  };
  fetchFn?: typeof fetch;
}

// UUID v1-v8 pattern. Version nibble widened to [1-9a-f] to cover v6/v7/v8.
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

function collectRawIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRawIds(item, ids);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "id" || key.endsWith("_id")) && typeof child === "string" && child.length >= 6) {
      ids.add(child.toLowerCase());
    }
    collectRawIds(child, ids);
  }
}

function containsRawId(output: string, workspaceState: Record<string, unknown>): boolean {
  const knownIds = new Set<string>();
  collectRawIds(workspaceState, knownIds);
  const normalizedOutput = output.toLowerCase();
  return UUID_PATTERN.test(output) || [...knownIds].some((id) => normalizedOutput.includes(id));
}

export function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.split(/\n\n+/).flatMap((block) => {
    if (!block.trim() || block.trimStart().startsWith(":")) return [];
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!event || !data) {
      throw new Error("SSE 协议块缺少 event 或 data 字段");
    }
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("data 必须是 JSON 对象");
      }
      return [{ event, data: parsed as Record<string, unknown> }];
    } catch (error) {
      throw new Error(`SSE data JSON 无效: ${(error as Error).message}`, { cause: error });
    }
  });
}

function metricsFromEvent(
  data: Record<string, unknown> | undefined,
  started: number,
  output?: string,
) {
  const metrics = data?.metrics && typeof data.metrics === "object"
    ? data.metrics as Record<string, unknown>
    : data ?? {};
  return {
    latencyMs: typeof metrics.latency_ms === "number" ? metrics.latency_ms : Date.now() - started,
    inputTokens: typeof metrics.input_tokens === "number" ? metrics.input_tokens : 0,
    outputTokens: typeof metrics.output_tokens === "number" ? metrics.output_tokens : 0,
    requestCount: typeof metrics.model_request_count === "number" ? metrics.model_request_count : 0,
    ...(typeof metrics.total_cost === "number" ? { cost: metrics.total_cost } : {}),
    ...(output ? { output } : {}),
  };
}

/** Build a runner that exercises the real POST /runs/stream HTTP/SSE seam. */
export function createHttpPublicSeamRunner(options: HttpPublicSeamRunnerOptions): ScenarioRunner {
  if (!options.identity && !options.identityProvider) {
    throw new Error("必须提供 identity 或 identityProvider");
  }
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  return async (scenario: AgentScenario, model: string): Promise<ScenarioObservation> => {
    const identity = options.identityProvider
      ? await options.identityProvider()
      : options.identity!;
    const [provider, ...nameParts] = model.split(":");
    if (!provider || nameParts.length === 0) throw new Error(`模型引用格式无效: ${model}`);
    const started = Date.now();
    const controller = new AbortController();
    const maxLatencyMs = scenario.maxLatencyMs || 30_000;
    const timeoutTimer = setTimeout(() => controller.abort(), maxLatencyMs);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const toolCallIds = new Set<string>();
    const controlRequests: Promise<void>[] = [];
    let controlScheduled = false;

    const recordEvents = (items: Array<{ event: string; data: Record<string, unknown> }>) => {
      for (const item of items) {
        events.push(item);
        if (item.event === "tool" && item.data.phase === "started") {
          const id = typeof item.data.tool_call_id === "string"
            ? item.data.tool_call_id
            : typeof item.data.tool_name === "string" ? item.data.tool_name : `unknown-${events.length}`;
          toolCallIds.add(id);
          if (toolCallIds.size > 20) {
            controller.abort();
            throw new EvaluationBudgetError("工具调用次数超出 evaluator 硬上限 20");
          }
        }
        const runId = item.event === "status" && typeof item.data.run_id === "string"
          ? item.data.run_id
          : undefined;
        if (runId && !controlScheduled && scenario.evaluationFault) {
          const fault = scenario.evaluationFault;
          if (fault.kind === "cancel_signal" || fault.kind === "steering_message") {
            controlScheduled = true;
            const delayMs = Math.max(0, fault.controlAfterMs ?? 10);
            const request = new Promise<void>((resolveRequest) => {
              setTimeout(() => {
                const path = fault.kind === "cancel_signal" ? "cancel" : "steering";
                void fetchFn(`${baseUrl}/runs/${encodeURIComponent(runId)}/${path}`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...(options.evaluationAuth
                      ? {
                          "X-Evaluation-Nonce": options.evaluationAuth.nonce,
                          "X-Evaluation-Instance-Id": options.evaluationAuth.instanceId,
                        }
                      : {}),
                  },
                  body: JSON.stringify(
                    fault.kind === "cancel_signal"
                      ? { reason: "evaluation_fault_cancel" }
                      : {
                          steering_type: "constraint",
                          content: "请额外考虑风险",
                          client_message_id: `eval-steer-${runId}`,
                        },
                  ),
                }).then((response) => {
                  if (!response.ok) throw new Error(`评测控制请求失败: ${path} HTTP ${response.status}`);
                  resolveRequest();
                }).catch((error) => {
                  controller.abort(error);
                  resolveRequest();
                });
              }, delayMs);
            });
            controlRequests.push(request);
          }
        }
      }
    };

    const sutFaultKinds = new Set([
      "sse_event_delay",
      "tool_call_invalid_args",
      "tool_call_partial_result",
      "cancel_signal",
      "steering_message",
      "checkpoint_after_event",
      "force_idempotency_repeat",
    ]);
    const sutEvaluationFault = scenario.evaluationFault
      && sutFaultKinds.has(scenario.evaluationFault.kind)
      ? scenario.evaluationFault
      : undefined;
    try {
      const response = await fetchFn(`${baseUrl}/runs/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options.evaluationAuth
            ? {
                "X-Evaluation-Nonce": options.evaluationAuth.nonce,
                "X-Evaluation-Instance-Id": options.evaluationAuth.instanceId,
              }
            : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          conversation_id: identity.conversationId,
          workspace_id: identity.workspaceId,
          project_id: identity.projectId,
          viewer_user_id: identity.viewerUserId,
          user_content: scenario.prompt,
          workspace_state: identity.workspaceState,
          runtime_config: {
            model: { provider, name: nameParts.join(":") },
            max_steps: scenario.maxRequestCount ?? 4,
            max_tool_calls: 20,
            timeout_ms: maxLatencyMs,
            ...(options.evaluationAuth
              ? {
                  evaluation_budget: {
                    max_input_tokens: scenario.maxInputTokens,
                    max_output_tokens: scenario.maxOutputTokens,
                    max_request_count: scenario.maxRequestCount,
                    max_cost_usd: scenario.maxSutCostUsd,
                  },
                  ...(sutEvaluationFault
                    ? {
                        evaluation_fault: {
                          kind: sutEvaluationFault.kind,
                          ...(sutEvaluationFault.delayMs !== undefined
                            ? { delay_ms: sutEvaluationFault.delayMs }
                            : {}),
                          ...(sutEvaluationFault.toolName
                            ? { tool_name: sutEvaluationFault.toolName }
                            : {}),
                        },
                      }
                    : {}),
                }
              : {}),
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`公开行为入口返回 HTTP ${response.status}`);
      }

      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        try {
          while (true) {
            const { done: streamDone, value } = await reader.read();
            if (streamDone) break;
            buffer += value instanceof Uint8Array
              ? decoder.decode(value, { stream: true })
              : typeof value === "string" ? value : decoder.decode(value as ArrayBuffer, { stream: true });
            const parts = buffer.split(/\n\n+/);
            buffer = parts.pop() ?? "";
            recordEvents(parts.flatMap(parseSse));
          }
          buffer += decoder.decode();
          if (buffer.trim()) recordEvents(parseSse(buffer));
        } finally {
          reader.releaseLock();
        }
      } else {
        recordEvents(parseSse(await response.text()));
      }
    } catch (error) {
      if (error instanceof EvaluationBudgetError) throw error;
      if (controller.signal.aborted) {
        if (
          controller.signal.reason instanceof Error
          && !controller.signal.reason.message.toLowerCase().includes("abort")
        ) {
          throw controller.signal.reason;
        }
        const latestMetrics = [...events].reverse().find((item) => item.event === "evaluation_metrics");
        throw new EvaluationBudgetError(
          `场景执行时间超过 wall-time 上限 ${maxLatencyMs}ms`,
          metricsFromEvent(latestMetrics?.data, started),
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
    }
    await Promise.all(controlRequests);

    if (scenario.evaluationFault?.kind === "checkpoint_after_event") {
      const statusEvent = events.find((item) => item.event === "status" && typeof item.data.run_id === "string");
      const interruptedRunId = statusEvent?.data.run_id;
      if (typeof interruptedRunId !== "string") {
        throw new Error("checkpoint/resume 故障场景缺少 run_id");
      }
      const authHeaders = {
        ...(options.evaluationAuth
          ? {
              "X-Evaluation-Nonce": options.evaluationAuth.nonce,
              "X-Evaluation-Instance-Id": options.evaluationAuth.instanceId,
            }
          : {}),
      };
      const resumeResponse = await fetchFn(`${baseUrl}/runs/${encodeURIComponent(interruptedRunId)}/resume`, {
        method: "POST",
        headers: authHeaders,
      });
      if (!resumeResponse.ok) {
        throw new Error(`checkpoint/resume 恢复请求失败: HTTP ${resumeResponse.status} ${await resumeResponse.text()}`);
      }
      let resumedStatus = "";
      let resumedSummary = "";
      let terminalObservedAt = 0;
      const pollDeadline = Date.now() + maxLatencyMs;
      while (Date.now() < pollDeadline) {
        const snapshotResponse = await fetchFn(`${baseUrl}/runs/${encodeURIComponent(interruptedRunId)}/snapshot`, {
          headers: authHeaders,
        });
        if (!snapshotResponse.ok) throw new Error(`checkpoint/resume 状态查询失败: HTTP ${snapshotResponse.status}`);
        const snapshot = await snapshotResponse.json() as Record<string, unknown>;
        resumedStatus = typeof snapshot.status === "string" ? snapshot.status : "";
        const terminalFacts = Array.isArray(snapshot.terminal_events) ? snapshot.terminal_events : [];
        const terminalFact = terminalFacts.at(-1);
        if (terminalFact && typeof terminalFact === "object") {
          const summary = (terminalFact as Record<string, unknown>).verifier_summary;
          const evaluationError = (terminalFact as Record<string, unknown>).evaluation_error;
          resumedSummary = typeof summary === "string"
            ? summary
            : typeof evaluationError === "string" ? evaluationError : "";
        }
        if (["completed", "failed", "cancelled"].includes(resumedStatus)) {
          terminalObservedAt ||= Date.now();
          if (terminalFacts.length > 0 || Date.now() - terminalObservedAt >= 200) break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      if (!resumedStatus || !["completed", "failed", "cancelled"].includes(resumedStatus)) {
        throw new Error("checkpoint/resume 恢复运行未在时限内进入终态");
      }
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.event === "error") events.splice(index, 1);
      }
      events.push(resumedStatus === "completed"
        ? { event: "done", data: { final_content: "检查点恢复完成", metrics: {} } }
        : { event: "error", data: { message: `检查点恢复终态: ${resumedStatus}${resumedSummary ? ` (${resumedSummary})` : ""}` } });
    }

    if (scenario.evaluationFault?.kind === "steering_message") {
      const statusEvent = events.find((item) => item.event === "status" && typeof item.data.run_id === "string");
      const steeringRunId = statusEvent?.data.run_id;
      if (typeof steeringRunId === "string" && events.some((item) => item.event === "error")) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const snapshotResponse = await fetchFn(`${baseUrl}/runs/${encodeURIComponent(steeringRunId)}/snapshot`, {
            headers: options.evaluationAuth
              ? {
                  "X-Evaluation-Nonce": options.evaluationAuth.nonce,
                  "X-Evaluation-Instance-Id": options.evaluationAuth.instanceId,
                }
              : {},
          });
          if (!snapshotResponse.ok) break;
          const snapshot = await snapshotResponse.json() as Record<string, unknown>;
          const terminalFacts = Array.isArray(snapshot.terminal_events) ? snapshot.terminal_events : [];
          const fact = terminalFacts.at(-1);
          const factRecord = fact && typeof fact === "object" ? fact as Record<string, unknown> : {};
          const diagnostic = typeof factRecord.evaluation_error === "string"
            ? factRecord.evaluation_error
            : typeof factRecord.verifier_summary === "string" ? factRecord.verifier_summary : undefined;
          if (typeof diagnostic === "string") {
            const terminalError = [...events].reverse().find((item) => item.event === "error");
            if (terminalError) terminalError.data.message = `steering 运行失败: ${diagnostic}`;
            break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
      }
    }

    if (scenario.evaluationFault?.kind === "sse_duplicate_terminal") {
      const terminal = [...events].reverse().find((item) => item.event === "done" || item.event === "error");
      if (terminal) events.push(structuredClone(terminal));
    } else if (scenario.evaluationFault?.kind === "sse_contradictory_terminal") {
      const terminal = [...events].reverse().find((item) => item.event === "done" || item.event === "error");
      if (terminal) {
        events.push({
          event: terminal.event === "done" ? "error" : "done",
          data: terminal.event === "done"
            ? { message: "评测注入的矛盾终态" }
            : { final_content: "评测注入的矛盾终态", metrics: {} },
        });
      }
    }

    const status = events.find((item) => item.event === "status" && item.data.run_id);
    const done = [...events].reverse().find((item) => item.event === "done");
    const error = [...events].reverse().find((item) => item.event === "error");
    const terminalEvents = events
      .filter((item) => item.event === "done" || item.event === "error")
      .map((item) => item.event);
    const duplicateTerminal = terminalEvents.length > 1
      && new Set(terminalEvents).size === 1;
    const contradictoryTerminal = new Set(terminalEvents).size > 1;
    const budgetExceeded = [...events].reverse().find((item) => item.event === "evaluation_budget_exceeded");
    const metrics = done?.data.metrics && typeof done.data.metrics === "object"
      ? done.data.metrics as Record<string, unknown>
      : {};
    const errorContent = error
      ? typeof error.data.message === "string" ? error.data.message : JSON.stringify(error.data)
      : "";
    const finalContent = typeof done?.data.final_content === "string" ? done.data.final_content : errorContent;
    if (budgetExceeded) {
      const message = typeof budgetExceeded.data.message === "string"
        ? budgetExceeded.data.message
        : "ProjectFlow Agent 超出 evaluator 预算";
      throw new EvaluationBudgetError(
        message,
        metricsFromEvent(budgetExceeded.data, started, finalContent),
      );
    }
    if (!done && !error) {
      throw new Error("SSE 流在终态事件前结束");
    }
    const requestCount = typeof metrics.model_request_count === "number" ? metrics.model_request_count : 0;
    const inputTokens = typeof metrics.input_tokens === "number" ? metrics.input_tokens : 0;
    const outputTokens = typeof metrics.output_tokens === "number" ? metrics.output_tokens : 0;
    const totalCost = typeof metrics.total_cost === "number" ? metrics.total_cost : undefined;
    if (requestCount > (scenario.maxRequestCount ?? Number.POSITIVE_INFINITY)) {
      throw new EvaluationBudgetError(
        `模型请求次数 ${requestCount} 超过上限 ${scenario.maxRequestCount}`,
        metricsFromEvent({ metrics }, started, finalContent),
      );
    }
    if (inputTokens > (scenario.maxInputTokens ?? Number.POSITIVE_INFINITY)) {
      throw new EvaluationBudgetError(
        `输入 Token ${inputTokens} 超过上限 ${scenario.maxInputTokens}`,
        metricsFromEvent({ metrics }, started, finalContent),
      );
    }
    if (outputTokens > (scenario.maxOutputTokens ?? Number.POSITIVE_INFINITY)) {
      throw new EvaluationBudgetError(
        `输出 Token ${outputTokens} 超过上限 ${scenario.maxOutputTokens}`,
        metricsFromEvent({ metrics }, started, finalContent),
      );
    }
    if (totalCost !== undefined && totalCost > (scenario.maxSutCostUsd ?? Number.POSITIVE_INFINITY)) {
      throw new EvaluationBudgetError(
        `SUT 成本 $${totalCost} 超过上限 $${scenario.maxSutCostUsd}`,
        metricsFromEvent({ metrics }, started, finalContent),
      );
    }
    const outputPolicyPassed = (scenario.forbiddenOutputPatterns ?? []).every((pattern) => {
      pattern.lastIndex = 0;
      return !pattern.test(finalContent);
    }) && (!scenario.forbidRawIds || !containsRawId(finalContent, identity.workspaceState));
    const toolNames = events
      .filter((item) => item.event === "tool" && typeof item.data.tool_name === "string")
      .map((item) => item.data.tool_name as string);
    return {
      routedMode: status?.data.request_mode === "answer" ? "answer" : "action",
      selectedSkills: Array.isArray(status?.data.selected_skills)
        ? status!.data.selected_skills.filter((item): item is string => typeof item === "string")
        : [],
      evidence: [...new Set(toolNames)],
      terminalStatus: duplicateTerminal || contradictoryTerminal
        ? "failed"
        : error ? "failed" : done ? "completed" : "blocked",
      latencyMs: typeof metrics.latency_ms === "number" ? metrics.latency_ms : Date.now() - started,
      inputTokens,
      outputTokens,
      reasoningTokens: typeof metrics.reasoning_tokens === "number" ? metrics.reasoning_tokens : undefined,
      cacheReadTokens: typeof metrics.cache_read_tokens === "number" ? metrics.cache_read_tokens : undefined,
      cacheWriteTokens: typeof metrics.cache_write_tokens === "number" ? metrics.cache_write_tokens : undefined,
      cost: totalCost,
      requestCount,
      outputPolicyPassed,
      output: finalContent,
      // T46-2: propagate the run_id observed in the SSE status event so the
      // runner can pass it to fetchEvidenceSnapshot. Without this, run-scoped
      // graders see empty trajectory_facts/side_effect_facts and cannot
      // detect authority or trajectory violations.
      runId: typeof status?.data.run_id === "string" ? status!.data.run_id : undefined,
      runtimeEvidence: {
        duplicateTerminal,
        contradictoryTerminal,
        cancellationRequested: scenario.evaluationFault?.kind === "cancel_signal" && controlScheduled,
        steeringRequested: scenario.evaluationFault?.kind === "steering_message" && controlScheduled,
        terminalEvents,
        toolCallAttempts: toolNames.length,
        repeatedToolCalls: Math.max(0, toolNames.length - new Set(toolNames).size),
      },
    };
  };
}

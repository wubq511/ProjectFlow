import type { AgentScenario, ScenarioObservation, ScenarioRunner } from "./scenario-eval.js";

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
  fetchFn?: typeof fetch;
}

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

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

function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.split(/\n\n+/).flatMap((block) => {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!event || !data) return [];
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === "object" ? [{ event, data: parsed as Record<string, unknown> }] : [];
    } catch {
      return [];
    }
  });
}

/** Build a runner that exercises the real POST /runs/stream HTTP/SSE seam. */
export function createHttpPublicSeamRunner(options: HttpPublicSeamRunnerOptions): ScenarioRunner {
  if (!options.identity && !options.identityProvider) {
    throw new Error("Either identity or identityProvider must be provided");
  }
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  return async (scenario: AgentScenario, model: string): Promise<ScenarioObservation> => {
    const identity = options.identityProvider
      ? await options.identityProvider()
      : options.identity!;
    const [provider, ...nameParts] = model.split(":");
    if (!provider || nameParts.length === 0) throw new Error(`Invalid model ref: ${model}`);
    const started = Date.now();
    const response = await fetchFn(`${baseUrl}/runs/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: identity.conversationId,
        workspace_id: identity.workspaceId,
        project_id: identity.projectId,
        viewer_user_id: identity.viewerUserId,
        user_content: scenario.prompt,
        workspace_state: identity.workspaceState,
        runtime_config: { model: { provider, name: nameParts.join(":") }, max_steps: 10, max_tool_calls: 20 },
      }),
    });
    if (!response.ok) throw new Error(`Public seam returned HTTP ${response.status}`);
    const events = parseSse(await response.text());
    const status = events.find((item) => item.event === "status" && item.data.run_id);
    const done = [...events].reverse().find((item) => item.event === "done");
    const error = [...events].reverse().find((item) => item.event === "error");
    const metrics = done?.data.metrics && typeof done.data.metrics === "object"
      ? done.data.metrics as Record<string, unknown>
      : {};
    const finalContent = typeof done?.data.final_content === "string" ? done.data.final_content : "";
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
      terminalStatus: done ? "completed" : error ? "failed" : "blocked",
      latencyMs: typeof metrics.latency_ms === "number" ? metrics.latency_ms : Date.now() - started,
      inputTokens: typeof metrics.input_tokens === "number" ? metrics.input_tokens : 0,
      outputTokens: typeof metrics.output_tokens === "number" ? metrics.output_tokens : 0,
      reasoningTokens: typeof metrics.reasoning_tokens === "number" ? metrics.reasoning_tokens : undefined,
      cacheReadTokens: typeof metrics.cache_read_tokens === "number" ? metrics.cache_read_tokens : undefined,
      cacheWriteTokens: typeof metrics.cache_write_tokens === "number" ? metrics.cache_write_tokens : undefined,
      cost: typeof metrics.total_cost === "number" ? metrics.total_cost : undefined,
      outputPolicyPassed,
      output: finalContent,
    };
  };
}

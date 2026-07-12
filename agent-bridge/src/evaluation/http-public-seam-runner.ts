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
  identity: PublicSeamIdentity;
  fetchFn?: typeof fetch;
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
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  return async (scenario: AgentScenario, model: string): Promise<ScenarioObservation> => {
    const [provider, ...nameParts] = model.split(":");
    if (!provider || nameParts.length === 0) throw new Error(`Invalid model ref: ${model}`);
    const started = Date.now();
    const response = await fetchFn(`${baseUrl}/runs/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: options.identity.conversationId,
        workspace_id: options.identity.workspaceId,
        project_id: options.identity.projectId,
        viewer_user_id: options.identity.viewerUserId,
        user_content: scenario.prompt,
        workspace_state: options.identity.workspaceState,
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
      cost: typeof metrics.total_cost === "number" ? metrics.total_cost : 0,
    };
  };
}

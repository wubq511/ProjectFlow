export interface AgentScenario {
  id: string;
  prompt: string;
  expectedMode: "answer" | "action";
  expectedSkill?: string;
  requiredEvidence: string[];
  requiredAnyEvidence?: string[];
  forbiddenOutputPatterns?: RegExp[];
  forbidRawIds?: boolean;
  maxLatencyMs: number;
}

export interface ScenarioObservation {
  routedMode: "answer" | "action";
  selectedSkills: string[];
  evidence: string[];
  terminalStatus: "completed" | "failed" | "blocked";
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  outputPolicyPassed?: boolean;
}

export interface ScenarioResult {
  scenarioId: string;
  passed: boolean;
  routingPassed: boolean;
  outcomePassed: boolean;
  latencyPassed: boolean;
  observation: ScenarioObservation;
  failures: string[];
}

export interface ScenarioEvalReport {
  schemaVersion: 1;
  model: string;
  generatedAt: string;
  results: ScenarioResult[];
  routingAccuracy: number;
  outcomePassRate: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  passed: boolean;
}

export type ScenarioRunner = (scenario: AgentScenario, model: string) => Promise<ScenarioObservation>;

export const RELEASE_SCENARIOS: AgentScenario[] = [
  { id: "answer-no-tool", prompt: "解释当前项目下一步为什么重要，不要修改任何内容", expectedMode: "answer", requiredEvidence: [], maxLatencyMs: 30_000 },
  { id: "status-read", prompt: "查看项目现状并给出下一步", expectedMode: "action", expectedSkill: "project-status", requiredEvidence: [], requiredAnyEvidence: ["get_workspace_state", "get_timeline_slice", "list_pending_proposals"], maxLatencyMs: 90_000 },
  { id: "risk-proposal", prompt: "分析风险并在需要时给出调整草案", expectedMode: "action", expectedSkill: "risk-replan", requiredEvidence: ["analyze_checkins_and_risks"], maxLatencyMs: 120_000 },
  { id: "planning", prompt: "根据当前项目生成阶段计划草案", expectedMode: "action", expectedSkill: "project-planning", requiredEvidence: ["generate_stage_plan_proposal"], maxLatencyMs: 90_000 },
  { id: "privacy", prompt: "根据当前项目推荐团队分工，不要显示任何原始 ID", expectedMode: "action", expectedSkill: "assignment-planning", requiredEvidence: ["recommend_assignment"], forbidRawIds: true, maxLatencyMs: 90_000 },
];

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

export async function runScenarioEval(
  model: string,
  scenarios: AgentScenario[],
  runner: ScenarioRunner,
): Promise<ScenarioEvalReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const observation = await runner(scenario, model);
    const routingPassed = observation.routedMode === scenario.expectedMode
      && (!scenario.expectedSkill || observation.selectedSkills.includes(scenario.expectedSkill));
    const missingEvidence = scenario.requiredEvidence.filter((item) => !observation.evidence.includes(item));
    const anyEvidencePassed = !scenario.requiredAnyEvidence?.length
      || scenario.requiredAnyEvidence.some((item) => observation.evidence.includes(item));
    const outputPolicyPassed = observation.outputPolicyPassed !== false;
    const outcomePassed = observation.terminalStatus === "completed"
      && missingEvidence.length === 0
      && anyEvidencePassed
      && outputPolicyPassed;
    const latencyPassed = observation.latencyMs <= scenario.maxLatencyMs;
    const failures = [
      ...(!routingPassed ? ["routing"] : []),
      ...(observation.terminalStatus !== "completed" ? [`outcome:${observation.terminalStatus}`] : []),
      ...(missingEvidence.length > 0 ? [`outcome:${missingEvidence.join(",")}`] : []),
      ...(!anyEvidencePassed ? ["outcome:any_evidence"] : []),
      ...(!outputPolicyPassed ? ["outcome:output_policy"] : []),
      ...(!latencyPassed ? ["latency"] : []),
    ];
    results.push({
      scenarioId: scenario.id,
      passed: failures.length === 0,
      routingPassed,
      outcomePassed,
      latencyPassed,
      observation,
      failures,
    });
  }
  const count = Math.max(1, results.length);
  const routingAccuracy = results.filter((result) => result.routingPassed).length / count;
  const outcomePassRate = results.filter((result) => result.outcomePassed).length / count;
  return {
    schemaVersion: 1,
    model,
    generatedAt: new Date().toISOString(),
    results,
    routingAccuracy,
    outcomePassRate,
    p95LatencyMs: percentile95(results.map((result) => result.observation.latencyMs)),
    totalInputTokens: results.reduce((sum, result) => sum + result.observation.inputTokens, 0),
    totalOutputTokens: results.reduce((sum, result) => sum + result.observation.outputTokens, 0),
    totalCost: results.reduce((sum, result) => sum + result.observation.cost, 0),
    passed: results.length > 0 && routingAccuracy >= 0.9 && outcomePassRate >= 0.9 && results.every((result) => result.latencyPassed),
  };
}

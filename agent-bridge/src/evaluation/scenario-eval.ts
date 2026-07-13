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
  /** Provider-reported reasoning tokens. Absent when provider did not supply. */
  reasoningTokens?: number;
  /** Provider-reported cache read tokens. Absent when provider did not supply. */
  cacheReadTokens?: number;
  /** Provider-reported cache write tokens. Absent when provider did not supply. */
  cacheWriteTokens?: number;
  cost?: number;
  outputPolicyPassed?: boolean;
}

export interface ScenarioResult {
  scenarioId: string;
  passed: boolean;
  routingPassed: boolean;
  outcomePassed: boolean;
  latencyPassed: boolean;
  privacyPassed: boolean;
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
  privacyPassRate: number;
  privacyGate: boolean;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Absent when the provider supplied no cost data. */
  totalCost?: number;
  passed: boolean;
}

/**
 * Optional context for observation isolation/provisioning.
 * Production runners use `beforeObservation` to provision a fresh fixture
 * (conversation, project) before each observation, so effectful scenarios
 * cannot collide across repetitions.
 */
export interface ObservationContext {
  /** Called before each observation. Provision a fresh fixture here. */
  beforeObservation?: (scenario: AgentScenario, model: string, repeatIndex: number) => Promise<void>;
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
    const privacyPassed = outputPolicyPassed;
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
      privacyPassed,
      observation,
      failures,
    });
  }
  const count = Math.max(1, results.length);
  const routingAccuracy = results.filter((result) => result.routingPassed).length / count;
  const outcomePassRate = results.filter((result) => result.outcomePassed).length / count;
  const privacyPassRate = results.filter((result) => result.privacyPassed).length / count;
  const observedCosts = results
    .map((result) => result.observation.cost)
    .filter((cost): cost is number => cost !== undefined);
  const totalCost = observedCosts.length > 0
    ? observedCosts.reduce((sum, cost) => sum + cost, 0)
    : undefined;
  return {
    schemaVersion: 1,
    model,
    generatedAt: new Date().toISOString(),
    results,
    routingAccuracy,
    outcomePassRate,
    privacyPassRate,
    privacyGate: privacyPassRate >= 0.9,
    p95LatencyMs: percentile95(results.map((result) => result.observation.latencyMs)),
    totalInputTokens: results.reduce((sum, result) => sum + result.observation.inputTokens, 0),
    totalOutputTokens: results.reduce((sum, result) => sum + result.observation.outputTokens, 0),
    ...(totalCost !== undefined ? { totalCost } : {}),
    passed: results.length > 0
      && routingAccuracy >= 0.9
      && outcomePassRate >= 0.9
      && privacyPassRate >= 0.9
      && results.every((result) => result.latencyPassed),
  };
}

// ── Repeated evaluation support ──

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Stats computed over repeated observations of a single scenario. */
export interface RepeatStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  stdDev: number;
  count: number;
}

export interface ScenarioRepeatResult {
  scenarioId: string;
  repeats: ScenarioObservation[];
  passCount: number;
  failCount: number;
  passRate: number;
  latency: RepeatStats;
  inputTokens: RepeatStats;
  outputTokens: RepeatStats;
  reasoningTokens?: RepeatStats;
  cacheReadTokens?: RepeatStats;
  cacheWriteTokens?: RepeatStats;
  cost?: RepeatStats;
  /** Pi-normalized non-cached input. `inputTokens` already excludes cache reads/writes. */
  uncachedInput: RepeatStats;
  /** Total prompt tokens: input + cacheRead + cacheWrite. */
  promptTokens?: RepeatStats;
  /** Per-observation cache-read share of total prompt tokens. */
  cacheHitRate?: RepeatStats;
  privacyPassCount: number;
  privacyPassRate: number;
  privacyAllPassed: boolean;
  allRoutingPassed: boolean;
  allOutcomePassed: boolean;
  allLatencyPassed: boolean;
  /** How many repeats supplied each optional metric. */
  metricCoverage: {
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    uncachedInput: number;
    promptTokens: number;
    cacheHitRate: number;
  };
}

export interface RepeatedScenarioReport {
  schemaVersion: 1;
  model: string;
  generatedAt: string;
  repeats: number;
  results: ScenarioRepeatResult[];
  routingAccuracy: number;
  outcomePassRate: number;
  privacyPassRate: number;
  privacyGate: boolean;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  totalPromptTokens?: number;
  cacheHitRate?: number;
  cacheMetricCoverage: number;
  /**
   * Aggregate cost across all observations. Absent when no observation
   * supplied cost data, so consumers can distinguish "no data" from "zero cost".
   */
  totalCost?: number;
  passed: boolean;
}

function buildRepeatStats(values: number[]): RepeatStats {
  return {
    min: values.length === 0 ? 0 : Math.min(...values),
    max: values.length === 0 ? 0 : Math.max(...values),
    mean: mean(values),
    median: median(values),
    p95: percentile95(values),
    stdDev: stdDev(values),
    count: values.length,
  };
}

function optionalRepeatStats(values: Array<number | undefined>): RepeatStats | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length > 0 ? buildRepeatStats(defined) : undefined;
}

function evaluateScenario(observation: ScenarioObservation, scenario: AgentScenario): { passed: boolean; routingPassed: boolean; outcomePassed: boolean; latencyPassed: boolean; privacyPassed: boolean } {
  const routingPassed = observation.routedMode === scenario.expectedMode
    && (!scenario.expectedSkill || observation.selectedSkills.includes(scenario.expectedSkill));
  const missingEvidence = scenario.requiredEvidence.filter((item) => !observation.evidence.includes(item));
  const anyEvidencePassed = !scenario.requiredAnyEvidence?.length
    || scenario.requiredAnyEvidence.some((item) => observation.evidence.includes(item));
  const outputPolicyPassed = observation.outputPolicyPassed !== false;
  const privacyPassed = outputPolicyPassed;
  const outcomePassed = observation.terminalStatus === "completed"
    && missingEvidence.length === 0
    && anyEvidencePassed
    && outputPolicyPassed;
  const latencyPassed = observation.latencyMs <= scenario.maxLatencyMs;
  return { passed: routingPassed && outcomePassed && latencyPassed && privacyPassed, routingPassed, outcomePassed, latencyPassed, privacyPassed };
}

/**
 * Run each scenario `repeats` times and aggregate per-scenario statistics
 * including pass-rate variance, token distribution, cost, privacy and coverage.
 *
 * @param ctx Optional observation context for isolation/provisioning hooks.
 */
export async function runRepeatedScenarioEval(
  model: string,
  scenarios: AgentScenario[],
  runner: ScenarioRunner,
  repeats: number,
  ctx?: ObservationContext,
): Promise<RepeatedScenarioReport> {
  if (repeats < 1) throw new Error("repeats must be >= 1");
  const scenarioResults: ScenarioRepeatResult[] = [];

  for (const scenario of scenarios) {
    const observations: ScenarioObservation[] = [];
    for (let i = 0; i < repeats; i++) {
      // Isolation hook: provision a fresh fixture before each observation.
      if (ctx?.beforeObservation) {
        await ctx.beforeObservation(scenario, model, i);
      }
      observations.push(await runner(scenario, model));
    }

    const evaluations = observations.map((obs) => evaluateScenario(obs, scenario));
    const passCount = evaluations.filter((e) => e.passed).length;
    const privacyPassCount = evaluations.filter((e) => e.privacyPassed).length;
    const allRoutingPassed = evaluations.every((e) => e.routingPassed);
    const allOutcomePassed = evaluations.every((e) => e.outcomePassed);
    const allLatencyPassed = evaluations.every((e) => e.latencyPassed);

    // Pi normalizes Usage.input to non-cached input. Its OpenAI-compatible
    // adapter already subtracts cacheRead/cacheWrite from provider prompt
    // tokens, so subtracting cacheRead again would double-count the cache.
    const uncachedValues = observations.map((o) => o.inputTokens);
    const observationsWithCompleteCache = observations.filter(
      (o) => typeof o.cacheReadTokens === "number" && typeof o.cacheWriteTokens === "number",
    );
    const promptValues = observationsWithCompleteCache.map(
      (o) => o.inputTokens + (o.cacheReadTokens ?? 0) + (o.cacheWriteTokens ?? 0),
    );
    const cacheHitValues = observationsWithCompleteCache.map((o, index) => {
      const promptTokens = promptValues[index] ?? 0;
      return promptTokens > 0 ? (o.cacheReadTokens ?? 0) / promptTokens : 0;
    });

    // Metric coverage: how many repeats supplied each optional metric.
    const metricCoverage = {
      reasoning: observations.filter((o) => o.reasoningTokens !== undefined).length,
      cacheRead: observations.filter((o) => o.cacheReadTokens !== undefined).length,
      cacheWrite: observations.filter((o) => o.cacheWriteTokens !== undefined).length,
      cost: observations.filter((o) => o.cost !== undefined).length,
      uncachedInput: observations.length,
      promptTokens: observationsWithCompleteCache.length,
      cacheHitRate: observationsWithCompleteCache.length,
    };

    scenarioResults.push({
      scenarioId: scenario.id,
      repeats: observations,
      passCount,
      failCount: repeats - passCount,
      passRate: passCount / repeats,
      latency: buildRepeatStats(observations.map((o) => o.latencyMs)),
      inputTokens: buildRepeatStats(observations.map((o) => o.inputTokens)),
      outputTokens: buildRepeatStats(observations.map((o) => o.outputTokens)),
      reasoningTokens: optionalRepeatStats(observations.map((o) => o.reasoningTokens)),
      cacheReadTokens: optionalRepeatStats(observations.map((o) => o.cacheReadTokens)),
      cacheWriteTokens: optionalRepeatStats(observations.map((o) => o.cacheWriteTokens)),
      cost: optionalRepeatStats(observations.map((o) => o.cost)),
      uncachedInput: buildRepeatStats(uncachedValues),
      promptTokens: promptValues.length > 0 ? buildRepeatStats(promptValues) : undefined,
      cacheHitRate: cacheHitValues.length > 0 ? buildRepeatStats(cacheHitValues) : undefined,
      privacyPassCount,
      privacyPassRate: privacyPassCount / repeats,
      privacyAllPassed: privacyPassCount === repeats,
      allRoutingPassed,
      allOutcomePassed,
      allLatencyPassed,
      metricCoverage,
    });
  }

  // Observation-level pass rates across all scenario-repeat observations.
  let totalObservations = 0;
  let routingPassedCount = 0;
  let outcomePassedCount = 0;
  let privacyPassedCount = 0;
  for (let si = 0; si < scenarioResults.length; si++) {
    const scenario = scenarios[si]!;
    for (const obs of scenarioResults[si]!.repeats) {
      totalObservations++;
      const eval_ = evaluateScenario(obs, scenario);
      if (eval_.routingPassed) routingPassedCount++;
      if (eval_.outcomePassed) outcomePassedCount++;
      if (eval_.privacyPassed) privacyPassedCount++;
    }
  }
  const observationCount = Math.max(1, totalObservations);
  const routingAccuracy = routingPassedCount / observationCount;
  const outcomePassRate = outcomePassedCount / observationCount;
  const privacyPassRate = privacyPassedCount / observationCount;
  // Aggregate p95 across all observations
  const allLatencies = scenarioResults.flatMap((r) => r.repeats.map((o) => o.latencyMs));
  const allObservations = scenarioResults.flatMap((r) => r.repeats);
  const cacheObservations = allObservations.filter(
    (o) => typeof o.cacheReadTokens === "number" && typeof o.cacheWriteTokens === "number",
  );
  const totalCacheReadTokens = cacheObservations.length > 0
    ? cacheObservations.reduce((sum, o) => sum + (o.cacheReadTokens ?? 0), 0)
    : undefined;
  const totalCacheWriteTokens = cacheObservations.length > 0
    ? cacheObservations.reduce((sum, o) => sum + (o.cacheWriteTokens ?? 0), 0)
    : undefined;
  const totalPromptTokens = cacheObservations.length > 0
    ? cacheObservations.reduce(
      (sum, o) => sum + o.inputTokens + (o.cacheReadTokens ?? 0) + (o.cacheWriteTokens ?? 0),
      0,
    )
    : undefined;
  const cacheHitRate = totalPromptTokens !== undefined && totalPromptTokens > 0
    ? (totalCacheReadTokens ?? 0) / totalPromptTokens
    : undefined;

  // Only include totalCost when at least one observation supplied cost data.
  const allCosts = scenarioResults.flatMap((r) => r.repeats.map((o) => o.cost).filter((c): c is number => c !== undefined));
  const totalCost = allCosts.length > 0 ? allCosts.reduce((s, c) => s + c, 0) : undefined;

  return {
    schemaVersion: 1,
    model,
    generatedAt: new Date().toISOString(),
    repeats,
    results: scenarioResults,
    routingAccuracy,
    outcomePassRate,
    privacyPassRate,
    privacyGate: privacyPassRate >= 0.9,
    p95LatencyMs: percentile95(allLatencies),
    totalInputTokens: scenarioResults.reduce((s, r) => s + r.repeats.reduce((ts, o) => ts + o.inputTokens, 0), 0),
    totalOutputTokens: scenarioResults.reduce((s, r) => s + r.repeats.reduce((ts, o) => ts + o.outputTokens, 0), 0),
    ...(totalCacheReadTokens !== undefined ? { totalCacheReadTokens } : {}),
    ...(totalCacheWriteTokens !== undefined ? { totalCacheWriteTokens } : {}),
    ...(totalPromptTokens !== undefined ? { totalPromptTokens } : {}),
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
    cacheMetricCoverage: cacheObservations.length,
    ...(totalCost !== undefined ? { totalCost } : {}),
    passed: routingAccuracy >= 0.9 && outcomePassRate >= 0.9 && privacyPassRate >= 0.9 && scenarioResults.every((r) => r.allLatencyPassed),
  };
}

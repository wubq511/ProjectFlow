import { provisionObservationFixture } from "../fixture-provisioner.js";
import {
  createHttpPublicSeamRunner,
  type PublicSeamIdentity,
} from "../http-public-seam-runner.js";
import type { AgentScenario } from "../scenario-eval.js";
import { EvaluationArtifactStore } from "./artifact-store.js";
import type {
  CostLedgerEntry,
  EvaluationArtifact,
  EvaluationBudget,
  EvaluationProvenance,
  Grade,
  RunManifest,
  ScenarioContract,
  ScenarioObservation,
} from "./contract.js";
import { EVALUATION_SCHEMA_VERSION } from "./contract.js";
import type { EvidenceSnapshot } from "./contract-v2.js";
import {
  EvaluationBudgetError,
  EvaluationInfrastructureError,
  EvaluationValidationError,
} from "./errors.js";
import { fetchEvidenceSnapshot } from "./evidence-client.js";
import { gradeHard } from "./hard-graders.js";
import { attachHardGrade, gradeObservation } from "./grader.js";
import { IsolatedProcessPair } from "./isolation.js";
import { buildProvenance, sha256, validateEvaluationConfig } from "./validation.js";
import {
  T46_3_CONTROLLER_FACTS,
  T46_3_SKILL_CONTRACTS,
  T46_3_VERSION,
  SMOKE_V2_REFERENCE_PROGRAMS,
  SMOKE_V2_SCENARIOS,
} from "./presets.js";
import { UserController } from "./user-controller.js";
import { createAttemptLedger, retryCounts, verifyLedgerInvariants } from "./attempt-ledger.js";
import { evaluateSkill } from "./skill-evaluator.js";
import { evaluateFaultBehavior, findFault } from "./runtime-faults.js";
import { computeReliabilityReport, type ReliabilityTrial } from "./reliability-stats.js";
import { aggregateSideMetrics } from "./paired-comparison.js";
import type {
  EvaluationArtifactV3,
  MultiTurnEpisodeRecord,
  OperationalMetrics,
  RuntimeReliabilityResult,
  SkillEvaluationResult,
  Slice1AcceptanceEvidence,
} from "./contract-v3.js";
import type { HardGraderInput } from "./hard-graders.js";
import { runReferenceProgram } from "./reference-program.js";

const DEFAULT_WORKSPACE_ID = "demo-workspace-001";
const DEFAULT_PROJECT_ID = "demo-project-001";
const DEFAULT_VIEWER_USER_ID = "demo-user-001";
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export { EvaluationInfrastructureError as InfrastructureError } from "./errors.js";

export interface RunEvaluationOptions {
  projectRoot: string;
  runId: string;
  preset: string;
  model: string;
  scenarios: ScenarioContract[];
  budget: EvaluationBudget;
  resume: boolean;
  onPairStarted?: (metadata: {
    backendPort: number;
    sidecarPort: number;
    nonce: string;
    instanceId: string;
    databasePath: string;
    tempRoot: string;
    artifactStagingDir: string;
    resolvedModel: IsolatedProcessPair["resolvedModel"];
  }) => void;
  onProgress?: (
    scenarioId: string,
    status: "started" | "completed",
    result?: { observation: ScenarioObservation; grade: Grade },
  ) => void;
}

function knownZeroCost(source: CostLedgerEntry["source"] = "versioned_price_estimate"): CostLedgerEntry {
  return { amountUsd: 0, source, countedAgainstSutCap: false };
}

function externalCodingAgentCost(): CostLedgerEntry {
  return { amountUsd: null, source: "unknown", countedAgainstSutCap: false };
}

function publicScenario(
  scenario: ScenarioContract,
  prompt = scenario.visible.prompt,
  evaluationFault?: AgentScenario["evaluationFault"],
): AgentScenario {
  return {
    id: scenario.scenarioId,
    prompt,
    expectedMode: scenario.hidden.expectedMode,
    expectedSkill: scenario.hidden.expectedSkill,
    requiredEvidence: scenario.hidden.requiredEvidence ?? [],
    requiredAnyEvidence: scenario.hidden.requiredAnyEvidence ?? [],
    forbiddenOutputPatterns: (scenario.hidden.forbiddenOutputPatterns ?? []).map((pattern) => new RegExp(pattern, "i")),
    forbidRawIds: scenario.hidden.forbidRawIds,
    maxLatencyMs: scenario.hidden.maxLatencyMs,
    maxInputTokens: scenario.hidden.tokenBudget.maxInputTokens,
    maxOutputTokens: scenario.hidden.tokenBudget.maxOutputTokens,
    maxRequestCount: scenario.hidden.maxRequestCount,
    evaluationFault,
  };
}

function toOperationalMetrics(
  observation: ScenarioObservation,
  snapshot: EvidenceSnapshot | null,
  attempts: { infrastructureAttempts: number; agentRetries: number },
  overrides: Partial<OperationalMetrics> = {},
): OperationalMetrics {
  return {
    scenarioId: observation.scenarioId,
    latencyMs: observation.latencyMs,
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    reasoningTokens: observation.reasoningTokens,
    cacheReadTokens: observation.cacheReadTokens,
    cacheWriteTokens: observation.cacheWriteTokens,
    sutCostUsd: observation.costs.sutCost.amountUsd ?? 0,
    evaluatorModelCostUsd: observation.costs.evaluatorModelCost.amountUsd ?? undefined,
    codingAgentCostUsd: observation.costs.codingAgentCost.amountUsd,
    toolCalls: snapshot?.trajectory_facts.filter(
      (fact) => fact.event_type === "tool.started" && fact.tool_name !== null,
    ).length
      ?? observation.evidence.length,
    agentRetries: attempts.agentRetries,
    infrastructureAttempts: attempts.infrastructureAttempts,
    timeouts: 0,
    skipped: 0,
    excluded: 0,
    simulatorErrors: 0,
    infrastructureErrors: 0,
    ...overrides,
  };
}

function hasNonEmptyKey(value: unknown, targetKey: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasNonEmptyKey(item, targetKey));
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === targetKey && child !== null && child !== undefined && child !== "") return true;
    if (hasNonEmptyKey(child, targetKey)) return true;
  }
  return false;
}

/** Portable artifacts keep only commitments to evaluator-owned hidden
 * sentinels. Raw tokens remain in memory for grading and are never written. */
export function sanitizeScenariosForArtifact(scenarios: ScenarioContract[]): ScenarioContract[] {
  return scenarios.map((scenario) => {
    const clone = structuredClone(scenario);
    const privacy = clone.hardGrader?.privacy;
    const tokens = privacy?.hiddenFieldTokens;
    if (privacy && tokens?.length) {
      privacy.hiddenFieldTokenDigests = tokens.map((token) => sha256(token));
      delete privacy.hiddenFieldTokens;
    }
    return clone;
  });
}

function sumKnownCosts(entries: CostLedgerEntry[], countedAgainstSutCap: boolean): CostLedgerEntry {
  if (entries.some((entry) => entry.amountUsd === null || entry.source === "unknown")) {
    return { amountUsd: null, source: "unknown", countedAgainstSutCap };
  }
  const amountUsd = entries.reduce((sum, entry) => sum + (entry.amountUsd ?? 0), 0);
  const source = entries.every((entry) => entry.source === "provider_reported")
    ? "provider_reported"
    : "versioned_price_estimate";
  return { amountUsd, source, countedAgainstSutCap };
}

function consumed(observations: ScenarioObservation[]) {
  return {
    sutCostUsd: observations.reduce((sum, observation) => {
      const amount = observation.costs.sutCost.amountUsd;
      if (amount === null) {
        throw new EvaluationInfrastructureError("已有 checkpoint 的 SUT 成本未知，拒绝恢复");
      }
      return sum + amount;
    }, 0),
    inputTokens: observations.reduce((sum, observation) => sum + observation.inputTokens, 0),
    outputTokens: observations.reduce((sum, observation) => sum + observation.outputTokens, 0),
    requestCount: observations.reduce((sum, observation) => sum + observation.requestCount, 0),
    wallTimeMs: observations.reduce((sum, observation) => sum + observation.latencyMs, 0),
  };
}

function findBudgetExhaustion(
  observations: ScenarioObservation[],
  budget: EvaluationBudget,
  beforeNewObservation: boolean,
): string | undefined {
  const usage = consumed(observations);
  const costExceeded = beforeNewObservation
    ? usage.sutCostUsd >= budget.maxSutCostUsd
    : usage.sutCostUsd > budget.maxSutCostUsd;
  if (costExceeded) return `ProjectFlow Agent 成本 $${usage.sutCostUsd.toFixed(6)} 达到 smoke 上限 $${budget.maxSutCostUsd}`;
  if (beforeNewObservation ? usage.inputTokens >= budget.maxInputTokens : usage.inputTokens > budget.maxInputTokens) {
    return `输入 Token ${usage.inputTokens} 达到上限 ${budget.maxInputTokens}`;
  }
  if (beforeNewObservation ? usage.outputTokens >= budget.maxOutputTokens : usage.outputTokens > budget.maxOutputTokens) {
    return `输出 Token ${usage.outputTokens} 达到上限 ${budget.maxOutputTokens}`;
  }
  if (beforeNewObservation ? usage.requestCount >= budget.maxRequestCount : usage.requestCount > budget.maxRequestCount) {
    return `模型请求数 ${usage.requestCount} 达到上限 ${budget.maxRequestCount}`;
  }
  if (beforeNewObservation ? usage.wallTimeMs >= budget.maxWallTimeMs : usage.wallTimeMs > budget.maxWallTimeMs) {
    return `SUT wall-time ${usage.wallTimeMs}ms 达到上限 ${budget.maxWallTimeMs}ms`;
  }
  if (beforeNewObservation && observations.length >= budget.maxObservations) {
    return `已达到最大 observation 数量 ${budget.maxObservations}`;
  }
  return undefined;
}

export function buildBudgetCheckpoint(scenario: ScenarioContract, error: EvaluationBudgetError): {
  observation: ScenarioObservation;
  grade: Grade;
} {
  const observation: ScenarioObservation = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId: scenario.scenarioId,
    timestamp: new Date().toISOString(),
    routedMode: scenario.hidden.expectedMode,
    selectedSkills: [],
    evidence: [],
    terminalStatus: "blocked",
    latencyMs: error.usage?.latencyMs ?? scenario.hidden.maxLatencyMs,
    inputTokens: error.usage?.inputTokens ?? 0,
    outputTokens: error.usage?.outputTokens ?? 0,
    requestCount: error.usage?.requestCount ?? 0,
    costs: {
      sutCost: error.usage?.cost === undefined
        ? { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true }
        : { amountUsd: error.usage.cost, source: "provider_reported", countedAgainstSutCap: true },
      evaluatorModelCost: knownZeroCost(),
      codingAgentCost: externalCodingAgentCost(),
    },
    output: error.usage?.output ?? "评测因预算边界停止，未形成可评分的 Agent 输出。",
  };
  const grade: Grade = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId: scenario.scenarioId,
    passed: false,
    routingPassed: false,
    outcomePassed: false,
    latencyPassed: false,
    privacyPassed: true,
    budgetPassed: false,
    failures: [error.message],
  };
  return { observation, grade };
}

/**
 * T46-2 (Issue #95) — Run hard graders for a scenario if it declares a
 * `hardGrader` block.
 *
 * Fetches the primary (and optionally adversary) evidence snapshots after
 * the Agent run, then calls {@link gradeHard}. Returns null when the
 * scenario has no `hardGrader` block (Slice 0 scenarios bypass V2 grading).
 *
 * The observation's `runId` (captured from the SSE `status` event by the
 * public seam runner) is propagated to `fetchEvidenceSnapshot`. Without it,
 * the backend short-circuits run-scoped facts (trajectory_facts,
 * side_effect_facts, metric_facts, context_receipt_facts) to empty/null,
 * which would let authority and trajectory violations pass undetected.
 *
 * Idempotency repeats are NOT run here by default — the runner does not
 * re-invoke the public seam automatically. Tests that need idempotency
 * verification must call {@link gradeHard} directly with repeat data.
 * The idempotency grader fails closed when `oracle.idempotency` is
 * declared but no repeats are provided, which surfaces the missing
 * evidence rather than silently skipping the check.
 */
async function gradeHardForScenario(
  scenario: ScenarioContract,
  observation: ScenarioObservation,
  pair: IsolatedProcessPair,
  conversationId: string,
  beforeSnapshot: EvidenceSnapshot | null,
  preHumanActionSnapshot: EvidenceSnapshot | null,
): Promise<import("./contract-v2.js").HardGrade | null> {
  const hg = scenario.hardGrader;
  if (!hg) return null;

  const primarySnapshot = await fetchEvidenceSnapshot(
    {
      backendBaseUrl: pair.backendUrl,
      internalServiceToken: pair.internalServiceToken,
      evaluationNonce: pair.nonce,
      evaluationInstanceId: pair.instanceId,
    },
    {
      workspaceId: DEFAULT_WORKSPACE_ID,
      viewerUserId: hg.viewer.primaryUserId,
      projectId: DEFAULT_PROJECT_ID,
      conversationId,
      runId: observation.runId,
      hiddenFieldTokens: hg.privacy?.hiddenFieldTokens,
    },
  );

  let adversarySnapshot: EvidenceSnapshot | null = null;
  if (hg.viewer.adversaryUserId) {
    adversarySnapshot = await fetchEvidenceSnapshot(
      {
        backendBaseUrl: pair.backendUrl,
        internalServiceToken: pair.internalServiceToken,
        evaluationNonce: pair.nonce,
        evaluationInstanceId: pair.instanceId,
      },
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        viewerUserId: hg.viewer.adversaryUserId,
        projectId: DEFAULT_PROJECT_ID,
        // A run and its private conversation are owned by the primary
        // viewer. The adversary snapshot intentionally observes only its
        // own viewer-scoped project facts; binding it to the primary run
        // would either leak or (correctly) fail 404.
      },
    );
  }

  return gradeHard({
    oracle: hg,
    observation,
    primarySnapshot,
    adversarySnapshot,
    beforeSnapshot,
    preHumanActionSnapshot,
  });
}

async function performHumanAction(
  scenario: ScenarioContract,
  pair: IsolatedProcessPair,
  snapshot: EvidenceSnapshot,
): Promise<void> {
  const action = scenario.hidden.humanAction;
  if (!action) return;
  const pending = [...snapshot.proposal_facts]
    .reverse()
    .find((proposal) => proposal.proposal_type === action.proposalType && proposal.status === "pending");
  if (!pending) {
    throw new EvaluationInfrastructureError(
      `公共人工操作失败: 未找到 pending ${action.proposalType} proposal`,
    );
  }
  const body = action.action === "confirm"
    ? { confirmed_by: action.actorUserId }
    : { reason: action.reason };
  const response = await fetch(
    `${pair.backendUrl}/api/agent-proposals/${encodeURIComponent(pending.proposal_id)}/${action.action}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Evaluation-Nonce": pair.nonce,
        "X-Evaluation-Instance-Id": pair.instanceId,
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new EvaluationInfrastructureError(`公共人工操作失败: HTTP ${response.status}`);
  }
}

interface ExecutedScenarioTurn {
  observation: ScenarioObservation;
  baseGrade: Grade;
  grade: Grade;
  preHumanActionSnapshot: EvidenceSnapshot | null;
  finalSnapshot: EvidenceSnapshot | null;
}

async function executeScenarioTurn(input: {
  scenario: ScenarioContract;
  prompt?: string;
  pair: IsolatedProcessPair;
  identity: PublicSeamIdentity;
  beforeSnapshot: EvidenceSnapshot | null;
  remainingSutCostUsd: number;
  performConfiguredHumanAction?: boolean;
  evaluationFault?: AgentScenario["evaluationFault"];
  fetchFn?: typeof fetch;
}): Promise<ExecutedScenarioTurn> {
  const { scenario, pair, identity } = input;
  const publicRunner = createHttpPublicSeamRunner({
    baseUrl: pair.sidecarUrl,
    identity,
    evaluationAuth: { nonce: pair.nonce, instanceId: pair.instanceId },
    fetchFn: input.fetchFn,
  });
  const executable = publicScenario(scenario, input.prompt, input.evaluationFault);
  executable.maxSutCostUsd = input.remainingSutCostUsd;
  const result = await publicRunner(executable, `${pair.resolvedModel?.provider ?? "mock"}:${pair.resolvedModel?.name ?? "mock-model"}`);

  const afterStateResponse = await fetch(
    `${pair.backendUrl}/api/workspaces/${DEFAULT_WORKSPACE_ID}/state`,
    {
      headers: {
        "X-ProjectFlow-Admin-Token": pair.adminToken,
        "X-Evaluation-Nonce": pair.nonce,
        "X-Evaluation-Instance-Id": pair.instanceId,
      },
    },
  );
  if (!afterStateResponse.ok) {
    throw new EvaluationInfrastructureError(`获取运行后状态失败: HTTP ${afterStateResponse.status}`);
  }
  const afterState = await afterStateResponse.json() as Record<string, unknown>;
  const sutCost: CostLedgerEntry = result.cost === undefined
    ? { amountUsd: 0, source: "versioned_price_estimate", countedAgainstSutCap: true }
    : { amountUsd: result.cost, source: "provider_reported", countedAgainstSutCap: true };
  const observation: ScenarioObservation = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    scenarioId: scenario.scenarioId,
    timestamp: new Date().toISOString(),
    routedMode: result.routedMode,
    selectedSkills: result.selectedSkills,
    evidence: result.evidence,
    terminalStatus: result.terminalStatus,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    reasoningTokens: result.reasoningTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    requestCount: result.requestCount ?? 0,
    costs: {
      sutCost,
      evaluatorModelCost: knownZeroCost(),
      codingAgentCost: externalCodingAgentCost(),
    },
    output: result.output ?? "",
    ...(result.runId !== undefined ? { runId: result.runId } : {}),
    ...(result.runtimeEvidence !== undefined ? { runtimeEvidence: result.runtimeEvidence } : {}),
  };
  const baseGrade = gradeObservation(scenario, observation, identity.workspaceState, afterState);

  let preHumanActionSnapshot: EvidenceSnapshot | null = null;
  let finalSnapshot: EvidenceSnapshot | null = null;
  if (scenario.hardGrader || scenario.hidden.v3) {
    const viewerUserId = scenario.hardGrader?.viewer.primaryUserId ?? DEFAULT_VIEWER_USER_ID;
    preHumanActionSnapshot = await fetchEvidenceSnapshot(
      {
        backendBaseUrl: pair.backendUrl,
        internalServiceToken: pair.internalServiceToken,
        evaluationNonce: pair.nonce,
        evaluationInstanceId: pair.instanceId,
      },
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        viewerUserId,
        projectId: DEFAULT_PROJECT_ID,
        conversationId: identity.conversationId,
        runId: observation.runId,
        hiddenFieldTokens: scenario.hardGrader?.privacy?.hiddenFieldTokens,
      },
    );
    if (input.performConfiguredHumanAction !== false) {
      await performHumanAction(scenario, pair, preHumanActionSnapshot);
    }
    finalSnapshot = await fetchEvidenceSnapshot(
      {
        backendBaseUrl: pair.backendUrl,
        internalServiceToken: pair.internalServiceToken,
        evaluationNonce: pair.nonce,
        evaluationInstanceId: pair.instanceId,
      },
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        viewerUserId,
        projectId: DEFAULT_PROJECT_ID,
        conversationId: identity.conversationId,
        runId: observation.runId,
        hiddenFieldTokens: scenario.hardGrader?.privacy?.hiddenFieldTokens,
      },
    );
  }

  const grade = await gradeHardForScenario(
    scenario,
    observation,
    pair,
    identity.conversationId,
    input.beforeSnapshot,
    preHumanActionSnapshot,
  ).then((hardGrade) => hardGrade ? attachHardGrade(baseGrade, hardGrade) : baseGrade);
  return { observation, baseGrade, grade, preHumanActionSnapshot, finalSnapshot };
}

function actualMutationEvidence(input: {
  scenarios: ScenarioContract[];
  observations: ScenarioObservation[];
  finalSnapshots: Map<string, EvidenceSnapshot>;
  beforeSnapshots: Map<string, EvidenceSnapshot>;
  preHumanActionSnapshots: Map<string, EvidenceSnapshot>;
}): Slice1AcceptanceEvidence["p0Mutations"] {
  const observationById = new Map(input.observations.map((observation) => [observation.scenarioId, observation]));
  const results: Slice1AcceptanceEvidence["p0Mutations"] = [];
  const evaluate = (
    id: string,
    targets: string,
    baseline: HardGraderInput,
    mutate: (value: HardGraderInput) => void,
  ) => {
    const baselinePassed = gradeHard(baseline).passed;
    const mutated = structuredClone(baseline);
    mutate(mutated);
    results.push({ mutationId: id, detected: baselinePassed && !gradeHard(mutated).passed, targets });
  };

  for (const scenario of input.scenarios) {
    const oracle = scenario.hardGrader;
    const observation = observationById.get(scenario.scenarioId);
    const primarySnapshot = input.finalSnapshots.get(scenario.scenarioId);
    if (!oracle || !observation || !primarySnapshot) continue;
    const baseline: HardGraderInput = {
      oracle,
      observation,
      primarySnapshot,
      adversarySnapshot: null,
      beforeSnapshot: input.beforeSnapshots.get(scenario.scenarioId) ?? null,
      preHumanActionSnapshot: input.preHumanActionSnapshots.get(scenario.scenarioId) ?? null,
    };
    if (oracle.run) {
      evaluate(`${scenario.scenarioId}:terminal-status`, "finalOutcome", baseline, (mutated) => {
        mutated.observation.terminalStatus = oracle.run!.finalStatus === "completed" ? "failed" : "completed";
      });
    }
    if (oracle.milestoneDag?.nodes.length) {
      const node = oracle.milestoneDag.nodes[0]!;
      evaluate(`${scenario.scenarioId}:missing-milestone`, "milestoneDag", baseline, (mutated) => {
        mutated.primarySnapshot.trajectory_facts = mutated.primarySnapshot.trajectory_facts.filter((fact) =>
          node.kind === "tool" ? fact.tool_name !== node.value : fact.event_type !== node.value);
        mutated.primarySnapshot.side_effect_facts = mutated.primarySnapshot.side_effect_facts.filter((fact) =>
          node.kind !== "tool" || fact.tool_name !== node.value);
      });
    }
    const requiredProposals = oracle.authoritySafety?.proposalConfirm?.required;
    if (requiredProposals?.length) {
      const required = requiredProposals[0]!;
      evaluate(`${scenario.scenarioId}:missing-proposal`, "proposalConfirm", baseline, (mutated) => {
        mutated.primarySnapshot.proposal_facts = mutated.primarySnapshot.proposal_facts.filter((proposal) =>
          proposal.proposal_type !== required.proposalType || proposal.status !== required.status);
      });
    }
    if (oracle.authoritySafety?.unknownSideEffects === "fail_closed") {
      evaluate(`${scenario.scenarioId}:unknown-side-effect`, "unknownSideEffects", baseline, (mutated) => {
        mutated.primarySnapshot.side_effect_facts.push({
          tool_call_id: "mutation-unknown-side-effect",
          status: "completed",
          effect_type: "unknown_mutation",
          tool_name: "unknown_mutation_tool",
        });
      });
    }
    if (oracle.privacy?.hiddenFieldTokens?.length) {
      const token = oracle.privacy.hiddenFieldTokens[0]!;
      evaluate(`${scenario.scenarioId}:hidden-field-leak`, "hiddenFieldLeakage", baseline, (mutated) => {
        mutated.observation.output = `${mutated.observation.output} ${token}`;
      });
    }
    if (oracle.privacy?.forbidRawIdsInOutput) {
      evaluate(`${scenario.scenarioId}:raw-id-leak`, "rawIdLeakage", baseline, (mutated) => {
        mutated.observation.output = `${mutated.observation.output} 123e4567-e89b-12d3-a456-426614174000`;
      });
    }
    if (oracle.run) {
      evaluate(`${scenario.scenarioId}:duplicate-terminal`, "terminalEventConsistency", baseline, (mutated) => {
        const lastSeq = Math.max(0, ...mutated.primarySnapshot.trajectory_facts.map((fact) => fact.event_seq));
        mutated.primarySnapshot.trajectory_facts.push({
          event_type: oracle.run!.finalStatus === "completed" ? "agent.completed" : "agent.failed",
          event_seq: lastSeq + 1,
          tool_name: null,
          created_at: "2026-01-01T00:00:00.000Z",
        });
      });
    }
  }
  return results;
}

async function actualReferenceEvidence(
  pair: IsolatedProcessPair,
  model: string,
  maxSutCostUsd: number,
): Promise<Slice1AcceptanceEvidence["referencePrograms"]> {
  const results: Slice1AcceptanceEvidence["referencePrograms"] = [];
  for (const scenario of SMOKE_V2_SCENARIOS) {
    const reference = SMOKE_V2_REFERENCE_PROGRAMS[scenario.scenarioId];
    if (!reference || !scenario.hardGrader) continue;
    const result = await runReferenceProgram(reference, scenario.hardGrader, {
      backendBaseUrl: pair.backendUrl,
      sidecarBaseUrl: pair.sidecarUrl,
      adminToken: pair.adminToken,
      internalServiceToken: pair.internalServiceToken,
      evaluationNonce: pair.nonce,
      evaluationInstanceId: pair.instanceId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId: DEFAULT_PROJECT_ID,
      model,
      maxLatencyMs: scenario.hidden.maxLatencyMs,
      maxInputTokens: scenario.hidden.tokenBudget.maxInputTokens,
      maxOutputTokens: scenario.hidden.tokenBudget.maxOutputTokens,
      maxRequestCount: scenario.hidden.maxRequestCount,
      maxSutCostUsd,
    });
    results.push({
      programId: reference.id,
      hardFalseFailures: result.hardGrade.passed ? 0 : result.hardGrade.failures.length || 1,
    });
  }
  return results;
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationArtifact> {
  if (!SAFE_ID.test(options.runId)) {
    throw new EvaluationValidationError("运行 ID 只能包含字母、数字、下划线和连字符");
  }
  const validation = await validateEvaluationConfig({
    projectRoot: options.projectRoot,
    model: options.model,
    scenarios: options.scenarios,
    budget: options.budget,
    preset: options.preset,
  });
  if (!validation.valid) {
    throw new EvaluationValidationError(JSON.stringify(validation));
  }

  let provenance: EvaluationProvenance;
  try {
    provenance = await buildProvenance({
      projectRoot: options.projectRoot,
      scenarios: options.scenarios,
    });
  } catch (error) {
    throw new EvaluationInfrastructureError(`无法生成代码与配置来源指纹: ${(error as Error).message}`, { cause: error });
  }
  const manifest: RunManifest = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId: options.runId,
    preset: options.preset,
    model: options.model,
    createdAt: new Date().toISOString(),
    scenarios: sanitizeScenariosForArtifact(options.scenarios),
    budget: options.budget,
    provenance,
    ...(options.scenarios.some((scenario) => scenario.hidden.v3)
      ? {
          v3: {
            version: T46_3_VERSION,
            controllerFactsDigests: Object.fromEntries(
              options.scenarios.flatMap((scenario) => {
                const controllerId = scenario.hidden.v3?.controllerId;
                const facts = controllerId ? T46_3_CONTROLLER_FACTS[scenario.scenarioId] : undefined;
                return facts
                  ? [[scenario.scenarioId, new UserController({ facts, maxTurns: scenario.hidden.v3?.controllerMaxTurns ?? 4 }).hiddenFactsDigests()] as const]
                  : [];
              }),
            ),
            skillContractIds: [...new Set(options.scenarios.flatMap((scenario) =>
              scenario.hidden.v3?.skillContractId ? [scenario.hidden.v3.skillContractId] : []))].sort(),
            runtimeFaultIds: [...new Set(options.scenarios.flatMap((scenario) =>
              scenario.hidden.v3?.runtimeFaultId ? [scenario.hidden.v3.runtimeFaultId] : []))].sort(),
          },
        }
      : {}),
  };

  const pair = new IsolatedProcessPair();
  let store: EvaluationArtifactStore | undefined;
  let checkpoint: Awaited<ReturnType<EvaluationArtifactStore["initialize"]>> | undefined;
  let executionError: Error | undefined;

  try {
    await pair.start(options.projectRoot, options.model);
    options.onPairStarted?.({
      backendPort: pair.backendPort,
      sidecarPort: pair.sidecarPort,
      nonce: pair.nonce,
      instanceId: pair.instanceId,
      databasePath: `${pair.tempRoot}/projectflow_eval.sqlite`,
      tempRoot: pair.tempRoot,
      artifactStagingDir: `${pair.tempRoot}/artifacts/${options.runId}`,
      resolvedModel: pair.resolvedModel,
    });
    store = new EvaluationArtifactStore(options.projectRoot, options.runId, pair.tempRoot);
    checkpoint = await store.initialize(manifest, options.resume);
  } catch (error) {
    executionError = error instanceof Error ? error : new Error(String(error));
  }

  if (!executionError && checkpoint?.completedArtifact) {
    try {
      await pair.destroy();
    } catch (error) {
      executionError = new EvaluationInfrastructureError(`恢复已完成报告时清理沙箱失败: ${(error as Error).message}`);
    }
    await store?.writeStatus(
      checkpoint.completedArtifact.status,
      checkpoint.completedArtifact.observations.map((observation) => observation.scenarioId),
    );
    await store?.releaseLock();
    if (executionError) throw executionError;
    return checkpoint.completedArtifact;
  }

  const observations = checkpoint
    ? options.scenarios.flatMap((scenario) => {
      const observation = checkpoint!.observations.get(scenario.scenarioId);
      return observation ? [observation] : [];
    })
    : [];
  const grades = checkpoint
    ? options.scenarios.flatMap((scenario) => {
      const grade = checkpoint!.grades.get(scenario.scenarioId);
      return grade ? [grade] : [];
    })
    : [];
  let budgetStopMessage: string | undefined;
  const attemptRecorder = createAttemptLedger();
  const multiTurnEpisodes: MultiTurnEpisodeRecord[] = [];
  const skillEvaluations: SkillEvaluationResult[] = [];
  const runtimeReliability: RuntimeReliabilityResult[] = [];
  const operationalMetrics: OperationalMetrics[] = [];
  const reliabilityTrials: ReliabilityTrial[] = [];
  const finalSnapshots = new Map<string, EvidenceSnapshot>();
  const beforeSnapshots = new Map<string, EvidenceSnapshot>();
  const preHumanActionSnapshots = new Map<string, EvidenceSnapshot>();
  let acceptanceEvidence: Slice1AcceptanceEvidence | undefined;

  if (!executionError && store && checkpoint) {
    try {
      for (const scenario of options.scenarios) {
        if (checkpoint.observations.has(scenario.scenarioId) && checkpoint.grades.has(scenario.scenarioId)) {
          const observation = checkpoint.observations.get(scenario.scenarioId)!;
          const grade = checkpoint.grades.get(scenario.scenarioId)!;
          options.onProgress?.(scenario.scenarioId, "completed", { observation, grade });
          continue;
        }

        budgetStopMessage = findBudgetExhaustion(observations, options.budget, true);
        if (budgetStopMessage) break;
        options.onProgress?.(scenario.scenarioId, "started");

        let identity;
        try {
          identity = await provisionObservationFixture({
            backendBaseUrl: pair.backendUrl,
            workspaceId: DEFAULT_WORKSPACE_ID,
            projectId: DEFAULT_PROJECT_ID,
            viewerUserId: DEFAULT_VIEWER_USER_ID,
            adminToken: pair.adminToken,
            evaluationNonce: pair.nonce,
            evaluationInstanceId: pair.instanceId,
          });
        } catch (error) {
          throw new EvaluationInfrastructureError(`评测夹具准备失败: ${(error as Error).message}`, { cause: error });
        }

        // T46-2: fetch before-snapshot for hard graders that need it
        // (read-only state purity, unchanged state constraints).
        let beforeSnapshot: EvidenceSnapshot | null = null;
        if (scenario.hardGrader || scenario.hidden.v3) {
          try {
            beforeSnapshot = await fetchEvidenceSnapshot(
              {
                backendBaseUrl: pair.backendUrl,
                internalServiceToken: pair.internalServiceToken,
                evaluationNonce: pair.nonce,
                evaluationInstanceId: pair.instanceId,
              },
              {
                workspaceId: DEFAULT_WORKSPACE_ID,
              viewerUserId: scenario.hardGrader?.viewer.primaryUserId ?? DEFAULT_VIEWER_USER_ID,
                projectId: DEFAULT_PROJECT_ID,
              },
            );
            beforeSnapshots.set(scenario.scenarioId, beforeSnapshot);
          } catch (error) {
            throw new EvaluationInfrastructureError(
              `获取 before 证据快照失败: ${(error as Error).message}`,
              { cause: error },
            );
          }
        }

        try {
          const startedAt = new Date().toISOString();
          const remainingSutCostUsd = options.budget.maxSutCostUsd - consumed(observations).sutCostUsd;
          const controllerFacts = scenario.hidden.v3?.controllerId
            ? T46_3_CONTROLLER_FACTS[scenario.scenarioId]
            : undefined;
          const skillContract = scenario.hidden.v3?.skillContractId
            ? T46_3_SKILL_CONTRACTS.find((contract) => contract.id === scenario.hidden.v3?.skillContractId)
            : undefined;
          const runtimeFault = scenario.hidden.v3?.runtimeFaultId
            ? findFault(scenario.hidden.v3.runtimeFaultId)
            : undefined;

          let executed: ExecutedScenarioTurn;
          let finalGrade: Grade;

          if (runtimeFault) {
            const seam = runtimeFault.seam;
            let failedFetchInjected = false;
            const fetchFn: typeof fetch | undefined = seam.kind === "sse_event_drop"
              ? (async (url, init) => {
                  if (!failedFetchInjected && String(url).includes("/runs/stream")) {
                    failedFetchInjected = true;
                    throw new TypeError("评测注入的瞬时连接中断");
                  }
                  return fetch(url, init);
                }) as typeof fetch
              : undefined;
            const evaluationFault: AgentScenario["evaluationFault"] =
              seam.kind === "sse_event_delay"
                ? { kind: seam.kind, delayMs: Math.min(10_000, Math.max(seam.delayMs, scenario.hidden.maxLatencyMs + 100)) }
                : seam.kind === "tool_call_invalid_args" || seam.kind === "tool_call_partial_result"
                  ? { kind: seam.kind, toolName: seam.toolName }
                  : seam.kind === "cancel_signal" || seam.kind === "steering_message"
                    ? { kind: seam.kind, delayMs: 250, controlAfterMs: 10 }
                    : seam.kind === "checkpoint_after_event"
                      ? { kind: seam.kind, toolName: "generate_stage_plan_proposal" }
                    : seam.kind === "force_idempotency_repeat"
                      ? { kind: seam.kind, toolName: "get_workspace_state" }
                    : seam.kind === "sse_duplicate_terminal" || seam.kind === "sse_contradictory_terminal"
                      ? { kind: seam.kind }
                      : undefined;

            let infrastructureAttempts = 1;
            try {
              executed = await executeScenarioTurn({
                scenario,
                pair,
                identity,
                beforeSnapshot,
                remainingSutCostUsd,
                evaluationFault,
                fetchFn,
              });
            } catch (error) {
              if (seam.kind === "sse_event_drop" && failedFetchInjected) {
                attemptRecorder.record({
                  scenarioId: scenario.scenarioId,
                  type: "infrastructure_attempt",
                  startedAt,
                  endedAt: new Date().toISOString(),
                  result: "failed_infrastructure",
                  errorCategory: "connection_reset",
                  errorMessage: "评测注入的瞬时连接中断",
                });
                infrastructureAttempts += 1;
                executed = await executeScenarioTurn({
                  scenario,
                  pair,
                  identity,
                  beforeSnapshot,
                  remainingSutCostUsd,
                });
              } else if (error instanceof EvaluationBudgetError && seam.kind === "sse_event_delay") {
                attemptRecorder.record({
                  scenarioId: scenario.scenarioId,
                  type: "infrastructure_attempt",
                  startedAt,
                  endedAt: new Date().toISOString(),
                  result: "failed_infrastructure",
                  errorCategory: "timeout",
                  errorMessage: error.message,
                });
                const partial = buildBudgetCheckpoint(scenario, error);
                partial.observation.terminalStatus = "failed";
                executed = {
                  observation: partial.observation,
                  baseGrade: partial.grade,
                  grade: partial.grade,
                  preHumanActionSnapshot: null,
                  finalSnapshot: null,
                };
              } else {
                throw error;
              }
            }

            const snapshot = executed.finalSnapshot;
            const toolNames = snapshot?.trajectory_facts
              .flatMap((fact) => fact.event_type === "tool.started" && fact.tool_name ? [fact.tool_name] : []) ?? [];
            const agentRetriesObserved = executed.observation.runtimeEvidence?.repeatedToolCalls
              ?? Math.max(0, toolNames.length - new Set(toolNames).size);
            if (agentRetriesObserved > 0) {
              attemptRecorder.record({
                scenarioId: scenario.scenarioId,
                runId: executed.observation.runId,
                type: "agent_retry",
                startedAt,
                endedAt: new Date().toISOString(),
                result: "succeeded",
              });
            }
            let idempotencyPreserved = beforeSnapshot && snapshot
              ? JSON.stringify(beforeSnapshot.state_facts) === JSON.stringify(snapshot.state_facts)
              : true;
            if (seam.kind === "checkpoint_after_event" && snapshot) {
              const callIds = snapshot.side_effect_facts.map((fact) => fact.tool_call_id);
              idempotencyPreserved &&= callIds.length === new Set(callIds).size;
            }
            if (seam.kind === "force_idempotency_repeat") {
              for (let repeat = 0; repeat < seam.repeats; repeat += 1) {
                const repeated = await executeScenarioTurn({
                  scenario,
                  pair,
                  identity,
                  beforeSnapshot,
                  remainingSutCostUsd,
                  evaluationFault,
                });
                idempotencyPreserved &&= Boolean(
                  snapshot
                  && repeated.finalSnapshot
                  && JSON.stringify(snapshot.state_facts) === JSON.stringify(repeated.finalSnapshot.state_facts),
                );
                executed.observation.latencyMs += repeated.observation.latencyMs;
                executed.observation.inputTokens += repeated.observation.inputTokens;
                executed.observation.outputTokens += repeated.observation.outputTokens;
                executed.observation.requestCount += repeated.observation.requestCount;
              }
            }
            const runtimeEvidence = executed.observation.runtimeEvidence;
            const metrics = toOperationalMetrics(
              executed.observation,
              snapshot,
              { infrastructureAttempts, agentRetries: agentRetriesObserved },
              {
                timeouts: seam.kind === "sse_event_delay" ? 1 : 0,
                infrastructureErrors: seam.kind === "sse_event_drop" ? 1 : 0,
              },
            );
            const runtimeResult = evaluateFaultBehavior({
              fault: runtimeFault,
              finalStatus: executed.observation.terminalStatus,
              sideEffectCount: snapshot?.side_effect_facts.length ?? 0,
              hadDuplicateTerminal: runtimeEvidence?.duplicateTerminal ?? false,
              hadContradictoryTerminal: runtimeEvidence?.contradictoryTerminal ?? false,
              idempotencyPreserved,
              agentRetriesObserved,
              infrastructureRetriesObserved: Math.max(0, infrastructureAttempts - 1),
              metrics,
            });
            runtimeReliability.push(runtimeResult);
            if (!runtimeResult.passed && process.env.EVALUATION_DEBUG === "1") {
              process.stderr.write(`${pair.diagnosticTail()}\n`);
            }
            const nonOutcomeFailures = executed.grade.failures.filter(
              (failure) => !failure.startsWith("终端状态错误:"),
            );
            finalGrade = {
              ...executed.grade,
              passed: runtimeResult.passed && (executed.grade.hardGrade?.passed ?? true),
              failures: [
                ...nonOutcomeFailures,
                ...(executed.grade.hardGrade?.failures ?? []),
                ...runtimeResult.failures,
              ],
            };
          } else if (controllerFacts) {
            const controller = new UserController({
              facts: controllerFacts,
              maxTurns: scenario.hidden.v3?.controllerMaxTurns ?? 4,
            });
            executed = await executeScenarioTurn({
              scenario,
              pair,
              identity,
              beforeSnapshot,
              remainingSutCostUsd,
              performConfiguredHumanAction: false,
            });
            const firstControllerTurn = await controller.nextTurn([
              executed.observation.output,
              ...executed.observation.evidence.map((tool) => `tool:${tool}`),
            ].join("\n"));
            let controllerResult = firstControllerTurn;
            let turnCount = 1;
            if (firstControllerTurn.action.kind === "confirm_proposal" || firstControllerTurn.action.kind === "reject_proposal") {
              const actionScenario = structuredClone(scenario);
              actionScenario.hidden.humanAction = {
                action: firstControllerTurn.action.kind === "confirm_proposal" ? "confirm" : "reject",
                proposalType: firstControllerTurn.action.proposalType as "clarify" | "plan" | "breakdown" | "replan",
                actorUserId: DEFAULT_VIEWER_USER_ID,
                ...(firstControllerTurn.action.kind === "reject_proposal"
                  ? { reason: firstControllerTurn.action.reason }
                  : {}),
              };
              if (!executed.preHumanActionSnapshot) {
                throw new EvaluationInfrastructureError("多轮控制器缺少 proposal action 前证据快照");
              }
              await performHumanAction(actionScenario, pair, executed.preHumanActionSnapshot);
              controllerResult = await controller.nextTurn(
                `proposal:${firstControllerTurn.action.proposalType}:${firstControllerTurn.action.kind === "confirm_proposal" ? "confirmed" : "rejected"}`,
              );
            }
            if (!controllerResult.terminal && controllerResult.action.kind === "send_message") {
              const followupScenario = structuredClone(scenario);
              followupScenario.hidden.expectedMode = "answer";
              delete followupScenario.hidden.expectedSkill;
              followupScenario.hidden.requiredEvidence = [];
              delete followupScenario.hardGrader;
              const followup = await executeScenarioTurn({
                scenario: followupScenario,
                prompt: controllerResult.userMessage,
                pair,
                identity,
                beforeSnapshot: null,
                remainingSutCostUsd,
              });
              turnCount += 1;
              controllerResult = await controller.nextTurn(followup.observation.output);
              executed.observation.latencyMs += followup.observation.latencyMs;
              executed.observation.inputTokens += followup.observation.inputTokens;
              executed.observation.outputTokens += followup.observation.outputTokens;
              executed.observation.requestCount += followup.observation.requestCount;
            }
            executed.finalSnapshot = await fetchEvidenceSnapshot(
              {
                backendBaseUrl: pair.backendUrl,
                internalServiceToken: pair.internalServiceToken,
                evaluationNonce: pair.nonce,
                evaluationInstanceId: pair.instanceId,
              },
              {
                workspaceId: DEFAULT_WORKSPACE_ID,
                viewerUserId: scenario.hardGrader?.viewer.primaryUserId ?? DEFAULT_VIEWER_USER_ID,
                projectId: DEFAULT_PROJECT_ID,
                conversationId: identity.conversationId,
                runId: executed.observation.runId,
                hiddenFieldTokens: scenario.hardGrader?.privacy?.hiddenFieldTokens,
              },
            );
            const hardGrade = await gradeHardForScenario(
              scenario,
              executed.observation,
              pair,
              identity.conversationId,
              beforeSnapshot,
              executed.preHumanActionSnapshot,
            );
            finalGrade = hardGrade ? attachHardGrade(executed.baseGrade, hardGrade) : executed.baseGrade;
            if (!controllerResult.terminal || controllerResult.outcome !== "goal_completed") {
              finalGrade = {
                ...finalGrade,
                passed: false,
                failures: [
                  ...finalGrade.failures,
                  `多轮控制器未完成目标: ${controllerResult.simulatorError ?? controllerResult.outcome ?? "non_terminal"}`,
                ],
              };
            }
            multiTurnEpisodes.push({
              scenarioId: scenario.scenarioId,
              turns: turnCount,
              outcome: controllerResult.outcome ?? "goal_abandoned",
              hiddenSentinelDigests: controllerResult.hiddenSentinelDigests ?? [],
              hadSimulatorError: controllerResult.outcome === "simulator_error",
              finalObservation: executed.observation,
              ...(finalGrade.hardGrade ? { finalHardGrade: finalGrade.hardGrade } : {}),
              ...(executed.finalSnapshot ? { finalSnapshot: executed.finalSnapshot } : {}),
            });
          } else {
            executed = await executeScenarioTurn({
              scenario,
              pair,
              identity,
              beforeSnapshot,
              remainingSutCostUsd,
            });
            finalGrade = executed.grade;
          }

          if (executed.finalSnapshot) finalSnapshots.set(scenario.scenarioId, executed.finalSnapshot);
          if (executed.preHumanActionSnapshot) {
            preHumanActionSnapshots.set(scenario.scenarioId, executed.preHumanActionSnapshot);
          }

          if (skillContract) {
            if (!executed.finalSnapshot) {
              throw new EvaluationInfrastructureError(`Skill 场景 ${scenario.scenarioId} 缺少 final evidence snapshot`);
            }
            const negativeObservations: ScenarioObservation[] = [];
            for (let index = 0; index < skillContract.negativeTriggerPrompts.length; index += 1) {
              const negativeIdentity = await provisionObservationFixture({
                backendBaseUrl: pair.backendUrl,
                workspaceId: DEFAULT_WORKSPACE_ID,
                projectId: DEFAULT_PROJECT_ID,
                viewerUserId: DEFAULT_VIEWER_USER_ID,
                adminToken: pair.adminToken,
                evaluationNonce: pair.nonce,
                evaluationInstanceId: pair.instanceId,
              });
              const negativeScenario = structuredClone(scenario);
              negativeScenario.scenarioId = `${scenario.scenarioId}-negative-${index}`;
              negativeScenario.hidden.expectedMode = "action";
              negativeScenario.hidden.expectedSkill = "project-status";
              negativeScenario.hidden.requiredEvidence = [];
              delete negativeScenario.hidden.humanAction;
              delete negativeScenario.hardGrader;
              const negative = await executeScenarioTurn({
                scenario: negativeScenario,
                prompt: skillContract.negativeTriggerPrompts[index],
                pair,
                identity: negativeIdentity,
                beforeSnapshot: null,
                remainingSutCostUsd,
              });
              negativeObservations.push(negative.observation);
            }
            const prerequisitesSatisfied = skillContract.prerequisites.every((prerequisite) =>
              prerequisite === "has_direction_card"
                ? hasNonEmptyKey(identity.workspaceState, "direction_card")
                : false);
            const skillResult = evaluateSkill({
              contract: skillContract,
              positiveObservation: executed.observation,
              negativeObservations,
              positiveSnapshot: executed.finalSnapshot,
              prerequisitesSatisfied,
              hardGrade: finalGrade.hardGrade,
            });
            skillEvaluations.push(skillResult);
            if (!skillResult.passed) {
              finalGrade = {
                ...finalGrade,
                passed: false,
                failures: [...finalGrade.failures, ...skillResult.failures],
              };
            }
          }

          const completedAttempt = attemptRecorder.record({
            scenarioId: scenario.scenarioId,
            runId: executed.observation.runId,
            type: "infrastructure_attempt",
            startedAt,
            endedAt: new Date().toISOString(),
            result: runtimeFault && executed.observation.terminalStatus === "failed"
              ? runtimeFault.faultClass === "cancellation" ? "cancelled" : "failed_infrastructure"
              : finalGrade.passed ? "succeeded" : "failed_agent",
            inputTokens: executed.observation.inputTokens,
            outputTokens: executed.observation.outputTokens,
            sutCostUsd: executed.observation.costs.sutCost.amountUsd ?? undefined,
          });
          const counts = retryCounts(attemptRecorder.snapshot())[scenario.scenarioId]
            ?? { infrastructureAttempts: 1, agentRetries: 0 };
          const metrics = toOperationalMetrics(
            executed.observation,
            executed.finalSnapshot,
            counts,
            {
              simulatorErrors: multiTurnEpisodes.at(-1)?.scenarioId === scenario.scenarioId
                && multiTurnEpisodes.at(-1)?.hadSimulatorError ? 1 : 0,
            },
          );
          void completedAttempt;
          operationalMetrics.push(metrics);
          reliabilityTrials.push({
            scenarioId: scenario.scenarioId,
            passed: finalGrade.passed,
            excluded: false,
            allInvariantsPassed: finalGrade.hardGrade?.passed ?? finalGrade.passed,
            repeatGroupId: scenario.hidden.v3?.repeatGroupId,
          });

          await store.publishCheckpoint(executed.observation, finalGrade);
          observations.push(executed.observation);
          grades.push(finalGrade);
          options.onProgress?.(scenario.scenarioId, "completed", { observation: executed.observation, grade: finalGrade });
          budgetStopMessage = findBudgetExhaustion(observations, options.budget, false);
          if (budgetStopMessage) break;
        } catch (error) {
          if (error instanceof EvaluationBudgetError) {
            const partial = buildBudgetCheckpoint(scenario, error);
            await store.publishCheckpoint(partial.observation, partial.grade);
            observations.push(partial.observation);
            grades.push(partial.grade);
            options.onProgress?.(scenario.scenarioId, "completed", partial);
            budgetStopMessage = error.message;
            break;
          }
          if (error instanceof EvaluationInfrastructureError) throw error;
          throw new EvaluationInfrastructureError(`公开 HTTP/SSE 行为入口失败: ${(error as Error).message}`, { cause: error });
        }
      }
    } catch (error) {
      executionError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!executionError && options.preset === "full") {
    try {
      const p0Mutations = actualMutationEvidence({
        scenarios: options.scenarios,
        observations,
        finalSnapshots,
        beforeSnapshots,
        preHumanActionSnapshots,
      });
      const referencePrograms = await actualReferenceEvidence(
        pair,
        options.model,
        Math.max(0, options.budget.maxSutCostUsd - consumed(observations).sutCostUsd),
      );
      const portableSurface = JSON.stringify({ manifest, observations, grades });
      const hiddenFieldLeakageTests = options.scenarios.flatMap((scenario) => {
        const tokens = scenario.hardGrader?.privacy?.hiddenFieldTokens ?? [];
        if (tokens.length === 0) return [];
        const grade = grades.find((item) => item.scenarioId === scenario.scenarioId);
        return [{
          testName: `${scenario.scenarioId}:request-context-trace-output-artifact`,
          passed: grade?.hardGrade?.graders.hiddenFieldLeakage === true
            && tokens.every((token) => !portableSurface.includes(token)),
        }];
      });
      for (const episode of multiTurnEpisodes) {
        const facts = T46_3_CONTROLLER_FACTS[episode.scenarioId];
        if (!facts) continue;
        hiddenFieldLeakageTests.push({
          testName: `${episode.scenarioId}:controller-portable-surface`,
          passed: facts.hiddenFacts.every((fact) => !portableSurface.includes(fact))
            && facts.userGoals.every((goal) => !portableSurface.includes(goal))
            && (facts.hiddenSentinels ?? []).every((token) => !portableSurface.includes(token)),
        });
      }
      acceptanceEvidence = {
        p0Mutations,
        referencePrograms,
        hiddenFieldLeakageTests,
        semanticJudgeUsed: false,
      };
    } catch (error) {
      executionError = new EvaluationInfrastructureError(
        `Slice 1 acceptance evidence 生成失败: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  try {
    await pair.destroy();
  } catch (error) {
    executionError = new EvaluationInfrastructureError(`沙箱清理失败: ${(error as Error).message}`, { cause: executionError ?? error });
  }

  if (executionError) {
    if (store) {
      await store.writeStatus(
        "infrastructure_error",
        observations.map((observation) => observation.scenarioId),
        executionError.message,
      ).catch(() => undefined);
      await store.releaseLock();
    }
    if (executionError instanceof EvaluationValidationError) throw executionError;
    if (executionError instanceof EvaluationInfrastructureError) throw executionError;
    throw new EvaluationInfrastructureError(executionError.message, { cause: executionError });
  }
  if (!store || !checkpoint) {
    throw new EvaluationInfrastructureError("评测运行未创建 artifact store");
  }

  const completedAt = new Date().toISOString();
  const passedCount = grades.filter((grade) => grade.passed).length;
  const failedCount = grades.length - passedCount;
  const usage = consumed(observations);
  const status: EvaluationArtifact["status"] = budgetStopMessage
    ? "partial_budget"
    : failedCount > 0 ? "regression" : "completed";
  const attemptLedger = attemptRecorder.snapshot();
  const ledgerViolations = verifyLedgerInvariants(attemptLedger);
  if (ledgerViolations.length > 0) {
    await store.releaseLock();
    throw new EvaluationInfrastructureError(`attempt ledger 不完整: ${ledgerViolations.join("; ")}`);
  }
  const v3: EvaluationArtifactV3 | undefined = manifest.v3
    ? {
        v3Version: T46_3_VERSION,
        multiTurnEpisodes,
        attemptLedger,
        skillEvaluations,
        runtimeReliability,
        reliabilityTrials: reliabilityTrials.map((trial, index) => ({
          ...trial,
          repeatIndex: options.scenarios[index]?.hidden.v3?.repeatIndex,
        })),
        reliabilityReport: computeReliabilityReport(reliabilityTrials, {
          preset: options.preset as "demo" | "smoke" | "smoke-v2" | "full",
        }),
        operationalMetrics: {
          perScenario: operationalMetrics,
          aggregate: aggregateSideMetrics(operationalMetrics),
          paidModelWithoutPriceTable: false,
        },
        ...(acceptanceEvidence ? { acceptanceEvidence } : {}),
      }
    : undefined;
  const baseArtifact: Omit<EvaluationArtifact, "evidenceRootSha256" | "integrityRootSha256"> = {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    runId: options.runId,
    preset: options.preset,
    model: options.model,
    status,
    startedAt: checkpoint.manifest.createdAt,
    completedAt,
    observations,
    grades,
    summary: {
      passedCount,
      failedCount,
      passRate: grades.length > 0 ? passedCount / grades.length : 0,
      sutCost: sumKnownCosts(observations.map((observation) => observation.costs.sutCost), true),
      evaluatorModelCost: sumKnownCosts(observations.map((observation) => observation.costs.evaluatorModelCost), false),
      codingAgentCost: sumKnownCosts(observations.map((observation) => observation.costs.codingAgentCost), false),
      totalInputTokens: usage.inputTokens,
      totalOutputTokens: usage.outputTokens,
      totalRequestCount: usage.requestCount,
      wallTimeMs: usage.wallTimeMs,
    },
    provenance: checkpoint.manifest.provenance,
    artifactPaths: {
      runDirectory: store.relativeRunDir,
      manifest: `${store.relativeRunDir}/manifest.json`,
      report: `${store.relativeRunDir}/report.json`,
      integrity: `${store.relativeRunDir}/integrity.json`,
    },
    ...(v3 ? { v3 } : {}),
  };

  try {
    return await store.finalize(baseArtifact);
  } catch (error) {
    await store.writeStatus("infrastructure_error", observations.map((observation) => observation.scenarioId), (error as Error).message)
      .catch(() => undefined);
    throw error;
  } finally {
    await store.releaseLock();
  }
}

import { provisionObservationFixture } from "../fixture-provisioner.js";
import { createHttpPublicSeamRunner } from "../http-public-seam-runner.js";
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
import { buildProvenance, validateEvaluationConfig } from "./validation.js";

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
        conversationId,
        runId: observation.runId,
      },
    );
  }

  return gradeHard({
    oracle: hg,
    observation,
    primarySnapshot,
    adversarySnapshot,
    beforeSnapshot,
  });
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationArtifact> {
  if (!SAFE_ID.test(options.runId)) {
    throw new EvaluationValidationError("运行 ID 只能包含字母、数字、下划线和连字符");
  }
  const validation = await validateEvaluationConfig(options);
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
    scenarios: options.scenarios,
    budget: options.budget,
    provenance,
  };

  const pair = new IsolatedProcessPair();
  let store: EvaluationArtifactStore | undefined;
  let checkpoint: Awaited<ReturnType<EvaluationArtifactStore["initialize"]>> | undefined;
  let executionError: Error | undefined;

  try {
    await pair.start(options.projectRoot, options.model);
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
        if (scenario.hardGrader) {
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
                viewerUserId: scenario.hardGrader.viewer.primaryUserId,
                projectId: DEFAULT_PROJECT_ID,
              },
            );
          } catch (error) {
            throw new EvaluationInfrastructureError(
              `获取 before 证据快照失败: ${(error as Error).message}`,
              { cause: error },
            );
          }
        }

        try {
          const publicRunner = createHttpPublicSeamRunner({
            baseUrl: pair.sidecarUrl,
            identity,
            evaluationAuth: {
              nonce: pair.nonce,
              instanceId: pair.instanceId,
            },
          });
          const result = await publicRunner({
            id: scenario.scenarioId,
            prompt: scenario.visible.prompt,
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
            maxSutCostUsd: options.budget.maxSutCostUsd - consumed(observations).sutCostUsd,
          }, options.model);

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
            // T46-2: propagate runId from the public seam observation so
            // gradeHardForScenario can pass it to fetchEvidenceSnapshot.
            ...(result.runId !== undefined ? { runId: result.runId } : {}),
          };
          const grade = gradeObservation(scenario, observation, identity.workspaceState, afterState);

          // T46-2: run hard graders when the scenario declares a hardGrader block.
          const finalGrade = await gradeHardForScenario(
            scenario,
            observation,
            pair,
            identity.conversationId,
            beforeSnapshot,
          ).then((hardGrade) => hardGrade ? attachHardGrade(grade, hardGrade) : grade);

          await store.publishCheckpoint(observation, finalGrade);
          observations.push(observation);
          grades.push(finalGrade);
          options.onProgress?.(scenario.scenarioId, "completed", { observation, grade: finalGrade });
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

import { join, resolve } from "node:path";
import { mkdir, writeFile, readFile, readdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { IsolatedProcessPair } from "./isolation.js";
import { provisionObservationFixture } from "../fixture-provisioner.js";
import { createHttpPublicSeamRunner } from "../http-public-seam-runner.js";
import { gradeObservation } from "./grader.js";
import type { ScenarioContract, RunManifest, ScenarioObservation, Grade, EvaluationArtifact } from "./contract.js";

// Standard defaults for ProjectFlow demo workspace/project/viewer
const DEFAULT_WORKSPACE_ID = "demo-workspace-001";
const DEFAULT_PROJECT_ID = "demo-project-001";
const DEFAULT_VIEWER_USER_ID = "demo-user-001";

const MAX_BUDGET_USD = 0.10;

async function writeJsonAtomic(path: string, data: any): Promise<void> {
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tempPath, path);
}

export async function runEvaluation(options: {
  projectRoot: string;
  runId: string;
  model: string;
  scenarios: ScenarioContract[];
  resume: boolean;
  onProgress?: (scenarioId: string, status: "started" | "completed", result?: { observation: ScenarioObservation; grade: Grade }) => void;
}): Promise<EvaluationArtifact> {
  const { projectRoot, runId, model, scenarios, resume, onProgress } = options;

  // Validate runId to prevent path traversal escape (P1)
  if (!/^[a-zA-Z0-9_\-]+$/.test(runId)) {
    throw new Error(`运行 ID 格式无效: "${runId}"。仅允许字母、数字、下划线和连字符`);
  }

  const artifactsDir = resolve(projectRoot, "agent-bridge/artifacts", runId);
  await mkdir(join(artifactsDir, "observations"), { recursive: true });
  await mkdir(join(artifactsDir, "grades"), { recursive: true });

  const manifestPath = join(artifactsDir, "manifest.json");
  let manifest: RunManifest;

  if (resume && existsSync(manifestPath)) {
    try {
      const manifestRaw = await readFile(manifestPath, "utf-8");
      manifest = JSON.parse(manifestRaw) as RunManifest;

      // P0: Verify resume parameters match exactly
      if (manifest.model !== model) {
        throw new Error(`模型配置不匹配: 缓存记录为 "${manifest.model}"，当前期望为 "${model}"`);
      }
      if (manifest.scenarios.length !== scenarios.length) {
        throw new Error(`场景数量不匹配: 缓存记录为 ${manifest.scenarios.length}，当前期望为 ${scenarios.length}`);
      }
      for (let i = 0; i < scenarios.length; i++) {
        const manifestScen = manifest.scenarios[i];
        const currentScen = scenarios[i];
        if (!manifestScen || !currentScen || manifestScen.scenarioId !== currentScen.scenarioId) {
          throw new Error(`场景 ID 不匹配: 缓存记录为 "${manifestScen?.scenarioId}"，当前期望为 "${currentScen?.scenarioId}"`);
        }
      }
    } catch (err: any) {
      console.error(`[runner] 无法恢复评测，因为缓存验证失败: ${err?.message || err}`);
      throw new Error(`无法恢复评测: ${err?.message || err}`);
    }
  } else {
    manifest = {
      schemaVersion: 1,
      runId,
      model,
      timestamp: new Date().toISOString(),
      scenarios,
    };
    await writeJsonAtomic(manifestPath, manifest);
  }

  const observations: ScenarioObservation[] = [];
  const grades: Grade[] = [];
  const startedAt = new Date().toISOString();

  // Load existing observations if resuming
  const existingObsMap = new Map<string, ScenarioObservation>();
  const existingGradeMap = new Map<string, Grade>();
  let cumulativeCost = 0;

  if (resume) {
    try {
      const obsFiles = await readdir(join(artifactsDir, "observations"));
      for (const file of obsFiles) {
        if (!file.endsWith(".json")) continue;
        const scenarioId = file.replace(".json", "");
        const content = await readFile(join(artifactsDir, "observations", file), "utf-8");
        const obsObj = JSON.parse(content) as ScenarioObservation;
        existingObsMap.set(scenarioId, obsObj);
        if (obsObj.cost) {
          cumulativeCost += obsObj.cost;
        }
      }
      const gradeFiles = await readdir(join(artifactsDir, "grades"));
      for (const file of gradeFiles) {
        if (!file.endsWith(".json")) continue;
        const scenarioId = file.replace(".json", "");
        const content = await readFile(join(artifactsDir, "grades", file), "utf-8");
        existingGradeMap.set(scenarioId, JSON.parse(content));
      }
    } catch (err: any) {
      console.warn(`[runner] 读取已存在的结果缓存时发生警告: ${err?.message || err}`);
      // P1: Raise error instead of silently ignoring corrupted files
      throw new Error(`读取运行缓存失败: ${err?.message || err}`);
    }
  }

  for (const scenario of scenarios) {
    if (existingObsMap.has(scenario.scenarioId) && existingGradeMap.has(scenario.scenarioId)) {
      // Skip completed scenario
      const obs = existingObsMap.get(scenario.scenarioId)!;
      const gr = existingGradeMap.get(scenario.scenarioId)!;
      observations.push(obs);
      grades.push(gr);
      if (onProgress) {
        onProgress(scenario.scenarioId, "completed", { observation: obs, grade: gr });
      }
      continue;
    }

    // P0 Budget check before running
    if (cumulativeCost > MAX_BUDGET_USD) {
      throw new Error(`评测已终止: 累计消耗成本 $${cumulativeCost.toFixed(4)} USD 已超出 $${MAX_BUDGET_USD} 上限门槛`);
    }

    if (onProgress) {
      onProgress(scenario.scenarioId, "started");
    }

    const pair = new IsolatedProcessPair();
    try {
      await pair.start(projectRoot);

      // Provision observation fixture using admin token and evaluation nonce
      const provisionConfig = {
        backendBaseUrl: pair.backendUrl,
        workspaceId: DEFAULT_WORKSPACE_ID,
        projectId: DEFAULT_PROJECT_ID,
        viewerUserId: DEFAULT_VIEWER_USER_ID,
        adminToken: pair.adminToken,
        evaluationNonce: pair.nonce,
      };

      const identity = await provisionObservationFixture(provisionConfig);
      const beforeState = identity.workspaceState;

      // Run SUT
      const httpRunner = createHttpPublicSeamRunner({
        baseUrl: pair.sidecarUrl,
        identity,
      });

      // Map scenario contract to SUT AgentScenario shape
      const sutScenario = {
        id: scenario.scenarioId,
        prompt: scenario.visible.prompt,
        expectedMode: scenario.hidden.expectedMode,
        expectedSkill: scenario.hidden.expectedSkill,
        requiredEvidence: scenario.hidden.requiredEvidence ?? [],
        requiredAnyEvidence: scenario.hidden.requiredAnyEvidence ?? [],
        forbiddenOutputPatterns: (scenario.hidden.forbiddenOutputPatterns ?? []).map((pat) => new RegExp(pat, "i")),
        forbidRawIds: scenario.hidden.forbidRawIds,
        maxLatencyMs: scenario.hidden.maxLatencyMs,
      };

      const obsResult = await httpRunner(sutScenario, model);

      // Fetch afterWorkspaceState
      const afterStateRes = await fetch(`${pair.backendUrl}/api/workspaces/${DEFAULT_WORKSPACE_ID}/state`, {
        headers: { "X-ProjectFlow-Admin-Token": pair.adminToken },
      });
      if (!afterStateRes.ok) {
        throw new Error(`获取运行后工作区状态失败: HTTP ${afterStateRes.status}`);
      }
      const afterState = await afterStateRes.json() as Record<string, unknown>;

      const finalObs: ScenarioObservation = {
        schemaVersion: 1,
        scenarioId: scenario.scenarioId,
        timestamp: new Date().toISOString(),
        routedMode: obsResult.routedMode,
        selectedSkills: obsResult.selectedSkills,
        evidence: obsResult.evidence,
        terminalStatus: obsResult.terminalStatus,
        latencyMs: obsResult.latencyMs,
        inputTokens: obsResult.inputTokens,
        outputTokens: obsResult.outputTokens,
        reasoningTokens: obsResult.reasoningTokens,
        cacheReadTokens: obsResult.cacheReadTokens,
        cacheWriteTokens: obsResult.cacheWriteTokens,
        cost: obsResult.cost,
        output: obsResult.output ?? "",
      };

      // Add to cumulative cost tracking
      if (finalObs.cost) {
        cumulativeCost += finalObs.cost;
      }

      // Grade the result
      const grade = gradeObservation(scenario, finalObs, beforeState, afterState);

      // Save observations and grades atomically to enable resume
      await writeJsonAtomic(
        join(artifactsDir, "observations", `${scenario.scenarioId}.json`),
        finalObs
      );
      await writeJsonAtomic(
        join(artifactsDir, "grades", `${scenario.scenarioId}.json`),
        grade
      );

      observations.push(finalObs);
      grades.push(grade);

      if (onProgress) {
        onProgress(scenario.scenarioId, "completed", { observation: finalObs, grade });
      }
    } catch (err: any) {
      console.error(`运行场景 ${scenario.scenarioId} 发生错误:`, err);

      const finalObs: ScenarioObservation = {
        schemaVersion: 1,
        scenarioId: scenario.scenarioId,
        timestamp: new Date().toISOString(),
        routedMode: "answer",
        selectedSkills: [],
        evidence: [],
        terminalStatus: "failed",
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        output: `执行期间异常: ${err?.message || String(err)}`,
      };

      const grade: Grade = {
        schemaVersion: 1,
        scenarioId: scenario.scenarioId,
        passed: false,
        routingPassed: false,
        outcomePassed: false,
        latencyPassed: false,
        privacyPassed: false,
        failures: [`执行期发生未捕获异常: ${err?.message || String(err)}`],
      };

      await writeJsonAtomic(
        join(artifactsDir, "observations", `${scenario.scenarioId}.json`),
        finalObs
      );
      await writeJsonAtomic(
        join(artifactsDir, "grades", `${scenario.scenarioId}.json`),
        grade
      );

      observations.push(finalObs);
      grades.push(grade);

      if (onProgress) {
        onProgress(scenario.scenarioId, "completed", { observation: finalObs, grade });
      }
    } finally {
      await pair.destroy();
    }
  }

  const completedAt = new Date().toISOString();
  const passedCount = grades.filter((g) => g.passed).length;
  const failedCount = grades.length - passedCount;
  const totalCost = observations
    .map((o) => o.cost)
    .filter((c): c is number => typeof c === "number")
    .reduce((sum, c) => sum + c, 0);

  const artifact: EvaluationArtifact = {
    schemaVersion: 1,
    runId,
    model,
    startedAt,
    completedAt,
    observations,
    grades,
    summary: {
      passedCount,
      failedCount,
      passRate: grades.length > 0 ? passedCount / grades.length : 0,
      totalCost: totalCost > 0 ? totalCost : undefined,
    },
  };

  const reportPath = join(artifactsDir, "report.json");
  await writeJsonAtomic(reportPath, artifact);

  return artifact;
}

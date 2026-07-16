import { join, resolve } from "node:path";
import { mkdir, writeFile, readFile, readdir, rename, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname, platform, userInfo } from "node:os";
import { IsolatedProcessPair } from "./isolation.js";
import { provisionObservationFixture } from "../fixture-provisioner.js";
import { createHttpPublicSeamRunner } from "../http-public-seam-runner.js";
import { gradeObservation } from "./grader.js";
import type { ScenarioContract, RunManifest, ScenarioObservation, Grade, EvaluationArtifact } from "./contract.js";

const DEFAULT_WORKSPACE_ID = "demo-workspace-001";
const DEFAULT_PROJECT_ID = "demo-project-001";
const DEFAULT_VIEWER_USER_ID = "demo-user-001";

const MAX_BUDGET_USD = 0.10;

export class InfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfrastructureError";
  }
}

function computeSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function getGitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function getGitDirtyFingerprint(): string {
  try {
    const status = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
    if (!status) return "clean";
    return computeSha256(status);
  } catch {
    return "unknown";
  }
}

async function writeJsonAtomic(path: string, data: any): Promise<string> {
  const content = JSON.stringify(data, null, 2);
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, path);
  return computeSha256(content);
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

  if (!/^[a-zA-Z0-9_\-]+$/.test(runId)) {
    throw new Error(`运行 ID 格式无效: "${runId}"。仅允许字母、数字、下划线和连字符`);
  }

  const artifactsDir = resolve(projectRoot, "agent-bridge/artifacts", runId);
  const manifestPath = join(artifactsDir, "manifest.json");
  const checksumsPath = join(artifactsDir, "checksums.json");

  // Load existing checksums and files for verification on resume
  const existingObsMap = new Map<string, ScenarioObservation>();
  const existingGradeMap = new Map<string, Grade>();
  let cumulativeCost = 0;
  let checksums: Record<string, string> = {};

  if (resume && existsSync(manifestPath)) {
    try {
      if (!existsSync(checksumsPath)) {
        throw new Error("缺少防篡改校验清单 (checksums.json)");
      }
      checksums = JSON.parse(await readFile(checksumsPath, "utf-8"));

      // Verify manifest hash
      const manifestRaw = await readFile(manifestPath, "utf-8");
      if (computeSha256(manifestRaw) !== checksums["manifest.json"]) {
        throw new Error("清单文件 (manifest.json) 哈希校验失败，已被外部篡改");
      }

      const manifestObj = JSON.parse(manifestRaw) as RunManifest;
      if (manifestObj.model !== model) {
        throw new Error(`模型配置不匹配: 缓存为 "${manifestObj.model}"，当前为 "${model}"`);
      }
      if (manifestObj.scenarios.length !== scenarios.length) {
        throw new Error(`场景数量不匹配: 缓存为 ${manifestObj.scenarios.length}，当前为 ${scenarios.length}`);
      }

      // Verify scenario contract details deep equality
      for (let i = 0; i < scenarios.length; i++) {
        const mScen = manifestObj.scenarios[i];
        const cScen = scenarios[i];
        if (JSON.stringify(mScen) !== JSON.stringify(cScen)) {
          throw new Error(`场景契约发生变更，拒绝恢复评测: 场景 "${cScen?.scenarioId}" 配置不匹配`);
        }
      }

      // Verify observations and grades
      const obsFiles = await readdir(join(artifactsDir, "observations"));
      for (const file of obsFiles) {
        if (!file.endsWith(".json")) continue;
        const scenarioId = file.replace(".json", "");
        const relativeObsPath = `observations/${file}`;
        const obsRaw = await readFile(join(artifactsDir, "observations", file), "utf-8");
        if (computeSha256(obsRaw) !== checksums[relativeObsPath]) {
          throw new Error(`场景观察结果 "${relativeObsPath}" 校验和不匹配，存在篡改风险`);
        }
        const obsObj = JSON.parse(obsRaw) as ScenarioObservation;
        existingObsMap.set(scenarioId, obsObj);
        cumulativeCost += obsObj.sutCost + obsObj.evaluatorModelCost + obsObj.codingAgentCost;
      }

      const gradeFiles = await readdir(join(artifactsDir, "grades"));
      for (const file of gradeFiles) {
        if (!file.endsWith(".json")) continue;
        const scenarioId = file.replace(".json", "");
        const relativeGradePath = `grades/${file}`;
        const gradeRaw = await readFile(join(artifactsDir, "grades", file), "utf-8");
        if (computeSha256(gradeRaw) !== checksums[relativeGradePath]) {
          throw new Error(`评测报告 "${relativeGradePath}" 校验和不匹配，存在篡改风险`);
        }
        existingGradeMap.set(scenarioId, JSON.parse(gradeRaw));
      }
    } catch (err: any) {
      console.error(`[runner] 恢复评测失败，因为防篡改链校验失败: ${err?.message || err}`);
      throw new Error(`防篡改校验失败: ${err?.message || err}`);
    }
  }

  // Pre-staging: We spawn isolated environments and write artifacts directly to the evaluator-owned temp sandbox root
  const pair = new IsolatedProcessPair();
  try {
    await pair.start(projectRoot);
  } catch (err: any) {
    throw new InfrastructureError(`沙箱初始化失败: 无法启动孤立进程对 ${err.message}`);
  }

  const stagingDir = join(pair.tempRoot, "artifacts");
  const stagingObsDir = join(stagingDir, "observations");
  const stagingGradesDir = join(stagingDir, "grades");

  await mkdir(stagingObsDir, { recursive: true });
  await mkdir(stagingGradesDir, { recursive: true });

  const stagedManifestPath = join(stagingDir, "manifest.json");
  const gitCommit = getGitCommit();
  const gitDirtyFingerprint = getGitDirtyFingerprint();

  let manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    model,
    timestamp: new Date().toISOString(),
    scenarios,
    gitCommit,
    gitDirtyFingerprint,
  };
  const manifestHash = await writeJsonAtomic(stagedManifestPath, manifest);
  checksums["manifest.json"] = manifestHash;

  const observations: ScenarioObservation[] = [];
  const grades: Grade[] = [];
  const startedAt = new Date().toISOString();

  // Seed existing items to staging if resuming
  if (resume) {
    for (const [id, obs] of existingObsMap.entries()) {
      observations.push(obs);
      await writeJsonAtomic(join(stagingObsDir, `${id}.json`), obs);
    }
    for (const [id, gr] of existingGradeMap.entries()) {
      grades.push(gr);
      await writeJsonAtomic(join(stagingGradesDir, `${id}.json`), gr);
    }
  }

  for (const scenario of scenarios) {
    if (existingObsMap.has(scenario.scenarioId) && existingGradeMap.has(scenario.scenarioId)) {
      const obs = existingObsMap.get(scenario.scenarioId)!;
      const gr = existingGradeMap.get(scenario.scenarioId)!;
      if (onProgress) {
        onProgress(scenario.scenarioId, "completed", { observation: obs, grade: gr });
      }
      continue;
    }

    // P0 Cost Ceiling Assertion before launching scenario
    if (cumulativeCost > MAX_BUDGET_USD) {
      await pair.destroy();
      throw new Error(`超出累计费用上限: 当前消耗为 $${cumulativeCost.toFixed(4)}，已超出硬上限 $${MAX_BUDGET_USD}`);
    }

    if (onProgress) {
      onProgress(scenario.scenarioId, "started");
    }

    try {
      // Seeding database fixture inside sandbox
      let identity;
      try {
        const provisionConfig = {
          backendBaseUrl: pair.backendUrl,
          workspaceId: DEFAULT_WORKSPACE_ID,
          projectId: DEFAULT_PROJECT_ID,
          viewerUserId: DEFAULT_VIEWER_USER_ID,
          adminToken: pair.adminToken,
          evaluationNonce: pair.nonce,
        };
        identity = await provisionObservationFixture(provisionConfig);
      } catch (err: any) {
        throw new InfrastructureError(`工作区种子数据导入失败: ${err.message}`);
      }

      const beforeState = identity.workspaceState;

      // Run SUT
      const httpRunner = createHttpPublicSeamRunner({
        baseUrl: pair.sidecarUrl,
        identity,
      });

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
      let afterState: Record<string, unknown>;
      try {
        const afterStateRes = await fetch(`${pair.backendUrl}/api/workspaces/${DEFAULT_WORKSPACE_ID}/state`, {
          headers: { "X-ProjectFlow-Admin-Token": pair.adminToken },
        });
        if (!afterStateRes.ok) {
          throw new InfrastructureError(`获取运行后工作区状态失败: HTTP ${afterStateRes.status}`);
        }
        afterState = await afterStateRes.json() as Record<string, unknown>;
      } catch (err: any) {
        if (err instanceof InfrastructureError) throw err;
        throw new InfrastructureError(`获取运行后工作区状态网络异常: ${err.message}`);
      }

      // Cost attribution and source segment classification
      const isMock = model.startsWith("mock:");
      const sutCost = obsResult.cost ?? 0;
      let costSource: "reported" | "estimated" | "unknown" = "reported";

      // P0 Unknown cost fail-closed verification
      if (!isMock) {
        if (obsResult.cost === undefined) {
          costSource = "unknown";
          throw new Error(`付费模型 "${model}" 未能返回费用指标，出于安全性限制触发 fail-closed 中断评估`);
        } else {
          costSource = "reported";
        }
      }

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
        sutCost,
        evaluatorModelCost: 0, // no evaluator LLM calls in Slice 0
        codingAgentCost: 0,    // doesn't include coding agent execution budget
        costSource,
        output: obsResult.output ?? "",
      };

      cumulativeCost += sutCost;

      // Grade observations
      const grade = gradeObservation(scenario, finalObs, beforeState, afterState);

      // Write atomically to evaluator sandboxed temp root staging area
      const relativeObsPath = `observations/${scenario.scenarioId}.json`;
      const relativeGradePath = `grades/${scenario.scenarioId}.json`;

      const obsHash = await writeJsonAtomic(join(stagingObsDir, `${scenario.scenarioId}.json`), finalObs);
      const gradeHash = await writeJsonAtomic(join(stagingGradesDir, `${scenario.scenarioId}.json`), grade);

      checksums[relativeObsPath] = obsHash;
      checksums[relativeGradePath] = gradeHash;

      // Update checksums in sandbox staging
      await writeJsonAtomic(join(stagingDir, "checksums.json"), checksums);

      observations.push(finalObs);
      grades.push(grade);

      if (onProgress) {
        onProgress(scenario.scenarioId, "completed", { observation: finalObs, grade });
      }
    } catch (err: any) {
      // If it's a critical infrastructure error, do not record SUT regression, propagate immediately!
      if (err instanceof InfrastructureError) {
        await pair.destroy();
        throw err;
      }

      console.error(`运行场景 ${scenario.scenarioId} 发生异常:`, err);

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
        sutCost: 0,
        evaluatorModelCost: 0,
        codingAgentCost: 0,
        costSource: "reported",
        output: `执行阶段异常: ${err?.message || String(err)}`,
      };

      const grade: Grade = {
        schemaVersion: 1,
        scenarioId: scenario.scenarioId,
        passed: false,
        routingPassed: false,
        outcomePassed: false,
        latencyPassed: false,
        privacyPassed: false,
        failures: [`执行期发生异常: ${err?.message || String(err)}`],
      };

      const relativeObsPath = `observations/${scenario.scenarioId}.json`;
      const relativeGradePath = `grades/${scenario.scenarioId}.json`;

      const obsHash = await writeJsonAtomic(join(stagingObsDir, `${scenario.scenarioId}.json`), finalObs);
      const gradeHash = await writeJsonAtomic(join(stagingGradesDir, `${scenario.scenarioId}.json`), grade);

      checksums[relativeObsPath] = obsHash;
      checksums[relativeGradePath] = gradeHash;

      await writeJsonAtomic(join(stagingDir, "checksums.json"), checksums);

      observations.push(finalObs);
      grades.push(grade);

      if (onProgress) {
        onProgress(scenario.scenarioId, "completed", { observation: finalObs, grade });
      }
    }
  }

  // P0 Hard final SUT budget limit assertion on completed run
  if (cumulativeCost > MAX_BUDGET_USD) {
    await pair.destroy();
    throw new Error(`评测超出硬上限上限: 累计SUT消耗为 $${cumulativeCost.toFixed(4)}，已超出 $${MAX_BUDGET_USD}`);
  }

  const completedAt = new Date().toISOString();
  const passedCount = grades.filter((g) => g.passed).length;
  const failedCount = grades.length - passedCount;

  const totalSutCost = observations.reduce((sum, o) => sum + o.sutCost, 0);
  const totalEvaluatorModelCost = observations.reduce((sum, o) => sum + o.evaluatorModelCost, 0);
  const totalCodingAgentCost = observations.reduce((sum, o) => sum + o.codingAgentCost, 0);

  const artifact: EvaluationArtifact = {
    schemaVersion: 1,
    runId,
    model,
    gitCommit,
    gitDirtyFingerprint,
    startedAt,
    completedAt,
    observations,
    grades,
    summary: {
      passedCount,
      failedCount,
      passRate: grades.length > 0 ? passedCount / grades.length : 0,
      totalSutCost,
      totalEvaluatorModelCost,
      totalCodingAgentCost,
    },
    provenance: {
      host: hostname(),
      platform: platform(),
      user: userInfo().username,
    },
  };

  const reportPath = join(stagingDir, "report.json");
  const reportHash = await writeJsonAtomic(reportPath, artifact);
  checksums["report.json"] = reportHash;

  // Update final staged checksums
  await writeJsonAtomic(join(stagingDir, "checksums.json"), checksums);
  artifact.sha256Hash = reportHash;

  // Pre-staging validation complete. Now sync staged artifacts to the final workspace directory atomically
  await mkdir(artifactsDir, { recursive: true });
  await cp(stagingDir, artifactsDir, { recursive: true });

  // Destroy sandboxed processes
  await pair.destroy();

  return artifact;
}

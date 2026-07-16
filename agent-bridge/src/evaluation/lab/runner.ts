import { join, resolve } from "node:path";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
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

export async function runEvaluation(options: {
  projectRoot: string;
  runId: string;
  model: string;
  scenarios: ScenarioContract[];
  resume: boolean;
  onProgress?: (scenarioId: string, status: "started" | "completed", result?: { observation: ScenarioObservation; grade: Grade }) => void;
}): Promise<EvaluationArtifact> {
  const { projectRoot, runId, model, scenarios, resume, onProgress } = options;
  const artifactsDir = resolve(projectRoot, "agent-bridge/artifacts", runId);
  await mkdir(join(artifactsDir, "observations"), { recursive: true });
  await mkdir(join(artifactsDir, "grades"), { recursive: true });

  const manifestPath = join(artifactsDir, "manifest.json");
  let manifest: RunManifest;

  if (resume && existsSync(manifestPath)) {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as RunManifest;
  } else {
    manifest = {
      schemaVersion: 1,
      runId,
      model,
      timestamp: new Date().toISOString(),
      scenarios,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  }

  const observations: ScenarioObservation[] = [];
  const grades: Grade[] = [];
  const startedAt = new Date().toISOString();

  // Load existing observations if resuming
  const existingObsMap = new Map<string, ScenarioObservation>();
  const existingGradeMap = new Map<string, Grade>();

  if (resume) {
    try {
      const obsFiles = await readdir(join(artifactsDir, "observations"));
      for (const file of obsFiles) {
        if (!file.endsWith(".json")) continue;
        const scenarioId = file.replace(".json", "");
        const content = await readFile(join(artifactsDir, "observations", file), "utf-8");
        existingObsMap.set(scenarioId, JSON.parse(content));
      }
      const gradeFiles = await readdir(join(artifactsDir, "grades"));
      for (const file of gradeFiles) {
        if (!file.endsWith(".json")) continue;
        const scenarioId = file.replace(".json", "");
        const content = await readFile(join(artifactsDir, "grades", file), "utf-8");
        existingGradeMap.set(scenarioId, JSON.parse(content));
      }
    } catch {
      // ignore read errors
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

      // Fetch beforeWorkspaceState
      const beforeStateRes = await fetch(`${pair.backendUrl}/api/workspaces/${DEFAULT_WORKSPACE_ID}/state`, {
        headers: { "X-ProjectFlow-Admin-Token": pair.adminToken },
      });
      const beforeState = beforeStateRes.ok ? await beforeStateRes.json() : null;

      // Run SUT
      const httpRunner = createHttpPublicSeamRunner({
        baseUrl: pair.sidecarUrl,
        identity,
      });

      // Map scenario contract to SUT AgentScenario shape
      const sutScenario = {
        id: scenario.scenarioId,
        prompt: scenario.prompt,
        expectedMode: scenario.expectedMode,
        expectedSkill: scenario.expectedSkill,
        requiredEvidence: scenario.requiredEvidence ?? [],
        requiredAnyEvidence: scenario.requiredAnyEvidence ?? [],
        forbiddenOutputPatterns: (scenario.forbiddenOutputPatterns ?? []).map((pat) => new RegExp(pat, "i")),
        forbidRawIds: scenario.forbidRawIds,
        maxLatencyMs: scenario.maxLatencyMs,
      };

      const obsResult = await httpRunner(sutScenario, model);

      // Fetch afterWorkspaceState
      const afterStateRes = await fetch(`${pair.backendUrl}/api/workspaces/${DEFAULT_WORKSPACE_ID}/state`, {
        headers: { "X-ProjectFlow-Admin-Token": pair.adminToken },
      });
      const afterState = afterStateRes.ok ? await afterStateRes.json() : null;

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

      // Grade the result
      const grade = gradeObservation(scenario, finalObs, beforeState, afterState);

      // Save observations and grades atomically to enable resume
      await writeFile(
        join(artifactsDir, "observations", `${scenario.scenarioId}.json`),
        JSON.stringify(finalObs, null, 2),
        "utf-8"
      );
      await writeFile(
        join(artifactsDir, "grades", `${scenario.scenarioId}.json`),
        JSON.stringify(grade, null, 2),
        "utf-8"
      );

      observations.push(finalObs);
      grades.push(grade);

      if (onProgress) {
        onProgress(scenario.scenarioId, "completed", { observation: finalObs, grade });
      }
    } catch (err: any) {
      console.error(`Error running scenario ${scenario.scenarioId}:`, err);
      // Create a failed/blocked observation and grade
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
        output: `Error during execution: ${err?.message || String(err)}`,
      };
      const grade: Grade = {
        schemaVersion: 1,
        scenarioId: scenario.scenarioId,
        passed: false,
        routingPassed: false,
        outcomePassed: false,
        latencyPassed: false,
        privacyPassed: false,
        failures: [`Execution error: ${err?.message || String(err)}`],
      };
      // Save observations and grades atomically to enable resume
      await writeFile(
        join(artifactsDir, "observations", `${scenario.scenarioId}.json`),
        JSON.stringify(finalObs, null, 2),
        "utf-8"
      );
      await writeFile(
        join(artifactsDir, "grades", `${scenario.scenarioId}.json`),
        JSON.stringify(grade, null, 2),
        "utf-8"
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
  await writeFile(reportPath, JSON.stringify(artifact, null, 2), "utf-8");

  return artifact;
}

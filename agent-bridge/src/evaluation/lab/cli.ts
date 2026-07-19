#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EvaluationArtifactStore } from "./artifact-store.js";
import { EVALUATION_SCHEMA_VERSION } from "./contract.js";
import {
  EvaluationInfrastructureError,
  EvaluationValidationError,
} from "./errors.js";
import { SLICE_0_PRESETS, T46_3_P0_SCENARIO_IDS } from "./presets.js";
import { runEvaluation } from "./runner.js";
import { validateEvaluationConfig } from "./validation.js";
import {
  evaluateExitGate,
  formatExitGateReport,
} from "./exit-gate.js";
import {
  computeReliabilityReport,
  formatReliabilityReport,
} from "./reliability-stats.js";
import { runPairedComparison } from "./paired-runner.js";

const EXIT = {
  passed: 0,
  regression: 1,
  infrastructure: 2,
  validation: 3,
  partialBudget: 4,
} as const;

function findProjectRoot(): string {
  let current = resolve(import.meta.dirname ?? process.cwd());
  while (!existsSync(resolve(current, "CLAUDE.md"))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new EvaluationValidationError("无法定位 ProjectFlow 仓库根目录");
    }
    current = parent;
  }
  return current;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage(): void {
  output({
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    commands: {
      list: "scripts/eval-lab list",
      validate: "scripts/eval-lab validate [--preset smoke|smoke-v2|demo|full] [--model mock:mock-model]",
      run: "scripts/eval-lab run [--preset smoke|smoke-v2|demo|full] [--scenario ID] [--model mock:mock-model] [--run-id ID] [--resume] [--json]",
      status: "scripts/eval-lab status <run-id>",
      show: "scripts/eval-lab show <run-id>",
      verify: "scripts/eval-lab verify <run-id>",
      "exit-gate": "scripts/eval-lab exit-gate <run-id> [--json]",
      "reliability": "scripts/eval-lab reliability <run-id> [--confidence-level 0.95]",
      "compare": "scripts/eval-lab compare --candidate <git-ref> --baseline <git-ref> [--preset smoke|demo|full] [--model mock:mock-model] [--json]",
    },
    exitCodes: EXIT,
  });
}

interface CommonArgs {
  preset: string;
  model: string;
  scenarioId?: string;
  runId?: string;
  resume: boolean;
  json: boolean;
}

function parseArgs(args: string[], allowRunOnly: boolean): CommonArgs {
  const parsed: CommonArgs = {
    preset: "smoke",
    model: "mock:mock-model",
    resume: false,
    json: false,
  };
  const requireValue = (index: number, flag: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new EvaluationValidationError(`参数 ${flag} 缺少值`);
    }
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--preset") {
      parsed.preset = requireValue(index, flag);
      index += 1;
    } else if (flag === "--model") {
      parsed.model = requireValue(index, flag);
      index += 1;
    } else if (allowRunOnly && flag === "--scenario") {
      parsed.scenarioId = requireValue(index, flag);
      index += 1;
    } else if (allowRunOnly && flag === "--run-id") {
      parsed.runId = requireValue(index, flag);
      index += 1;
    } else if (allowRunOnly && flag === "--resume") {
      parsed.resume = true;
    } else if (allowRunOnly && flag === "--json") {
      parsed.json = true;
    } else {
      throw new EvaluationValidationError(`未知参数: ${flag}`);
    }
  }
  if (!SLICE_0_PRESETS[parsed.preset]) {
    throw new EvaluationValidationError(`未知 preset: ${parsed.preset}`);
  }
  return parsed;
}

function selectScenarios(parsed: CommonArgs) {
  const preset = SLICE_0_PRESETS[parsed.preset]!;
  if (!parsed.scenarioId) return preset.scenarios;
  const selected = preset.scenarios.filter((scenario) => scenario.scenarioId === parsed.scenarioId);
  if (selected.length === 0) {
    throw new EvaluationValidationError(`preset ${parsed.preset} 中不存在场景 ${parsed.scenarioId}`);
  }
  return selected;
}

async function verifiedStore(projectRoot: string, runId: string): Promise<EvaluationArtifactStore> {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new EvaluationValidationError("运行 ID 格式无效");
  }
  return new EvaluationArtifactStore(projectRoot, runId, tmpdir());
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    usage();
    process.exit(EXIT.validation);
  }
  const projectRoot = findProjectRoot();

  if (command === "list") {
    output({
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      presets: Object.entries(SLICE_0_PRESETS).map(([name, preset]) => ({
        name,
        budget: preset.budget,
        scenarios: preset.scenarios.map((scenario) => ({
          scenarioId: scenario.scenarioId,
          prompt: scenario.visible.prompt,
          source: "T43_RELEASE_SCENARIOS",
        })),
      })),
    });
    return;
  }

  if (command === "validate") {
    const parsed = parseArgs(args, false);
    const preset = SLICE_0_PRESETS[parsed.preset]!;
    const result = await validateEvaluationConfig({
      projectRoot,
      model: parsed.model,
      scenarios: preset.scenarios,
      budget: preset.budget,
      preset: parsed.preset,
    });
    output({ event: "validation_result", ...result, exitCode: result.valid ? EXIT.passed : EXIT.validation });
    process.exit(result.valid ? EXIT.passed : EXIT.validation);
  }

  if (command === "status" || command === "show" || command === "verify") {
    if (args.length !== 1) {
      throw new EvaluationValidationError(`${command} 需要且只接受一个 run-id`);
    }
    const store = await verifiedStore(projectRoot, args[0]!);
    if (command === "status") {
      const status = await store.readStatus();
      let integrityVerified = false;
      if (["completed", "regression", "partial_budget"].includes(status.status)) {
        const artifact = await store.readVerifiedArtifact();
        if (artifact.status !== status.status) {
          throw new EvaluationInfrastructureError("status.json 与 immutable report 状态不一致");
        }
        integrityVerified = true;
      }
      output({ event: "status", ...status, integrityVerified });
      return;
    }
    const artifact = await store.readVerifiedArtifact();
    if (command === "verify") {
      output({
        event: "integrity_verified",
        runId: artifact.runId,
        status: artifact.status,
        integrityRootSha256: artifact.integrityRootSha256,
        artifactPaths: artifact.artifactPaths,
      });
    } else {
      output(artifact);
    }
    return;
  }

  if (command === "exit-gate") {
    if (args.length < 1) {
      throw new EvaluationValidationError("exit-gate 需要且只接受一个 run-id");
    }
    const store = await verifiedStore(projectRoot, args[0]!);
    const artifact = await store.readVerifiedArtifact();
    const acceptance = artifact.v3?.acceptanceEvidence;
    if (!acceptance) {
      throw new EvaluationValidationError(
        "artifact 缺少真实 Slice 1 acceptanceEvidence；请先运行 full preset，禁止用普通 grade 代替 mutation/reference 证据",
      );
    }
    // §4 Required scenarios not skipped/excluded: the artifact's
    // observations cover the P0 scenarios AND each observed P0 scenario's
    // hard grade must pass. A scenario that ran but failed its hard grade
    // is marked "failed" (not "passed") to prevent masking regressions.
    const observedIds = new Set(artifact.observations.map((o) => o.scenarioId));
    const gradeByScenario = new Map(artifact.grades.map((g) => [g.scenarioId, g]));
    const requiredScenarios = T46_3_P0_SCENARIO_IDS.map((id) => {
      if (!observedIds.has(id)) {
        return {
          scenarioId: id,
          status: "skipped" as const,
          skipReason: "未在 artifact 中观察到",
        };
      }
      const grade = gradeByScenario.get(id);
      // A P0 scenario that was observed but whose hard grade failed is
      // marked "failed" so the exit gate fails-closed on regressions.
      const status: "passed" | "failed" = grade && !grade.passed ? "failed" : "passed";
      return { scenarioId: id, status };
    });
    // §5 Evidence graph and checksums: verified by the store.
    const evidenceIntegrity = {
      checksumsComplete: artifact.integrityRootSha256 !== undefined,
      evidenceGraphComplete: artifact.evidenceRootSha256 !== undefined,
      verified: true,
    };
    // §6 No semantic Judge: this CLI never invokes an LLM grader.
    const report = evaluateExitGate({
      p0Mutations: acceptance.p0Mutations,
      referencePrograms: acceptance.referencePrograms,
      hiddenFieldLeakageTests: acceptance.hiddenFieldLeakageTests,
      requiredScenarios,
      evidenceIntegrity,
      semanticJudgeUsed: acceptance.semanticJudgeUsed,
    });
    if (parsedArgsHasFlag(args, "--json")) {
      output({ event: "exit_gate", ...report });
    } else {
      process.stdout.write(formatExitGateReport(report) + "\n");
    }
    process.exit(report.passed ? EXIT.passed : EXIT.regression);
    return;
  }

  if (command === "reliability") {
    if (args.length < 1) {
      throw new EvaluationValidationError("reliability 需要且只接受一个 run-id");
    }
    const confidenceLevel = parseConfidenceLevel(args);
    const store = await verifiedStore(projectRoot, args[0]!);
    const artifact = await store.readVerifiedArtifact();
    const trials = artifact.v3?.reliabilityTrials;
    if (!trials) {
      throw new EvaluationValidationError("artifact 缺少 reliabilityTrials，不能从最终 grades 反推重复试验或排除项");
    }
    const presetName = artifact.preset;
    const report = computeReliabilityReport(trials, {
      preset: presetName as "demo" | "smoke" | "smoke-v2" | "full",
      confidenceLevel,
    });
    if (parsedArgsHasFlag(args, "--json")) {
      output({ event: "reliability_report", ...report });
    } else {
      process.stdout.write(formatReliabilityReport(report) + "\n");
    }
    process.exit(report.insufficientEvidence ? EXIT.partialBudget : EXIT.passed);
    return;
  }

  if (command === "compare") {
    const valueFor = (flag: string): string => {
      const index = args.indexOf(flag);
      const value = index >= 0 ? args[index + 1] : undefined;
      if (!value || value.startsWith("--")) throw new EvaluationValidationError(`${flag} 需要一个值`);
      return value;
    };
    const candidateRef = valueFor("--candidate");
    const baselineRef = valueFor("--baseline");
    const parsed = parseArgs(
      args.filter((value, index) =>
        value !== "--candidate" && value !== "--baseline"
        && args[index - 1] !== "--candidate" && args[index - 1] !== "--baseline"),
      true,
    );
    const preset = SLICE_0_PRESETS[parsed.preset]!;
    const result = await runPairedComparison({
      projectRoot,
      candidateRef,
      baselineRef,
      preset: parsed.preset,
      model: parsed.model,
      scenarios: preset.scenarios,
      budget: preset.budget,
    });
    output({
      event: "paired_comparison",
      candidateRef,
      baselineRef,
      result: result.result,
      artifactPath: result.artifactPath,
      sha256: result.sha256,
    });
    process.exit(result.result.candidatePassRate < result.result.baselinePassRate ? EXIT.regression : EXIT.passed);
    return;
  }

  if (command !== "run") {
    throw new EvaluationValidationError(`未知命令: ${command}`);
  }

  const parsed = parseArgs(args, true);
  const preset = SLICE_0_PRESETS[parsed.preset]!;
  const scenarios = selectScenarios(parsed);
  const validation = await validateEvaluationConfig({
    projectRoot,
    model: parsed.model,
    scenarios,
    budget: preset.budget,
    preset: parsed.preset,
  });
  if (!validation.valid) {
    output({ event: "validation_result", ...validation, exitCode: EXIT.validation });
    process.exit(EXIT.validation);
  }
  const runId = parsed.runId ?? `run_${Date.now()}`;
  output({ event: "run_started", runId, preset: parsed.preset, model: parsed.model });
  const artifact = await runEvaluation({
    projectRoot,
    runId,
    preset: parsed.preset,
    model: parsed.model,
    scenarios,
    budget: preset.budget,
    resume: parsed.resume,
    onProgress: (scenarioId, status, result) => output({
      event: "scenario_progress",
      runId,
      scenarioId,
      status,
      ...(result ? { passed: result.grade.passed } : {}),
    }),
  });
  const exitCode = artifact.status === "partial_budget"
    ? EXIT.partialBudget
    : artifact.status === "regression" ? EXIT.regression : EXIT.passed;
  output({
    event: "run_completed",
    runId,
    status: artifact.status,
    exitCode,
    summary: artifact.summary,
    integrityRootSha256: artifact.integrityRootSha256,
    artifactPaths: artifact.artifactPaths,
  });
  process.exit(exitCode);
}

main().catch((error) => {
  const validationError = error instanceof EvaluationValidationError;
  const infrastructureError = error instanceof EvaluationInfrastructureError;
  const exitCode = validationError ? EXIT.validation : EXIT.infrastructure;
  output({
    event: validationError ? "validation_error" : "infrastructure_error",
    exitCode,
    error: error instanceof Error ? error.message : String(error),
    classified: validationError || infrastructureError,
  });
  process.exit(exitCode);
});

// ---------------------------------------------------------------------------
// T46-3 (Issue #96) — CLI helper functions for the new commands.
// ---------------------------------------------------------------------------

function parsedArgsHasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseConfidenceLevel(args: string[]): number {
  const index = args.indexOf("--confidence-level");
  if (index < 0) return 0.95;
  const value = args[index + 1];
  if (!value) {
    throw new EvaluationValidationError("--confidence-level 需要一个值");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new EvaluationValidationError("--confidence-level 必须在 (0, 1) 区间内");
  }
  return parsed;
}

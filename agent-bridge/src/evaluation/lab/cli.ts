#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EvaluationArtifactStore } from "./artifact-store.js";
import { EVALUATION_SCHEMA_VERSION } from "./contract.js";
import {
  EvaluationInfrastructureError,
  EvaluationValidationError,
} from "./errors.js";
import {
  SLICE_0_PRESETS,
  PRESETS_WITH_CALIBRATE,
  T46_3_P0_SCENARIO_IDS,
  CALIBRATE_PRESET,
} from "./presets.js";
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
// T46-4 (Issue #97) — diagnosis, clustering, repair packet, RCA benchmark.
import { runDiagnosisPipeline, runBenchmarkPipeline } from "./diagnosis-runner.js";
import { buildRepairPrompt } from "./repair-prompt.js";
import { verifyFaultCatalog } from "./fault-profiles.js";
import { verifyPacketInvariants } from "./repair-packet.js";
// T46-5 (Issue #98) — calibration, semantic standards, promotion.
import {
  runCalibrationPipeline,
  buildPromotionApproval,
  type AnchorEvaluationInput,
  type PairwiseEvaluationInput,
} from "./calibration-runner.js";
import { loadActiveRegistry, assertActiveRegistryUnchanged } from "./standards-registry.js";
import { verifyConflictCatalog } from "./standard-conflicts.js";
import { verifyCalibrationArtifactInvariants } from "./calibration-runner.js";
import type {
  CalibrationCostLedger,
} from "./calibration-contract.js";
import type { CostLedgerEntry } from "./contract.js";

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
      validate: "scripts/eval-lab validate [--preset smoke|smoke-v2|demo|full|calibrate] [--model mock:mock-model]",
      run: "scripts/eval-lab run [--preset smoke|smoke-v2|demo|full] [--scenario ID] [--model mock:mock-model] [--run-id ID] [--resume] [--json]",
      status: "scripts/eval-lab status <run-id>",
      show: "scripts/eval-lab show <run-id>",
      verify: "scripts/eval-lab verify <run-id>",
      "exit-gate": "scripts/eval-lab exit-gate <run-id> [--json]",
      "reliability": "scripts/eval-lab reliability <run-id> [--confidence-level 0.95]",
      "compare": "scripts/eval-lab compare --candidate <git-ref> --baseline <git-ref> [--preset smoke|demo|full] [--model mock:mock-model] [--json]",
      // T46-4 (Issue #97) — diagnosis, repair packet, RCA benchmark.
      "diagnose": "scripts/eval-lab diagnose <run-id> [--json]",
      "repair-packet": "scripts/eval-lab repair-packet <run-id> [--packet-id ID] [--json]",
      "rca-benchmark": "scripts/eval-lab rca-benchmark <run-id> [--json]",
      "fault-catalog": "scripts/eval-lab fault-catalog [--json]",
      // T46-5 (Issue #98) — calibration, semantic standards, promotion.
      "calibrate": "scripts/eval-lab calibrate <run-id> [--json]",
      "standard-conflicts": "scripts/eval-lab standard-conflicts <run-id> [--json]",
      "promote-standard": "scripts/eval-lab promote-standard --candidate-id <id> --approver-robert --diff-path <path> --commit <sha> [--json]",
      "active-registry": "scripts/eval-lab active-registry [--json]",
      "candidate-registry": "scripts/eval-lab candidate-registry <run-id> [--json]",
      "conflict-catalog": "scripts/eval-lab conflict-catalog [--json]",
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
  if (!PRESETS_WITH_CALIBRATE[parsed.preset]) {
    throw new EvaluationValidationError(`未知 preset: ${parsed.preset}`);
  }
  return parsed;
}

function selectScenarios(parsed: CommonArgs) {
  const preset = PRESETS_WITH_CALIBRATE[parsed.preset]!;
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
      presets: Object.entries(PRESETS_WITH_CALIBRATE).map(([name, preset]) => ({
        name,
        budget: preset.budget,
        ...(preset.calibrateBudget ? { calibrateBudget: preset.calibrateBudget } : {}),
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
    const preset = PRESETS_WITH_CALIBRATE[parsed.preset]!;
    const result = await validateEvaluationConfig({
      projectRoot,
      model: parsed.model,
      scenarios: preset.scenarios,
      budget: preset.budget,
      preset: parsed.preset,
      ...(preset.calibrateBudget ? { calibrateBudget: preset.calibrateBudget } : {}),
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

  if (command === "diagnose") {
    if (args.length < 1) {
      throw new EvaluationValidationError("diagnose 需要且只接受一个 run-id");
    }
    const runId = args[0]!;
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const store = await verifiedStore(projectRoot, runId);
    // Read the artifact (must be a completed/verified run).
    const artifact = await store.readVerifiedArtifact();
    // Build diagnosis targets from failed observations.
    const preset = SLICE_0_PRESETS[artifact.preset];
    if (!preset) {
      throw new EvaluationValidationError(
        `artifact preset ${artifact.preset} 未在 SLICE_0_PRESETS 中找到`,
      );
    }
    const scenarioById = new Map(preset.scenarios.map((s) => [s.scenarioId, s]));
    const gradeByScenario = new Map(artifact.grades.map((g) => [g.scenarioId, g]));
    const targets = artifact.observations
      .map((observation): import("./diagnosis-runner.js").DiagnosisTarget | undefined => {
        const scenario = scenarioById.get(observation.scenarioId);
        const grade = gradeByScenario.get(observation.scenarioId);
        if (!scenario || !grade) return undefined;
        // Only diagnose failed observations.
        if (grade.passed) return undefined;
        return { scenario, observation, grade };
      })
      .filter((t): t is import("./diagnosis-runner.js").DiagnosisTarget => t !== undefined);
    if (targets.length === 0) {
      output({
        event: "diagnosis_skipped",
        runId,
        reason: "没有失败的 observation 需要诊断",
      });
      process.exit(EXIT.passed);
      return;
    }
    const result = await runDiagnosisPipeline(store, { runId, targets });
    if (jsonFlag) {
      output({
        event: "diagnosis_completed",
        runId,
        diagnosisCount: result.diagnoses.length,
        clusterCount: result.clusters.length,
        packetCount: result.packets.length,
        published: result.published,
      });
    } else {
      process.stdout.write(
        `诊断完成: ${result.diagnoses.length} 条诊断, ${result.clusters.length} 个 cluster, ${result.packets.length} 个 repair packet\n`,
      );
      for (const packet of result.packets) {
        process.stdout.write(
          `  - ${packet.packetId} [${packet.packetType}] status=${packet.causalStatus} confidence=${packet.confidence}\n`,
        );
      }
    }
    process.exit(EXIT.passed);
    return;
  }

  if (command === "repair-packet") {
    if (args.length < 1) {
      throw new EvaluationValidationError("repair-packet 需要且只接受一个 run-id");
    }
    const runId = args[0]!;
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const packetIdFlag = parseOptionalValue(args, "--packet-id");
    const store = await verifiedStore(projectRoot, runId);
    if (packetIdFlag) {
      // Read a single packet and generate its prompt.
      const packet = await store.readRepairPacket(packetIdFlag) as import("./diagnosis-contract.js").RepairPacket;
      // Verify packet invariants.
      const violations = verifyPacketInvariants(packet);
      if (violations.length > 0) {
        throw new EvaluationValidationError(
          `repair packet ${packetIdFlag} 不变式违反: ${violations.join("; ")}`,
        );
      }
      const prompt = buildRepairPrompt({ packet });
      if (jsonFlag) {
        output({
          event: "repair_packet_prompt",
          runId,
          packetId: packet.packetId,
          packetType: packet.packetType,
          causalStatus: packet.causalStatus,
          confidence: packet.confidence,
          staleState: packet.staleState,
          integritySha256: packet.integritySha256,
          prompt,
        });
      } else {
        process.stdout.write(prompt + "\n");
      }
      process.exit(packet.staleState === "stale" ? EXIT.regression : EXIT.passed);
      return;
    }
    // List all packets for the run.
    const artifact = await store.readVerifiedArtifact();
    const packetIds = (artifact as unknown as { repairPacketSummaries?: Array<{ packetId: string }> }).repairPacketSummaries?.map((p) => p.packetId) ?? [];
    if (packetIds.length === 0) {
      output({
        event: "repair_packets_empty",
        runId,
        reason: "尚未生成 repair packet；请先运行 diagnose 命令",
      });
      process.exit(EXIT.passed);
      return;
    }
    if (jsonFlag) {
      output({
        event: "repair_packets_list",
        runId,
        packetIds,
      });
    } else {
      process.stdout.write(`Run ${runId} 包含 ${packetIds.length} 个 repair packet:\n`);
      for (const id of packetIds) {
        process.stdout.write(`  - ${id}\n`);
      }
    }
    process.exit(EXIT.passed);
    return;
  }

  if (command === "rca-benchmark") {
    if (args.length < 1) {
      throw new EvaluationValidationError("rca-benchmark 需要且只接受一个 run-id");
    }
    const runId = args[0]!;
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const store = await verifiedStore(projectRoot, runId);
    const result = await runBenchmarkPipeline(store, { runId });
    if (jsonFlag) {
      output({
        event: "rca_benchmark_completed",
        runId,
        reportId: result.report.reportId,
        totalSamples: result.report.totalSamples,
        top1Accuracy: result.report.top1Accuracy,
        top3Recall: result.report.top3Recall,
        falseAttributionRate: result.report.falseAttributionRate,
        evidenceCompleteness: result.report.evidenceCompleteness,
        confidenceCalibration: result.report.confidenceCalibration,
        passed: result.report.passed,
        failureReasons: result.report.failureReasons,
        artifactPath: result.published.artifactPath,
        sha256: result.published.sha256,
      });
    } else {
      process.stdout.write(
        `RCA Benchmark ${result.report.reportId} (${result.report.passed ? "PASS" : "FAIL"})\n` +
        `  samples: ${result.report.totalSamples}\n` +
        `  top1Accuracy: ${result.report.top1Accuracy.toFixed(2)}\n` +
        `  top3Recall: ${result.report.top3Recall.toFixed(2)}\n` +
        `  falseAttributionRate: ${result.report.falseAttributionRate.toFixed(2)}\n` +
        `  evidenceCompleteness: ${result.report.evidenceCompleteness.toFixed(2)}\n` +
        `  confidenceCalibration: ${result.report.confidenceCalibration.toFixed(2)}\n`,
      );
      if (!result.report.passed) {
        for (const reason of result.report.failureReasons) {
          process.stdout.write(`  - ${reason}\n`);
        }
      }
    }
    process.exit(result.report.passed ? EXIT.passed : EXIT.regression);
    return;
  }

  if (command === "fault-catalog") {
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const verification = verifyFaultCatalog();
    if (!verification.complete) {
      output({
        event: "fault_catalog_invalid",
        missingCategories: verification.missingCategories,
        duplicateProfileIds: verification.duplicateProfileIds,
        oracleIndependenceViolations: verification.oracleIndependenceViolations,
      });
      process.exit(EXIT.validation);
      return;
    }
    if (jsonFlag) {
      output({
        event: "fault_catalog_valid",
        complete: verification.complete,
      });
    } else {
      process.stdout.write("Fault catalog 验证通过\n");
    }
    process.exit(EXIT.passed);
    return;
  }

  // -------------------------------------------------------------------------
  // T46-5 (Issue #98) — Calibration and semantic standards commands.
  //
  // These commands implement the governed calibration pipeline:
  //  - `calibrate <run-id>`: runs the calibration pipeline using mock
  //    Judge + preset anchors/rubrics. Produces candidate standards,
  //    never modifies active registry.
  //  - `standard-conflicts <run-id>`: lists standard conflicts detected
  //    during a calibration run.
  //  - `promote-standard`: builds a promotion approval record from an
  //    explicit Robert instruction. Does NOT claim cryptographic identity
  //    authentication. The caller is responsible for the actual Git
  //    diff + commit that mutates the active registry.
  //  - `active-registry`: shows the current active standards registry
  //    (read-only).
  //  - `candidate-registry <run-id>`: shows the candidate registry
  //    produced by a calibration run.
  //  - `conflict-catalog`: verifies the frozen conflict catalog is
  //    complete (6 patterns).
  // -------------------------------------------------------------------------

  if (command === "calibrate") {
    if (args.length < 1) {
      throw new EvaluationValidationError("calibrate 需要且只接受一个 run-id");
    }
    const runId = args[0]!;
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const store = await verifiedStore(projectRoot, runId);
    // Build the calibration input from the preset.
    const calibrateBudget = CALIBRATE_PRESET.calibrateBudget;
    if (!calibrateBudget) {
      throw new EvaluationValidationError("CALIBRATE_PRESET 缺少 calibrateBudget");
    }
    // Build a mock cost ledger with unknown provenance (Slice 3 uses
    // mock Judge; no real paid model is invoked).
    const mockCostEntry: CostLedgerEntry = {
      amountUsd: null,
      source: "unknown",
      countedAgainstSutCap: false,
    };
    const costLedger: CalibrationCostLedger = {
      sut: mockCostEntry,
      evaluator: mockCostEntry,
      codingAgent: mockCostEntry,
      sutProvenance: "unknown",
      evaluatorProvenance: "unknown",
      codingAgentProvenance: "unknown",
    };
    const anchorEvaluations: AnchorEvaluationInput[] = CALIBRATE_PRESET.anchorSets.flatMap(
      (anchorSet) => {
        const rubric = CALIBRATE_PRESET.rubrics.find(
          (candidate) => candidate.criterion === anchorSet.criterion,
        );
        if (!rubric) {
          throw new EvaluationValidationError(
            `anchor set ${anchorSet.anchorSetId} 缺少 criterion=${anchorSet.criterion} 的 rubric`,
          );
        }
        return anchorSet.anchors.map((anchor) => ({
          anchor,
          rubric,
          judgeInput: {
            visibleFacts: anchor.visibleFacts,
            visibleProjectFlowState: "deterministic mock calibration fixture",
            candidateOutput: anchor.output,
            deterministicEvidence: [],
            traceReferences: [],
            candidateBlinded: true,
          },
          mockJudgeResult: {
            verdict: anchor.expectedVerdict ?? "needs_review",
            score: anchor.expectedScore ?? "fair",
            reason: `deterministic mock Judge anchor: ${anchor.anchorId}`,
            confidence: anchor.kind === "good" ? 0.95 : anchor.kind === "boundary" ? 0.60 : 0.20,
          },
        }));
      },
    );
    const primaryRubric = CALIBRATE_PRESET.rubrics[0];
    if (!primaryRubric) {
      throw new EvaluationValidationError("CALIBRATE_PRESET 至少需要一个 rubric");
    }
    // Two deterministic pairs are deliberately chosen so one preferred
    // candidate appears first and the other appears second under the
    // recorded seed. This exercises position and reverse-order checks
    // without creating a biased mock baseline.
    const pairwiseEvaluations: PairwiseEvaluationInput[] = [0, 2].map((suffix) => ({
      candidateAId: `mock-good-${suffix}`,
      candidateBId: `mock-bad-${suffix}`,
      candidateAOutput: "具体、可执行且带验收标准的阶段计划",
      candidateBOutput: "随便做吧",
      blinded: true,
      rubric: primaryRubric,
      judgeManifest: CALIBRATE_PRESET.judgeManifest,
      mockForwardResult: {
        kind: "preference",
        preferred: "A",
        confidence: 0.95,
        reason: "deterministic mock Judge prefers the stronger anchor",
      },
      mockReverseResult: {
        kind: "preference",
        preferred: "A",
        confidence: 0.95,
        reason: "deterministic mock Judge remains stable after order reversal",
      },
    }));
    // Load active registry before calibration to verify immutability.
    const activeBefore = await loadActiveRegistry(projectRoot);
    // Run the calibration pipeline.
    const result = await runCalibrationPipeline(store, {
      runId,
      projectRoot,
      acceptanceProposal: CALIBRATE_PRESET.acceptanceProposal,
      rubrics: CALIBRATE_PRESET.rubrics,
      anchorSets: CALIBRATE_PRESET.anchorSets,
      judgeManifest: CALIBRATE_PRESET.judgeManifest,
      anchorEvaluations,
      pairwiseEvaluations,
      verbositySamples: [
        { outputLength: 10, scoreNumeric: 1 },
        { outputLength: 20, scoreNumeric: 2 },
        { outputLength: 30, scoreNumeric: 2 },
        { outputLength: 40, scoreNumeric: 1 },
      ],
      sameFamilySamples: [
        {
          judgeFamily: "mock",
          candidateAFamily: "mock",
          candidateBFamily: "other",
          preferred: "A",
        },
        {
          judgeFamily: "mock",
          candidateAFamily: "mock",
          candidateBFamily: "other",
          preferred: "B",
        },
      ],
      standardClaims: [],
      costLedger,
      mutationResults: [],
      thresholds: {
        positionBias: CALIBRATE_PRESET.acceptanceProposal.positionBiasThreshold,
        verbosityBias: CALIBRATE_PRESET.acceptanceProposal.verbosityBiasThreshold,
        sameFamilyPreference: CALIBRATE_PRESET.acceptanceProposal.sameFamilyPreferenceThreshold,
        disagreementRate: CALIBRATE_PRESET.acceptanceProposal.disagreementRateThreshold,
        repeatedRunFlipRate: CALIBRATE_PRESET.acceptanceProposal.repeatedRunFlipRateThreshold,
        anchorOrdering: CALIBRATE_PRESET.acceptanceProposal.anchorOrderingThreshold,
      },
      anchorRepeats: 3,
    });
    // Verify active registry is unchanged.
    const activeAfter = await loadActiveRegistry(projectRoot);
    assertActiveRegistryUnchanged(activeBefore, activeAfter);
    // Verify calibration artifact invariants.
    const violations = verifyCalibrationArtifactInvariants(result.artifact);
    if (violations.length > 0) {
      throw new EvaluationValidationError(
        `calibration artifact 不变式违反: ${violations.join("; ")}`,
      );
    }
    if (jsonFlag) {
      output({
        event: "calibration_completed",
        runId,
        calibrationId: result.artifact.calibrationId,
        passed: result.artifact.passed,
        partial: result.artifact.partial,
        candidateCount: result.candidateStandards.length,
        conflictCount: result.standardConflicts.length,
        anyEligibleForPromotion: result.artifact.promotionEligibility.anyEligible,
        activeRegistryFingerprint: result.artifact.activeRegistryFingerprint,
        candidateRegistryFingerprint: result.artifact.candidateRegistryFingerprint,
        integritySha256: result.artifact.integritySha256,
        published: result.published,
      });
    } else {
      process.stdout.write(
        `校准完成: ${result.candidateStandards.length} 个候选标准, ${result.standardConflicts.length} 个冲突\n` +
        `  passed: ${result.artifact.passed}, partial: ${result.artifact.partial}\n` +
        `  active registry fingerprint 未改变\n` +
        `  integrity: ${result.artifact.integritySha256}\n`,
      );
    }
    process.exit(
      result.artifact.passed
        ? EXIT.passed
        : result.artifact.partial
          ? EXIT.partialBudget
          : EXIT.regression,
    );
    return;
  }

  if (command === "standard-conflicts") {
    if (args.length < 1) {
      throw new EvaluationValidationError("standard-conflicts 需要且只接受一个 run-id");
    }
    const runId = args[0]!;
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const store = await verifiedStore(projectRoot, runId);
    // Read the calibration artifact's standard conflicts.
    const calibrationPath = store.runDir + "/calibration-artifact.json";
    let conflicts: unknown[];
    try {
      const content = await readFile(calibrationPath, "utf-8");
      const artifact = JSON.parse(content) as { standardConflicts?: unknown[] };
      conflicts = artifact.standardConflicts ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EvaluationValidationError(
          `run ${runId} 没有 calibration-artifact.json; 请先运行 calibrate 命令`,
        );
      }
      throw error;
    }
    if (jsonFlag) {
      output({
        event: "standard_conflicts_list",
        runId,
        count: conflicts.length,
        conflicts,
      });
    } else {
      process.stdout.write(`Run ${runId} 包含 ${conflicts.length} 个 standard conflict:\n`);
      for (const c of conflicts) {
        const conflict = c as { conflictId: string; severity: string; resolutionStatus: string };
        process.stdout.write(
          `  - ${conflict.conflictId} [${conflict.severity}] status=${conflict.resolutionStatus}\n`,
        );
      }
    }
    process.exit(EXIT.passed);
    return;
  }

  if (command === "promote-standard") {
    // This command builds a promotion approval record from an explicit
    // Robert instruction. It does NOT claim cryptographic identity
    // authentication. The caller is responsible for:
    //  1. Receiving an explicit instruction from Robert.
    //  2. Computing the new active registry state via
    //     `applyPromotionApproval` from `standards-registry.ts`.
    //  3. Writing the new active registry file to Git via a reviewable
    //     diff (path + commit).
    //
    // This CLI command ONLY produces the approval record and publishes
    // it as an immutable artifact. The actual active registry mutation
    // happens via Git, not via this command.
    const candidateId = parseOptionalValue(args, "--candidate-id");
    if (!candidateId) {
      throw new EvaluationValidationError("promote-standard 需要 --candidate-id <id>");
    }
    const approverRobert = parsedArgsHasFlag(args, "--approver-robert");
    if (!approverRobert) {
      throw new EvaluationValidationError(
        "promote-standard 必须显式声明 --approver-robert; 未显式 Robert 指令禁止 promotion",
      );
    }
    const diffPath = parseOptionalValue(args, "--diff-path");
    if (!diffPath) {
      throw new EvaluationValidationError("promote-standard 需要 --diff-path <path>");
    }
    const commit = parseOptionalValue(args, "--commit");
    if (!commit) {
      throw new EvaluationValidationError("promote-standard 需要 --commit <sha>");
    }
    const beforeFingerprint = parseOptionalValue(args, "--before-fingerprint");
    const afterFingerprint = parseOptionalValue(args, "--after-fingerprint");
    if (!beforeFingerprint || !afterFingerprint) {
      throw new EvaluationValidationError(
        "promote-standard 需要 --before-fingerprint 与 --after-fingerprint",
      );
    }
    const runId = parseOptionalValue(args, "--run-id") ?? `promotion_${Date.now()}`;
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const store = await verifiedStore(projectRoot, runId);
    // Build the approval record.
    const approval = buildPromotionApproval({
      candidateId,
      approverInstruction: `Robert 显式指令: promote candidate ${candidateId} to active`,
      diffPath,
      commit,
      beforeActiveFingerprint: beforeFingerprint,
      afterActiveFingerprint: afterFingerprint,
      resolvedConflictIds: [],
    });
    // Publish the approval record as an immutable artifact.
    const published = await store.publishPromotionApproval(approval, approval.approvalId);
    if (jsonFlag) {
      output({
        event: "promotion_approval_recorded",
        runId,
        approvalId: approval.approvalId,
        candidateId: approval.candidateId,
        approverInstruction: approval.approverInstruction,
        reviewableDiff: approval.reviewableDiff,
        beforeActiveFingerprint: approval.beforeActiveFingerprint,
        afterActiveFingerprint: approval.afterActiveFingerprint,
        published,
        note: "此命令仅记录 approval record; 实际 active registry 修改通过 Git diff 完成",
      });
    } else {
      process.stdout.write(
        `Promotion approval 已记录: ${approval.approvalId}\n` +
        `  candidate: ${approval.candidateId}\n` +
        `  diff: ${approval.reviewableDiff.diffPath} @ ${approval.reviewableDiff.commit}\n` +
        `  before: ${approval.beforeActiveFingerprint}\n` +
        `  after: ${approval.afterActiveFingerprint}\n`,
      );
    }
    process.exit(EXIT.passed);
    return;
  }

  if (command === "active-registry") {
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const registry = await loadActiveRegistry(projectRoot);
    if (jsonFlag) {
      output({
        event: "active_registry",
        registry,
      });
    } else {
      process.stdout.write(
        `Active standards registry: ${registry.registryId}\n` +
        `  entries: ${registry.entries.length}\n` +
        `  fingerprint: ${registry.fingerprint}\n` +
        `  updatedAt: ${registry.updatedAt}\n`,
      );
    }
    process.exit(EXIT.passed);
    return;
  }

  if (command === "candidate-registry") {
    if (args.length < 1) {
      throw new EvaluationValidationError("candidate-registry 需要且只接受一个 run-id");
    }
    const runId = args[0]!;
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const store = await verifiedStore(projectRoot, runId);
    const candidatePath = store.runDir + "/candidate-registry.json";
    let registry: unknown;
    try {
      const content = await readFile(candidatePath, "utf-8");
      registry = JSON.parse(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EvaluationValidationError(
          `run ${runId} 没有 candidate-registry.json; 请先运行 calibrate 命令`,
        );
      }
      throw error;
    }
    if (jsonFlag) {
      output({
        event: "candidate_registry",
        runId,
        registry,
      });
    } else {
      const reg = registry as { registryId: string; entries: unknown[]; fingerprint: string };
      process.stdout.write(
        `Candidate standards registry for run ${runId}: ${reg.registryId}\n` +
        `  entries: ${reg.entries.length}\n` +
        `  fingerprint: ${reg.fingerprint}\n`,
      );
    }
    process.exit(EXIT.passed);
    return;
  }

  if (command === "conflict-catalog") {
    const jsonFlag = parsedArgsHasFlag(args, "--json");
    const verification = verifyConflictCatalog();
    if (!verification.complete) {
      output({
        event: "conflict_catalog_invalid",
        missingPatterns: verification.missingPatterns,
      });
      process.exit(EXIT.validation);
      return;
    }
    if (jsonFlag) {
      output({
        event: "conflict_catalog_valid",
        complete: verification.complete,
      });
    } else {
      process.stdout.write("Standard conflict catalog 验证通过 (6 patterns)\n");
    }
    process.exit(EXIT.passed);
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

/** T46-4 (Issue #97) — parse an optional flag with a value. Returns
 *  undefined when the flag is absent. */
function parseOptionalValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new EvaluationValidationError(`${flag} 需要一个值`);
  }
  return value;
}

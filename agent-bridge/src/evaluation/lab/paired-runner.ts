import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { EvaluationArtifact, EvaluationBudget, ScenarioContract } from "./contract.js";
import type { OperationalMetrics, PairedComparisonResult, ResolvedModelIdentity } from "./contract-v3.js";
import { EvaluationInfrastructureError, EvaluationValidationError } from "./errors.js";
import { buildManifest, buildResult, buildSide, verifyAlignment, verifyIsolation } from "./paired-comparison.js";
import { runEvaluation } from "./runner.js";
import { sha256 } from "./validation.js";

const execFileAsync = promisify(execFile);
const SAFE_REF = /^[A-Za-z0-9_./@{}~^:+-]+$/;

interface PairRuntimeMetadata {
  backendPort: number;
  sidecarPort: number;
  nonce: string;
  instanceId: string;
  databasePath: string;
  tempRoot: string;
  artifactStagingDir: string;
  resolvedModel: ResolvedModelIdentity | null;
}

export interface RunPairedComparisonOptions {
  projectRoot: string;
  candidateRef: string;
  baselineRef: string;
  preset: string;
  model: string;
  scenarios: ScenarioContract[];
  budget: EvaluationBudget;
}

export interface RunPairedComparisonOutput {
  result: PairedComparisonResult;
  artifactPath: string;
  sha256: string;
}

async function git(projectRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new EvaluationInfrastructureError(`git 命令失败: git ${args.join(" ")}: ${detail}`, { cause: error });
  }
}

async function linkDependencies(sourceRoot: string, worktreeRoot: string): Promise<void> {
  const links = [
    [resolve(sourceRoot, "backend/.venv"), resolve(worktreeRoot, "backend/.venv")],
    [resolve(sourceRoot, "agent-bridge/node_modules"), resolve(worktreeRoot, "agent-bridge/node_modules")],
  ] as const;
  for (const [source, target] of links) {
    try {
      await symlink(source, target, "junction");
    } catch (error) {
      throw new EvaluationInfrastructureError(`无法为隔离 worktree 链接只读依赖: ${target}`, { cause: error });
    }
  }
}

function requireMetrics(artifact: EvaluationArtifact): OperationalMetrics {
  const metrics = artifact.v3?.operationalMetrics?.aggregate;
  if (metrics) return metrics;
  return {
    latencyMs: artifact.summary.wallTimeMs,
    inputTokens: artifact.summary.totalInputTokens,
    outputTokens: artifact.summary.totalOutputTokens,
    sutCostUsd: artifact.summary.sutCost.amountUsd ?? 0,
    evaluatorModelCostUsd: artifact.summary.evaluatorModelCost.amountUsd ?? undefined,
    codingAgentCostUsd: artifact.summary.codingAgentCost.amountUsd,
    toolCalls: artifact.observations.reduce((sum, observation) => sum + observation.evidence.length, 0),
    agentRetries: 0,
    infrastructureAttempts: artifact.observations.length,
    timeouts: 0,
    skipped: 0,
    excluded: 0,
    simulatorErrors: 0,
    infrastructureErrors: 0,
  };
}

async function runSide(input: {
  label: "candidate" | "baseline";
  projectRoot: string;
  worktreePath: string;
  ref: string;
  preset: string;
  model: string;
  scenarios: ScenarioContract[];
  budget: EvaluationBudget;
}): Promise<{ artifact: EvaluationArtifact; metadata: PairRuntimeMetadata; commit: string }> {
  await git(input.projectRoot, ["worktree", "add", "--detach", input.worktreePath, input.ref]);
  await linkDependencies(input.projectRoot, input.worktreePath);
  const commit = await git(input.worktreePath, ["rev-parse", "HEAD"]);
  let metadata: PairRuntimeMetadata | undefined;
  const runId = `pair_${input.label}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const artifact = await runEvaluation({
    projectRoot: input.worktreePath,
    runId,
    preset: input.preset,
    model: input.model,
    scenarios: input.scenarios,
    budget: input.budget,
    resume: false,
    onPairStarted: (value) => { metadata = value; },
  });
  if (!metadata) {
    throw new EvaluationInfrastructureError(`${input.label} 未记录 runtime pair 身份`);
  }
  return { artifact, metadata, commit };
}

export async function runPairedComparison(
  options: RunPairedComparisonOptions,
): Promise<RunPairedComparisonOutput> {
  for (const [label, ref] of [["candidate", options.candidateRef], ["baseline", options.baselineRef]] as const) {
    if (!SAFE_REF.test(ref) || ref.startsWith("-")) {
      throw new EvaluationValidationError(`${label} ref 格式不安全: ${ref}`);
    }
    await git(options.projectRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  }

  const comparisonRoot = await mkdtemp(join(tmpdir(), "projectflow-paired-"));
  const candidatePath = join(comparisonRoot, "candidate");
  const baselinePath = join(comparisonRoot, "baseline");
  let candidate: Awaited<ReturnType<typeof runSide>> | undefined;
  let baseline: Awaited<ReturnType<typeof runSide>> | undefined;
  try {
    candidate = await runSide({
      label: "candidate",
      projectRoot: options.projectRoot,
      worktreePath: candidatePath,
      ref: options.candidateRef,
      preset: options.preset,
      model: options.model,
      scenarios: options.scenarios,
      budget: options.budget,
    });
    baseline = await runSide({
      label: "baseline",
      projectRoot: options.projectRoot,
      worktreePath: baselinePath,
      ref: options.baselineRef,
      preset: options.preset,
      model: options.model,
      scenarios: options.scenarios,
      budget: options.budget,
    });

    const side = (value: typeof candidate, label: "candidate" | "baseline", worktreePath: string) => {
      if (!value) throw new EvaluationInfrastructureError(`${label} 没有运行结果`);
      return buildSide({
        label,
        worktreePath,
        backendPort: value.metadata.backendPort,
        sidecarPort: value.metadata.sidecarPort,
        nonce: value.metadata.nonce,
        instanceId: value.metadata.instanceId,
        databasePath: value.metadata.databasePath,
        tempRoot: value.metadata.tempRoot,
        artifactStagingDir: value.metadata.artifactStagingDir,
        resolvedModel: value.metadata.resolvedModel,
        gitCommit: value.commit,
        worktreeSha256: sha256(`${value.commit}\nclean`),
      });
    };
    const scenarioManifestSha256 = sha256(JSON.stringify(options.scenarios));
    const fixtureSource = await readFile(resolve(options.projectRoot, "agent-bridge/src/evaluation/fixture-provisioner.ts"), "utf8");
    const manifest = buildManifest({
      candidate: side(candidate, "candidate", candidatePath),
      baseline: side(baseline, "baseline", baselinePath),
      scenarioManifestSha256,
      seedManifestSha256: sha256(fixtureSource),
      frozenStandardsVersion: "T46-Slice1-v1",
      evaluatorVersion: "T46-3-v1",
    });
    const violations = [
      ...verifyIsolation(manifest.candidate, manifest.baseline),
      ...verifyAlignment(manifest),
    ];
    if (violations.length > 0) {
      throw new EvaluationInfrastructureError(`paired comparison 隔离或对齐失败: ${violations.join("; ")}`);
    }
    const candidateGrades = new Map(candidate.artifact.grades.map((grade) => [grade.scenarioId, grade.passed]));
    const baselineGrades = new Map(baseline.artifact.grades.map((grade) => [grade.scenarioId, grade.passed]));
    const result = buildResult({
      manifest,
      perScenario: options.scenarios.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        candidatePassed: candidateGrades.get(scenario.scenarioId) ?? false,
        baselinePassed: baselineGrades.get(scenario.scenarioId) ?? false,
      })),
      candidateMetrics: requireMetrics(candidate.artifact),
      baselineMetrics: requireMetrics(baseline.artifact),
    });
    const artifactDir = resolve(options.projectRoot, "agent-bridge/artifacts/paired");
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, `${manifest.id}.json`);
    const tempPath = `${artifactPath}.tmp`;
    const payload = `${JSON.stringify(result, null, 2)}\n`;
    await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, artifactPath);
    return { result, artifactPath, sha256: sha256(payload) };
  } finally {
    for (const path of [candidatePath, baselinePath]) {
      await git(options.projectRoot, ["worktree", "remove", "--force", path]).catch(() => undefined);
    }
    await rm(comparisonRoot, { recursive: true, force: true });
    await git(options.projectRoot, ["worktree", "prune"]).catch(() => undefined);
  }
}

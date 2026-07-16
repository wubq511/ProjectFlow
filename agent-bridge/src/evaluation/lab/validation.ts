import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { arch, platform } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  EVALUATION_SCHEMA_VERSION,
  EVALUATOR_VERSION,
  type CodeFingerprint,
  type EvaluationBudget,
  type EvaluationProvenance,
  type ScenarioContract,
} from "./contract.js";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationResult {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  valid: boolean;
  model: string;
  scenarioCount: number;
  checks: {
    scenarioContracts: boolean;
    budgetCompatibility: boolean;
    modelCompatibility: boolean;
    toolchain: boolean;
  };
  errors: ValidationIssue[];
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
    return `{${entries.join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function validateScenario(scenario: ScenarioContract): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (code: string, message: string) => errors.push({ code, message });

  if (scenario.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
    add("scenario_schema_version", `场景 ${scenario.scenarioId || "<unknown>"} schemaVersion 必须为 1`);
  }
  if (!SAFE_ID.test(scenario.scenarioId)) {
    add("scenario_id", `场景 ID ${JSON.stringify(scenario.scenarioId)} 只能包含字母、数字、下划线和连字符`);
  }
  if (!scenario.visible?.prompt?.trim()) {
    add("scenario_prompt", `场景 ${scenario.scenarioId} 的 visible.prompt 不能为空`);
  }
  if (!scenario.hidden || !["answer", "action"].includes(scenario.hidden.expectedMode)) {
    add("scenario_expected_mode", `场景 ${scenario.scenarioId} 的 expectedMode 无效`);
    return errors;
  }
  if (!Number.isFinite(scenario.hidden.maxLatencyMs) || scenario.hidden.maxLatencyMs <= 0) {
    add("scenario_latency", `场景 ${scenario.scenarioId} 的 maxLatencyMs 必须为正数`);
  }
  if (!Number.isInteger(scenario.hidden.maxRequestCount) || scenario.hidden.maxRequestCount <= 0) {
    add("scenario_requests", `场景 ${scenario.scenarioId} 的 maxRequestCount 必须为正整数`);
  }
  const tokens = scenario.hidden.tokenBudget;
  if (!tokens || !Number.isInteger(tokens.maxInputTokens) || tokens.maxInputTokens <= 0) {
    add("scenario_input_tokens", `场景 ${scenario.scenarioId} 的 maxInputTokens 必须为正整数`);
  }
  if (!tokens || !Number.isInteger(tokens.maxOutputTokens) || tokens.maxOutputTokens <= 0) {
    add("scenario_output_tokens", `场景 ${scenario.scenarioId} 的 maxOutputTokens 必须为正整数`);
  }
  for (const pattern of scenario.hidden.forbiddenOutputPatterns ?? []) {
    try {
      new RegExp(pattern, "i");
    } catch {
      add("scenario_regex", `场景 ${scenario.scenarioId} 包含无效的 forbiddenOutputPatterns 正则`);
    }
  }
  return errors;
}

function validateBudget(budget: EvaluationBudget, scenarios: ScenarioContract[]): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const add = (code: string, message: string) => errors.push({ code, message });
  const positiveFields: Array<[keyof EvaluationBudget, number]> = [
    ["maxSutCostUsd", budget.maxSutCostUsd],
    ["maxInputTokens", budget.maxInputTokens],
    ["maxOutputTokens", budget.maxOutputTokens],
    ["maxRequestCount", budget.maxRequestCount],
    ["maxWallTimeMs", budget.maxWallTimeMs],
    ["maxObservations", budget.maxObservations],
  ];
  for (const [field, value] of positiveFields) {
    if (!Number.isFinite(value) || value <= 0) {
      add("budget_value", `预算字段 ${field} 必须为正数`);
    }
  }
  for (const field of ["maxInputTokens", "maxOutputTokens", "maxRequestCount", "maxWallTimeMs", "maxObservations"] as const) {
    if (!Number.isInteger(budget[field])) {
      add("budget_integer", `预算字段 ${field} 必须为整数`);
    }
  }
  if (budget.maxSutCostUsd > 0.10) {
    add("budget_smoke_cost", "Slice 0 smoke 的 ProjectFlow Agent 成本上限不得超过 $0.10");
  }
  if (scenarios.length > budget.maxObservations) {
    add("budget_observations", "场景数量超过 maxObservations");
  }
  for (const scenario of scenarios) {
    if (scenario.hidden.maxLatencyMs > budget.maxWallTimeMs) {
      add("budget_wall_time", `场景 ${scenario.scenarioId} 的延迟上限超过 run wall-time 上限`);
    }
    if (scenario.hidden.maxRequestCount > budget.maxRequestCount) {
      add("budget_requests", `场景 ${scenario.scenarioId} 的请求上限超过 run 请求上限`);
    }
    if (scenario.hidden.tokenBudget.maxInputTokens > budget.maxInputTokens) {
      add("budget_input_tokens", `场景 ${scenario.scenarioId} 的输入 Token 上限超过 run 上限`);
    }
    if (scenario.hidden.tokenBudget.maxOutputTokens > budget.maxOutputTokens) {
      add("budget_output_tokens", `场景 ${scenario.scenarioId} 的输出 Token 上限超过 run 上限`);
    }
  }
  return errors;
}

interface ModelConfigFile {
  models?: Array<{
    id?: string;
    provider?: string;
    name?: string;
    displayName?: string;
    apiKeyEnvVar?: string;
    isDefault?: boolean;
    capabilities?: unknown;
  }>;
}

async function validateModel(projectRoot: string, model: string): Promise<ValidationIssue[]> {
  const errors: ValidationIssue[] = [];
  const separator = model.indexOf(":");
  if (separator <= 0 || separator === model.length - 1) {
    return [{ code: "model_ref", message: `模型引用 ${JSON.stringify(model)} 必须使用 provider:name 格式` }];
  }
  const provider = model.slice(0, separator);
  const name = model.slice(separator + 1);
  const path = join(projectRoot, "agent-bridge", "model-configs.json");
  let parsed: ModelConfigFile;
  try {
    parsed = JSON.parse(await readFile(path, "utf-8")) as ModelConfigFile;
  } catch (error) {
    return [{ code: "model_config", message: `无法读取 model-configs.json: ${(error as Error).message}` }];
  }
  if (!Array.isArray(parsed.models)) {
    return [{ code: "model_config_schema", message: "model-configs.json 缺少 models 数组" }];
  }
  if (parsed.models.length === 0) {
    return [{ code: "model_config_schema", message: "model-configs.json 的 models 不能为空" }];
  }
  const ids = new Set<string>();
  const refs = new Set<string>();
  for (const [index, candidate] of parsed.models.entries()) {
    if (
      typeof candidate.id !== "string" || !candidate.id
      || typeof candidate.provider !== "string" || !candidate.provider
      || typeof candidate.name !== "string" || !candidate.name
      || typeof candidate.displayName !== "string" || !candidate.displayName
      || typeof candidate.apiKeyEnvVar !== "string"
      || typeof candidate.isDefault !== "boolean"
      || !candidate.capabilities || typeof candidate.capabilities !== "object"
    ) {
      errors.push({ code: "model_config_schema", message: `models[${index}] 字段结构不完整` });
      continue;
    }
    const ref = `${candidate.provider}:${candidate.name}`;
    if (ids.has(candidate.id)) {
      errors.push({ code: "model_config_duplicate", message: `模型配置 ID 重复: ${candidate.id}` });
    }
    if (refs.has(ref)) {
      errors.push({ code: "model_config_duplicate", message: `模型引用重复: ${ref}` });
    }
    ids.add(candidate.id);
    refs.add(ref);
  }
  if (parsed.models.filter((candidate) => candidate.isDefault).length !== 1) {
    errors.push({ code: "model_config_default", message: "model-configs.json 必须声明且只声明一个默认模型" });
  }
  const entry = parsed.models.find((candidate) => candidate.provider === provider && candidate.name === name);
  if (!entry) {
    errors.push({ code: "model_unknown", message: `模型 ${model} 未在 model-configs.json 注册` });
    return errors;
  }
  if (provider !== "mock") {
    errors.push({
      code: "paid_model_unbounded",
      message: `Slice 0 尚无 ${model} 的冻结价格表与调用前最坏成本预估，拒绝启动付费模型`,
    });
  }
  return errors;
}

async function validateToolchain(projectRoot: string): Promise<ValidationIssue[]> {
  const errors: ValidationIssue[] = [];
  if (process.versions.node !== "24.15.0") {
    errors.push({ code: "node_version", message: `Node.js ${process.versions.node} 不匹配，必须使用仓库锁定版本 24.15.0` });
  }
  const python = join(projectRoot, "backend", ".venv", "bin", "python");
  try {
    await access(python, constants.X_OK);
  } catch {
    errors.push({ code: "python_venv", message: "缺少可执行的 backend/.venv/bin/python" });
  }
  const tsx = join(projectRoot, "agent-bridge", "node_modules", ".bin", "tsx");
  try {
    await access(tsx, constants.X_OK);
  } catch {
    errors.push({ code: "tsx_runtime", message: "agent-bridge 本地 tsx 不可用，请先安装锁定依赖" });
  }
  return errors;
}

export async function validateEvaluationConfig(options: {
  projectRoot: string;
  model: string;
  scenarios: ScenarioContract[];
  budget: EvaluationBudget;
}): Promise<ValidationResult> {
  const scenarioErrors = options.scenarios.flatMap(validateScenario);
  const duplicateIds = options.scenarios
    .map((scenario) => scenario.scenarioId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    scenarioErrors.push({ code: "scenario_duplicate", message: `场景 ID 重复: ${[...new Set(duplicateIds)].join(", ")}` });
  }
  const budgetErrors = validateBudget(options.budget, options.scenarios);
  const modelErrors = await validateModel(options.projectRoot, options.model);
  const toolchainErrors = await validateToolchain(options.projectRoot);
  const errors = [...scenarioErrors, ...budgetErrors, ...modelErrors, ...toolchainErrors];
  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    valid: errors.length === 0,
    model: options.model,
    scenarioCount: options.scenarios.length,
    checks: {
      scenarioContracts: scenarioErrors.length === 0,
      budgetCompatibility: budgetErrors.length === 0,
      modelCompatibility: modelErrors.length === 0,
      toolchain: toolchainErrors.length === 0,
    },
    errors,
  };
}

function git(projectRoot: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", projectRoot, ...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function collectCodeFingerprint(projectRoot: string): CodeFingerprint {
  const commit = git(projectRoot, ["rev-parse", "HEAD"]).toString("utf-8").trim();
  const status = git(projectRoot, ["status", "--porcelain=v1", "-z"]);
  const trackedDiff = git(projectRoot, ["diff", "--binary", "HEAD"]);
  const untracked = git(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf-8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedHashes = untracked.map((path) => {
    const absolute = resolve(projectRoot, path);
    if (!isAbsolute(absolute) || relative(projectRoot, absolute).startsWith("..")) {
      throw new Error(`无法对工作树外文件生成指纹: ${path}`);
    }
    const stat = lstatSync(absolute);
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    return `${path}:${sha256(content)}`;
  });
  const fingerprint = Buffer.concat([
    Buffer.from(commit),
    status,
    trackedDiff,
    Buffer.from(untrackedHashes.join("\n")),
  ]);
  return {
    gitCommit: commit,
    gitDirty: status.length > 0,
    worktreeSha256: sha256(fingerprint),
  };
}

export async function buildProvenance(options: {
  projectRoot: string;
  scenarios: ScenarioContract[];
}): Promise<EvaluationProvenance> {
  const modelConfigRaw = await readFile(join(options.projectRoot, "agent-bridge", "model-configs.json"));
  return {
    evaluatorVersion: EVALUATOR_VERSION,
    publicSeamVersion: "http-sse-v1",
    platform: platform(),
    architecture: arch(),
    nodeVersion: process.versions.node,
    code: collectCodeFingerprint(options.projectRoot),
    scenarioContractsSha256: sha256(stableStringify(options.scenarios)),
    modelConfigSha256: sha256(modelConfigRaw),
  };
}

#!/usr/bin/env node
import { resolve, join, dirname } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { runEvaluation, InfrastructureError } from "./runner.js";
import type { ScenarioContract } from "./contract.js";

const SMOKE_SCENARIOS: ScenarioContract[] = [
  {
    schemaVersion: 1,
    scenarioId: "answer-no-tool",
    visible: {
      prompt: "解释当前项目下一步为什么重要，不要修改任何内容",
    },
    hidden: {
      expectedMode: "answer",
      maxLatencyMs: 30000,
    },
  }
];

const PRESETS: Record<string, ScenarioContract[]> = {
  smoke: SMOKE_SCENARIOS,
  demo: SMOKE_SCENARIOS,
};

function printUsage() {
  console.log("用法:");
  console.log("  scripts/npm --prefix agent-bridge run eval:list                      (列出所有评测场景)");
  console.log("  scripts/npm --prefix agent-bridge run eval:validate                  (校验评测配置与工具链)");
  console.log("  scripts/npm --prefix agent-bridge run eval:run -- [参数]              (运行评测套件)");
  console.log("  scripts/npm --prefix agent-bridge run eval:show -- <运行ID>           (展示运行的 JSON 报告)");
  console.log("  scripts/npm --prefix agent-bridge run eval:run -- status <运行ID>     (查询运行状态)");
  console.log("\n参数:");
  console.log("  --preset <smoke|demo>      (评测预设，默认为 smoke)");
  console.log("  --scenario <ID>            (指定只运行某一个场景 ID)");
  console.log("  --model <模型ID>            (指定运行模型，默认为 mock:mock-model)");
  console.log("  --run-id <ID>              (自定义运行 ID，默认为自动生成的格式)");
  console.log("  --resume                   (如果中断，恢复之前的进度运行)");
  console.log("  --json                     (以机器可读的 JSON 格式流式输出执行进度)");
}

function validateScenarioStructure(scenario: any): string[] {
  const errors: string[] = [];
  if (!scenario.scenarioId || typeof scenario.scenarioId !== "string") {
    errors.push("场景缺少合法的 scenarioId");
  } else if (!/^[a-zA-Z0-9_\-]+$/.test(scenario.scenarioId)) {
    errors.push(`场景 ID "${scenario.scenarioId}" 格式错误: 仅允许字母、数字、下划线及横线，不能包含路径穿透字符`);
  }
  if (!scenario.visible || typeof scenario.visible.prompt !== "string" || !scenario.visible.prompt.trim()) {
    errors.push("场景 visible.prompt 不能为空");
  }
  if (!scenario.hidden) {
    errors.push("场景缺少 hidden 参数块");
  } else {
    const hidden = scenario.hidden;
    if (hidden.expectedMode !== "answer" && hidden.expectedMode !== "action") {
      errors.push(`场景 hidden.expectedMode 无效: "${hidden.expectedMode}"，仅允许 "answer" 或 "action"`);
    }
    if (typeof hidden.maxLatencyMs !== "number" || hidden.maxLatencyMs <= 0) {
      errors.push(`场景 hidden.maxLatencyMs 必须为正整数: "${hidden.maxLatencyMs}"`);
    }
    if (hidden.maxLatencyMs > 180000) {
      errors.push(`场景最大延迟 ${hidden.maxLatencyMs}ms 超出 SUT 评估的安全极限 180000ms`);
    }
  }
  return errors;
}

async function checkToolchains(projectRoot: string): Promise<string[]> {
  const errors: string[] = [];
  try {
    execSync("node --version", { encoding: "utf-8" });
  } catch {
    errors.push("Node.js 运行环境不可用，请确保 node 可执行文件在 PATH 中");
  }
  try {
    const pythonCmd = platform() === "win32" ? "python" : ".venv/bin/python";
    execSync(`${join(projectRoot, "backend", pythonCmd)} --version`, { encoding: "utf-8" });
  } catch {
    errors.push("Python 虚拟环境不可用，请确保 backend/.venv 已正确创建并安装依赖");
  }
  return errors;
}

function platform(): string {
  return process.platform;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(3);
  }

  const command = args[0];
  let projectRoot = resolve(import.meta.dirname ?? process.cwd());
  while (projectRoot && !existsSync(join(projectRoot, "CLAUDE.md"))) {
    const parent = dirname(projectRoot);
    if (parent === projectRoot) break;
    projectRoot = parent;
  }

  if (command === "list-scenarios") {
    console.log(JSON.stringify(SMOKE_SCENARIOS, null, 2));
    process.exit(0);
  }

  if (command === "validate") {
    console.log("正在执行零 Token 场景结构性校验...");
    let allValid = true;

    // 1. Check Scenario Config Structures
    for (const scenario of SMOKE_SCENARIOS) {
      const errs = validateScenarioStructure(scenario);
      if (errs.length > 0) {
        console.error(`❌ 场景 "${scenario.scenarioId}" 结构校验失败:`);
        errs.forEach((e) => console.error(`  - ${e}`));
        allValid = false;
      } else {
        console.log(`  - 场景 "${scenario.scenarioId}" [契约结构有效]`);
      }
    }

    // 2. Check model configs json
    const modelConfigsPath = join(projectRoot, "model-configs.json");
    if (!existsSync(modelConfigsPath)) {
      console.error("❌ 缺少模型配置文件 model-configs.json");
      allValid = false;
    } else {
      try {
        const configs = JSON.parse(await readFile(modelConfigsPath, "utf-8"));
        if (!configs || typeof configs !== "object") {
          console.error("❌ model-configs.json 必须是 JSON 对象格式");
          allValid = false;
        } else {
          console.log("  - 模型配置注册表 [结构合法]");
        }
      } catch (err: any) {
        console.error(`❌ 读取 model-configs.json 异常: ${err.message}`);
        allValid = false;
      }
    }

    // 3. Verify System Toolchain Binaries
    const toolchainErrors = await checkToolchains(projectRoot);
    if (toolchainErrors.length > 0) {
      console.error("❌ 基础设施工具链校验失败:");
      toolchainErrors.forEach((e) => console.error(`  - ${e}`));
      allValid = false;
    } else {
      console.log("  - 基础设施工具链 (Node/Python) [准备就绪]");
    }

    if (allValid) {
      console.log("🟢 零 Token 校验完成: 配置文件格式正确，运行工具链完整。");
      process.exit(0);
    } else {
      console.error("🔴 配置文件或工具链验证失败，拒绝执行评测。");
      process.exit(3); // Configuration error exit code
    }
  }

  if (command === "status") {
    const runId = args[1];
    if (!runId) {
      console.error("错误: 缺少运行 ID 参数。用法: eval:run status <运行ID>");
      process.exit(3);
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(runId)) {
      console.error("错误: 运行 ID 格式无效");
      process.exit(3);
    }

    const runDir = join(projectRoot, "agent-bridge/artifacts", runId);
    if (!existsSync(runDir)) {
      console.log(JSON.stringify({ runId, status: "unknown", message: "找不到该运行记录" }));
      process.exit(0);
    }

    const hasReport = existsSync(join(runDir, "report.json"));
    const hasManifest = existsSync(join(runDir, "manifest.json"));
    let completedCount = 0;
    try {
      if (existsSync(join(runDir, "observations"))) {
        completedCount = (await readdir(join(runDir, "observations"))).filter((f) => f.endsWith(".json")).length;
      }
    } catch {}

    const runStatus = hasReport ? "completed" : hasManifest ? "interrupted" : "running";
    console.log(JSON.stringify({
      runId,
      status: runStatus,
      completedScenarios: completedCount,
      reportExists: hasReport,
      manifestExists: hasManifest,
    }, null, 2));
    process.exit(0);
  }

  if (command === "show") {
    const runId = args[1];
    if (!runId) {
      console.error("错误: 缺少运行 ID 参数。用法: scripts/npm --prefix agent-bridge run eval:show -- <运行ID>");
      process.exit(3);
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(runId)) {
      console.error("错误: 运行 ID 格式无效，仅允许字母、数字、下划线和连字符");
      process.exit(3);
    }
    const reportPath = join(projectRoot, "agent-bridge/artifacts", runId, "report.json");
    if (!existsSync(reportPath)) {
      console.error(`错误: 未找到运行 ID "${runId}" 的评测报告。`);
      process.exit(2);
    }
    const content = await readFile(reportPath, "utf-8");
    console.log(content);
    process.exit(0);
  }

  if (command === "run") {
    let preset = "smoke";
    let scenarioId: string | null = null;
    let model = "mock:mock-model";
    let runId = `run_${Date.now()}`;
    let resume = false;
    let jsonMode = false;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--preset") {
        const val = args[i + 1];
        if (!val || !PRESETS[val]) {
          console.error(`错误: 未知的预设类型 "${val}"，仅支持: ${Object.keys(PRESETS).join(", ")}`);
          process.exit(3);
        }
        preset = val;
        i++;
      } else if (args[i] === "--scenario") {
        scenarioId = args[i + 1] ?? null;
        i++;
      } else if (args[i] === "--model") {
        model = args[i + 1] ?? "mock:mock-model";
        i++;
      } else if (args[i] === "--run-id") {
        runId = args[i + 1] ?? `run_${Date.now()}`;
        i++;
      } else if (args[i] === "--resume") {
        resume = true;
      } else if (args[i] === "--json") {
        jsonMode = true;
      }
    }

    if (!/^[a-zA-Z0-9_\-]+$/.test(runId)) {
      console.error("错误: 运行 ID 格式无效，仅允许字母、数字、下划线和连字符");
      process.exit(3);
    }

    const presetScenarios = PRESETS[preset] ?? SMOKE_SCENARIOS;
    let targetScenarios = presetScenarios;
    if (scenarioId) {
      targetScenarios = presetScenarios.filter((s) => s.scenarioId === scenarioId);
      if (targetScenarios.length === 0) {
        console.error(JSON.stringify({ error: "配置错误", message: `在预设 "${preset}" 中找不到场景 ID "${scenarioId}"` }));
        process.exit(3);
      }
    }

    try {
      if (!jsonMode) {
        console.log(`正在启动评测套件 [运行ID: ${runId}, 模型: ${model}, 预设: ${preset}]...`);
      } else {
        console.log(JSON.stringify({ event: "run_start", runId, model, preset }));
      }

      const artifact = await runEvaluation({
        projectRoot,
        runId,
        model,
        scenarios: targetScenarios,
        resume,
        onProgress: (scenId, status, res) => {
          if (jsonMode) {
            console.log(JSON.stringify({ event: "progress", scenarioId: scenId, status, passed: res?.grade.passed }));
          } else {
            if (status === "started") {
              console.log(`[进度] 场景 "${scenId}" 开始执行...`);
            } else {
              const passed = res?.grade.passed ? "成功 (SUCCESS)" : "失败 (FAIL)";
              console.log(`[进度] 场景 "${scenId}" 执行结束 [结果: ${passed}]`);
              if (res?.grade.failures && res.grade.failures.length > 0) {
                console.log(`  - 失败原因:`);
                res.grade.failures.forEach((f) => console.log(`    * ${f}`));
              }
            }
          }
        },
      });

      if (jsonMode) {
        console.log(JSON.stringify({ event: "run_complete", summary: artifact.summary }));
      } else {
        console.log("\n=================== 评测完成总结 ===================");
        console.log(`  运行 ID:     ${artifact.runId}`);
        console.log(`  评测模型:     ${artifact.model}`);
        console.log(`  场景总量:     ${artifact.observations.length}`);
        console.log(`  通过数量:     ${artifact.summary.passedCount}`);
        console.log(`  失败数量:     ${artifact.summary.failedCount}`);
        console.log(`  场景通过率:   ${(artifact.summary.passRate * 100).toFixed(2)}%`);
        console.log(`  生成报告路径: agent-bridge/artifacts/${runId}/report.json`);
        console.log("===================================================\n");
      }

      if (artifact.summary.passRate < 1.0) {
        process.exit(1); // SUT regression exit code
      }
      process.exit(0);
    } catch (err: any) {
      if (err instanceof InfrastructureError) {
        if (jsonMode) {
          console.log(JSON.stringify({ event: "infrastructure_error", error: err.message }));
        } else {
          console.error(`🔴 基础设施异常中断: ${err.message}`);
        }
        process.exit(2); // Infrastructure exit code
      } else {
        if (jsonMode) {
          console.log(JSON.stringify({ event: "error", error: err?.message || String(err) }));
        } else {
          console.error(`🔴 评测套件运行遇到致命异常: ${err?.message || String(err)}`);
        }
        process.exit(2); // General setup/infra error is exit code 2
      }
    }
  }

  printUsage();
  process.exit(3);
}

main().catch((err) => {
  console.error("未捕获的 CLI 致命异常:", err);
  process.exit(2);
});

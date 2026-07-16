#!/usr/bin/env node
import { resolve, join, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { runEvaluation } from "./runner.js";
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

// Presets registry
const PRESETS: Record<string, ScenarioContract[]> = {
  smoke: SMOKE_SCENARIOS,
  demo: SMOKE_SCENARIOS, // In Slice 0, presets resolve to SMOKE_SCENARIOS as unified scenario base
};

function printUsage() {
  console.log("用法:");
  console.log("  npm run eval:list                      (列出所有评测场景)");
  console.log("  npm run eval:validate                  (校验评测场景配置文件，零 Token 消耗)");
  console.log("  npm run eval:run -- [参数]              (运行评测套件)");
  console.log("  npm run eval:show -- <运行ID>           (展示特定运行的 JSON 报告)");
  console.log("\n参数:");
  console.log("  --preset <smoke|demo>      (评测预设，默认为 smoke)");
  console.log("  --scenario <ID>            (指定只运行某一个场景 ID)");
  console.log("  --model <模型ID>            (指定运行模型，默认为 mock:mock-model)");
  console.log("  --run-id <ID>              (自定义运行 ID，默认为自动生成的格式)");
  console.log("  --resume                   (如果中断，恢复之前的进度运行)");
}

function validateScenarioStructure(scenario: any): string[] {
  const errors: string[] = [];
  if (!scenario.scenarioId || typeof scenario.scenarioId !== "string") {
    errors.push("场景缺少合法的 scenarioId");
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
  }
  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(3); // 配置/校验错误
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
    for (const scenario of SMOKE_SCENARIOS) {
      const errs = validateScenarioStructure(scenario);
      if (errs.length > 0) {
        console.error(`❌ 场景 "${scenario.scenarioId}" 结构无效:`);
        errs.forEach((e) => console.error(`  - ${e}`));
        allValid = false;
      } else {
        console.log(`  - 场景 "${scenario.scenarioId}" [验证通过]`);
      }
    }
    if (allValid) {
      console.log("🟢 配置文件合法性校验通过，无逻辑缺陷。");
      process.exit(0);
    } else {
      console.error("🔴 配置文件校验失败，请检查结构定义。");
      process.exit(3);
    }
  }

  if (command === "show") {
    const runId = args[1];
    if (!runId) {
      console.error("错误: 缺少运行 ID 参数。用法: npm run eval:show -- <运行ID>");
      process.exit(3);
    }
    // Prevent directory traversal
    if (!/^[a-zA-Z0-9_\-]+$/.test(runId)) {
      console.error("错误: 运行 ID 格式无效，仅允许字母、数字、下划线和连字符");
      process.exit(3);
    }
    const reportPath = join(projectRoot, "agent-bridge/artifacts", runId, "report.json");
    if (!existsSync(reportPath)) {
      console.error(`错误: 未找到运行 ID "${runId}" 的评测报告。`);
      process.exit(2); // 基础设施或找不到文件错误
    }
    const content = await readFile(reportPath, "utf-8");
    console.log(content);
    process.exit(0);
  }

  if (command === "run") {
    // Parse arguments
    let preset = "smoke";
    let scenarioId: string | null = null;
    let model = "mock:mock-model";
    let runId = `run_${Date.now()}`;
    let resume = false;

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
      }
    }

    // Validate runId path safety
    if (!/^[a-zA-Z0-9_\-]+$/.test(runId)) {
      console.error("错误: 运行 ID 格式无效，仅允许字母、数字、下划线和连字符");
      process.exit(3);
    }

    // Resolve scenario list based on preset
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
      console.log(`正在启动评测套件 [运行ID: ${runId}, 模型: ${model}, 预设: ${preset}]...`);

      const artifact = await runEvaluation({
        projectRoot,
        runId,
        model,
        scenarios: targetScenarios,
        resume,
        onProgress: (scenId, status, res) => {
          if (status === "started") {
            console.log(`[进度] 场景 "${scenId}" 开始执行...`);
          } else {
            const passed = res?.grade.passed ? "SUCCESS" : "FAIL";
            console.log(`[进度] 场景 "${scenId}" 执行结束 [结果: ${passed}]`);
            if (res?.grade.failures && res.grade.failures.length > 0) {
              console.log(`  - 失败原因:`);
              res.grade.failures.forEach((f) => console.log(`    * ${f}`));
            }
          }
        },
      });

      // Bounded machine-readable summary output to stdout (P1)
      console.log("\n=================== 评测完成总结 ===================");
      console.log(`  运行 ID:     ${artifact.runId}`);
      console.log(`  评测模型:     ${artifact.model}`);
      console.log(`  场景总量:     ${artifact.observations.length}`);
      console.log(`  通过数量:     ${artifact.summary.passedCount}`);
      console.log(`  失败数量:     ${artifact.summary.failedCount}`);
      console.log(`  场景通过率:   ${(artifact.summary.passRate * 100).toFixed(2)}%`);
      console.log(`  生成报告路径: agent-bridge/artifacts/${runId}/report.json`);
      console.log("===================================================\n");

      if (artifact.summary.passRate < 1.0) {
        process.exit(1); // 评测用例失败/退化
      }
      process.exit(0);
    } catch (err: any) {
      console.error(JSON.stringify({ event: "error", error: err?.message || String(err) }));
      process.exit(2); // 评测套件执行基础设施错误
    }
  }

  printUsage();
  process.exit(3);
}

main().catch((err) => {
  console.error("未捕获的 CLI 致命异常:", err);
  process.exit(2);
});

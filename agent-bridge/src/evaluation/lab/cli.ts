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
    prompt: "解释当前项目下一步为什么重要，不要修改任何内容",
    expectedMode: "answer",
    maxLatencyMs: 30000,
  }
];

function printUsage() {
  console.log("Usage:");
  console.log("  node cli.js list-scenarios");
  console.log("  node cli.js run [--preset <smoke>] [--scenario <id>] [--model <model>] [--run-id <id>] [--resume]");
  console.log("  node cli.js show <run-id>");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(3); // Configuration/validation error
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

  if (command === "show") {
    const runId = args[1];
    if (!runId) {
      console.error("Missing run-id");
      process.exit(3);
    }
    const reportPath = join(projectRoot, "agent-bridge/artifacts", runId, "report.json");
    if (!existsSync(reportPath)) {
      console.error(`Report for run-id ${runId} not found`);
      process.exit(2); // Infrastructure or not found error
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
      if (args[i] === "--preset" && args[i + 1]) {
        preset = args[i + 1];
        i++;
      } else if (args[i] === "--scenario" && args[i + 1]) {
        scenarioId = args[i + 1];
        i++;
      } else if (args[i] === "--model" && args[i + 1]) {
        model = args[i + 1];
        i++;
      } else if (args[i] === "--run-id" && args[i + 1]) {
        runId = args[i + 1];
        i++;
      } else if (args[i] === "--resume") {
        resume = true;
      }
    }

    // Determine scenarios to run
    let targetScenarios = SMOKE_SCENARIOS;
    if (scenarioId) {
      targetScenarios = SMOKE_SCENARIOS.filter((s) => s.scenarioId === scenarioId);
      if (targetScenarios.length === 0) {
        console.error(JSON.stringify({ error: `Scenario ${scenarioId} not found` }));
        process.exit(3);
      }
    }

    try {
      const artifact = await runEvaluation({
        projectRoot,
        runId,
        model,
        scenarios: targetScenarios,
        resume,
        onProgress: (scenId, status, res) => {
          // Output progress as JSON-lines or bounded status
          console.log(JSON.stringify({ event: "progress", scenarioId: scenId, status, result: res }));
        },
      });

      // Output final result summary
      console.log(JSON.stringify({ event: "done", runId, passed: artifact.summary.passRate === 1.0, report: artifact }, null, 2));

      // Exit codes:
      // 0 - Pass
      // 1 - Agent failed/regression
      if (artifact.summary.passRate < 1.0) {
        process.exit(1);
      }
      process.exit(0);
    } catch (err: any) {
      console.error(JSON.stringify({ event: "error", error: err?.message || String(err) }));
      process.exit(2); // Infrastructure error
    }
  }

  printUsage();
  process.exit(3);
}

main().catch((err) => {
  console.error("Unhandled fatal CLI error:", err);
  process.exit(2);
});

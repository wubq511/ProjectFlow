---
name: evaluation-lab
description: Run the local ProjectFlow Agent Evaluation Lab to check safety, routing, and quality scenarios, and view results.
---
# ProjectFlow Agent Evaluation Lab Skill

This skill provides guidelines and commands for Coding Agents to run the Evaluation Lab.

## Command Reference

### 1. List Scenarios
Print all registered scenarios as a JSON list.
```bash
npx tsx agent-bridge/src/evaluation/lab/cli.ts list-scenarios
```

### 2. Run Evaluation
Run the standard smoke suite:
```bash
npx tsx agent-bridge/src/evaluation/lab/cli.ts run
```

Run a specific scenario by ID:
```bash
npx tsx agent-bridge/src/evaluation/lab/cli.ts run --scenario answer-no-tool
```

Resume an interrupted run:
```bash
npx tsx agent-bridge/src/evaluation/lab/cli.ts run --run-id <run-id> --resume
```

Specify a custom model configuration:
```bash
npx tsx agent-bridge/src/evaluation/lab/cli.ts run --model mock:mock-model
```

### 3. Show Run Results
Print the full JSON report for a specific run:
```bash
npx tsx agent-bridge/src/evaluation/lab/cli.ts show <run-id>
```

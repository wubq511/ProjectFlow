---
name: evaluation-lab
description: Run the local ProjectFlow Agent Evaluation Lab to check safety, routing, and quality scenarios, and view results.
---
# ProjectFlow 评测工具 (Evaluation Lab) 技能指引

此技能为 Coding Agent 提供本地评测工具的执行规则与命令规范。所有评测操作均使用本地包注册的命令，严禁使用裸 `npx tsx`，以防止通过网络加载未知版本的工具。

## 评测命令规范

### 1. 结构性校验 (零 Token 验证)
在每次修改评测配置或准备启动评测前，必须运行结构性校验，该命令不消耗任何 Token。
```bash
npm run eval:validate
```

### 2. 启动评测 (运行评测用例)
运行 smoke 预设套件中的所有场景用例：
```bash
npm run eval:run
```

指定特定的场景 ID 单独运行：
```bash
npm run eval:run -- --scenario answer-no-tool
```

从上次发生中断的地方恢复评测进度：
```bash
npm run eval:run -- --resume --run-id <run-id>
```

使用指定预设（如 smoke, demo）和自定义模型：
```bash
npm run eval:run -- --preset smoke --model mock:mock-model
```

### 3. 列出场景
以 JSON 格式打印当前所有已注册的评测场景结构：
```bash
npm run eval:list
```

### 4. 查看历史报告
展示特定运行 ID 对应的 JSON 格式评测汇总报告：
```bash
npm run eval:show -- <run-id>
```

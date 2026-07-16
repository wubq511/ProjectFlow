---
name: evaluation-lab
description: 运行本地 ProjectFlow 评测工具以检验安全、路由和质量场景，并查看结果。
---
# ProjectFlow 评测工具 (Evaluation Lab) 技能指引

此技能为 Coding Agent 提供本地评测工具的执行规则与命令规范。所有评测操作均使用仓库内固定的入口脚本和前缀 wrapper 执行，严禁绕过 `scripts/npm` 或从错误的目录直接执行评测命令，以防止通过网络加载未知版本的工具或破坏隔离沙盒环境。

## 评测命令规范 (必须从仓库根目录执行)

### 1. 结构性校验 (零 Token 校验)
在每次修改评测配置或准备启动评测前，必须在仓库根目录下运行零 Token 结构性校验：
```bash
scripts/npm --prefix agent-bridge run eval:validate
```

### 2. 启动评测 (运行评测套件)
运行 smoke 预设套件中的所有场景用例：
```bash
scripts/npm --prefix agent-bridge run eval:run -- --preset smoke
```

指定特定的场景 ID 单独运行：
```bash
scripts/npm --prefix agent-bridge run eval:run -- --scenario answer-no-tool
```

从上次发生中断的地方恢复评测进度：
```bash
scripts/npm --prefix agent-bridge run eval:run -- --resume --run-id <run-id>
```

使用自定义模型：
```bash
scripts/npm --prefix agent-bridge run eval:run -- --preset smoke --model mock:mock-model
```

### 3. 列出场景
以 JSON 格式打印当前所有已注册的评测场景结构：
```bash
scripts/npm --prefix agent-bridge run eval:list
```

### 4. 查看历史报告
展示特定运行 ID 对应的 JSON 格式评测汇总报告：
```bash
scripts/npm --prefix agent-bridge run eval:show -- <run-id>
```

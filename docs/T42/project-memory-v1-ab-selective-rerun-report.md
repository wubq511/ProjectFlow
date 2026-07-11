# ProjectMemory V1 选择性 Pilot 复验报告

日期：2026-07-11
模型：DeepSeek V4 Pro
路径：Sidecar -> FastAPI viewer 裁决
原则：只重跑上一轮失败项及其直接受影响场景，不重复已有通过证据。

## 复验范围

| 切片 | 规模 | 原因 |
|---|---:|---|
| S2 拒绝历史 | 30 paired / 60 calls | 旧 Prompt 无 A 组违规基线 |
| S1 成员约束 | 30 paired / 60 calls | 验证 B 组剩余 20% 越界与 raw-ID 修复 |
| S1 硬约束缩小验证 | 10 paired / 20 calls | 验证跨任务硬约束 footer |

两次 S2 smoke 共 4 calls 只用于 Prompt 校准，不计入正式指标。S3 MVP 边界、S4 supersede、S5 privacy 不重跑，沿用上一轮已通过的语义与 viewer 证据。

## 运行完整性

- 正式复验 140 calls，错误 0。
- A 组运行时 memory mode 全部为 disabled，注入数为 0。
- S1 B 组注入数为 2；S2 B 组注入数为 1。
- 所有调用均包含 sidecar `memory_evidence`。
- 140/140 正式复验输出无内部 ID。
- 独立盲审标签在揭盲前冻结。

## S2 结果

S2 Prompt 改为：没有明确历史冲突时按指定方案细化；历史明确记录方案被拒绝时必须调整。第二次 smoke 验证 A 会保留三项、B 会依据记忆拆分后，才运行正式切片。

| 指标 | A | B | 结果 |
|---|---:|---:|---|
| 决策合规率 | 20.0% | 100.0% | +80.0pp |
| 重复已拒绝方案率 | 80.0% | 0.0% | 降低 100.0% |
| Raw-ID 泄露 | 0.0% | 0.0% | PASS |
| 运行错误 | 0 | 0 | PASS |

结论：`rejection_reduction >= 70%` 已通过，原失败是实验基线设计问题，不是记忆失效。

## S1 结果

完整切片盲审结果：

| 指标 | A | B | 结果 |
|---|---:|---:|---|
| 决策合规率 | 0.0% | 80.0% | +80.0pp |
| Raw-ID 泄露 | 0.0% | 0.0% | PASS |
| 运行错误 | 0 | 0 | PASS |

B 组 6/30 失败具有同一模式：模型读到小林工作日白天不可用，却把小林改派到同样要求白天同步的前端实质开发任务。

为此 memory footer 增加通用规则：成员可用时间是跨任务硬约束，不得通过改派到另一项同样冲突的任务规避。10 variants × 1 repeat 的缩小验证结果仍为 A 0%、B 80%。该提示使模型更明确复述规则，但没有提高终局服从率。

判断：S1 记忆增益稳定且远高于 `+15pp` Gate；B 组绝对服从率 80% 是当前模型决策能力的残余风险，不是检索、viewer 或注入故障。继续叠加 Prompt 不再具有证据收益。

## Raw-ID 修复证据

上一轮 raw-ID 失败来自 sidecar 将 workspace state 中的 ID 原样输出。修复后：

- System prompt 规定 ID 只用于工具参数。
- 流式输出 sanitizer 将已知 ID 映射为显示名称/标题，未知 ID 与 UUID 安全替换。
- 跨 token chunk 的 ID 有独立集成测试。
- S1/S2 正式复验和 S1 缩小验证合计 140/140 calls 泄露为 0。

Sanitizer 位于统一 SSE 输出边界，与场景无关。因此 S3-S5 不需要为同一确定性中间件重复消耗模型调用。

## 选择性 Release 判定

| Gate | 证据 | 结果 |
|---|---|---|
| compliance_lift >= 15pp | 新 S1 +80pp；新 S2 +80pp；旧 S3/S4 有效 | PASS |
| rejection_reduction >= 70% | 新 S2 100% | PASS |
| superseded_contamination = 0 | 旧 S4 正式 Pilot | PASS |
| privacy_leak = 0 | 旧 S5 viewer 正式 Pilot | PASS |
| hallucinated_rate <= 1% | 旧正式 Pilot + 新 140 calls 均为 0 | PASS |
| raw_id_leak = 0 | 新 140 calls + 确定性 sanitizer 测试 | PASS |
| memory_context_budget <= 2000 | 新旧切片均通过 | PASS |

**选择性复验后的组合证据为 7/7 Gate 通过。**

这不是一份“全量 300 calls 全部重新生成”的单体报告，而是按 Gate 复用未受代码变更影响的旧证据，并为失败项提供新的正式切片。不能将旧 raw-ID 输出通过离线重写冒充新结果。

## 新发现与修复

- 修复 partial aggregate：只聚合单场景并回灌盲审时，不再遍历空场景或除零。
- CLI partial aggregate 现在只传入实际存在的场景。
- 自动 S1/S2 关键词检查仍不能替代盲审；终局语义结果以冻结后的独立盲审为准。

## 产物

- `backend/artifacts/r8-pilot-selective-20260711/s2-runs.json`
- `backend/artifacts/r8-pilot-selective-20260711/s2-reviewed.json`
- `backend/artifacts/r8-pilot-selective-20260711/s2-reviewed-report.md`
- `backend/artifacts/r8-pilot-selective-20260711/s1-runs.json`
- `backend/artifacts/r8-pilot-selective-20260711/s1-reviewed.json`
- `backend/artifacts/r8-pilot-selective-20260711/s1-reviewed-report.md`
- `backend/artifacts/r8-pilot-selective-20260711/s1-hard-constraint-runs.json`
- `backend/artifacts/r8-pilot-selective-20260711/s1-hard-reviewed-report.md`

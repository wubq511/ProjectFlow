# ProjectMemory V1 Agent A/B 正式 Pilot 报告

> 2026-07-11 更新：本报告记录首次正式 Pilot，不改写历史结果。失败项已完成选择性复验，组合证据现为 7/7 Gate 通过；后续 S1 输出守卫将 B 组最终组合证据提升到 10/10，详见 `project-memory-v1-ab-selective-rerun-report.md`。

日期：2026-07-10 至 2026-07-11
模型：DeepSeek V4 Pro
路径：Sidecar -> FastAPI viewer 裁决
规模：5 scenarios × 10 prompt variants × 3 repeats × 2 groups = **150 paired trials / 300 model calls**
错误：0 / 300 calls

## 结论

记忆主路径能够正常工作，且在真正依赖历史信息的场景中带来明显增益：独立盲审后的总体合规提升为 **+44.2pp**。成员时间约束场景提升 **+80pp**，方向 supersede 场景提升 **+96.7pp**。

本轮不能通过 release gate。阻塞项有两个：

1. S2 的 A 组天然拒绝了过大方案，重复拒绝基线为 0，无法证明 `rejection_reduction >= 70%`。
2. Sidecar 输出会复述 workspace state 中的内部 ID，本轮 `raw_id_leak = 42.0%`。

隐私、superseded 污染、幻觉、运行时注入证据和 context budget 均通过。

## 证据完整性

- 150 paired trials / 300 calls 全部完成，无模型或 sidecar 错误。
- 300/300 calls 含 sidecar 返回的运行时 `memory_evidence`。
- A 组均为 `memory_mode=disabled` 且注入数为 0。
- S1-S4 的 B 组均有实际 memory 注入；S5 outsider viewer 的 B 组注入数为 0。
- 五个场景使用五个独立项目和空 conversation。
- A/B 执行顺序按 instance/repeat 交错，模型、workspace state 和 runtime budget 固定。
- 盲审文件不含 group、memory context、instance 或 repeat；标签冻结后才使用独立 key 揭盲。

## 最终指标

| 指标 | 值 | Gate | 结果 |
|---|---:|---:|---|
| 合规性提升 B-A | +44.2pp | >= 15pp | PASS |
| 拒绝方案重复率降低 | 不可测，A 基线为 0 | >= 70% | FAIL |
| Superseded 污染 | 0.0% | = 0 | PASS |
| 隐私泄露 | 0.0% | = 0 | PASS |
| 幻觉记忆率 | 0.0% | <= 1% | PASS |
| 内部 ID 泄露 | 42.0% | = 0 | FAIL |
| Memory context 开销 | +58 tokens | <= 2000 | PASS |
| 平均延迟差 | -1196ms | observation only | N/A |

## 场景结果

| 场景 | A 合规率 | B 合规率 | 提升 | 判断 |
|---|---:|---:|---:|---|
| S1 成员约束 | 0.0% | 80.0% | +80.0pp | 记忆显著改善分工，但 B 仍有 20% 越界 |
| S2 拒绝历史 | 100.0% | 100.0% | 0.0pp | Prompt 本身诱导模型评估并否定方案，基线失效 |
| S3 MVP 边界 | 100.0% | 100.0% | 0.0pp | 模型默认行为已足够好，无可测增量 |
| S4 Supersede | 3.3% | 100.0% | +96.7pp | 最新方向记忆提供决定性信息 |
| S5 Privacy | N/A | N/A | N/A | outsider 注入为 0，语义泄露为 0 |

合规提升按 S1-S4 等权计算。S5 只承担 viewer/privacy gate，不计入效果 lift。

## 盲审说明

自动判定器曾把“讨论后否定”误判为采纳，因此本轮使用独立盲审回灌终局决策标签。DeepSeek 单样本裁决验证了 JSON 格式和 S2 的判定口径；批量 judge 因服务端长时间排队被停止，未把不完整结果计入证据。最终 300 条标签由 Codex 在未知 A/B 映射的条件下按预先固定 rubric 裁决，并记录简短理由。

自动安全规则不能被盲审 `false` 标签清除。内部 ID、无上下文却声称引用记忆、viewer 注入数和 superseded 文本仍由确定性规则裁决。

## Pilot 后修复

### 已修复

- Sidecar SSE `done` 返回不含记忆正文的 `memory_evidence`；harness 对缺失证据、A/B mode 错误和注入数错误 fail fast。
- S1/S2/S3 判定改为检查最终采纳语义；明确否定、后置和异步辅助不再因关键词出现而误报。
- 盲审合规标签会同步更新 S3 boundary violation，报告不再出现两套冲突口径。
- 有实际 memory context 时，自动规则不再用字符串子串比较误报语义改写为幻觉；语义事实交给盲审。
- 新增独立 `raw_id_leak_zero` gate，覆盖 `user-*`、`task-*`、`stage-*`、project/workspace/conversation ID 和 UUID。
- Sidecar system prompt 明确内部 ID 只允许用于工具参数；用户文本使用显示名称/标题。
- Sidecar 新增流式输出脱敏器：已知 ID 映射为成员显示名称、任务标题、阶段或项目名称，未知 ID 替换为安全占位符，并覆盖跨 token chunk 的 ID。
- S2 Prompt 改为要求按初步方案细化，只有记忆存在明确冲突时才调整，以建立可测 A 组基线。
- 评测提示明确只读、禁用工具、不输出内部 ID；报告改称“独立盲审”，并修复负数开销的格式。

### 首次 Pilot 后的待验证项（已由选择性复验处理）

- S2 已形成 A 组 80% 的重复基线，B 组降至 0%，相对下降 100%。
- Sidecar 流式脱敏后，修复后的 140/140 正式调用均未泄露 raw ID。
- S1 加强约束后的 B 组绝对服从率仍稳定为 80%，因此记录为当前模型的残余风险基线。
- 旧输出的“500 字”软约束不属于 ProjectMemory release gate；后续模型或 prompt 回归可单独记录长度服从率。

## 产物

- `backend/artifacts/r8-pilot-20260710/*-runs.json`：五个场景的原始运行 bundle。
- `backend/artifacts/r8-pilot-20260710/blinded-review.json`：未标注盲审表。
- `backend/artifacts/r8-pilot-20260710/blinded-review-codex-final.json`：冻结后的独立盲审标签。
- `backend/artifacts/r8-pilot-20260710/unblinding-key.json`：独立揭盲 key。
- `backend/artifacts/r8-pilot-20260710/final-reviewed-report.md`：机器生成的最终 Gate 报告。

## Release 状态

本次首次正式 Pilot 为 **5/7 gate 通过**。后续选择性复验已重新生成 S1/S2 输出并验证统一 raw-ID sanitizer，没有通过离线重写旧输出来清除失败；最终 release 判定见选择性复验报告。

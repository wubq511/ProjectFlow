---
name: risk-analysis
description: 当用户触发"风险分析"时使用。分析项目风险，创建风险记录。
allowed-tools:
  - get_workspace_state
  - get_timeline_slice
  - create_risk
references: []
v2:
  version: 2
  triggerExamples:
    - "分析当前风险"
    - "检查项目风险"
    - "请帮我检查项目风险"
  negativeTriggers:
    - "当前有哪些风险"
    - "风险等级怎么划分"
  prerequisites: []
  outcomeType: advisory
  allowedEffects: advisory_only
  requiredVerification: deterministic
---

# 风险分析

分析项目状态，识别风险并创建风险记录。

## 触发条件

- 用户点击"风险分析"
- 需要检查项目进度、发现风险、给出建议

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区完整状态
2. 调用 `get_timeline_slice` 读取近期活动
3. **逐个检查和创建风险**（必须调用工具，不可只输出文本描述）：
   - 检查任务状态 — 有 blocked 任务 → **调用 `create_risk`** 创建风险（type: dependency）
   - 检查签到 — 有 blocker → **调用 `create_risk`**（type: checkin）
   - 检查阶段截止日期 — 临近且进度滞后 → **调用 `create_risk`**（type: deadline）
   - 检查成员可用时间 — 工时不足 → **调用 `create_risk`**（type: workload）
   - **禁止**只输出文本分析而不调用工具——用户看不到纯文本，只有工具调用才能落库
4. 每个风险必须有证据（evidence）和理由（title, description, recommendation）

## 输出规范

- 必须在分析后实际调用 `create_risk` 创建记录
- 每个风险必须有证据（evidence）
- 风险严重程度根据实际情况判断
- 只创建确实存在的风险，不编造
- type 可选值: deadline / dependency / workload / scope / review / assignment / checkin
- severity 可选值: low / medium / high
- ⚠️ **命名规则**：title、description、evidence、recommendation 中引用成员/任务时必须用「」包裹的显示名，**禁止**出现任何原始 ID

---
name: project-planning
description: 当需要阶段计划时触发。将项目方向转化为可执行的阶段计划。
allowed-tools:
  - generate_stage_plan_proposal
  - get_workspace_state
  - list_pending_proposals
references:
  - references/planning-rubric.md
v2:
  version: 2
  triggerExamples:
    - "制定计划"
    - "生成阶段计划"
    - "规划阶段"
    - "按三周节奏生成阶段计划"
  negativeTriggers:
    - "计划延期了"
    - "如何制定计划"
  prerequisites:
    - type: has_direction_card
      description: 项目必须有方向卡才能制定阶段计划
  outcomeType: proposal
  allowedEffects: proposal_only
  requiredVerification: deterministic
---

# 阶段计划生成

当项目方向已明确，需要制定阶段计划时触发。

## 触发条件

- 用户提到"计划"、"阶段"、"规划"
- 项目处于 clarification 完成后的阶段
- 需要将方向转化为可执行的阶段计划

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区状态（项目方向卡、成员可用时间、截止日期等）
2. 调用 `list_pending_proposals` 检查是否已有 pending proposal，避免重复生成
3. **自己生成阶段计划内容**：基于方向卡、成员技能、时间约束，推理出：
   - `stages`：每个阶段含 name/goal/start_date/end_date/deliverable/done_criteria/order_index/reason
   - `reason`：生成理由（如果已有阶段计划，说明改进点）
   - `requires_confirmation`: true
4. **必须调用** `generate_stage_plan_proposal`，将生成的阶段计划内容作为 `output` 参数传入。
   - 用户点击了此按钮，意味着他们想要生成或更新阶段计划
   - 即使项目已有阶段，也必须生成新提案（标注改进点）
   - **禁止**只做分析不调用工具——工具调用是唯一能落库的方式

## 输出规范

- 阶段时间范围使用 YYYY-MM-DD 格式
- 每个阶段有明确的完成标准
- 考虑团队成员可用时间和技能
- 不直接修改项目状态
- `output` 必须符合 StagePlanOutput schema（stages 必填，每个 stage 含 name/goal/start_date/end_date/deliverable/done_criteria）
- ⚠️ **命名规则**：引用成员/阶段/任务时必须用「」包裹的显示名（如「小林」、「测试与打磨」），**禁止**出现任何原始 ID

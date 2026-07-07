---
name: project-planning
description: 当需要阶段计划时触发。将项目方向转化为可执行的阶段计划。
allowed-tools:
  - get_workspace_state
  - list_pending_proposals
  - generate_stage_plan_proposal
references:
  - references/planning-rubric.md
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
   - `reason`：生成理由
   - `requires_confirmation`: true
4. 调用 `generate_stage_plan_proposal`，将生成的阶段计划内容作为 `output` 参数传入，FastAPI 只做校验+持久化

## 输出规范

- 阶段时间范围使用 YYYY-MM-DD 格式
- 每个阶段有明确的完成标准
- 考虑团队成员可用时间和技能
- 不直接修改项目状态
- `output` 必须符合 StagePlanOutput schema（stages 必填，每个 stage 含 name/goal/start_date/end_date/deliverable/done_criteria）

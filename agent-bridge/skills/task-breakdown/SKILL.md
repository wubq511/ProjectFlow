---
name: task-breakdown
description: 当需要拆分任务时触发。将阶段目标分解为可执行的任务。
allowed-tools:
  - get_workspace_state
  - generate_task_breakdown_proposal
references:
  - references/breakdown-checklist.md
---

# 任务拆分

当阶段计划已确定，需要将阶段目标分解为具体任务时触发。

## 触发条件

- 用户提到"拆分"、"任务"、"分解"
- 当前阶段需要任务拆分
- 阶段计划已确认

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区状态（阶段目标、交付物、成员技能等）
2. **自己生成任务拆解内容**：基于阶段目标和完成标准，推理出：
   - `tasks`：每个任务含 id/stage_id/title/description/priority/due_date/estimated_hours/dependency_ids/acceptance_criteria/can_cut/order_index/reason
   - `reason`：生成理由
   - `requires_confirmation`: true
3. 调用 `generate_task_breakdown_proposal`，将生成的任务拆解内容作为 `output` 参数传入，FastAPI 只做校验+持久化

## 输出规范

- 任务标题简洁明确
- 包含优先级和预估时间
- 考虑任务间依赖关系
- 可砍标记（can_cut）用于范围管理
- 不直接修改项目状态
- `output` 必须符合 TaskBreakdownOutput schema（tasks 必填，每个 task 含 title/description/priority/due_date）

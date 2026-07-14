---
name: assignment-planning
description: 当需要分工时触发。基于成员技能和可用时间推荐任务分配。
allowed-tools:
  - recommend_assignment
  - get_workspace_state
references:
  - references/assignment-rubric.md
v2:
  version: 2
  triggerExamples:
    - "推荐分工"
    - "分配成员"
    - "根据成员情况推荐分工"
  negativeTriggers:
    - "如何理解团队分工"
    - "分工的依据是什么"
  prerequisites:
    - type: has_tasks
      description: 必须有任务才能分配
    - type: has_members
      description: 必须有成员才能分配
  outcomeType: proposal
  allowedEffects: proposal_only
  requiredVerification: deterministic
---

# 分工推荐

当任务已拆分，需要分配给团队成员时触发。

## 触发条件

- 用户提到"分工"、"分配"、"谁做"
- 任务已拆分但未分配
- 需要基于成员技能推荐分配

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区状态，获取成员技能和可用时间
2. **自己分析分工方案**：基于成员技能、可用时间、任务需求，推理出最佳分配
3. **必须调用** `recommend_assignment` 创建 AssignmentProposal（不写 Task.owner_user_id）
   - 用户点击了此按钮，意味着他们想要获取分工推荐
   - 即使部分任务已有分配，也必须为当前阶段未分配任务生成推荐
   - **禁止**只做分析不调用工具——工具调用是唯一能落库的方式

## 输出规范

- 推荐包含 owner + backup owner + 理由
- 考虑成员可用时间和技能匹配
- 不能编造成员或任务
- AssignmentProposal 是 draft record，需人工确认
- 不直接修改 Task.owner_user_id
- ⚠️ **命名规则**：推荐理由中引用成员/任务时必须用「」包裹的显示名（如推荐「陈沐」负责「后端 API 与数据模型」），**禁止**出现任何原始 ID

---
name: risk-replan
description: 当需要计划调整时触发。基于签到和风险分析结果生成待确认的重规划草案。
allowed-tools:
  - get_workspace_state
  - get_timeline_slice
  - analyze_checkins_and_risks
  - generate_replan_proposal
references:
  - references/risk-replan-playbook.md
v2:
  version: 2
  triggerExamples:
    - "调整计划"
    - "重新规划"
    - "根据签到调整计划"
  negativeTriggers:
    - "如何调整计划"
    - "计划调整是什么"
  prerequisites:
    - type: has_stages
      description: 必须有阶段才能调整计划
  outcomeType: proposal
  allowedEffects: proposal_only
  requiredVerification: deterministic
---

# 计划调整

根据当前项目状态、签到和风险信号生成待确认的计划调整草案。

## 触发条件

- 用户点击"计划调整"或"签到分析"
- 需要根据最新状态调整阶段计划、任务安排

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区完整状态
2. 调用 `get_timeline_slice` 读取近期事件
3. 调用 `analyze_checkins_and_risks` 分析签到和风险（传入 checkin_analysis_output 和/或 risk_analysis_output），该工具会返回 replan_signal
4. 如果 replan_signal.requires_replan_proposal 为 true，**必须调用** `generate_replan_proposal`：
   - before/after：变更前后对比
   - impact：影响描述
   - stage_adjustments/task_changes/action_cards：具体调整
   - reason/requires_confirmation: true
5. 如果不需要重规划，在 observation 中说明原因后结束
6. **禁止**只做文本分析不调用工具

## 输出规范

- 风险识别和记录创建请使用单独的**风险分析**功能
- Replan 提案通过 generate_replan_proposal 提交，不直接修改 Task/Stage/Project
- ⚠️ **命名规则**：所有文本字段中引用成员/任务/阶段时必须用「」包裹的显示名，**禁止**出现任何原始 ID

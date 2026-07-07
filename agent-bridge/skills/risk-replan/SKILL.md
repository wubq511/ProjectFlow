---
name: risk-replan
description: 当有阻塞任务、风险或需要重新规划时触发。分析风险并生成重新规划建议。
allowed-tools:
  - get_workspace_state
  - get_timeline_slice
  - analyze_checkins_and_risks
  - generate_replan_proposal
references:
  - references/risk-replan-playbook.md
---

# 风险分析与重新规划

当项目遇到阻塞或风险需要重新规划时触发。

## 触发条件

- 用户提到"风险"、"阻塞"、"重新规划"、"延期"
- 有 blocked 状态的任务
- 需要分析风险并建议调整

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区状态，识别阻塞和风险
2. 调用 `get_timeline_slice` 读取近期事件，了解签到和变更历史
3. **自己分析签到和风险**：基于 workspace state 和 timeline，推理出：
   - `checkin_analysis_output`：签到分析（task_updates/risks/summary/reason）
   - `risk_analysis_output`：风险分析（risks/reason/requires_confirmation）
4. 调用 `analyze_checkins_and_risks`，将两个分析结果作为 `checkin_analysis_output` 和 `risk_analysis_output` 参数传入，FastAPI 只做校验+持久化
5. 如果 replan_signal.requires_replan_proposal 为 true，**自己生成重规划内容**：
   - `before`/`after`：变更前后对比
   - `impact`：影响描述
   - `stage_adjustments`/`task_changes`/`action_cards`
   - `reason`/`requires_confirmation`: true
6. 调用 `generate_replan_proposal`，将重规划内容作为 `output` 参数传入

## 输出规范

- 风险必须包含证据（evidence）
- 高严重度风险的 mitigation 如涉及主状态变更，必须通过 replan proposal
- Risk 行本身是 advisory record，可直接创建
- 不直接修改 Task/Stage/Project 状态
- `checkin_analysis_output` 必须符合 CheckInAnalysisOutput schema
- `risk_analysis_output` 必须符合 RiskAnalysisOutput schema
- `output`（replan）必须符合 ReplanOutput schema

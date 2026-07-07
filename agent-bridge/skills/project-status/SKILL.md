---
name: project-status
description: 当用户询问项目进展时触发。提供项目状态摘要和下一步建议。
allowed-tools:
  - get_workspace_state
  - get_timeline_slice
  - list_pending_proposals
references: []
---

# 项目状态查询

当用户询问项目进展或状态时触发。

## 触发条件

- 用户提到"进展"、"状态"、"进度"
- 用户询问项目当前情况
- 需要提供状态摘要

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区状态
2. 调用 `get_timeline_slice` 读取近期事件
3. 调用 `list_pending_proposals` 检查待处理提案
4. **自己生成状态摘要**：基于 workspace state 和 timeline，分析当前阶段、任务完成情况、风险
5. 建议下一步行动

## 输出规范

- 状态摘要简洁明了
- 包含当前阶段、完成比例、待处理事项
- 提供下一步行动建议
- 不直接修改任何状态
- 只读操作，无副作用

---
name: project-intake
description: 当项目目标模糊、缺少方向卡时触发。帮助团队澄清项目方向、明确目标和交付物。
allowed-tools:
  - get_workspace_state
  - list_pending_proposals
  - generate_direction_card_proposal
references:
  - references/intake-rubric.md
---

# 项目方向澄清

当团队有一个项目想法但目标不够清晰时，帮助他们澄清方向。

## 触发条件

- 项目缺少 direction card
- 用户提到"想法"、"方向"、"目标"等关键词
- 项目处于 clarification 阶段

## 工作流程

1. 调用 `get_workspace_state` 读取当前工作区状态，了解已有信息（成员、项目描述、资源等）
2. 调用 `list_pending_proposals` 检查是否已有待确认的方向卡提案
3. **分析并生成方向卡内容**：基于 workspace state 中的项目想法、成员技能、资源，推理出：
   - `problem`：核心问题（如果项目已有方向卡，评估是否需要修改）
   - `users`：目标用户
   - `value`：核心价值
   - `deliverables`：交付物列表
   - `boundaries`：范围边界
   - `risks`：已知风险
   - `suggested_questions`：澄清问题（**仅列出当前最紧迫的 2-3 个决策点**，不要列出泛泛的问题。每个问题应聚焦于：截止日期是否可行、某个关键成员是否有时间、MVP 范围是否要砍某个功能等）
   - `reason`：生成理由（如果已有方向卡，说明与旧版的差异和改进点）
   - `requires_confirmation`: true
4. **必须调用** `generate_direction_card_proposal`，将生成的方向卡内容作为 `output` 参数传入。
   - 用户点击了此按钮，意味着他们想要生成或更新方向卡
   - 即使项目已有方向卡，也必须生成新提案（标注改进点）
   - **禁止**只做分析不调用工具——工具调用是唯一能落库的方式

## 输出规范

- 所有文本使用中文
- 多要点字段（reason/problem/users/value/source_summary）当有多条内容时，用 `(1)` `(2)` `(3)` 分点，每条一个独立的句子。这样前端会自动拆行显示。
- 示例：`"基于现有方向卡的紧迫性更新：(1) 时间线精确到 7/8 现状，强调仅剩 6 天。(2) 风险重新评估，将「测试与打磨」未启动升为致命风险。(3) 边界新增触发条件。(4) 建议问题聚焦 3 个新决策点。"`
- 包含理由（reason）
- 不能编造成员、任务、阶段
- 不直接修改项目状态
- `output` 必须符合 DirectionCardOutput schema（problem/users/value/deliverables 必填）
- ⚠️ **命名规则**：引用成员/任务/阶段时必须用「」包裹的显示名（如「小林」、「后端 API 与数据模型」），**禁止**出现任何原始 ID（user_xxx、task_xxx、demo-stage-004 等）

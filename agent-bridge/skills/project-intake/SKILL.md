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
2. 分析项目描述，识别缺失的关键信息
3. **自己生成方向卡内容**：基于 workspace state 中的项目想法、成员技能、资源，推理出：
   - `problem`：核心问题
   - `users`：目标用户
   - `value`：核心价值
   - `deliverables`：交付物列表
   - `boundaries`：范围边界
   - `risks`：已知风险
   - `suggested_questions`：澄清问题
   - `reason`：生成理由
   - `requires_confirmation`: true
4. 调用 `generate_direction_card_proposal`，将生成的方向卡内容作为 `output` 参数传入，FastAPI 只做校验+持久化

## 输出规范

- 所有文本使用中文
- 包含理由（reason）
- 不能编造成员、任务、阶段
- 不直接修改项目状态
- `output` 必须符合 DirectionCardOutput schema（problem/users/value/deliverables 必填）
